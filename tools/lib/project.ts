import { projectRoot, contextForProject, assertProjectInput } from "./runtimeContext.js";
/** Target selection is independent of the candidate compiler. Missing manifest
 * keeps the existing executable/overlay pipeline. Never infer a library from SDK inputs. */
import { existsSync, readFileSync, realpathSync, globSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadToolchain } from "./toolchain.js";
export const PROJECT_FILE = "project.json";
export interface LibraryProject {
  schemaVersion: 1;
  target: { kind: "relocatable-library"; format: "elf-ar"; archives: string[]; standaloneObjects: string[] };
  headers: { reference: string[]; owned: string[]; context: string[] };
  selection: { scope: "all-code-members" };
  verification: { mode: "relocatable-object" };
  output: { sourceDir: string; sourceLayout?: "grouped" | "member-id" | "tu-directory"; inputRoot?: string };
  /** Named toolchain flag/include profiles; exact member id wins over default. */
  toolchainProfile?: string;
  memberProfiles: Record<string, string>;
}
function object(value: any, allowed: string[], at: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${PROJECT_FILE}: ${at} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${PROJECT_FILE}: unknown ${at}.${key}`);
}
function paths(value: any, at: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(p => typeof p !== "string" || !p || p.includes("\0") || isAbsolute(p) || p.split(/[\\/]/).includes("..")))
    throw new Error(`${PROJECT_FILE}: ${at} must contain safe root-relative paths`);
}
export function loadLibraryProject(root = projectRoot()): LibraryProject | null {
  const file = join(root, PROJECT_FILE);
  if (!existsSync(file)) return null;
  const p = JSON.parse(readFileSync(file, "utf8"));
  object(p, ["$schema", "schemaVersion", "target", "headers", "selection", "verification", "output", "toolchainProfile", "memberProfiles"], "config");
  if (p.schemaVersion !== 1) throw new Error(`${PROJECT_FILE}: unsupported schemaVersion`);
  object(p.target, ["kind", "format", "archives", "standaloneObjects"], "target");
  if (p.target.kind === "linked-image") {
    if (Object.keys(p.target).length !== 1) throw new Error(`${PROJECT_FILE}: linked-image layout belongs in configs/splat and configs/overlays.json`);
    return null;
  }
  if (p.target.kind !== "relocatable-library" || p.target.format !== "elf-ar") throw new Error(`${PROJECT_FILE}: supported library format is elf-ar (not original PSY-Q LIB/LNK)`);
  p.target.archives ??= []; p.target.standaloneObjects ??= [];
  paths(p.target.archives, "target.archives"); paths(p.target.standaloneObjects, "target.standaloneObjects");
  if (!p.target.archives.length && !p.target.standaloneObjects.length) throw new Error(`${PROJECT_FILE}: no target inputs configured`);
  p.headers ??= {}; object(p.headers, ["reference", "owned", "context"], "headers");
  for (const role of ["reference", "owned", "context"]) { p.headers[role] ??= []; paths(p.headers[role], `headers.${role}`); }
  if ([...p.headers.reference, ...p.headers.owned].some(s => /[*?\[]/.test(s))) throw new Error(`${PROJECT_FILE}: header roles name directories, not globs`);
  for (const a of p.headers.reference) for (const b of p.headers.owned) {
    if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) throw new Error(`${PROJECT_FILE}: reference and owned headers overlap`);
  }
  p.selection ??= { scope: "all-code-members" }; object(p.selection, ["scope"], "selection");
  p.verification ??= { mode: "relocatable-object" }; object(p.verification, ["mode"], "verification");
  if (p.selection.scope !== "all-code-members" || p.verification.mode !== "relocatable-object") throw new Error(`${PROJECT_FILE}: unsupported selection/verification mode`);
  p.output ??= { sourceDir: "src/libraries" }; object(p.output, ["sourceDir", "sourceLayout", "inputRoot"], "output"); paths([p.output.sourceDir], "output.sourceDir");
  if (!p.output.sourceDir.startsWith("src/") || /[*?\[{]/.test(p.output.sourceDir)) throw new Error(`${PROJECT_FILE}: output.sourceDir must be a directory under src/`);
  p.output.sourceLayout ??= "grouped";
  if (!["grouped", "member-id", "tu-directory"].includes(p.output.sourceLayout)) throw new Error(`${PROJECT_FILE}: unsupported output.sourceLayout`);
  if (p.output.inputRoot !== undefined) {
    paths([p.output.inputRoot], "output.inputRoot");
    if (/[*?\[{]/.test(p.output.inputRoot)) throw new Error(`${PROJECT_FILE}: output.inputRoot must name a directory, not a glob`);
  }
  p.memberProfiles ??= {}; object(p.memberProfiles, Object.keys(p.memberProfiles), "memberProfiles");
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
