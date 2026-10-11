import { projectRoot, HARNESS_ROOT, contextForProject } from "../lib/runtimeContext.js";
import { installedScriptArgs } from "../lib/installedScripts.js";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredTool, loadToolchain } from "../lib/toolchain.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
export function m2cPatchIdentity(root: string): { upstream: string; sha256: string; inputs: string[] } {
  const manifest = join(HARNESS_ROOT, "tools/vendor/m2c-patches/manifest.json");
  const spec = JSON.parse(readFileSync(manifest, "utf8")) as { version: number; upstream: string; patches: string[] };
  if (spec.version !== 1 || !/^[a-f0-9]{40}$/.test(spec.upstream) || spec.patches.some((p) => !/^[\w.-]+\.patch$/.test(p))) throw new Error("Invalid m2c patch manifest");
  const inputs = [manifest, join(dirname(manifest), "upstream-files.json"), ...spec.patches.map((p) => join(dirname(manifest), p))];
  return { upstream: spec.upstream, sha256: hash(JSON.stringify(inputs.map((p) => [relative(HARNESS_ROOT, p), hash(readFileSync(p))]))), inputs };
}
/** Materialize a pinned, patched vendor tree without mutating the submodule.
 * Only source patches are tracked; archives, generated code and caches stay in build/. */
export function prepareM2c(root: string): { script: string; identity: ReturnType<typeof m2cPatchIdentity>; sources: string[] } {
  const script = configuredTool("m2c", root);
  const owner = loadToolchain(root).tools.m2c;
  if (!existsSync(script) && typeof owner === "object" && owner.origin === "runtime" && owner.path.startsWith("dependencies/m2c/")) {
    execFileSync(process.execPath, installedScriptArgs("tools/build/prepareDependencies.ts", [], root), { cwd: root, stdio: "inherit" });
  }
  const vendor = dirname(script);
  const runtime = contextForProject(root).runtimeRoot;
  const standard = script === join(root, "tools/vendor/m2c/m2c.py") || script.startsWith(join(runtime, "dependencies/m2c") + "/");
  if (!standard) {
    if (!existsSync(script)) throw new Error(`Configured m2c missing: ${script}`);
    const sources = files(dirname(script)).filter(p => /\.(py|h)$/.test(p) && !p.includes("/.git/"));
    return { script, sources, identity: { upstream: "explicit-external-config", inputs: sources, sha256: hash(JSON.stringify(sources.map(p => [relative(dirname(script), p), hash(readFileSync(p))]))) } };
  }
  const identity = m2cPatchIdentity(root);
  if (!existsSync(join(vendor, "m2c.py"))) throw new Error("Pinned m2c sources missing. A degit export may omit submodules; use a recursive clone or provision the pinned vendor sources (docs/toolchain.md).");
  const pin = JSON.parse(readFileSync(join(HARNESS_ROOT, "tools/vendor/m2c-patches/upstream-files.json"), "utf8"));
  const sourceFiles = files(vendor).filter(p => !p.includes("/.git/") && relative(vendor, p) !== ".git" && !p.includes("/__pycache__/") && !p.endsWith(".pyc"));
  const sourceHash = hash(JSON.stringify(sourceFiles.map(p => [relative(vendor, p), hash(readFileSync(p))]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0)));
  if (pin.upstream !== identity.upstream || pin.files !== sourceFiles.length || pin.sha256 !== sourceHash) throw new Error("m2c upstream differs from the pinned source snapshot");
  if (existsSync(join(vendor, ".git"))) {
    const head = execFileSync("git", ["-C", vendor, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 }).trim();
    const dirty = execFileSync("git", ["-C", vendor, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 10000 }).trim();
    if (head !== identity.upstream || dirty) throw new Error("m2c upstream differs from the pinned clean vendor revision");
  }
  const dir = join(runtime, "dependencies/patched-m2c", identity.sha256);
  const stamp = join(dir, "patched-source.json");
  const inspect = () => {
    const hashes = JSON.parse(readFileSync(stamp, "utf8")) as Record<string, string>;
    for (const [path, expected] of Object.entries(hashes)) if (!existsSync(join(dir, path)) || hash(readFileSync(join(dir, path))) !== expected) throw new Error(`Edited m2c build source: ${join(dir, path)}`);
    return { script: join(dir, "m2c.py"), identity, sources: Object.keys(hashes).map((p) => join(dir, p)) };
  };
  if (existsSync(stamp)) return inspect();
  if (existsSync(dir)) throw new Error(`Incomplete m2c build preserved: ${dir}`);
  const temp = `${dir}.tmp-${randomUUID()}`;
  mkdirSync(temp, { recursive: true });
  try {
    // Copy only verified source bytes; a faithful export needs no Git metadata.
    for (const path of sourceFiles) {
      const destination = join(temp, relative(vendor, path));
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(path));
    }
    for (const patch of identity.inputs.filter(p => p.endsWith(".patch"))) execFileSync("patch", ["--batch", "--fuzz=0", "-p1", "-d", temp, "-i", patch], { timeout: 10000 });
    const hashes = Object.fromEntries(files(temp).filter((p) => p.endsWith(".py") || p.endsWith(".h")).map((p) => [relative(temp, p), hash(readFileSync(p))]));
    writeFileSync(join(temp, "patched-source.json"), JSON.stringify(hashes, null, 2) + "\n");
    mkdirSync(dirname(dir), { recursive: true });
    try { renameSync(temp, dir); } catch (error) { if (!existsSync(stamp)) throw error; rmSync(temp, { recursive: true, force: true }); }
    return inspect();
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(prepareM2c(projectRoot()).script); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
