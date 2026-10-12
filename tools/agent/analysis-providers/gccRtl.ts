/** GCC RTL protocol probes. No compiler-version dispatch or production tool replacement. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { projectRoot, contextForProject, resolveOwnedPath } from "../../lib/runtimeContext.js";
import { fileDigest } from "../../lib/contentCache.js";
import { configuredFlags, configuredFileFlags, configuredTool, executablePath, loadToolchain, type FlagContext } from "../../lib/toolchain.js";
import type { CompilerAnalysisProfile } from "../../lib/compilerAnalysis.js";
import { parseRtlInstructions } from "../compiler-trace/rtl-parser.js";

function run(command: string, args: string[], directory: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function assemblyWords(path: string): string {
  return readFileSync(path, "utf8").split("\n").map(line => line.replace(/#.*/, "").trim()).filter(Boolean).join("\n");
}

export function bootstrapGccRtl(context?: FlagContext, ownerStem?: string): CompilerAnalysisProfile {
  const root = projectRoot(), config = loadToolchain(root), selected = config.compiler.analysis;
  if (!selected || selected.provider !== "gcc-rtl" || config.compiler.family !== "gcc") throw new Error("The gcc-rtl provider requires a configured GCC toolchain.");
  const compiler = configuredTool("cc1", root, { prepare: false }), compilerPath = executablePath(compiler);
  if (!compilerPath) throw new Error(`Configured compiler not found: ${compiler}`);
  const directory = join(root, "build/analysisSupport", `${Date.now()}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const source = join(directory, "probe.c"), input = join(directory, "probe.i");
  // A protocol probe, not a target candidate. Target matching still uses the ordered production TU.
  writeFileSync(source, "int harness_analysis_probe(int x) { int i; int s = x; for (i = 0; i < 4; i++) s = s * 3 + i; return x > 7 ? s : s + 1; }\n");
  const records: object[] = [];
  const execute = (label: string, command: string, args: string[]) => {
    const result = run(command, args, directory);
    writeFileSync(join(directory, `${label}.stdout`), result.stdout);
    writeFileSync(join(directory, `${label}.stderr`), result.stderr);
    records.push({ label, command, args, status: result.status });
    return result;
  };
  const cpp = execute("cpp", configuredTool("cpp"), [...configuredFlags("cpp", context), source, "-o", input]);
  if (cpp.status !== 0) throw new Error(`Analysis probe preprocessing failed: ${cpp.stderr}`);
  const flags = [...configuredFlags("cc1", context), ...(ownerStem ? configuredFileFlags(ownerStem) : [])];
  const compile = (label: string, extra: string[], compileInput = input) =>
    execute(label, compiler, [...flags, ...extra, basename(compileInput), "-o", `${label}.s`]);
  const baseline = compile("baseline", []);
  if (baseline.status !== 0) throw new Error(`Configured production compiler rejected the probe: ${baseline.stderr}`);
  const dumped = compile("dumps", ["-da"]);
  const dumpFiles = readdirSync(directory).filter(name => name.startsWith("probe.i."));
  const counts = Object.fromEntries(dumpFiles.map(name => [name.split(".").at(-1)!, parseRtlInstructions(readFileSync(join(directory, name), "utf8"), name.split(".").at(-1)!).length]));
  const unchanged = dumped.status === 0 && assemblyWords(join(directory, "baseline.s")) === assemblyWords(join(directory, "dumps.s"));
  const emission = compile("emission", ["-dp"]);
  const emissionAvailable = emission.status === 0 && assemblyWords(join(directory, "baseline.s")) === assemblyWords(join(directory, "emission.s")) &&
    /#\s*\d+\s+[\w.*]+\s+\[length[=:]/.test(readFileSync(join(directory, "emission.s"), "utf8"));
  const implicitSource = join(directory, "implicit.c"), implicitInput = join(directory, "implicit.i");
  writeFileSync(implicitSource, "int harness_analysis_probe(int x) { return harness_analysis_undeclared(x); }\n");
  const implicitCpp = execute("implicit-cpp", configuredTool("cpp"), [...configuredFlags("cpp", context), implicitSource, "-o", implicitInput]);
  const implicit = implicitCpp.status === 0 ? compile("implicit", ["-Wimplicit"], implicitInput) : implicitCpp;
  const implicitAvailable = implicit.status === 0 && /warning: implicit declaration of function [`']harness_analysis_undeclared'/.test(implicit.stderr);
  const sourcePath = config.compiler.source ? resolveOwnedPath(config.compiler.source, contextForProject(root)) : undefined;
  const pin = sourcePath ? join(sourcePath, "pin.json") : undefined;
  const profile: CompilerAnalysisProfile = {
    schemaVersion: 1, provider: selected.provider,
    compiler: { family: config.compiler.family, version: config.compiler.version, sha256: fileDigest(compilerPath),
      ...(pin && existsSync(pin) ? { sourcePinSha256: fileDigest(pin) } : {}) },
    capture: { dumpFlags: ["-da"], emissionFlags: emissionAvailable ? ["-dp"] : [], implicitFlags: ["-Wimplicit"] },
    stageOrder: [],
    preDbrStage: null, passModel: null,
    validated: { dumpCapture: dumped.status === 0 && dumpFiles.length > 0, rtlParser: Object.values(counts).some(count => count > 0),
      implicitDeclarations: implicitAvailable, emissionAttribution: emissionAvailable, preDbrReplay: false },
    evidence: { directory: relative(root, directory), unchangedAssembly: unchanged, notes: [
      "Single-function protocol probes used the configured compiler, cpp and effective owner flags; no production configuration or target source was changed.",
      "Available stages are recorded in dumpInstructionCounts. File timestamps do not establish pass order; stageOrder remains empty until independently validated.",
      "Native dump availability and parsing do not establish allocator/scheduler semantics or an equivalent pre-delay-slot snapshot.",
    ] },
  };
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({ records, dumpInstructionCounts: counts, profile }, null, 2) + "\n");
  const destination = resolveOwnedPath(selected.profile, contextForProject(root));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(profile, null, 2) + "\n");
  return profile;
}
