import { projectRoot, harnessRoot } from "../lib/runtimeContext.js";
import { currentScriptArgs } from "../lib/installedScripts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { splitSdkLibs } from "./splitSdkLibs.js";
import { runRodataDerivation } from "./deriveRodataSplits.js";
import { generateProjectProfile } from "./genProjectProfile.js";
import { cleanRuntime } from "../lib/runtimeCleanup.js";

interface BuildInvocation { built: Set<string>; sdk: boolean; identity?: string; exporting: boolean; exported: boolean }
const builds = new AsyncLocalStorage<BuildInvocation>();
function invocation<T>(operation: () => T): T {
  return builds.getStore() ? operation() : withContentMemo(() => builds.run({ built: new Set(), sdk: false, exporting: false, exported: false }, operation));
}
function state(): BuildInvocation { const current = builds.getStore(); if (!current) throw new Error("Build invocation missing"); return current; }
/** npm task implementation. Existing split/analysis tools remain the owners of
 * their derivations; this module replaces Make's dependency/orchestration rules. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Container, loadContainers, requireContainer, unresolvedCodeMembers } from "../lib/container.js";
import { configuredFlags, configuredFileFlags, configuredSdk, configuredTool, loadToolchain } from "../lib/toolchain.js";
import { withContentMemo, digest, fileDigest, filesUnder, readCache, snapshot, writeCache, writeIfChanged } from "../lib/contentCache.js";
import { dependencyPaths } from "../agent/preprocessedCache.js";
import { buildInputIdentity, refreshBuildInputs } from "./buildInputs.js";
import { loadLibraryProject } from "../lib/project.js";
import { runLibraryTask } from "../agent/libraryTarget.js";

function command(tool: string, args: string[], root = projectRoot(), capture = false, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(tool, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${tool}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${tool} exited ${result.status}${capture ? `\n${result.stderr ?? ""}\n${result.stdout ?? ""}` : ""}`);
  return result.stdout ?? "";
}
function script(path: string, args: string[] = [], capture = false): string {
  return command(process.execPath, currentScriptArgs(`tools/${path}.ts`, args), projectRoot(), capture);
}
function splat(container: Container): void {
  const support = join(projectRoot(), "build/runtime-splat.yaml");
  writeIfChanged(support, `options:\n  extensions_path: ${JSON.stringify(join(harnessRoot(), "tools/vendor/splat_ext"))}\n`);
  command(configuredTool("splat"), ["split", container.paths.splat, support], projectRoot(), false, { ...process.env, SPIMDISASM_ARCHLEVEL: "1" });
}
function appendLinkIncludes(container: Container): void {
  const ld = join(projectRoot(), container.paths.ldScript);
  let content = readFileSync(ld, "utf8");
  if (container.kind === "overlay") {
    const includes = readFileSync(join(projectRoot(), `build/${container.id}/ld_includes.txt`), "utf8");
    for (const line of includes.split("\n").filter(Boolean)) if (!content.includes(line)) content += `\n${line}\n`;
  } else {
    for (const path of [container.paths.undefinedFuncs, container.paths.undefinedSyms, "build/dep_syms.txt", "build/lib_bss_syms.txt"]) {
      if (!existsSync(join(projectRoot(), path))) continue;
      const line = `INCLUDE "${path}"`;
      if (!content.includes(line)) content += `\n${line}\n`;
    }
  }
  writeIfChanged(ld, content);
}
export function splitSdk(): void {
  invocation(() => {
    if (state().sdk) return;
    const config = loadToolchain(), sdk = configuredSdk();
    const map = splitSdkLibs({ root: projectRoot(), sdkDir: sdk.originalDir, convertedDir: sdk.convertedDir, signatures: sdk.signatures, version: sdk.version, write: true,
      ...(config.tools.psyq2elf ? { converter: configuredTool("psyq2elf") } : {}) });
    console.log(`Wrote SDK ${map.version}: ${map.members.length} members, ${new Set(map.members.filter(m => m.collision).map(m => m.oPath)).size} collision-safe objects, ${map.signatures.length} signature mappings`);
    state().sdk = true;
  });
}
export function splitContainer(container: Container): void {
  if (container.kind === "overlay") {
    refreshEngineExports(true);
    script("build/bootstrapOverlay", ["--container", container.id, "--write"]);
    splat(container);
    appendLinkIncludes(container);
    return;
  }
  splitSdk();
  for (const name of ["bootstrap", "mergeFragments", "addLibSymbols"]) script(`build/${name}`, ["--write"]);
  script("build/disassemble", ["--container", "exe"]);
  for (const name of ["patchSplatForLibs", "addDepObjects"]) script(`build/${name}`, ["--write"]);
  splat(container);
  for (let i = 0; i < 3; i++) {
    const output = script("build/fixCrossFileRefs", ["--write"], true);
    process.stdout.write(output);
    if (output.includes("No cross-file")) break;
    splat(container);
  }
  script("build/mergeFragments", ["--write"]);
  splat(container);
  for (const name of ["patchLinkerBss", "patchLibBss"]) script(`build/${name}`, ["--write"]);
  appendLinkIncludes(container);
  script("build/classifyGlobals", ["--write"]);
  script("agent/contextExport", ["--all"]);
  script("build/genProjectProfile", ["--write"]);
}

/** Only configured overlay C subsegments. Retired sources stay reviewable but
 * must not be compiled accidentally on a cold tree. EXE retains its flat src/. */
export function selectedCSources(container: Container, root = projectRoot()): string[] {
  const dir = join(root, container.paths.srcDir);
  if (container.kind === "exe") return filesUnder(dir).filter(p => dirname(p) === dir && p.endsWith(".c"));
  const yaml = readFileSync(join(root, container.paths.splat), "utf8");
  return [...new Set([...yaml.matchAll(/^\s*-\s*\[\s*(?:0x[\da-fA-F]+|\d+)\s*,\s*c\s*,\s*([^\],]+)\s*\]/gm)]
    .map(m => join(dir, m[1]!.trim().replace(/^['"]|['"]$/g, "") + ".c")))];
}
function assemblyIncludes(root: string): string[] {
  return loadToolchain(root).includeDirs.flatMap(dir => filesUnder(resolve(root, dir)).filter(p => p.endsWith(".inc")));
}
interface BuiltArtifact { outputHash: string }
function artifactCurrent(path: string, key: string): boolean {
  const record = readCache<BuiltArtifact>(`${path}.inputs.json`, key);
  return !!record && record.outputHash === fileDigest(path) && existsSync(path);
}
function publishArtifact(path: string, key: string): void { writeCache(`${path}.inputs.json`, key, { outputHash: fileDigest(path) }); }

export function compileObject(container: Container, source: string, root = projectRoot(), identity = buildInputIdentity(root)): string {
  source = resolve(root, source);
  const stem = basename(source, ".c");
  const output = join(root, container.paths.objDir, `${stem}.c.o`), deps = `${output}.d`;
  const preprocessed = join(dirname(output), `${stem}.i`), assembly = join(dirname(output), `${stem}.s`);
  const flags = configuredFlags("cc1", container, root).concat(configuredFileFlags(stem, root));
  const inc = assemblyIncludes(root);
  const stubs = filesUnder(join(root, container.paths.asmDir, "nonmatchings", stem)).filter(p => p.endsWith(".s"));
  const inputKey = (dependencies: string[]) => digest(JSON.stringify({ identity, flags, inputs: snapshot(root, [source, ...dependencies, ...inc, ...stubs]) }));
  if (existsSync(deps)) {
    const dependencies = dependencyPaths(readFileSync(deps, "utf8"), root);
    if (artifactCurrent(output, inputKey(dependencies))) return output;
  }
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  command(configuredTool("cpp", root), [...configuredFlags("cpp", container, root), "-MD", "-MP", "-MF", deps, "-MT", output, source, "-o", preprocessed], root);
  const dependencies = dependencyPaths(readFileSync(deps, "utf8"), root);
  const before = inputKey(dependencies);
  command(configuredTool("cc1", root), [...flags, preprocessed, "-o", assembly], root);
  command(configuredTool("python", root), [configuredTool("maspsx", root), ...configuredFlags("maspsx", container, root),
    "--gnu-as-path", configuredTool("as", root), "-o", output, ...configuredFlags("as", container, root), assembly], root);
  if (before !== inputKey(dependencies)) { rmSync(output, { force: true }); throw new Error(`Inputs changed while compiling ${source}`); }
  publishArtifact(output, before);
  return output;
}
function assembleObject(container: Container, source: string, root: string, identity: string): string {
  const output = `${source}.o`;
  const key = digest(JSON.stringify({ identity, flags: configuredFlags("as", container, root), inputs: snapshot(root, [source, ...assemblyIncludes(root)]) }));
  if (artifactCurrent(output, key)) return output;
  rmSync(output, { force: true });
  command(configuredTool("as", root), [...configuredFlags("as", container, root), source, "-o", output], root);
  publishArtifact(output, key);
  return output;
}
function refreshEngineExports(allowUnlinked = false): void {
  invocation(() => {
    const current = state();
    if (current.exporting || current.exported) return;
    current.exporting = true;
    try {
      const exe = requireContainer("exe"), elf = join(projectRoot(), exe.paths.builtElf);
      try { buildContainer(exe); }
      catch (error) {
        rmSync(elf, { force: true });
        rmSync(join(projectRoot(), "build/engine_syms.txt"), { force: true });
        if (!allowUnlinked) throw error;
        console.warn(`note: executable does not link yet; fresh engine exports use configured symbol tables: ${String(error)}`);
      }
      const output = join(projectRoot(), "build/engine_syms.txt");
      const key = digest(JSON.stringify({ elf: fileDigest(elf), fallback: existsSync(elf) ? undefined : snapshot(projectRoot(), [exe.paths.symbolAddrs, exe.paths.undefinedFuncs, exe.paths.undefinedSyms]) }));
      if (!artifactCurrent(output, key)) { script("build/exportEngineSymbols", ["--write"]); publishArtifact(output, key); }
      current.exported = true;
    } finally { current.exporting = false; }
  });
}
function linkerInputs(root: string, container: Container): string[] {
  // INCLUDEs and SDK/engine inputs are generated alongside the linker script.
  // Hash linker scripts, absolute symbol tables and converted SDK objects too.
  return [container.paths.ldScript, container.paths.undefinedFuncs, container.paths.undefinedSyms, "build/engine_syms.txt",
    "build/dep_syms.txt", "build/lib_bss_syms.txt", `build/${container.id}/ld_includes.txt`,
    ...filesUnder(join(root, "build")).filter(p => p.endsWith(".ld") || p.endsWith(".txt")),
    configuredSdk(root).convertedDir, "build/sdk"];
}
export function buildContainer(container: Container, retry = false): void {
  return invocation(() => buildContainerInInvocation(container, retry));
}
function buildContainerInInvocation(container: Container, retry: boolean): void {
  if (state().built.has(container.id)) return;
  if (container.kind === "exe") splitSdk();
  else refreshEngineExports();
  if (!existsSync(join(projectRoot(), container.paths.ldScript))) throw new Error(`Missing ${container.paths.ldScript}; run npm run split -- --container ${container.id}`);
  if (!state().identity) {
    refreshBuildInputs(projectRoot());
    state().identity = readFileSync(join(projectRoot(), "build/toolchain-inputs.stamp"), "utf8").trim();
  }
  const identity = state().identity!;
  const objects = selectedCSources(container).map(source => compileObject(container, source, projectRoot(), identity));
  for (const source of filesUnder(join(projectRoot(), container.paths.asmDir)).filter(p => p.endsWith(".s") && !p.includes("/nonmatchings/"))) {
    objects.push(assembleObject(container, source, projectRoot(), identity));
  }
  const elf = join(projectRoot(), container.paths.builtElf), bin = join(projectRoot(), container.paths.builtBin);
  const key = digest(JSON.stringify({ identity, flags: configuredFlags("ld", container), objects, inputs: snapshot(projectRoot(), [...objects, ...linkerInputs(projectRoot(), container)]) }));
  const linkNeeded = !artifactCurrent(elf, key);
  try { if (linkNeeded) runRodataDerivation(["--container", container.id]); }
  catch (error) {
    if (retry) throw new Error(`Rodata attribution still inconsistent after rederivation: ${String(error)}`);
    console.log(`${container.id}: rederiving rodata attribution and rebuilding once`);
    runRodataDerivation(["--container", container.id, "--write"]);
    splitContainer(container);
    buildContainer(container, true);
    return;
  }
  if (container.kind === "overlay" && linkNeeded) script("build/exportEngineSymbols", ["--check"]);
  if (linkNeeded) {
    rmSync(elf, { force: true });
    command(configuredTool("ld"), [...configuredFlags("ld", container), "-T", container.paths.ldScript, "-Map", elf.replace(/\.elf$/, ".map"), "-o", elf]);
    publishArtifact(elf, key);
  }
  const binaryKey = digest(JSON.stringify({ identity, elf: fileDigest(elf) }));
  if (!artifactCurrent(bin, binaryKey)) {
    rmSync(bin, { force: true });
    command(configuredTool("objcopy"), ["-O", "binary", elf, bin]);
    publishArtifact(bin, binaryKey);
  }
  state().built.add(container.id);
}
/** Verify the entire payload, never a truncated slice or just function scores.
 * EXE headers are excluded; raw overlays are compared in their entirety. */
export function verifyContainer(container: Container, root = projectRoot()): void {
  const original = readFileSync(resolve(root, container.targetPath)), built = readFileSync(join(root, container.paths.builtBin));
  let a = original, b = built;
  if (container.kind === "exe") {
    const end = container.payloadOffset + container.payloadSize;
    if (original.length < end || built.length < end) throw new Error(`${container.id}: original or built payload is truncated`);
    a = original.subarray(container.payloadOffset, end); b = built.subarray(container.payloadOffset, end);
  }
  const dir = dirname(join(root, container.paths.builtBin));
  writeFileSync(join(dir, "original.sha256"), digest(a) + "\n");
  writeFileSync(join(dir, "built.sha256"), digest(b) + "\n");
  if (!a.equals(b)) throw new Error(`MISMATCH: ${container.id} does not match the original ${container.kind === "exe" ? "payload" : "member"}`);
  console.log(`OK: ${container.id} matches original bytes`);
}
/** The verification phase is separate from required build-time rodata work.
 * Keeping this sequence explicit makes success/failure side effects testable. */
export function verifyBuiltContainers(containers: Container[], all: boolean, root = projectRoot(), actions = {
  verify: verifyContainer,
  profile: () => generateProjectProfile(["--write"]),
  rodata: runRodataDerivation,
}): void {
  for (const container of containers) {
    if (!existsSync(join(root, container.paths.builtElf))) throw new Error(`${container.id}: no successful final link to verify`);
    actions.verify(container, root);
    if (container.kind === "exe") actions.profile();
    if (!all) actions.rodata(["--container", container.id]);
  }
  if (all) actions.rodata(["--all"]);
}
function selection(args: string[], all = false): Container[] {
  const index = args.indexOf("--container");
  if (index >= 0 && !args[index + 1]) throw new Error("--container needs an id");
  if (index >= 0 && (all || args.includes("--all"))) throw new Error("Choose --container or --all, not both");
  return all || args.includes("--all") ? loadContainers() : [requireContainer(index >= 0 ? args[index + 1]! : "exe")];
}
export function runTask(task: string, args: string[]): void {
  return invocation(() => runTaskInInvocation(task, args));
}
function runTaskInInvocation(task: string, args: string[]): void {
  if (args.includes("--help")) {
    console.log(loadLibraryProject() ? `npm run ${task} -- [--all]\nLibrary targets: project.json; toolchain: toolchain.json. npm run library -- --help for member tools.` :
      `npm run ${task} -- [--container ID | --all]\nTool paths, flags, SDK and profiles: toolchain.json. No Makefile is used.\nDisassemble: --archives opts into the paired-index archive discovery adapter.`);
    return;
  }
  if (loadLibraryProject() && !["setup", "clean", "wipe"].includes(task)) {
    if (args.some(a => a !== "--all")) throw new Error("Library npm tasks accept --all only; use npm run library -- check --member ID for a scoped check");
    runLibraryTask(task, []); return;
  }
  const allowed = ["--container", "--all", ...(task === "disassemble" ? ["--archives"] : [])];
  for (let i = 0; i < args.length; i++) {
    if (!allowed.includes(args[i]!)) throw new Error(`Unknown ${task} argument: ${args[i]}`);
    if (args[i] === "--container") i++;
  }
  if (task === "setup") {
    script("build/prepareDependencies");
    script("build/prepareM2c");
    console.log("Pinned public sources prepared in the runtime cache; supply configured external compiler/binutils/Python capabilities when unavailable.");
    if (loadToolchain().compiler.analysis) {
      script("agent/analysisSupport", ["status"]);
      console.log("Bootstrap configured diagnostics explicitly with analysis-support bootstrap [--function KEY]; this never provisions or replaces a compiler.");
    }
    return;
  }
  if (task === "split-sdk-libs") { splitSdk(); return; }
  if (task === "clean") {
    if (loadLibraryProject() && args.includes("--container")) throw new Error("Libraries have members, not image containers; npm run clean removes build/ only");
    if (!args.length || args.includes("--all")) cleanRuntime(join(projectRoot(), "build"));
    else for (const container of selection(args)) {
      if (container.kind === "exe") {
        for (const path of ["build/asm", "build/functions", container.paths.builtElf, container.paths.builtBin, container.paths.ldScript]) rmSync(join(projectRoot(), path), { recursive: true, force: true });
        for (const path of filesUnder(join(projectRoot(), container.paths.objDir)).filter(p => dirname(p) === join(projectRoot(), container.paths.objDir))) rmSync(path, { force: true });
      }
      else for (const path of [`build/${container.id}`, container.paths.objDir]) rmSync(join(projectRoot(), path), { recursive: true, force: true });
    }
    return;
  }
  if (task === "disassemble") {
    for (const container of selection(args)) script("build/disassemble", ["--container", container.id]);
    script("build/bootstrap", ["--write"]);
    if (args.includes("--archives")) {
      script("build/extractArchive", ["--write"]);
      script("build/classifyArchiveMembers", ["--write"]);
      script("build/extractArchive", ["--write", "--extract"]);
      script("build/solveOverlayBase", ["--write"]);
      script("diagnostics/overlayIdentity", ["--write"]);
    }
    return;
  }
  if (loadLibraryProject()) throw new Error("Library wipe/container cleanup is unsupported; npm run clean removes generated build artifacts only");
  const containers = selection(args, ["check-all", "split-all", "config-check"].includes(task));
  if (["split", "split-all", "config-check"].includes(task)) {
    for (const container of containers) splitContainer(container);
    if (task === "config-check") {
      command("git", ["diff", "--exit-code", "--", "configs/", "include/"]);
      console.log("OK: tracked configs and headers are converged (review untracked outputs separately)");
    }
    return;
  }
  if (task === "wipe") {
    for (const container of containers) {
      rmSync(join(projectRoot(), container.paths.symbolAddrs), { force: true });
      if (container.kind === "overlay") {
        rmSync(join(projectRoot(), container.paths.splat), { force: true });
        rmSync(join(projectRoot(), `build/${container.id}`), { recursive: true, force: true });
        rmSync(join(projectRoot(), container.paths.objDir), { recursive: true, force: true });
      } else {
        const path = join(projectRoot(), container.paths.splat);
        if (existsSync(path)) {
          const lines = readFileSync(path, "utf8").split("\n"), index = lines.findIndex(l => l.trim() === "subsegments:");
          if (index < 0) throw new Error(`No subsegments in ${path}; refusing to wipe configuration`);
          writeFileSync(path, lines.slice(0, index + 1).join("\n") + "\n");
        }
        rmSync(join(projectRoot(), "configs/disassembler_symbol_addrs.txt"), { force: true });
        cleanRuntime(join(projectRoot(), "build"));
      }
    }
    console.log("Generated configs wiped. Run npm run split -- --all, then npm run check-all.");
    return;
  }
  if (!["build", "check", "check-exe", "check-all"].includes(task)) throw new Error(`Unknown npm task: ${task}`);
  for (const container of containers) buildContainer(container);
  if (task !== "build") {
    // Overlay convergence may refresh the EXE link. Verify final images once,
    // after all builds, rather than reporting an earlier EXE as final evidence.
    verifyBuiltContainers(containers, task === "check-all");
    if (task === "check-all") {
      const unresolved = unresolvedCodeMembers();
      console.log(`All ${containers.length} configured containers match.${unresolved.length ? ` ${unresolved.length} unresolved code members are not verified.` : ""}`);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runTask(process.argv[2] ?? "check", process.argv.slice(3)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
