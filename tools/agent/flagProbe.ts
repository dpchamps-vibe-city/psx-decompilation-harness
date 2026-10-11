#!/usr/bin/env npx tsx
import { projectRoot } from "../lib/runtimeContext.js";
/**
 * flagProbe.ts — early per-file flag-hypothesis check for one function.
 *
 * Usage:
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98 --json
 *   npx tsx tools/agent/flagProbe.ts func_8001FF98 --with-source build/candidate.c
 *
 * Run this BEFORE burning effort on source-shape archaeology. It answers:
 * "does the target carry a fingerprint that is unreachable (or nearly so)
 * from natural C under the baseline flags, and does a per-file flag delta
 * dominate?" See `psx_reference flags`, section 11, for the governed
 * escalation bar. Historical fingerprints are hypotheses to measure, not
 * evidence about a new target's flags.
 *
 * Three independent evidence sources:
 *   1. Target structural fingerprints, decoded from the original binary's
 *      bytes (no source needed):
 *      - nested loop with an in-place bottom-of-loop counter increment
 *        (unreachable from natural C under -fgcse: 2.95.2 loop-PRE splits it;
 *        signals -fno-gcse)
 *      - sequential lui/lw self-clobbering loads: symbolic %hi/%lo pairs
 *        signal -mno-split-addresses (unsplit assembler-macro load;
 *        func_800165D8/func_80016C08 precedent); non-symbolic or
 *        lui-grouping shapes signal -fno-schedule-insns
 *        -fno-schedule-insns2 (SetGfxClip precedent)
 *   2. Flag-matrix compile of the current src/<name>.c (if present): masked
 *      score + instruction count per candidate flag set.
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
import { join } from "path";
import { compileSource, configuredTool, runTool, loadFlagOverrides, assembleTarget, disassembleObject, configuredGccVersion, configuredToolchainIdentity, resolveAsmSource, sourcePathFor } from "./decompToolchain.js";
import { sha256, stableJson } from "./variant-lab/artifacts.js";
import { type Container } from "../lib/container.js";
import { addressEncodedInName, locateFunction } from "../lib/symbolIndex.js";
import { resolveFunctionTarget, type FunctionTarget } from "../lib/targetAdapter.js";
import { loadLibraryProject } from "../lib/project.js";
import { targetWordsOf } from "../lib/functionOracle.js";
import { configuredFlags } from "../lib/toolchain.js";

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

export type FingerprintKind = "pre-fatal-shape" | "self-clobber-shape";

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
  /** SHA-256 of src/<function>.c, or null when there is no source yet. */
  sourceHash: string | null;
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
export function fingerprintSelfClobberLoads(words: number[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (a >>> 26 !== 15) continue;                    /* lui rt,imm */
    const rt = (a >>> 16) & 0x1f;
    if (b >>> 26 === 35 && ((b >>> 21) & 0x1f) === rt && ((b >>> 16) & 0x1f) === rt) {
      hits.push(`lui/lw self-clobber at words ${i}-${i + 1} (reg $${rt})`);
    }
  }
  return hits;
}

export function fingerprintsOf(words: number[]): Fingerprint[] {
  return [
    ...fingerprintBottomIncrement(words).map((detail): Fingerprint => ({
      kind: "pre-fatal-shape",
      detail,
      candidates: ["-fno-gcse", "-fno-gcse -fno-schedule-insns{,2}"],
    })),
    ...fingerprintSelfClobberLoads(words).map((detail): Fingerprint => ({
      kind: "self-clobber-shape",
      detail,
      candidates: ["-mno-split-addresses", "-fno-schedule-insns{,2}", "-fno-schedule-insns2"],
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
    row.error = "compile failed";
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
  if (row.error) return row.error;
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

export function toolchainHash(): string {
  return sha256(stableJson(configuredToolchainIdentity()));
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

export function probe(name: string, extraSources: string[] = []): ProbeResult {
  const info = getFuncInfo(name);
  if (!info || !info.size) throw new Error(`${name} has no sized subsegment in any container's splat config`);

  const words = targetWordsOf(name, info.container ? { container: info.container } : {}).map(w => w.raw);
  const fingerprints = fingerprintsOf(words);
  const sourcePath = sourcePathFor(name);
  const sourceHash = existsSync(sourcePath) ? sha256(readFileSync(sourcePath, "utf-8")) : null;

  const matrix: FlagMatrixRow[] = [];
  let matrixSkipped: string | undefined;
  if (sourceHash !== null) {
    const target = assembleTargetInstrs(name);
    if (!target) matrixSkipped = "no nonmatchings asm for masked scoring";
    else {
      /* The matrix is one slice through a two-dimensional space: a flag can
       * only pay off on the source shape it was meant for, and the shape that
       * needs it usually scores WORSE than the incumbent until the flag is
       * applied. Scoring candidate shapes as well as the current one is what
       * keeps a winning pair from being ranked away one axis at a time. */
      const sources: Array<[string, string | undefined]> = [
        [CURRENT_SOURCE_LABEL, undefined],
        ...extraSources.map((path) => [path, path] as [string, string]),
      ];
      for (const [label, path] of sources) {
        for (const [flagLabel, flags] of FLAG_MATRIX) {
          matrix.push(compileRow(name, flagLabel, flags, target, label, path));
        }
      }
    }
  } else {
    matrixSkipped = `no src/${name}.c yet`;
  }

  const verdict = concludeMatrix({ rows: matrix, fingerprints, sourceLabel: CURRENT_SOURCE_LABEL });
  const report: FlagProbeReport = {
    schemaVersion: 1,
    function: name,
    sourceHash,
    targetHash: targetHashOf(name) ?? "",
    toolchainHash: toolchainHash(),
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
  if (preFatal.length > 0) {
    lines.push(
      "  PRE-fatal shape: try the counter-reuse idiom FIRST (psx_reference loop).",
      "  One counter variable shared across sequential loops may shield PRE;",
      "  measure this hypothesis under baseline flags. A flag delta is the",
      "  fallback, gated by the escalation bar below.");
  }
  if (selfClobber.length > 0) {
    lines.push(
      "  self-clobber shape: two distinct remedies, decided by the lui's operand.",
      "  If the pair is a SYMBOLIC address (lui %hi / lw %lo of a global), it is",
      "  the unsplit assembler-macro load: -mno-split-addresses candidate",
      "  (func_800165D8/func_80016C08 precedent — under split addresses the lui",
      "  is an independent insn and sched2 lifts it away; no source shape or",
      "  allocation can pin it unless an intervening insn touches its register).",
      "  If the pairs are non-symbolic or the issue is lui GROUPING across",
      "  consecutive loads, it is the scheduling class (SetGfxClip/SetGfxOffset",
      "  precedent: -fno-schedule-insns{,2}). Calibration 2026-07-31: on the",
      "  decompiled corpus this fires only on documented hard cases and pinned",
      "  files.");
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
    if ([...new Set(report.matrix.map((row) => row.source))].length === 1) {
      lines.push(
        "",
        "  Only the current source was scored. If a shape you rejected on score",
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
    console.error("Usage: npx tsx tools/agent/flagProbe.ts <func_name> [--json] [--with-source <file>]...");
    process.exit(1);
  }
  const json = argv.includes("--json");
  const extraSources: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] !== "--with-source") continue;
    const value = argv[++index];
    if (!value) { console.error("--with-source requires a path"); process.exit(1); }
    extraSources.push(value);
  }

  let result: ProbeResult;
  try {
    result = probe(name, extraSources);
  } catch (error) {
    console.error(`flagProbe: ${(error as Error).message}`);
    process.exit(1);
  }
  const path = writeReport(result.report);
  if (json) console.log(stableJson(result.report));
  else console.log(`${renderProbe(result)}\n\nReport: ${path.slice(projectRoot().length + 1)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
