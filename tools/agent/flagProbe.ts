#!/usr/bin/env npx tsx
import { projectRoot } from "../lib/runtimeContext.js";
/**
 * flagProbe.ts — early per-file flag-hypothesis check for one function.
 *
 * Usage:
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98 --json
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98 --src build/candidate.c
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98 --with-source build/advisory.c
 *
 * Run this BEFORE burning effort on source-shape archaeology. It answers:
 * "does the target nominate a flag hypothesis, and does a flag delta dominate
 * on the selected C candidate?" See `psx_reference flags`, section 11, for
 * the governed escalation bar. Historical fingerprints are hypotheses to
 * measure, not evidence about a new target's flags or original compiler input.
 *
 * Three independent evidence sources:
 *   1. Target structural fingerprints, decoded from the original binary's
 *      bytes (no source needed):
 *      - nested loop with an in-place bottom-of-loop counter increment
 *        nominates GCSE experiments where supported by the compiler
 *      - sequential lui/lw self-clobbering loads nominate address-splitting
 *        and scheduling experiments, not a unique original macro spelling
 *   2. Flag-matrix compile of the selected C candidate (if present): masked
 *      score + instruction count per candidate flag set. Assembly-backed
 *      stubs supply fingerprints only; --with-source rows remain advisory.
 *   3. Regional context: existing overrides near this function's VRAM
 *      (flags are per-TU; neighbors sharing a TU share flags).
 *
 * The run writes `build/flagProbe/<function>/report.json`. That report is what
 * lets triage stop repeating a flag hypothesis this probe has already measured
 * as tied on the current source — and its hashes are what stop it from
 * carrying a stale conclusion past the next source edit.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { handsSymbolToAssembler } from "./cSourceAnalysis.js";
import { compileSource, configuredTool, runTool, loadFlagOverrides, assembleTarget, disassembleObject, configuredGccVersion, configuredToolchainIdentity, resolveAsmSource, sourcePathFor } from "./decompToolchain.js";
import { sha256, stableJson } from "./variant-lab/artifacts.js";
import { type Container } from "../lib/container.js";
import { addressEncodedInName, locateFunction } from "../lib/symbolIndex.js";
import { resolveFunctionTarget, type FunctionTarget } from "../lib/targetAdapter.js";
import { loadLibraryProject } from "../lib/project.js";
import { targetWordsOf } from "../lib/functionOracle.js";
import { configuredAssembler, configuredFlags, type AssemblerKind } from "../lib/toolchain.js";

// Probe rows compile through the same config service as the production build.

/**
 * The compiler and assembler flags this function's translation unit was built
 * with — its container's, not the executable's.
 *
 * The small-data threshold is a per-container fact: overlay units were built
 * `-G0`. Probing an overlay function under the executable's `-G8` measures a
 * translation unit the original build never produced, and the whole matrix —
 * baseline included — then scores a program that is wrong for reasons the flag
 * columns cannot show.
 */
function flagsFor(name: string): { cc1: string; as: string } {
  const target = resolveFunctionTarget(name);
  return { cc1: configuredFlags("cc1", target.flags).join(" "), as: configuredFlags("as", target.flags).join(" ") };
}

export const BASELINE_LABEL = "baseline";

export const FLAG_MATRIX: [string, string][] = [
  [BASELINE_LABEL, ""],
  ["-fno-gcse", "-fno-gcse"],
  ["-fno-schedule-insns{,2}", "-fno-schedule-insns -fno-schedule-insns2"],
  ["-fno-schedule-insns2", "-fno-schedule-insns2"],
  ["-fno-gcse -fno-schedule-insns{,2}", "-fno-gcse -fno-schedule-insns -fno-schedule-insns2"],
  ["-fno-rerun-cse-after-loop", "-fno-rerun-cse-after-loop"],
  ["-mno-split-addresses", "-mno-split-addresses"],
  /* CSE path exploration. -O2 turns both on. They decide whether CSE carries
   * values across a branch into a block it does not straight-line dominate,
   * which is what makes an address or index re-materialise in a join block
   * instead of being folded to a register the dominator already holds. */
  ["-fno-cse-follow-jumps", "-fno-cse-follow-jumps"],
  ["-fno-cse-skip-blocks", "-fno-cse-skip-blocks"],
  ["-fno-cse-follow-jumps -fno-cse-skip-blocks", "-fno-cse-follow-jumps -fno-cse-skip-blocks"],
];

/* ---- report shape ---- */

export type FingerprintKind = "pre-fatal-shape" | "self-clobber-shape" | "expected-assembler-expansion";

export interface Fingerprint {
  kind: FingerprintKind;
  detail: string;
  /** Matrix labels this fingerprint nominates as the candidate remedy. */
  candidates: string[];
}

export interface FlagMatrixRow {
  label: string;
  flags: string;
  /** Which source this row was compiled from: "current src" or a path. */
  source: string;
  /** Masked instructions matching the target by index, or null on failure. */
  masked: number | null;
  /** Compiled instruction count, or null on failure. */
  instructions: number | null;
  targetInstructions: number;
  error?: string;
}

export type FlagConclusion = "supported" | "not-supported-current-source" | "inconclusive";

export interface FlagCandidateVerdict {
  label: string;
  conclusion: FlagConclusion;
  reason: string;
}

export interface FlagProbeReport {
  schemaVersion: 1;
  function: string;
  /** SHA-256 of the selected C candidate; null for missing or assembly-backed input. */
  sourceHash: string | null;
  /** Explicit source selection, retained so a scratch candidate is never called live C. */
  sourcePath?: string;
  sourceLabel?: string;
  sourceStatus?: ProbeSourceStatus;
  /** SHA-256 of the original assembly the fingerprints were decoded from. */
  targetHash: string;
  toolchainHash: string;
  fingerprints: Fingerprint[];
  matrix: FlagMatrixRow[];
  conclusion: FlagConclusion;
  /** Matrix labels that strictly beat baseline on the current source. */
  dominantRows: string[];
  reasons: string[];
  /** Per-candidate verdicts, in fingerprint order. */
  candidates: FlagCandidateVerdict[];
}

function run(cmd: string): string {
  return execSync(cmd, { cwd: projectRoot(), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Where the project's configuration places this function, and in which binary.
 *
 * The container model answers both, so nothing here parses a splat file or
 * assumes a load address. That matters twice over: a function may be in any of
 * the project's containers, and the executable's own name and base are facts
 * about one game rather than about the platform.
 */
type ProbeInfo = { vram: number; size: number; container?: Container; coordinate?: FunctionTarget["coordinate"] };
export function getFuncInfo(name: string): ProbeInfo | null {
  if (loadLibraryProject()) {
    const target = resolveFunctionTarget(name);
    if (target.coordinate.kind !== "section") return null;
    return { vram: target.coordinate.offset, size: target.coordinate.size, coordinate: target.coordinate };
  }
  const found = locateFunction(name);
  const location = found.length === 1 ? found[0] : found.find((entry) => entry.container.kind === "exe") ?? found[0];
  if (!location) return null;
  return { vram: location.span.vram, size: location.span.size, container: location.container };
}

function vramForStem(stem: string): number | null {
  const info = getFuncInfo(stem);
  if (info) return info.vram;
  return addressEncodedInName(stem);
}

/* ---- structural fingerprints (pure MIPS-I word decoding) ---- */

interface Loop { head: number; branch: number; } /* word indices */

function findLoops(words: number[]): Loop[] {
  const loops: Loop[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const op = w >>> 26;
    const isBranch =
      op === 4 || op === 5 || op === 6 || op === 7 ||          /* beq bne blez bgtz */
      (op === 1 && [0, 1, 16, 17].includes((w >>> 16) & 0x1f)); /* bltz bgez bltzal bgezal */
    if (!isBranch) continue;
    const offs = (w << 16) >> 16; /* sign-extend imm16 */
    const target = i + 1 + offs;
    if (target >= 0 && target < i) loops.push({ head: target, branch: i });
  }
  return loops;
}

/** Nested loop whose outer body ends with an in-place counter increment
 *  (addiu rX,rX,imm between the inner loop's branch and the outer branch,
 *  or in the outer branch's delay slot). The PRE-fatal shape. */
export function fingerprintBottomIncrement(words: number[]): string[] {
  const loops = findLoops(words);
  const hits: string[] = [];
  for (const outer of loops) {
    const inner = loops.find((l) => l !== outer && l.head > outer.head && l.branch < outer.branch);
    if (!inner) continue;
    for (let i = inner.branch + 1; i <= Math.min(outer.branch + 1, words.length - 1); i++) {
      const w = words[i];
      if (w >>> 26 === 9 && ((w >>> 21) & 0x1f) === ((w >>> 16) & 0x1f) && ((w >>> 16) & 0x1f) !== 0) {
        hits.push(`in-place bottom increment at word ${i} inside nested loop ` +
          `[${outer.head}..${outer.branch}] (inner [${inner.head}..${inner.branch}])`);
        break;
      }
    }
  }
  return hits;
}

/** Sequential lui rD / lw rD, off(rD) self-clobbering pairs. */
export function fingerprintSelfClobberLoads(words: number[], kind: AssemblerKind = "maspsx"): string[] {
  const hits: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!, b = words[i + 1]!;
    if (a >>> 26 !== 15) continue;                    /* lui rt,imm */
    const rt = (a >>> 16) & 0x1f;
    if (b >>> 26 === 35 && ((b >>> 21) & 0x1f) === rt && ((b >>> 16) & 0x1f) === rt) {
      hits.push(`expected absolute-symbol assembler expansion at words ${i}-${i + 1} (reg $${rt}; both backends)`);
    }
    if (kind === "gas" && i + 2 < words.length && b >>> 26 === 0 && (b & 63) === 33 && ((b >>> 11) & 31) === rt) {
      const rs = (b >>> 21) & 31, index = (b >>> 16) & 31;
      const base = rs === rt ? index : index === rt ? rs : rt, c = words[i + 2]!;
      if (base !== rt && c >>> 26 === 35 && ((c >>> 21) & 31) === rt && ((c >>> 16) & 31) === rt)
        hits.push(`expected indexed-symbol GAS load-destination expansion at words ${i}-${i + 2} (reg $${rt})`);
    }
  }
  return hits;
}

export function fingerprintsOf(words: number[], kind: AssemblerKind = "maspsx"): Fingerprint[] {
  return [
    ...fingerprintBottomIncrement(words).map((detail): Fingerprint => ({
      kind: "pre-fatal-shape",
      detail,
      candidates: ["-fno-gcse", "-fno-gcse -fno-schedule-insns{,2}"],
    })),
    ...fingerprintSelfClobberLoads(words, kind).map((detail): Fingerprint => ({
      kind: "expected-assembler-expansion",
      detail,
      candidates: [],
    })),
  ];
}

/* ---- flag-matrix compile & masked score ---- */

function maskedInstrs(objdumpOut: string): string[] {
  const branch = new Set(["b","beq","beql","beqz","beqzl","bgez","bgezl","bgtz","bgtzl","blez","blezl","bltz","bltzl","bne","bnel","bnez","bnezl"]);
  return objdumpOut.split("\n")
    .filter((l) => /^\s+[0-9a-f]+:\s/.test(l))
    .map((l) => {
      const t = l.trim().replace(/^[0-9a-f]+:\s+/, "");
      const mn = t.split(/\s/)[0].toLowerCase();
      return branch.has(mn) ? t.replace(/\s+<[^>]+>$/, "") : t;
    });
}

function maskedDisassembly(insns: ReturnType<typeof disassembleObject>): string[] {
  return maskedInstrs(insns.map(i => `  ${i.address.toString(16)}: ${i.mnemonic} ${i.operands.join(",")}${i.relocation ? ` [${i.relocation.type}:${i.relocation.symbol}]` : ""}`).join("\n"));
}

function targetAsmPath(name: string): string | null {
  const resolved = resolveAsmSource(name);
  return resolved ? resolved.slice(projectRoot().length + 1) : null;
}

function assembleTargetInstrs(name: string): string[] | null {
  try { return maskedDisassembly(disassembleObject(assembleTarget(name, "build/flagProbe"))); }
  catch { return null; }
}

function compileRow(
  name: string,
  label: string,
  extraFlags: string,
  target: string[],
  sourceLabel: string,
  sourcePath?: string,
): FlagMatrixRow {
  configuredGccVersion(); // This probe's matrix is a GCC adapter, not a generic flag search.
  const dir = "build/flagProbe";
  const src = sourcePath ?? sourcePathFor(name).slice(projectRoot().length + 1);
  const flags = flagsFor(name);
  const row: FlagMatrixRow = {
    label, flags: extraFlags, source: sourceLabel,
    masked: null, instructions: null, targetInstructions: target.length,
  };
  try {
    compileSource(src, dir, name, { assemble: true, extraCc1Flags: extraFlags.split(/\s+/).filter(Boolean) });
  } catch (error: any) {
    row.error = `compile failed: ${error?.message ?? String(error)}`;
    return row;
  }
  const got = maskedDisassembly(disassembleObject(join(projectRoot(), dir, `${name}.c.o`)));
  let matched = 0;
  const total = Math.max(target.length, got.length);
  for (let i = 0; i < total; i++) if (target[i] === got[i]) matched++;
  row.masked = matched;
  row.instructions = got.length;
  return row;
}

export function renderRow(row: FlagMatrixRow): string {
  if (row.error) return row.error.replace(/\s+/g, " ").slice(0, 300);
  return `${row.masked}/${row.targetInstructions} masked, ${row.instructions} instrs (target ${row.targetInstructions})`;
}

/* ---- conclusion ---- */

/**
 * A candidate flag is only "supported" when it strictly beats baseline on the
 * measured columns for THIS source. A tie is a real result and the useful one:
 * it says the flag is not the remedy for the source as written, which is what
 * killed a wrong override on func_8001FF98 in minutes.
 *
 * The scope matters and the wording has to keep it: this never proves a flag
 * irrelevant for every source shape, only for the shape that was measured.
 */
export function concludeMatrix(options: {
  rows: FlagMatrixRow[];
  fingerprints: Fingerprint[];
  /** Rows for the current source only; candidate shapes are advisory. */
  sourceLabel: string;
}): Pick<FlagProbeReport, "conclusion" | "dominantRows" | "reasons" | "candidates"> {
  const rows = options.rows.filter((row) => row.source === options.sourceLabel);
  const baseline = rows.find((row) => row.label === BASELINE_LABEL);
  const reasons: string[] = [];

  if (rows.length === 0 || !baseline || baseline.masked === null || baseline.instructions === null) {
    return {
      conclusion: "inconclusive",
      dominantRows: [],
      reasons: [rows.length === 0
        ? "no flag matrix was measured for the current source"
        : "the baseline row did not compile, so no row can be compared against it"],
      candidates: [],
    };
  }

  /* "Strictly better" means no column is worse and at least one is better:
   * a higher masked score bought with an instruction-count regression is not
   * a dominant column, it is a different wrong answer. */
  const beatsBaseline = (row: FlagMatrixRow): boolean =>
    row.masked !== null && row.instructions !== null &&
    row.masked >= baseline.masked! &&
    Math.abs(row.instructions - row.targetInstructions) <= Math.abs(baseline.instructions! - row.targetInstructions) &&
    (row.masked > baseline.masked! ||
      Math.abs(row.instructions - row.targetInstructions) < Math.abs(baseline.instructions! - row.targetInstructions));

  const dominantRows = rows.filter((row) => row.label !== BASELINE_LABEL && beatsBaseline(row)).map((row) => row.label);

  const nominated = [...new Set(options.fingerprints.flatMap((fingerprint) => fingerprint.candidates))]
    .filter((label) => rows.some((row) => row.label === label));

  const candidates: FlagCandidateVerdict[] = nominated.map((label) => {
    const row = rows.find((entry) => entry.label === label)!;
    if (row.masked === null || row.instructions === null) {
      return { label, conclusion: "inconclusive", reason: `${label} did not compile on the current source` };
    }
    if (dominantRows.includes(label)) {
      return {
        label,
        conclusion: "supported",
        reason: `${label} beats baseline on the current source (${row.masked}/${row.targetInstructions} masked, ` +
          `${row.instructions} instrs against baseline ${baseline.masked}/${baseline.targetInstructions}, ${baseline.instructions})`,
      };
    }
    return {
      label,
      conclusion: "not-supported-current-source",
      reason: `baseline ties or beats ${label} on the current source ` +
        `(baseline ${baseline.masked}/${baseline.targetInstructions} masked, ${baseline.instructions} instrs; ` +
        `${label} ${row.masked}/${row.targetInstructions}, ${row.instructions})`,
    };
  });

  let conclusion: FlagConclusion;
  if (candidates.length === 0) {
    conclusion = "inconclusive";
    reasons.push(options.fingerprints.length === 0
      ? "no target fingerprint nominated a candidate flag; the matrix stands on its own merits"
      : "the nominated candidate flags are not in the measured matrix");
  } else if (candidates.some((candidate) => candidate.conclusion === "supported")) {
    conclusion = "supported";
  } else if (candidates.every((candidate) => candidate.conclusion === "not-supported-current-source")) {
    conclusion = "not-supported-current-source";
    reasons.push(
      "scoped to the current source only: another source shape may still require one of these flags, " +
      "and the target fingerprint remains evidence in its own right");
  } else {
    conclusion = "inconclusive";
  }
  for (const candidate of candidates) reasons.push(candidate.reason);
  if (dominantRows.length > 0) reasons.push(`rows beating baseline: ${dominantRows.join(", ")}`);

  return { conclusion, dominantRows, reasons, candidates };
}

/* ---- regional override context ---- */

/**
 * Existing per-file overrides, with the ones close enough to be the same
 * translation unit flagged.
 *
 * Proximity is only evidence inside one container. Two containers share RAM, so
 * an override 0x200 away in another binary is not a regional witness for this
 * function — it is a different program at a coincidentally similar address.
 */
export function nearbyOverrides(vram: number, container?: Container): string[] {
  const out: string[] = [];
  for (const [stem, flags] of loadFlagOverrides()) {
    const m = ["", stem, flags.join(" ")];
    const info = getFuncInfo(m[1]);
    const v = info ? info.vram : vramForStem(m[1]);
    const sameContainer = !container || !info || info.container?.id === container.id;
    const dist = v !== null ? Math.abs(v - vram) : null;
    const tag = sameContainer && dist !== null && dist <= 0x8000 ? "  <-- NEARBY (possible same TU)" : "";
    const where = info?.container && container && info.container.id !== container.id ? ` [${info.container.id}]` : "";
    out.push(`  ${m[1]}${v !== null ? ` @0x${v.toString(16).toUpperCase()}` : ""}${where}: ${m[2].trim()}${tag}`);
  }
  return out;
}

/* ---- analysis ---- */

export const CURRENT_SOURCE_LABEL = "current src";

export function reportPath(name: string): string {
  return join(projectRoot(), "build/flagProbe", name, "report.json");
}

export function toolchainHash(name?: string): string {
  return sha256(stableJson(configuredToolchainIdentity(name)));
}

/** Hash of the original assembly the fingerprints were decoded from. */
export function targetHashOf(name: string): string | null {
  const relative = targetAsmPath(name);
  if (!relative) return null;
  return sha256(readFileSync(join(projectRoot(), relative), "utf-8"));
}

export interface ProbeResult {
  info: ProbeInfo;
  report: FlagProbeReport;
  nearby: string[];
  /** Set when no target assembly exists, so no matrix was scored. */
  matrixSkipped?: string;
}

export type ProbeSourceStatus = "c-candidate" | "assembly-stub" | "missing";

/** Original assembly compiles to its own bytes under every compiler flag; it
 * supplies fingerprints, never a C flag-matrix baseline. */
export function probeSourceStatus(source: string | undefined, symbol: string): ProbeSourceStatus {
  if (source === undefined) return "missing";
  return handsSymbolToAssembler(source, symbol) ? "assembly-stub" : "c-candidate";
}

export function probe(name: string, extraSources: string[] = [], selectedSource?: string): ProbeResult {
  const info = getFuncInfo(name);
  if (!info || !info.size) throw new Error(`${name} has no sized subsegment in any container's splat config`);

  const words = targetWordsOf(name, info.container ? { container: info.container } : {}).map(w => w.raw);
  const fingerprints = fingerprintsOf(words, configuredAssembler(resolveFunctionTarget(name).flags).kind);
  const sourcePath = selectedSource ? resolve(projectRoot(), selectedSource) : sourcePathFor(name);
  if (selectedSource && !existsSync(sourcePath)) throw new Error(`Selected source does not exist: ${selectedSource}`);
  const symbol = resolveFunctionTarget(name).symbol;
  const sourceText = existsSync(sourcePath) ? readFileSync(sourcePath, "utf-8") : undefined;
  const sourceStatus = probeSourceStatus(sourceText, symbol);
  const sourceLabel = selectedSource ?? CURRENT_SOURCE_LABEL;
  const sourceHash = sourceStatus === "c-candidate" ? sha256(sourceText!) : null;

  const matrix: FlagMatrixRow[] = [];
  let matrixSkipped: string | undefined;
  if (sourceHash !== null || extraSources.length > 0) {
    const target = assembleTargetInstrs(name);
    if (!target) matrixSkipped = "no nonmatchings asm for masked scoring";
    else {
      /* The matrix is one slice through a two-dimensional space: a flag can
       * only pay off on the source shape it was meant for, and the shape that
       * needs it usually scores WORSE than the incumbent until the flag is
       * applied. Scoring candidate shapes as well as the current one is what
       * keeps a winning pair from being ranked away one axis at a time. */
      const sources: Array<[string, string | undefined]> = [
        ...(sourceHash !== null ? [[sourceLabel, selectedSource] as [string, string | undefined]] : []),
        ...extraSources.filter(path => path !== selectedSource).map((path) => [path, path] as [string, string]),
      ];
      for (const [label, path] of sources) {
        if (path) {
          const absolute = resolve(projectRoot(), path);
          if (!existsSync(absolute)) throw new Error(`Advisory source does not exist: ${path}`);
          if (probeSourceStatus(readFileSync(absolute, "utf-8"), symbol) !== "c-candidate") continue;
        }
        for (const [flagLabel, flags] of FLAG_MATRIX) {
          matrix.push(compileRow(name, flagLabel, flags, target, label, path));
        }
      }
    }
  }
  if (!matrixSkipped && matrix.length === 0) {
    matrixSkipped = sourceStatus === "assembly-stub"
      ? "selected function is an INCLUDE_ASM backlog stub; fingerprints only, pass --src <candidate.c> for a C flag matrix"
      : `no selected C candidate at ${sourcePath}`;
  }

  const verdict = concludeMatrix({ rows: matrix, fingerprints, sourceLabel });
  const report: FlagProbeReport = {
    schemaVersion: 1,
    function: name,
    sourceHash,
    sourcePath,
    sourceLabel,
    sourceStatus,
    targetHash: targetHashOf(name) ?? "",
    toolchainHash: toolchainHash(name),
    fingerprints,
    matrix,
    ...verdict,
  };
  const result: ProbeResult = { info, report, nearby: info.coordinate?.kind === "section" ? [...loadFlagOverrides()].map(([id, flags]) => `  ${id}: ${flags.join(" ")}`) : nearbyOverrides(info.vram, info.container) };
  if (matrixSkipped) result.matrixSkipped = matrixSkipped;
  return result;
}

export function writeReport(report: FlagProbeReport): string {
  const path = reportPath(report.function);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, stableJson(report));
  return path;
}

/** Read a report if one exists and parses. */
export function readReport(name: string): FlagProbeReport | null {
  const path = reportPath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && parsed.schemaVersion === 1 && parsed.function === name ? parsed as FlagProbeReport : null;
  } catch {
    return null;
  }
}

/* ---- rendering ---- */

export function renderProbe(result: ProbeResult): string {
  const { info, report, nearby } = result;
  const lines: string[] = [
    `flagProbe ${report.function} @${info.coordinate?.kind === "section" ? `${info.coordinate.section}+0x${info.vram.toString(16)}` : `0x${info.vram.toString(16).toUpperCase()}`} (${info.size} bytes)`,
    "",
    `Selected source: ${report.sourceLabel ?? CURRENT_SOURCE_LABEL} (${report.sourceStatus ?? "legacy report"})`,
    "Target structural fingerprints (from original bytes):",
  ];
  const preFatal = report.fingerprints.filter((item) => item.kind === "pre-fatal-shape");
  const selfClobber = report.fingerprints.filter((item) => item.kind === "self-clobber-shape");
  if (report.fingerprints.length === 0) {
    lines.push(
      "  none detected",
      "  Two detectors exist (nested-loop bottom increment; symbolic",
      "  lui/lw self-clobber). They are the shapes someone has encoded, not",
      "  the shapes that exist, so silence here is NOT evidence that flags",
      "  are irrelevant. Read the matrix below on its own merits, and treat a",
      "  property you have proven unreachable from any C shape as a",
      "  fingerprint in its own right — that proof is what the bar is for.");
  }
  for (const hit of preFatal) lines.push(`  [PRE-fatal shape] ${hit.detail}`);
  for (const hit of selfClobber) lines.push(`  [self-clobber shape] ${hit.detail}`);
  for (const hit of report.fingerprints.filter(item => item.kind === "expected-assembler-expansion")) lines.push(`  [expected assembler expansion; no flag nomination] ${hit.detail}`);
  if (preFatal.length > 0) {
    lines.push(
      "  PRE-fatal shape: try the counter-reuse idiom FIRST (psx_reference loop).",
      "  One counter variable shared across sequential loops may shield PRE;",
      "  measure this hypothesis under baseline flags. A flag delta is the",
      "  fallback, gated by the escalation bar below.");
  }
  if (selfClobber.length > 0) {
    lines.push(
      "  This register relation nominates address-splitting and scheduling",
      "  experiments; their effects and availability depend on the compiler.",
      "  Original words alone do not distinguish an explicit compiler address",
      "  sequence from a macro in the unknown original compiler input.",
      "  A failed/unsupported flag is inconclusive, not a refutation of the",
      "  configuration hypothesis. Only the selected C matrix measures a remedy.");
  }

  lines.push("", "Nearby/existing flag overrides:", nearby.length ? nearby.join("\n") : "  none");

  if (result.matrixSkipped) {
    lines.push("", `(${result.matrixSkipped}; fingerprints above stand on their own)`);
  } else {
    for (const label of [...new Set(report.matrix.map((row) => row.source))]) {
      lines.push("", `Flag matrix on ${label} (masked scores; bytes still decide):`);
      for (const row of report.matrix.filter((item) => item.source === label)) {
        lines.push(`  ${row.label.padEnd(42)} ${renderRow(row)}`);
      }
    }
    const selectedLabel = report.sourceLabel ?? CURRENT_SOURCE_LABEL;
    if (!report.matrix.some((row) => row.source === selectedLabel)) {
      lines.push(
        "",
        "  Only advisory sources were scored; they do not own the conclusion.",
        "  Pass --src <candidate.c> to select a C flag-matrix baseline.");
    } else if ([...new Set(report.matrix.map((row) => row.source))].length === 1) {
      lines.push(
        "",
        "  Only the selected source was scored. If a shape you rejected on score",
        "  is still mechanically plausible, re-run with --with-source <file> for",
        "  each: the flag that matters may be the one that only pays off there.");
    }
  }

  lines.push("", `Conclusion: ${report.conclusion}`);
  for (const reason of report.reasons) lines.push(`  - ${reason}`);

  lines.push(`
Escalation bar (psx_reference flags, section 11): a fingerprint above
PLUS a dominant flag column PLUS no contrary regional witness justifies
adding a directly preceded evidence comment and CC1FLAGS_<stem> := <extra cc1 flags>
in configs/flag_overrides.mk, together with its flag-override allowlist entry in
.pi/autoloop.json sourcePolicy.allowlist. Verify with psx_finalize_function({functionName: "<function>"}).`);
  return lines.join("\n");
}

/* ---- CLI ---- */

function main(): void {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (!name || name.startsWith("--")) {
    console.error("Usage: npx tsx tools/agent/flagProbe.ts <func_name> [--json] [--src <candidate.c>] [--with-source <file>]...");
    process.exit(1);
  }
  const json = argv.includes("--json");
  const extraSources: string[] = [];
  let selectedSource: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option !== "--src" && option !== "--with-source") {
      console.error(`Unknown argument: ${option}`); process.exit(1);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) { console.error(`${option} requires a path`); process.exit(1); }
    if (option === "--src") selectedSource = value;
    else extraSources.push(value);
  }

  let result: ProbeResult;
  try {
    result = probe(name, extraSources, selectedSource);
  } catch (error) {
    console.error(`flagProbe: ${(error as Error).message}`);
    process.exit(1);
  }
  const path = writeReport(result.report);
  if (json) console.log(stableJson(result.report));
  else console.log(`${renderProbe(result)}\n\nReport: ${path.slice(projectRoot().length + 1)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
