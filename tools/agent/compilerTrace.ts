#!/usr/bin/env npx tsx
import { projectRoot } from "../lib/runtimeContext.js";
/**
 * compilerTrace.ts — expose native GCC RTL and reconstructed pass diagnostics.
 *
 * Usage:
 *   npx tsx tools/agent/compilerTrace.ts func_8001B4E4
 *   npx tsx tools/agent/compilerTrace.ts func_8001B4E4 --src build/candidate.c
 *   npx tsx tools/agent/compilerTrace.ts func_8001B4E4 --pseudo 106
 *   npx tsx tools/agent/compilerTrace.ts func_8001B4E4 --scheduler-window 24:32
 *   npx tsx tools/agent/compilerTrace.ts func_8001B4E4 --json
 *
 * Raw GCC -da dumps and a stable report.json are retained under
 * build/compilerTrace/<function>/.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, isAbsolute, join, relative } from "path";
import { assembleCompilerOutput, assembleTarget, compileSource, disassembleObject, normalizeFunctionName, resolveSource } from "./decompToolchain.js";
import { configuredAssembler, type AssemblerSelection, configuredCompilerAnalysis, supportsCompilerCapability, requireCompilerCapability } from "../lib/toolchain.js";
import { compilerAnalysisSummary } from "../lib/compilerAnalysis.js";
import { selectRtlFunction } from "../lib/compilerArtifacts.js";
import { functionSymbol, resolveFunctionTarget } from "../lib/targetAdapter.js";
import { detectAllocationFeedback } from "./compiler-trace/hard-register-hazards.js";
import { analyzeAllocation, applyAllocation } from "./compiler-trace/local-allocation.js";
import { buildPseudoProvenance } from "./compiler-trace/pseudo-provenance.js";
import { reconstructRtlMetadata } from "./compiler-trace/rtl-notes.js";
import { renderText } from "./compiler-trace/render-text.js";
import {
  firstPseudoRegister,
  parseRegisterReferences,
  parseRtlInstructions,
  parseRtlNotes,
} from "./compiler-trace/rtl-parser.js";
import { parseScheduler } from "./compiler-trace/scheduler-dag.js";
import { spliceSplitProducts } from "./compiler-trace/scheduler-order.js";
import { findTargetRegisterRecurrences } from "./compiler-trace/target-recurrence.js";
import type {
  CompilerTraceReport,
  RenderOptions,
  RtlInstruction,
  RtlStageMetadata,
  StageSummary,
} from "./compiler-trace/types.js";

export type { CompilerTraceReport } from "./compiler-trace/types.js";

const LEGACY_STAGE_ORDER = [
  "rtl", "jump", "cse", "gcse", "loop", "cse2", "addressof", "flow",
  "combine", "regmove", "sched", "lreg", "greg", "flow2", "bp", "sched2",
  "jump2", "dbr", "mach",
];

function countInstructions(content: string): number {
  return [...content.matchAll(/^\((?:insn|jump_insn|call_insn)(?:\/[a-z]+)*\s+\d+/gm)].length;
}

function pseudoOccurrences(content: string): { count: number; pseudos: Set<number> } {
  const pseudos = new Set<number>();
  let count = 0;
  for (const reference of parseRegisterReferences(content)) {
    if (reference.register < firstPseudoRegister()) continue;
    pseudos.add(reference.register);
    count++;
  }
  return { count, pseudos };
}

function stageSuffix(file: string): string {
  const pieces = file.split(".");
  return pieces[pieces.length - 1]!;
}

function dumpFiles(directory: string, prefix: string): string[] {
  const configuredOrder = configuredCompilerAnalysis().profile?.stageOrder;
  const order = configuredOrder?.length ? configuredOrder : LEGACY_STAGE_ORDER;
  return readdirSync(directory)
    .filter((file) => file.startsWith(`${prefix}.i.`))
    .sort((left, right) => {
      const leftIndex = order.indexOf(stageSuffix(left));
      const rightIndex = order.indexOf(stageSuffix(right));
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
    });
}

function summarizeStages(
  directory: string,
  files: string[],
  metadata: Map<string, RtlStageMetadata>,
  contents: Map<string, string>,
): StageSummary[] {
  return files.map((file) => {
    const path = join(directory, file);
    const content = contents.get(stageSuffix(file)) ?? "";
    let occurrences = { count: 0, pseudos: new Set<number>() };
    try { occurrences = pseudoOccurrences(content); } catch { /* Report register-model unavailability separately. */ }
    const stageMetadata = metadata.get(stageSuffix(file));
    return {
      suffix: stageSuffix(file),
      file: relative(projectRoot(), path),
      bytes: Buffer.byteLength(content),
      instructionCount: countInstructions(content),
      noteCount: stageMetadata?.notes.length || 0,
      loopRegionCount: stageMetadata?.loopRegions.length || 0,
      maximumLoopDepth: stageMetadata?.instructions.reduce(
        (maximum, instruction) => Math.max(maximum, instruction.loopDepth), 0,
      ) || 0,
      pseudoCount: occurrences.pseudos.size,
      pseudoOccurrences: occurrences.count,
    };
  });
}

function parseAllStages(
  directory: string,
  prefix: string,
  files: string[],
): {
  contents: Map<string, string>;
  instructions: Map<string, RtlInstruction[]>;
  metadata: Map<string, RtlStageMetadata>;
  caveats: string[];
} {
  const contents = new Map<string, string>();
  const instructions = new Map<string, RtlInstruction[]>();
  const metadata = new Map<string, RtlStageMetadata>();
  const caveats: string[] = [];
  for (const file of files) {
    const stage = stageSuffix(file);
    try {
      const content = selectRtlFunction(readFileSync(join(directory, file), "utf-8"), functionSymbol(prefix));
      const stageInstructions = parseRtlInstructions(content, stage);
      if (!stageInstructions.length) {
        caveats.push(`.${stage}: no function RTL instructions could be parsed; dependent analyses are unavailable.`);
        continue;
      }
      const notes = parseRtlNotes(content, stage);
      const stageMetadata = reconstructRtlMetadata(content, stage, stageInstructions, notes);
      contents.set(stage, content);
      instructions.set(stage, stageInstructions);
      metadata.set(stage, stageMetadata);
    } catch (error) {
      caveats.push(`.${stage} dump unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { contents, instructions, metadata, caveats };
}

function nearestInstructions(
  instructions: Map<string, RtlInstruction[]>,
  candidates: string[],
): RtlInstruction[] {
  for (const stage of candidates) {
    const value = instructions.get(stage);
    if (value && value.length > 0) return value;
  }
  return [];
}

export interface ExistingTraceArtifacts {
  functionName: string;
  sourcePath: string;
  assemblyPath: string;
  dumpDirectory: string;
  outputDirectory: string;
  flags: string[];
  assembler?: AssemblerSelection;
  reportFileName?: string;
}

/** Parse a compatible preserved GCC -da directory without invoking cc1 again. */
export function buildTraceReportFromArtifacts(options: ExistingTraceArtifacts): CompilerTraceReport {
  const funcName = options.functionName;
  requireCompilerCapability("gcc-rtl-dumps");
  const source = resolveSource(funcName, options.sourcePath);
  const outputDirectory = options.outputDirectory;
  mkdirSync(outputDirectory, { recursive: true });
  const files = dumpFiles(options.dumpDirectory, funcName);
  if (files.length === 0) throw new Error(`no preserved GCC dump files found in ${relative(projectRoot(), options.dumpDirectory)}`);
  const parsed = parseAllStages(options.dumpDirectory, funcName, files);
  if (!parsed.instructions.size)
    throw new Error(`No selected C/RTL for ${functionSymbol(funcName)}; pass --src with a candidate defining this function. ${parsed.caveats.join(" ")}`);
  const support = configuredCompilerAnalysis();
  const configuredOrder = support.profile?.stageOrder;
  const passOrderKnown = !!configuredOrder?.length;
  const order = passOrderKnown ? configuredOrder! : LEGACY_STAGE_ORDER;
  const globalStage = order.indexOf("greg");
  const provenanceStages = (globalStage >= 0 ? order.slice(0, globalStage + 1) : order)
    .filter(stage => parsed.instructions.has(stage));
  const caveats: string[] = [compilerAnalysisSummary(support), ...parsed.caveats];
  let boundary: number | undefined;
  let pseudoMap = new Map<number, import("./compiler-trace/types.js").PseudoProvenance>();
  try {
    boundary = firstPseudoRegister();
    pseudoMap = buildPseudoProvenance(provenanceStages, parsed.instructions);
  } catch (error) {
    caveats.push(`Register-dependent provenance unavailable: ${String(error)}. Native RTL remains available.`);
  }
  if (!passOrderKnown) {
    caveats.push("Pass order uses the common GCC ordering fallback, not an independently verified order for this compiler. Cross-stage transitions are inferred; stage-local SET/use/death UIDs remain observed.");
    for (const pseudo of pseudoMap.values()) for (const transition of pseudo.transitions) {
      transition.confidence = "inferred";
      transition.evidence += " Stage ordering is inferred from the common GCC pipeline.";
    }
  }
  let allocationOrder: CompilerTraceReport["allocationOrder"] = [];
  for (const metadata of parsed.metadata.values()) caveats.push(...metadata.caveats);

  const localContent = parsed.contents.get("lreg");
  if (localContent) {
    try {
      const allocation = analyzeAllocation(
        localContent,
        parsed.contents.get("greg") || "",
        parsed.instructions.get("lreg") || [],
      );
      applyAllocation(pseudoMap, allocation);
      allocationOrder = allocation.globalOrder;
      caveats.push(...allocation.caveats);
    } catch (error) {
      caveats.push(`Allocation analysis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    caveats.push("No readable .lreg dump, so allocation quantities and reconstructed lifetimes are unavailable.");
  }
  if (!parsed.contents.has("greg")) caveats.push("No readable .greg dump; global allocation observations are unavailable.");

  const schedulers = [];
  const schedContent = parsed.contents.get("sched");
  const schedInstructions = parsed.instructions.get("sched") || [];
  const schedInput = nearestInstructions(parsed.instructions, ["regmove", "combine", "flow"]);
  if (schedContent) {
    try {
      schedulers.push(parseScheduler(
        "sched",
        schedContent,
        schedInstructions,
        spliceSplitProducts(schedInput, schedInstructions, caveats),
      ));
    } catch (error) {
      caveats.push(`sched analysis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else caveats.push("No readable .sched dump; pre-reload scheduler analysis is unavailable.");
  const sched2Content = parsed.contents.get("sched2");
  const sched2Instructions = parsed.instructions.get("sched2") || [];
  const sched2Input = nearestInstructions(parsed.instructions, ["bp", "flow2", "greg"]);
  if (sched2Content) {
    try {
      schedulers.push(parseScheduler(
        "sched2",
        sched2Content,
        sched2Instructions,
        spliceSplitProducts(sched2Input, sched2Instructions, caveats),
      ));
    } catch (error) {
      caveats.push(`sched2 analysis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else caveats.push("No readable .sched2 dump; post-reload scheduler analysis is unavailable.");
  for (const scheduler of schedulers) caveats.push(...scheduler.caveats);

  const pseudos = [...pseudoMap.values()].sort((left, right) => left.pseudo - right.pseudo);
  const sched1 = schedulers.find((scheduler) => scheduler.stage === "sched");
  const sched2 = schedulers.find((scheduler) => scheduler.stage === "sched2");
  let feedback: CompilerTraceReport["feedback"] = [];
  try {
    feedback = detectAllocationFeedback(
      sched1, sched2, schedInput, schedInstructions, sched2Instructions, pseudos,
    );
  } catch (error) {
    caveats.push(`Allocation feedback analysis unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  let recurrenceHints: CompilerTraceReport["recurrenceHints"] = [];
  let candidateObject: string | undefined;
  try {
    const assembledObject = join(outputDirectory, `${funcName}.c.o`);
    assembleCompilerOutput(options.assemblyPath, assembledObject);
    candidateObject = assembledObject;
    const targetObject = assembleTarget(funcName, outputDirectory);
    const target = disassembleObject(targetObject);
    const candidate = disassembleObject(assembledObject);
    recurrenceHints = findTargetRegisterRecurrences(
      target,
      candidate,
      nearestInstructions(parsed.instructions, ["dbr", "mach", "sched2"]),
      parsed.instructions.get("lreg") || [],
      pseudos,
    );
  } catch (error: any) {
    caveats.push(`Target recurrence analysis unavailable: ${error.message}`);
  }

  caveats.push(
    "Source expressions are normalized RTL SET expressions, not recovered C identifiers; heuristic mappings are explicitly labeled inferred.",
    "An assignment explains what cc1 did for this candidate; the archived target has no recoverable RTL dump.",
    "Tracing is diagnostic-only: changing allocator or scheduler behavior would invalidate compiler identity.",
  );

  const reportPath = join(outputDirectory, options.reportFileName || "report.json");
  const report: CompilerTraceReport = {
    schemaVersion: 2,
    ...(options.assembler ? { assembler: options.assembler } : {}),
    analysis: { provider: support.provider, passOrderKnown, passModelsAvailable: true,
      passOrderConfidence: passOrderKnown ? "configured" : "inferred" },
    registerModel: boundary === undefined ? { status: "unavailable" } : { status: "observed", firstPseudoRegister: boundary },
    function: funcName,
    source: relative(projectRoot(), source),
    outputDirectory: relative(projectRoot(), outputDirectory),
    assembly: relative(projectRoot(), options.assemblyPath),
    ...(candidateObject ? { candidateObject: relative(projectRoot(), candidateObject) } : {}),
    reportArtifact: relative(projectRoot(), reportPath),
    flags: options.flags,
    stages: summarizeStages(options.dumpDirectory, files, parsed.metadata, parsed.contents),
    stageMetadata: [...parsed.metadata.values()],
    pseudos,
    allocationOrder,
    schedulers,
    feedback,
    recurrenceHints,
    caveats: [...new Set(caveats)],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function buildTraceReport(
  funcName: string,
  requestedSource?: string,
  useOverrides: boolean = true,
  requestedOutputDirectory?: string,
): CompilerTraceReport {
  requireCompilerCapability("gcc-rtl-dumps");
  const source = resolveSource(funcName, requestedSource);
  const outputDirectory = requestedOutputDirectory
    ? (isAbsolute(requestedOutputDirectory) ? requestedOutputDirectory : join(projectRoot(), requestedOutputDirectory))
    : join(projectRoot(), "build/compilerTrace", funcName);
  rmSync(outputDirectory, { recursive: true, force: true });
  /* -dp annotates the first assembly line of each RTL instruction with its UID
   * and pattern name, which is the only sound source for where one RTL
   * instruction emitted several machine instructions. The annotations are
   * comments, and every consumer of this assembly strips from `#` onward, so
   * they are transparent to instruction parsing. */
  const artifacts = compileSource(source, outputDirectory, funcName, {
    dumps: true,
    emissionAttribution: supportsCompilerCapability("gcc-emission-attribution"),
    useOverrides,
  });
  return buildTraceReportFromArtifacts({
    functionName: funcName,
    sourcePath: source,
    assemblyPath: artifacts.assembly,
    dumpDirectory: outputDirectory,
    outputDirectory,
    flags: artifacts.cc1Flags,
    assembler: configuredAssembler(resolveFunctionTarget(funcName).flags),
  });
}

interface CliOptions extends RenderOptions {
  functionName: string;
  requestedSource?: string;
  json: boolean;
  useOverrides: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`compilerTrace: ${message}`);
  console.error(
    "Usage: npx tsx tools/agent/compilerTrace.ts <func> [--src <file>] [--json] " +
    "[--pseudo <number>] [--scheduler-window <start:end>] [--no-overrides]",
  );
  process.exit(1);
}

function parseCli(args: string[]): CliOptions {
  let functionName: string | undefined;
  let requestedSource: string | undefined;
  let pseudo: number | undefined;
  let schedulerWindow: RenderOptions["schedulerWindow"];
  let json = false;
  let useOverrides = true;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--src") {
      requestedSource = args[++index];
      if (!requestedSource) usage("--src requires a file");
    } else if (argument === "--pseudo") {
      const raw = args[++index];
      if (!raw || !/^\d+$/.test(raw)) usage("--pseudo requires an integer");
      pseudo = parseInt(raw, 10);
    } else if (argument === "--scheduler-window") {
      const raw = args[++index];
      const match = raw?.match(/^(\d+):(\d+)$/);
      if (!match) usage("--scheduler-window requires start:end");
      schedulerWindow = { start: parseInt(match[1], 10), end: parseInt(match[2], 10) };
      if (schedulerWindow.end < schedulerWindow.start) usage("scheduler window end precedes start");
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--no-overrides") {
      useOverrides = false;
    } else if (argument.startsWith("--")) {
      usage(`unknown option ${argument}`);
    } else if (functionName) {
      usage("only one function may be traced");
    } else {
      functionName = normalizeFunctionName(argument);
    }
  }
  if (!functionName) usage("missing function name");
  const result: CliOptions = { functionName, json, useOverrides };
  if (requestedSource) result.requestedSource = requestedSource;
  if (pseudo !== undefined) result.pseudo = pseudo;
  if (schedulerWindow) result.schedulerWindow = schedulerWindow;
  return result;
}

const isCLI = process.argv[1]?.endsWith("compilerTrace.ts");
if (isCLI) {
  const options = parseCli(process.argv.slice(2));
  try {
    const report = buildTraceReport(
      options.functionName,
      options.requestedSource,
      options.useOverrides,
    );
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(renderText(report, options));
  } catch (error: any) {
    console.error(`compilerTrace: ${error.message}`);
    process.exit(1);
  }
}
