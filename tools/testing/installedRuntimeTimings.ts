/** Repeatable nine-scenario wall-time capture. Only disposable workspaces allowed. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createRuntimeContext, HARNESS_ROOT } from "../lib/runtimeContext.js";
import { installedDependency, installedScriptArgs } from "../lib/installedScripts.js";

const [implementation, directory, output, host, converter] = process.argv.slice(2);
const root = resolve(directory ?? "");
if (!directory || !output || !host || !implementation || !root.startsWith("/tmp/psx-installed-runtime-") || !["baseline", "harness"].includes(implementation)) throw new Error("Refusing a non-disposable timing workspace");
mkdirSync(output, { recursive: true });
const runner = fileURLToPath(new URL("./installedToolInvocation.ts", import.meta.url));
const owner = resolve(process.env.RUNTIME_HARNESS_ROOT ?? HARNESS_ROOT);
const tsx = installedDependency("tsx", owner);
const context = implementation === "harness" ? createRuntimeContext(root, { harnessRoot: owner }) : undefined;
const exe = "CopyVec3";
const overlay = "src/overlays/ovl_31/ovl_31_func_800B8600.c";
const candidate = join(root, "timing-candidate.c");
copyFileSync(join(root, "src", `${exe}.c`), candidate);
const environment = { ...process.env, PI_OFFLINE: "1", PSYQ2ELF: converter };
const timingDirectory = output;
const durableArchive = join(root, ".timing-durable", basename(resolve(timingDirectory)));
const measurements = join(timingDirectory, "measurements.jsonl");
const completed = new Set(existsSync(measurements) ? readFileSync(measurements, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.implementation === implementation).map(row => `${row.scenario}:${row.repeat}`) : []);
const operation = (action: string) => implementation === "baseline" ? ["make", [action, `PSYQ2ELF=${converter}`]] as const : [process.execPath, installedScriptArgs("tools/build/pipeline.ts", [action], context!)] as const;
const invoke = (tool: string, params: object) => [process.execPath, ["--import", tsx, runner, root, host, tool, JSON.stringify(params), process.env.RUNTIME_EXTENSION ?? join(implementation === "harness" ? owner : root, ".pi/extensions/psx-decomp/index.ts")]] as const;
function run(command: string, args: readonly string[], log: string) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  appendFileSync(log, JSON.stringify({ command, args }) + "\n" + result.stdout + result.stderr);
  if (result.error || result.status !== 0) throw new Error(`Timing operation failed (${result.status}): ${log}: ${result.error ?? result.stderr?.slice(-2000)}`);
}
function timed(scenario: string, repeat: number, operations: ReadonlyArray<readonly [string, readonly string[]]>) {
  if (completed.has(`${scenario}:${repeat}`)) return;
  const log = join(timingDirectory, `${implementation}-${scenario}-${repeat}.log`);
  const start = performance.now();
  for (const [command, args] of operations) run(command, args, log);
  const elapsedMs = performance.now() - start;
  const row = { implementation, scenario, repeat, elapsedMs, root, operations, log, ...(implementation === "harness" ? { installedPackage: owner } : {}), at: new Date().toISOString() };
  appendFileSync(measurements, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}
function clearResidualCaches() {
  // Durable experimentLedger and closed/evidence records are NEVER cleared.
  for (const path of ["residualObjective", "pipelineReversal", "targetSchedule", "diff", "contentCache"]) rmSync(join(root, "build", path), { recursive: true, force: true });
}
for (let repeat = 1; repeat <= 3; repeat++) {
  const history = join(root, "build/experimentLedger");
  const savedHistory = join(root, ".timing-history");
  if (!completed.has(`cold-full:${repeat}`)) {
    // Only disposable project-owned source/config/header state. Never AGENTS,
    // sibling inputs, installed implementation or durable experiment history.
    const reset = spawnSync("git", ["restore", "--source=HEAD", "--", "src", "include", "configs"], { cwd: root, encoding: "utf8" });
    if (reset.status !== 0) throw new Error(`Cannot reset disposable starting state: ${reset.stderr}`);
    if (existsSync(history)) renameSync(history, savedHistory);
    for (const path of ["preparation", "loopTrace"]) if (existsSync(join(root, "build", path))) {
      mkdirSync(join(durableArchive, String(repeat)), { recursive: true });
      renameSync(join(root, "build", path), join(durableArchive, String(repeat), path));
      appendFileSync(join(timingDirectory, "durable-archives.jsonl"), JSON.stringify({ original: `build/${path}`, preserved: join(durableArchive, String(repeat), path), repeat }) + "\n");
    }
    rmSync(join(root, "build"), { recursive: true, force: true });
    timed("cold-full", repeat, [operation("split-all"), operation("check-all")]);
    if (existsSync(savedHistory)) renameSync(savedHistory, history);
  }
  timed("warm-noop", repeat, [operation("check-all")]);
  utimesSync(join(root, "src", `${exe}.c`), new Date(), new Date());
  timed("touch-exe", repeat, [operation("check-all")]);
  utimesSync(join(root, overlay), new Date(), new Date());
  timed("touch-overlay", repeat, [operation("check-all")]);
  timed("exe-only", repeat, [operation("check")]);
  const setupLog = join(output, `${implementation}-setup-${repeat}.log`);
  if (!existsSync(join(root, "build/callGraph.json"))) {
    const [command, args] = implementation === "baseline" ? ["npx", ["tsx", "tools/agent/callGraph.ts"]] as const : [process.execPath, installedScriptArgs("tools/agent/callGraph.ts", [], context!)] as const;
    run(command, args, setupLog);
  }
  timed("finalize", repeat, [invoke("psx_finalize_function", { functionName: exe })]);
  if (!completed.has(`residual-cold:${repeat}`)) clearResidualCaches();
  timed("residual-cold", repeat, [invoke("psx_residual_objective", { functionName: exe, source: [candidate], json: true })]);
  timed("residual-warm", repeat, [invoke("psx_residual_objective", { functionName: exe, source: [candidate], json: true })]);
  // Fixed context/alternative; packets are cold for each preparation repetition.
  if (!completed.has(`preparation:${repeat}`) && existsSync(join(root, "build/preparation", exe))) {
    const archive = join(durableArchive, `preparation-${repeat}`);
    mkdirSync(archive, { recursive: true });
    renameSync(join(root, "build/preparation", exe), join(archive, exe));
    appendFileSync(join(output, "durable-archives.jsonl"), JSON.stringify({ original: `build/preparation/${exe}`, preserved: join(archive, exe), repeat }) + "\n");
  }
  timed("preparation", repeat, [invoke("psx_m2c", { functionName: exe, alternative: true })]);
}
