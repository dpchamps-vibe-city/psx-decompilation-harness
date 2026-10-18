/** One transactional rename from content-checked ELF inventory to originals.
 * Dry-run is read-only. No historical-ID aliasing survives the migration. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { libraryMembers } from "../lib/libraryTargets.js";
import { originalMemberId } from "../lib/libraryOriginals.js";
import { librarySourceInputRoot } from "../lib/librarySourceLayout.js";
import { libraryInputFiles, loadLibraryProject, type LibraryProject } from "../lib/project.js";
import { projectRoot, contextForProject, inRuntimeContext } from "../lib/runtimeContext.js";
import { generateProjectProfile } from "../build/genProjectProfile.js";
import { libraryMemberResults } from "./libraryTarget.js";
import { loadLoopConfig } from "../../.pi/extensions/psx-decomp/autoloop/config.js";
const oldId = /lib_[0-9a-f]{16}_\d+/g;
export interface MemberIdMigration {
  mapping: Record<string, string>;
  changes: Array<{ path: string; destination: string; occurrences: number; regenerate?: boolean }>;
  invalidated: string[];
  written: boolean;
  results?: Array<{ before: string; after: string; verdict: string }>;
}
export function migrateMemberIds(write = false, root = projectRoot()): MemberIdMigration {
  const project = loadLibraryProject(root);
  if (!project || project.target.format !== "elf-ar" || !project.verification.originals) throw new Error("ID migration requires an elf-ar inventory with content-checked original-object mapping");
  const members = libraryMembers(root, project), mapping: Record<string, string> = {}, newIds = new Set<string>(), views: Record<string, string> = {};
  const standalone = new Set(libraryInputFiles(project, root).filter(i => !i.archive).map(i => i.path));
  for (const member of members) {
    const selection = project.verification.originals.map[member.id]!;
    const id = originalMemberId(member.originalObject!.input, "archive" in selection ? member.originalObject!.ordinal : undefined);
    if (newIds.has(id)) throw new Error(`New member ID collision: ${id}`);
    newIds.add(id); mapping[member.id] = id;
    // An archive is not a standalone view. Require an explicit, independently
    // content-checked extracted view rather than creating one during a rename.
    const view = project.views?.elf[member.id] ?? (standalone.has(member.input) ? member.input : undefined);
    if (!view) throw new Error(`No standalone ELF view for ${member.id}`);
    views[id] = view;
  }
  const rewritten = (text: string) => text.replace(oldId, id => {
    if (!mapping[id]) throw new Error(`Unmapped old member ID: ${id}`);
    return mapping[id]!;
  });
  const next: LibraryProject = { ...project,
    target: { kind: "relocatable-library", format: "psyq-lib", archives: [...new Set(Object.values(project.verification.originals.map).flatMap(s => "archive" in s ? [s.archive] : []))], standaloneObjects: [...new Set(Object.values(project.verification.originals.map).flatMap(s => "object" in s ? [s.object] : []))] },
    output: { ...project.output, inputRoot: librarySourceInputRoot(project) },
    verification: { mode: "original-object" }, views: { elf: views },
    memberProfiles: Object.fromEntries(Object.entries(project.memberProfiles).map(([id, profile]) => [mapping[id]!, profile])),
  };
  const afterMembers = libraryMembers(root, next);
  if (afterMembers.length !== members.length) throw new Error("Original inventory population differs; select complete original archives before migrating");
  for (const member of members) {
    const after = afterMembers.find(m => m.id === mapping[member.id]);
    if (!after || after.originalObject!.sha256 !== member.originalObject!.sha256 || after.source !== rewritten(member.source)) throw new Error(`Migration changes content or source ownership: ${member.id}`);
  }
  const safe = (path: string) => {
    const absolute = resolve(root, path), rel = relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Migration path escapes project: ${path}`);
    let cursor = root;
    for (const part of rel.split(sep)) { cursor = join(cursor, part); if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Migration refuses symlink: ${path}`); }
    return absolute;
  };
  const directories = new Set<string>();
  const supportCache = (path: string) => /^(?:\.pi\/(?:node_modules|cache|agent|git|packages)(?:\/|$))/.test(path);
  const walk = (path: string): string[] => {
    if (supportCache(path)) return [];
    const absolute = safe(path), stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return [];
    if (stat.isDirectory()) { directories.add(path); return readdirSync(absolute).sort().flatMap(n => walk(`${path}/${n}`)); }
    return stat.isFile() ? [path] : [];
  };
  let tracked: string[];
  try {
    const options = { cwd: root, encoding: "utf8" as const, stdio: "pipe" as const };
    if (resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim()) !== resolve(root)) throw new Error("Not this project's Git root");
    tracked = execFileSync("git", ["ls-files", "-z"], options).split("\0").filter(Boolean);
  }
  catch { tracked = ["src", "include", "notes", "configs", "plans", ".pi", "project.json", "toolchain.json"].flatMap(walk); }
  const runtimeDirectory = relative(root, loadLoopConfig(root).runtimeDir).split(sep).join("/");
  const paths = [...new Set([...tracked.filter(p => !supportCache(p)), ...["src", "notes", "configs", "plans", ".pi", runtimeDirectory].flatMap(walk)])].sort();
  for (const path of paths) for (let directory = dirname(path); directory !== "."; directory = dirname(directory)) directories.add(directory);
  for (const directory of directories) {
    const destination = rewritten(directory);
    if (destination !== directory && existsSync(safe(destination))) throw new Error(`Migration directory collision: ${destination}`);
  }
  const profile = "configs/project-profile.md", profileBefore = existsSync(safe(profile)) ? readFileSync(safe(profile)) : undefined;
  const edits: Array<{ path: string; destination: string; before: Buffer; after: Buffer; occurrences: number }> = [];
  const destinations = new Set<string>();
  for (const path of paths) {
    if (path === profile) continue; // Generated output: regenerate, never text-patch.
    const absolute = safe(path), stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const before = readFileSync(absolute), text = before.toString("utf8"), destination = rewritten(path), occurrences = [...text.matchAll(oldId)].length;
    if (!occurrences && path === destination && path !== "project.json") continue;
    if (before.includes(0) || !Buffer.from(text).equals(before)) throw new Error(`Cannot migrate IDs in non-UTF8 file: ${path}`);
    const after = Buffer.from(path === "project.json" ? JSON.stringify(next, null, 2) + "\n" : rewritten(text));
    if (/lib_[0-9a-f]{16}_\d+/.test(destination) || /lib_[0-9a-f]{16}_\d+/.test(after.toString("utf8"))) throw new Error(`Old ID would remain: ${path}`);
    if (destinations.has(destination) || (destination !== path && existsSync(safe(destination)))) throw new Error(`Migration destination collision: ${destination}`);
    destinations.add(destination);
    edits.push({ path, destination, before, after, occurrences });
  }
  if (!edits.some(e => e.path === "project.json")) throw new Error("Migration did not find project.json");
  // Remove disposable build products only after a successful transactional edit.
  // The runtime parks/completions are migrated, not discarded.
  const invalidated = ["build/libraries", "build/preparation", "build/callGraph.json"].filter(p => existsSync(safe(p)));
  const report: MemberIdMigration = { mapping, changes: [...edits.map(({ path, destination, occurrences }) => ({ path, destination, occurrences })),
    ...(profileBefore ? [{ path: profile, destination: profile, occurrences: [...profileBefore.toString("utf8").matchAll(oldId)].length, regenerate: true }] : [])], invalidated, written: false };
  if (!write) return report;
  if (existsSync(safe(`${runtimeDirectory}/active.json`))) throw new Error("Stop the autoloop and remove its stale active.json lock before migrating IDs");
  const beforeResults = inRuntimeContext(contextForProject(root), () => libraryMemberResults(members, root));
  // Preflight ALL paths before touching anything, and roll back every completed
  // write/rename on failure. Originals and converted views are never changed.
  invalidated.forEach(safe);
  const done: typeof edits = [], removed: string[] = [];
  let profileTouched = false;
  try {
    for (const edit of edits) {
      if (!readFileSync(safe(edit.path)).equals(edit.before)) throw new Error(`Migration input changed: ${edit.path}`);
      mkdirSync(dirname(safe(edit.destination)), { recursive: true });
      if (edit.path !== edit.destination) renameSync(safe(edit.path), safe(edit.destination));
      done.push(edit); writeFileSync(safe(edit.destination), edit.after);
    }
    if (profileBefore) {
      if (!readFileSync(safe(profile)).equals(profileBefore)) throw new Error("Project profile changed during migration");
      profileTouched = true;
      inRuntimeContext(contextForProject(root), () => generateProjectProfile(["--write"], { quiet: true }));
      if (/lib_[0-9a-f]{16}_\d+/.test(readFileSync(safe(profile), "utf8"))) throw new Error("Regenerated profile retains an old member ID");
    }
    const afterResults = inRuntimeContext(contextForProject(root), () => libraryMemberResults(libraryMembers(root), root));
    report.results = members.map(member => {
      const after = mapping[member.id]!, verdict = beforeResults.get(member.id)!;
      if (afterResults.get(after) !== verdict) throw new Error(`Member result changed during rename: ${member.id} (${verdict} -> ${afterResults.get(after)})`);
      return { before: member.id, after, verdict };
    });
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      if (rewritten(directory) !== directory) {
        if (readdirSync(safe(directory)).length) throw new Error(`Old-ID directory is not empty after migration: ${directory}`);
        rmdirSync(safe(directory)); removed.push(directory);
      }
    }
  } catch (error) {
    if (profileTouched && profileBefore) writeFileSync(safe(profile), profileBefore);
    for (const directory of removed.reverse()) mkdirSync(safe(directory), { recursive: true });
    for (const edit of done.reverse()) {
      writeFileSync(safe(edit.destination), edit.before);
      if (edit.path !== edit.destination) { mkdirSync(dirname(safe(edit.path)), { recursive: true }); renameSync(safe(edit.destination), safe(edit.path)); }
    }
    for (const directory of [...directories].map(rewritten).filter(d => !directories.has(d)).sort((a, b) => b.length - a.length)) {
      if (existsSync(safe(directory)) && !readdirSync(safe(directory)).length) rmdirSync(safe(directory));
    }
    throw error;
  }
  for (const path of invalidated) rmSync(safe(path), { recursive: true, force: true });
  report.written = true;
  return report;
}
