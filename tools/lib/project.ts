import { projectRoot, contextForProject, assertProjectInput } from "./runtimeContext.js";
/** Target selection is independent of the candidate compiler. Missing manifest
 * keeps the existing executable/overlay pipeline. Never infer a library from SDK inputs. */
import { existsSync, readFileSync, realpathSync, globSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { deepFreeze, loadToolchain } from "./toolchain.js";
import { readStampedText } from "./contentCache.js";
import { count } from "./perfCounters.js";
export const PROJECT_FILE = "project.json";
export interface LibraryProject {
  schemaVersion: 1;
  target: { kind: "relocatable-library"; format: "elf-ar" | "psyq-lib"; archives: string[]; standaloneObjects: string[] };
  /** `requires`: reference headers (by include name) that rely on their includer
   * having included others first, as the SDK's own sources do. */
  headers: { reference: string[]; owned: string[]; context: string[]; requires?: Record<string, string[]> };
  selection: { scope: "all-code-members" };
  verification: { mode: "relocatable-object" | "original-object"; originals?: { format: "psyq-lnk"; archives: string[]; objects: string[]; map: Record<string, { archive: string; ordinal: number } | { object: string }> } };
  views?: { elf: Record<string, string> };
  output: { sourceDir: string; sourceLayout?: "grouped" | "member-id" | "tu-directory"; inputRoot?: string };
  /** Named toolchain flag/include profiles; exact member id wins over default. */
  toolchainProfile?: string;
  memberProfiles: Record<string, string>;
}
/** `allowed` omitted: any key, only the object shape is checked (open maps). */
function object(value: any, allowed: string[] | undefined, at: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${PROJECT_FILE}: ${at} must be an object`);
  if (!allowed) return;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${PROJECT_FILE}: unknown ${at}.${key}`);
}
function paths(value: any, at: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(p => typeof p !== "string" || !p || p.includes("\0") || isAbsolute(p) || p.split(/[\\/]/).includes("..")))
    throw new Error(`${PROJECT_FILE}: ${at} must contain safe root-relative paths`);
}
/* Like loadToolchain: validation is a function of this file's text and the
 * toolchain profiles it names, so accepted text is neither parsed nor validated
 * again. The file is still read on every request (once per stamp within a
 * content-memo scope); callers share one deep-frozen
 * configuration per text, and any attempt to change it throws. */
const loadedProjects = new Map<string, { text: string; profiles?: object; project: LibraryProject | null }>();
export function loadLibraryProject(root = projectRoot()): LibraryProject | null {
  const file = join(root, PROJECT_FILE);
  if (!existsSync(file)) return null;
  const text = readStampedText(file), key = resolve(root), prior = loadedProjects.get(key);
  /* Only an accepted library manifest read the toolchain's profiles. */
  if (prior?.text === text && (!prior.project || prior.profiles === loadToolchain(root).profiles)) return prior.project;
  const project = validateLibraryProject(JSON.parse(text), root);
  loadedProjects.set(key, { text, ...(project ? { profiles: loadToolchain(root).profiles } : {}), project: deepFreeze(project) });
  return project;
}
function validateLibraryProject(p: any, root: string): LibraryProject | null {
  count("project.validate");
  object(p, ["$schema", "schemaVersion", "target", "headers", "selection", "verification", "views", "output", "toolchainProfile", "memberProfiles"], "config");
  if (p.schemaVersion !== 1) throw new Error(`${PROJECT_FILE}: unsupported schemaVersion`);
  object(p.target, ["kind", "format", "archives", "standaloneObjects"], "target");
  if (p.target.kind === "linked-image") {
    if (Object.keys(p.target).length !== 1) throw new Error(`${PROJECT_FILE}: linked-image layout belongs in configs/splat and configs/overlays.json`);
    return null;
  }
  if (p.target.kind !== "relocatable-library" || !["elf-ar", "psyq-lib"].includes(p.target.format)) throw new Error(`${PROJECT_FILE}: supported library formats are elf-ar and psyq-lib`);
  p.target.archives ??= []; p.target.standaloneObjects ??= [];
  paths(p.target.archives, "target.archives"); paths(p.target.standaloneObjects, "target.standaloneObjects");
  if (!p.target.archives.length && !p.target.standaloneObjects.length) throw new Error(`${PROJECT_FILE}: no target inputs configured`);
  p.headers ??= {}; object(p.headers, ["reference", "owned", "context", "requires"], "headers");
  for (const role of ["reference", "owned", "context"]) { p.headers[role] ??= []; paths(p.headers[role], `headers.${role}`); }
  if (p.headers.requires !== undefined) {
    object(p.headers.requires, undefined, "headers.requires");
    for (const [header, prior] of Object.entries(p.headers.requires)) paths([header, ...(prior as unknown[])], `headers.requires.${header}`);
  }
  if ([...p.headers.reference, ...p.headers.owned].some(s => /[*?\[]/.test(s))) throw new Error(`${PROJECT_FILE}: header roles name directories, not globs`);
  for (const a of p.headers.reference) for (const b of p.headers.owned) {
    if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) throw new Error(`${PROJECT_FILE}: reference and owned headers overlap`);
  }
  p.selection ??= { scope: "all-code-members" }; object(p.selection, ["scope"], "selection");
  p.verification ??= { mode: "relocatable-object" }; object(p.verification, ["mode", "originals"], "verification");
  if (p.selection.scope !== "all-code-members" || !["relocatable-object", "original-object"].includes(p.verification.mode)) throw new Error(`${PROJECT_FILE}: unsupported selection/verification mode`);
  if (p.verification.originals !== undefined) {
    if (p.verification.mode !== "original-object" || p.target.format === "psyq-lib") throw new Error(`${PROJECT_FILE}: transitional originals mapping belongs only to elf-ar original-object verification`);
    const o = p.verification.originals; object(o, ["format", "archives", "objects", "map"], "verification.originals");
    if (o.format !== "psyq-lnk") throw new Error(`${PROJECT_FILE}: originals format must be psyq-lnk`);
    o.archives ??= []; o.objects ??= []; paths(o.archives, "originals.archives"); paths(o.objects, "originals.objects");
    object(o.map, undefined, "originals.map");
    for (const [id, raw] of Object.entries(o.map)) {
      const m = raw as any; object(m, m?.archive ? ["archive", "ordinal"] : ["object"], `originals.map.${id}`);
      paths([m.archive ?? m.object], `originals.map.${id}`);
      if (m.archive && (!Number.isSafeInteger(m.ordinal) || m.ordinal < 0)) throw new Error(`${PROJECT_FILE}: invalid original ordinal ${id}`);
    }
  }
  if (p.target.format === "elf-ar" && p.verification.mode === "original-object" && !p.verification.originals) throw new Error(`${PROJECT_FILE}: original-object mode requires an originals mapping`);
  if (p.target.format === "psyq-lib" && p.verification.mode !== "original-object") throw new Error(`${PROJECT_FILE}: psyq-lib requires original-object verification`);
  if (p.views !== undefined) {
    object(p.views, ["elf"], "views"); object(p.views.elf, undefined, "views.elf"); paths(Object.values(p.views.elf), "views.elf");
  }
  if (p.target.format === "psyq-lib" && !p.views) throw new Error(`${PROJECT_FILE}: psyq-lib requires explicit content-checked ELF views`);
  p.output ??= { sourceDir: "src/libraries" }; object(p.output, ["sourceDir", "sourceLayout", "inputRoot"], "output"); paths([p.output.sourceDir], "output.sourceDir");
  if (!p.output.sourceDir.startsWith("src/") || /[*?\[{]/.test(p.output.sourceDir)) throw new Error(`${PROJECT_FILE}: output.sourceDir must be a directory under src/`);
  p.output.sourceLayout ??= "grouped";
  if (!["grouped", "member-id", "tu-directory"].includes(p.output.sourceLayout)) throw new Error(`${PROJECT_FILE}: unsupported output.sourceLayout`);
  if (p.output.inputRoot !== undefined) {
    paths([p.output.inputRoot], "output.inputRoot");
    if (/[*?\[{]/.test(p.output.inputRoot)) throw new Error(`${PROJECT_FILE}: output.inputRoot must name a directory, not a glob`);
  }
  p.memberProfiles ??= {}; object(p.memberProfiles, undefined, "memberProfiles");
  const profiles = loadToolchain(root).profiles;
  for (const name of [...Object.values(p.memberProfiles), ...(p.toolchainProfile !== undefined ? [p.toolchainProfile] : [])]) {
    if (typeof name !== "string" || !Object.hasOwn(profiles, name)) throw new Error(`${PROJECT_FILE}: unknown toolchain profile ${String(name)}`);
  }
  return p as LibraryProject;
}
export function libraryInputFiles(project: LibraryProject, root = projectRoot()): { path: string; archive: boolean }[] {
  const seen = new Set<string>(), result: { path: string; archive: boolean }[] = [];
  const realRoot = realpathSync(root), context = contextForProject(root);
  for (const [patterns, archive] of [[project.target.archives, true], [project.target.standaloneObjects, false]] as const) {
    for (const pattern of patterns) {
      const matches = globSync(pattern, { cwd: root }).sort();
      if (!matches.length) throw new Error(`${PROJECT_FILE}: input pattern matched nothing: ${pattern}`);
      for (const path of matches) {
        const actual = realpathSync(resolve(root, path)), rel = relative(realRoot, actual);
        assertProjectInput(path, context);
        if (rel.startsWith(`build${sep}`) || path.startsWith("build/")) throw new Error(`Library target must be a pristine input outside build/: ${path}`);
        if (seen.has(actual)) throw new Error(`Library input selected twice: ${path}`);
        seen.add(actual); result.push({ path: path.split(sep).join("/"), archive });
      }
    }
  }
  return result;
}
export function libraryContext(memberId: string, root = projectRoot(), project = loadLibraryProject(root)): { kind: "library"; id: string; profile?: string } {
  if (!project) throw new Error("Not a library target");
  const profile = project.memberProfiles[memberId] ?? project.toolchainProfile;
  return { kind: "library", id: memberId, ...(profile ? { profile } : {}) };
}
