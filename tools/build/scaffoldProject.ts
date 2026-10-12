/** Non-destructive project scaffolding. Implementation stays in Pi's installed
 * package; only project files and disposable dependency caches are authored. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FLAG_OVERRIDE_HEADER } from "../lib/flagOverrides.js";

export type BootstrapMode = "exe" | "library";
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const BEGIN = "# BEGIN PSX harness";
const END = "# END PSX harness";
export const IGNORE_BLOCK = `${BEGIN}
/build/
/extracted/
/library-input/
/include/psyq/
/run_output/
/node_modules/
/coverage/
/.pi/git/
/.pi/npm/
.env
.env.*
!.env.example
*.log
*.pid
*.tsbuildinfo
*.m2c
__pycache__/
*.pyc
src/**/*.c.*
${END}\n`;

interface PlannedFile {
  path: string;
  bytes: Buffer;
  mode: number;
  before: string | null;
}
export interface ScaffoldPlan {
  root: string;
  mode: BootstrapMode;
  directories: string[];
  files: PlannedFile[];
  preserved: string[];
  unchanged: number;
  conflicts: string[];
  requirements: string[];
}
export interface ScaffoldReport {
  root: string;
  mode: BootstrapMode;
  dryRun: boolean;
  created: string[];
  updated: string[];
  preserved: string[];
  unchanged: number;
  requirements: string[];
}

/** Inspect every parent, including broken symlinks; no traversal into another
 * repo, the package cache, or a user's symlinked input tree is permitted. */
function safeDestination(root: string, path: string): string {
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`Unsafe scaffold path: ${path}`);
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Scaffold refuses symlink: ${relative(root, cursor)}`);
    if (cursor !== absolute && stat && !stat.isDirectory()) throw new Error(`Scaffold parent is not a directory: ${relative(root, cursor)}`);
  }
  return absolute;
}
function currentBytes(root: string, path: string): Buffer | null {
  const absolute = safeDestination(root, path), stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Scaffold destination is not a file: ${path}`);
  return readFileSync(absolute);
}
function parseObject(bytes: Buffer, path: string): Record<string, any> {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

/** Only implementation/template roots are exported; never src/, configs from
 * a live target, lib/, extracted/, examples, settings or autonomous state. */
function snapshotEligible(path: string): boolean {
  const parts = path.split("/");
  if (parts.some(p => [".git", "node_modules", "__pycache__", ".pytest_cache", ".venv"].includes(p) || p.startsWith("build-gcc-"))) return false;
  if (path === "tools/vendor/psyq47" || path.startsWith("tools/vendor/psyq47/")) return false;
  if (path === ".pi/extensions/psx-bootstrap" || path.startsWith(".pi/extensions/psx-bootstrap/")) return false;
  if (path === ".pi/skills/psx-bootstrap-project" || path.startsWith(".pi/skills/psx-bootstrap-project/")) return false;
  if (path.endsWith(".test.ts") && !path.startsWith("tools/agent/resource-extraction/parsers/")) return false;
  return !/\.(pyc|log|tsbuildinfo)$/.test(path);
}
function sourceFiles(root: string, path: string): string[] {
  if (!snapshotEligible(path)) return [];
  const absolute = join(root, path), stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) throw new Error(`Package scaffold source is a symlink: ${path}`);
  if (stat.isDirectory()) return readdirSync(absolute).sort().flatMap(name => sourceFiles(root, path ? `${path}/${name}` : name));
  return stat.isFile() ? [path] : [];
}

export function supplyInstructions(mode: BootstrapMode): string[] {
  return [
    mode === "exe"
      ? "Put your legally obtained, extracted game/disc tree in extracted/ (including the PS-X EXE and any archives/overlays). Retain original names; do not put a disc image there and assume it has been unpacked."
      : "Put authoritative ELF32 little-endian MIPS ET_REL archives in library-input/ (*.a). project.json initially selects library-input/**/*.a only; select standalone .o files explicitly instead if appropriate. Every configured glob must match.",
    "Supply SDK originals, headers and notices under library-input/psyq/ (LIB/ and INCLUDE/). The configured 470 release is a candidate, not measured identity. Existing explicitly configured SDK paths are preserved; no proprietary SDK is downloaded.",
    "lib/ is project-owned and trackable: it may contain authoritative library reconstruction targets or SDK extraction/conversion results. Compiled candidates and disposable traces belong in build/, never over authoritative inputs.",
    "Original PSY-Q LIB/LNK inputs require a supplied converter (toolchain.json.tools.psyq2elf). Select supported ELF/ar or converted member targets explicitly in project.json; converted-object identity is not original-LNK identity.",
    "The installed package supplies its own JavaScript dependencies. Configure external cross-binutils, Python, splat/spimdisasm and any custom compiler executable; missing supported pinned tooling is prepared in build/dependencies/, not in tools/.",
    "Diagnostic support is separate from compilation. Legacy default capabilities remain compatible; when configuring another toolchain, select compiler.analysis.provider/profile and explicitly run tools/agent/analysisSupport.ts bootstrap through the installed scriptHost. No compiler-version branch, automatic pass-model grant or replacement production compiler is implied; see docs/toolchain.md.",
    "Bootstrap prepares pinned public support sources automatically. Network/Git are needed only for absent support assets; original inputs and lib/ contents are never deleted. build/ contains disposable outputs, except append-only experiment history, which cleanup preserves.",
    "Run /reload in Pi, then /skill:psx-identify-project after supplying inputs. Configure target paths/layout, SDK and compiler choices from evidence before splitting or matching. No EXE addresses, section boundaries, SDK identity or byte verification were inferred by bootstrap.",
    "For an EXE, identification must create configs/splat/exe.yaml using the measured header. For a library, review project.json input/header roles before psx_split_project. Verification regenerates the project profile only after successful byte identity.",
  ];
}

export function planScaffold(root: string, mode: BootstrapMode = "exe", packageRoot = PACKAGE_ROOT): ScaffoldPlan {
  if (mode !== "exe" && mode !== "library") throw new Error(`Unsupported bootstrap mode: ${mode}`);
  root = resolve(root); packageRoot = resolve(packageRoot);
  if (existsSync(root)) root = realpathSync(root);
  else {
    // Reject symlinked parents before creating a new root.
    let parent = dirname(root);
    while (!existsSync(parent)) parent = dirname(parent);
    if (realpathSync(parent) !== parent) throw new Error("Bootstrap root has a symlinked parent");
  }
  const projectBytes = currentBytes(root, "project.json");
  if (projectBytes) {
    const project = parseObject(projectBytes, "project.json");
    const kind = project.target?.kind;
    if (kind !== "linked-image" && kind !== "relocatable-library") throw new Error("Existing project.json has no supported target kind; refusing to replace it");
    if ((kind === "relocatable-library") !== (mode === "library")) throw new Error("Bootstrap mode conflicts with project.json; mode changes require an explicit configuration review");
  }
  const plan: ScaffoldPlan = { root, mode, directories: ["include", "include/library", "extracted", "library-input", "library-input/psyq/LIB", "library-input/psyq/INCLUDE", "lib", "src", "configs/splat", "configs/symbols", "notes", "build", ".pi", "tools/resource-parsers"], files: [], preserved: [], unchanged: 0, conflicts: [], requirements: supplyInstructions(mode) };
  if (mode === "library") plan.directories.push("src/libraries");
  for (const path of plan.directories) {
    const stat = lstatSync(safeDestination(root, path), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`Scaffold destination is not a directory: ${path}`);
  }
  const add = (path: string, content: string | Buffer, preserve = false, fileMode = 0o644) => {
    const bytes = Buffer.from(content), before = currentBytes(root, path);
    if (before?.equals(bytes)) { plan.unchanged++; return; }
    if (before && preserve) { plan.preserved.push(path); return; }
    if (before) { plan.conflicts.push(path); return; }
    plan.files.push({ path, bytes, before: null, mode: fileMode });
  };
  const update = (path: string, bytes: Buffer, before: Buffer | null) => {
    if (before?.equals(bytes)) { plan.unchanged++; return; }
    plan.files.push({ path, bytes, before: before ? sha256(before) : null,
      mode: before ? lstatSync(safeDestination(root, path)).mode & 0o777 : 0o644 });
  };
  // Fixed templates, not configuration/header files from the package's worktree.
  for (const path of sourceFiles(packageRoot, "templates/project")) {
    const destination = path.slice("templates/project/".length);
    if (destination.startsWith("tools/") || destination.startsWith(".pi/extensions/")) continue;
    add(destination, readFileSync(join(packageRoot, path)), true);
  }
  for (const required of ["toolchain.json", ".pi/autoloop.json", "configs/project-info.json", "include/common.h"])
    if (!existsSync(join(packageRoot, "templates/project", required))) throw new Error(`Package bootstrap template missing: ${required}`);
  add("configs/flag_overrides.mk", FLAG_OVERRIDE_HEADER, true);
  add("tools/resource-parsers/parser-plugins.ts", "/* Project-authored resource parsers. Built-in parsers stay in the installed package. */\nexport const EXTRA_PARSERS = [];\n", true);
  for (const path of ["include/include_asm.h", "include/macro.inc", "include/labels.inc", "include/gte_macros.inc", "include/debughook.h", "include/scratchpad.h"])
    add(path, readFileSync(join(packageRoot, path)), true);
  add("project.json", json(mode === "exe"
    ? { schemaVersion: 1, target: { kind: "linked-image" } }
    : { schemaVersion: 1,
        target: { kind: "relocatable-library", format: "elf-ar", archives: ["library-input/**/*.a"], standaloneObjects: [] },
        headers: { reference: ["library-input/psyq/INCLUDE"], owned: ["include/library"], context: ["common.h"] },
        selection: { scope: "all-code-members" }, verification: { mode: "relocatable-object" },
        output: { sourceDir: "src/libraries", sourceLayout: "tu-directory" }, memberProfiles: {} }), true);
  add("README.psx.md", `# PSX project setup (${mode})\n\nImplementation is supplied by the Pi-installed PSX package, not copied into this repository. No target identification or verification is claimed.\n\n${plan.requirements.map((s, i) => `${i + 1}. ${s}`).join("\n\n")}\n\nBootstrap never clears inputs or overwrites existing project configuration.\n`, true);

  const ignoreBefore = currentBytes(root, ".gitignore"), ignore = ignoreBefore?.toString("utf8") ?? "";
  const begins = ignore.split(BEGIN).length - 1, ends = ignore.split(END).length - 1;
  if (begins !== ends || begins > 1 || (begins && ignore.indexOf(END) < ignore.indexOf(BEGIN))) throw new Error("Malformed PSX .gitignore block; fix it before bootstrapping");
  const ignoreNext = begins
    ? ignore.slice(0, ignore.indexOf(BEGIN)) + IGNORE_BLOCK.trimEnd() + ignore.slice(ignore.indexOf(END) + END.length)
    : ignore + (ignore && !ignore.endsWith("\n") ? "\n" : "") + (ignore ? "\n" : "") + IGNORE_BLOCK;
  update(".gitignore", Buffer.from(ignoreNext), ignoreBefore);

  // Pi owns installation/settings. Existing npm tasks and dependencies remain
  // untouched; consumers do not duplicate the package's runtime or test pins.
  return plan;
}

export interface VendorSource { name: string; url: string; revision: string; required: string[] }
export function vendorSources(packageRoot = PACKAGE_ROOT): VendorSource[] {
  const value = parseObject(readFileSync(join(packageRoot, "templates/vendor-sources.json")), "vendor sources");
  if (value.schemaVersion !== 1 || !Array.isArray(value.sources)) throw new Error("Invalid vendor source manifest");
  const seen = new Set<string>();
  for (const spec of value.sources) {
    if (!/^[a-z0-9_-]+$/.test(spec.name) || seen.has(spec.name) || !/^https:\/\/github\.com\/[\w-]+\/[\w-]+\.git$/.test(spec.url) ||
        !/^[a-f0-9]{40}$/.test(spec.revision) || !Array.isArray(spec.required) || !spec.required.length ||
        spec.required.some((p: unknown) => typeof p !== "string" || !p || p.startsWith("/") || p.split(/[\\/]/).includes(".."))) throw new Error("Invalid vendor source pin");
    seen.add(spec.name);
  }
  return value.sources;
}
const exec = promisify(execFile);
async function downloadVendor(spec: VendorSource, destination: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(destination, { recursive: true });
  const git = (args: string[]) => exec("git", args, { cwd: destination, signal, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  // Only temporary Git metadata. Fetch the exact commit, not a moving branch.
  await git(["init", "--quiet"]);
  await git(["fetch", "--quiet", "--depth", "1", spec.url, spec.revision]);
  await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (head !== spec.revision) throw new Error(`Wrong downloaded revision for ${spec.name}: ${head}`);
}
/** Extend the preflight in memory with downloaded, pinned source snapshots.
 * No project/package writes until ALL downloads and collision checks succeed.
 * A dry run never downloads. Dependency acquisition is explicit bootstrap work,
 * not an npm lifecycle hook or extension-load side effect. */
export async function provisionScaffoldVendors(plan: ScaffoldPlan, options: {
  packageRoot?: string; dryRun?: boolean; signal?: AbortSignal;
  download?: (spec: VendorSource, destination: string, signal?: AbortSignal) => Promise<void>;
} = {}): Promise<string[]> {
  if (plan.conflicts.length) throw new Error(`Bootstrap preflight conflicts: ${plan.conflicts.slice(0, 20).join(", ")}`);
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const specs = vendorSources(packageRoot);
  const missing = specs.filter(spec => !spec.required.every(path =>
    existsSync(join(plan.root, "build/dependencies", spec.name, spec.revision, path))) ||
    (spec.name === "m2c" && existsSync(join(packageRoot, "tools/vendor/m2c-patches/upstream-gitignore.txt")) &&
      !existsSync(join(plan.root, "build/dependencies", spec.name, spec.revision, ".gitignore"))));
  if (options.dryRun) {
    if (missing.length) plan.requirements.unshift(`Dry run: pinned public support sources would be prepared in build/dependencies/: ${missing.map(s => s.name).join(", ")}.`);
    return missing.map(s => s.name);
  }
  const scratch = mkdtempSync(join(tmpdir(), "psx-bootstrap-vendors-"));
  const downloaded: string[] = [];
  try {
    for (const spec of missing) {
      options.signal?.throwIfAborted();
      const bundled = join(packageRoot, "tools/vendor", spec.name);
      let source = bundled;
      if (!spec.required.every(path => existsSync(join(bundled, path)))) {
        source = join(scratch, spec.name);
        try { await (options.download ?? downloadVendor)(spec, source, options.signal); }
        catch (error) { throw new Error(`Could not obtain pinned tooling source ${spec.name} (${spec.revision}); no scaffold written. Check Git/network access and re-run bootstrap. ${String(error)}`); }
        downloaded.push(spec.name);
      }
      if (!spec.required.every(path => existsSync(join(source, path)))) throw new Error(`Incomplete pinned support source: ${spec.name}`);
      const exported = new Map(sourceFiles(source, "").map(path => [path, readFileSync(join(source, path))]));
      // npm omits .gitignore even when explicitly listed. Retain the public
      // metadata byte-for-byte so the pinned upstream snapshot still verifies.
      const metadata = join(packageRoot, "tools/vendor/m2c-patches/upstream-gitignore.txt");
      if (spec.name === "m2c" && !exported.has(".gitignore") && existsSync(metadata)) exported.set(".gitignore", readFileSync(metadata));
      for (const [path, bytes] of exported) {
        const destination = join("build/dependencies", spec.name, spec.revision, path);
        const before = currentBytes(plan.root, destination);
        if (before?.equals(bytes)) plan.unchanged++;
        else if (before) plan.conflicts.push(destination);
        else plan.files.push({ path: destination, bytes, before: null, mode: existsSync(join(source, path)) ? lstatSync(join(source, path)).mode & 0o777 : 0o644 });
      }
    }
    return downloaded;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** The extension supplies Pi's per-file mutation queue. Revalidate the preflight
 * fingerprints inside it so concurrent edits are never silently overwritten. */
export async function applyScaffold(plan: ScaffoldPlan, dryRun = false,
  mutate: (path: string, action: () => void) => Promise<void> = async (_path, action) => { action(); }): Promise<ScaffoldReport> {
  if (plan.conflicts.length) throw new Error(`Bootstrap conflicts; no files written:\n${plan.conflicts.slice(0, 20).join("\n")}\nExisting implementation files/tasks differ. Use a clean directory or review/migrate them explicitly; no force overwrite is supported.`);
  const report: ScaffoldReport = { root: plan.root, mode: plan.mode, dryRun, created: [], updated: [], preserved: plan.preserved, unchanged: plan.unchanged, requirements: plan.requirements };
  // Check the complete plan again before the first write.
  const check = (file: PlannedFile) => {
    const now = currentBytes(plan.root, file.path);
    if ((now ? sha256(now) : null) !== file.before) throw new Error(`Scaffold input changed after preflight: ${file.path}`);
  };
  plan.files.forEach(check);
  if (!dryRun) for (const path of plan.directories) mkdirSync(safeDestination(plan.root, path), { recursive: true });
  for (const file of plan.files) {
    if (!dryRun) await mutate(safeDestination(plan.root, file.path), () => {
      check(file);
      const destination = safeDestination(plan.root, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes, file.before === null ? { flag: "wx" } : {});
      chmodSync(destination, file.mode);
    });
    (file.before === null ? report.created : report.updated).push(file.path);
  }
  return report;
}
export function formatScaffoldReport(report: ScaffoldReport): string {
  return `${report.dryRun ? "Would scaffold" : "Scaffolded"} ${report.mode} project at ${report.root}.\n${report.created.length} new files; ${report.updated.length} merged files; ${report.unchanged} unchanged; ${report.preserved.length} existing project files preserved.\n` +
    (report.preserved.length ? `Preserved: ${report.preserved.slice(0, 20).join(", ")}${report.preserved.length > 20 ? ", …" : ""}. Review them against the new scaffold.\n` : "") +
    `\nWhat you need to supply / do next:\n${report.requirements.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nNo assets, compiler binaries, detected target facts or verification claim were created. Inputs and existing lib/ contents were not deleted. See README.psx.md.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help")) { console.log("scaffoldProject.ts [--mode exe|library] [--root DIRECTORY] [--write] [--json]\nDefault: exe, current directory, dry run. Applying fetches missing pinned public tooling sources. No asset downloads/deletion or force overwrites."); return; }
    let mode: BootstrapMode = "exe", root = process.cwd();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--mode" || arg === "--root") {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
        if (arg === "--root") root = value;
        else if (value === "exe" || value === "library") mode = value;
        else throw new Error(`Unsupported bootstrap mode: ${value}`);
      } else if (arg !== "--write" && arg !== "--json") throw new Error(`Unknown bootstrap argument: ${arg}`);
    }
    const dryRun = !args.includes("--write"), plan = planScaffold(root, mode);
    await provisionScaffoldVendors(plan, { dryRun });
    const report = await applyScaffold(plan, dryRun);
    console.log(args.includes("--json") ? json(report) : formatScaffoldReport(report));
  }
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
