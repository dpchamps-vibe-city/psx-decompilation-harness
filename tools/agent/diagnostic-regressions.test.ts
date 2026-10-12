import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writeObjectFunctionView } from "../lib/compilerArtifacts.js";
import { disassembleFunctionObject } from "./decompToolchain.js";
import { join } from "node:path";
import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import { StubSourceError } from "../lib/functionOracle.js";
import { digest } from "../lib/contentCache.js";
import { loadToolchain } from "../lib/toolchain.js";
import { firstPseudoRegister, parseRtlInstructions } from "./compiler-trace/rtl-parser.js";
import { buildPseudoProvenance } from "./compiler-trace/pseudo-provenance.js";
import { analyzeAllocation } from "./compiler-trace/local-allocation.js";
import { semanticInstructionSignature } from "./compiler-trace/rtl-notes.js";
import { reconstructHardRegisterLifetimes } from "./allocator-counterfactual/analyze.js";
import { parseCc1Assembly, normalizeDisassembly } from "./variant-lab/compile.js";
import { analyzeTargetScheduleFromArtifacts } from "./target-schedule/analyze.js";
import type { CompilerTraceReport } from "./compiler-trace/types.js";
import { bestMeasuredEntry, residualReportJson, renderResidualReport, type Entry } from "./residualObjective.js";
import type { ResidualObjective } from "./pipeline-reversal/objective.js";
import { buildTraceReportFromArtifacts } from "./compilerTrace.js";
import { repairReport } from "./nearMissRepair.js";
import { requireRecipeAtlasImageSupport, UnsupportedRecipeAtlasTarget } from "./recipe-atlas/target-support.js";

function temp(t: { after(f: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "harness-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(loadToolchain()));
  return root;
}
function registerProject(t: { after(f: () => void): void }, boundary: number): string {
  const root = temp(t), config = structuredClone(loadToolchain());
  config.compiler.source = { origin: "project", path: "compiler-source" };
  config.tools.cc1 = { origin: "project", path: "cc1" };
  const binary = `synthetic identity ${boundary} — never executed`;
  writeFileSync(join(root, "cc1"), binary);
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const source = `#define FIRST_PSEUDO_REGISTER ${boundary}\n`;
  mkdirSync(join(root, "compiler-source/src/gcc/config/mips"), { recursive: true });
  writeFileSync(join(root, "compiler-source/src/gcc/config/mips/mips.h"), source);
  writeFileSync(join(root, "compiler-source/pin.json"), JSON.stringify({
    name: "fixture", gccVersion: config.compiler.version,
    correspondsTo: { binary: "cc1", binarySha256: digest(binary), recipe: "fixture", target: "mips-sony-psx" },
    tree: { root: "src", sha256: digest(`${digest(source)}  gcc/config/mips/mips.h\n`), files: 1 },
  }));
  return root;
}

test("register interpretation follows runtime source identity, retaining every low pseudo allocation", t => {
  const sixtyEight = registerProject(t, 68), eighty = registerProject(t, 80);
  const assignments = [[73, 5], [75, 4], [78, 4], [80, 2], [81, 2], [82, 3], [83, 3]];
  const rtl = assignments.map(([pseudo], i) => `(insn ${10 + i} 0 0 (set (reg:SI ${pseudo}) (const_int 1)) -1 (nil) (nil))`).join("\n");
  const lreg = `84 registers.\n;; Start of basic block 0, registers live: 4\n` +
    assignments.map(([pseudo, hard]) => `;; Register ${pseudo} in ${hard}.`).join("\n") + "\n" + rtl;
  const check = (root: string, boundary: number, pseudos: number[]) => fixtureContext(root, () => {
    assert.equal(firstPseudoRegister(), boundary);
    const instructions = parseRtlInstructions(lreg, "lreg");
    assert.deepEqual([...buildPseudoProvenance(["lreg"], new Map([["lreg", instructions]])).keys()], pseudos);
    const allocation = analyzeAllocation(lreg, "", instructions);
    assert.deepEqual([...allocation.records.keys()], pseudos);
    for (const [pseudo, hard] of assignments.filter(([pseudo]) => pseudo! >= boundary))
      assert.equal(allocation.records.get(pseudo!)?.assignedHardReg, hard);
    const hard = reconstructHardRegisterLifetimes(lreg, instructions);
    assert.equal(hard.some(range => range.register === 73), boundary > 73);
    const low = parseRtlInstructions("(insn 1 0 0 (set (reg:SI 2) (reg:SI 73)) -1 (nil) (nil))", "lreg")[0]!;
    const high = parseRtlInstructions("(insn 1 0 0 (set (reg:SI 2) (reg:SI 100)) -1 (nil) (nil))", "lreg")[0]!;
    assert.equal(semanticInstructionSignature(low) === semanticInstructionSignature(high), boundary <= 73);
  });
  check(sixtyEight, 68, [73, 75, 78, 80, 81, 82, 83]);
  check(eighty, 80, [80, 81, 82, 83]);
  check(sixtyEight, 68, [73, 75, 78, 80, 81, 82, 83]);
  fixtureContext(sixtyEight, () => {
    writeFileSync(join(sixtyEight, "cc1"), "different compiler identity");
    assert.throws(() => firstPseudoRegister(), /Compiler-source binding mismatch/);
  });
});

test("missing register source does not prevent native RTL parsing or invent a register classification", t => {
  const root = temp(t);
  const config = structuredClone(loadToolchain());
  config.compiler.source = { origin: "project", path: "missing-source" };
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  fixtureContext(root, () => {
    const instructions = parseRtlInstructions("(insn 10 0 0 (set (reg:SI 2) (reg:SI 73)) -1 (nil) (nil))", "rtl");
    assert.equal(instructions.length, 1);
    assert.throws(() => firstPseudoRegister(), /No pinned source/);
    assert.match(semanticInstructionSignature(instructions[0]!), /unclassified-73/);
  });
});

test("preserved trace rejects absent named RTL and keeps native stages when only the register model is missing", t => {
  const root = temp(t), config = structuredClone(loadToolchain());
  config.compiler.source = { origin: "project", path: "missing-source" };
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  writeFileSync(join(root, "candidate.c"), "int StopRCnt(void) { return 1; }\n");
  writeFileSync(join(root, "candidate.s"), asm("GetRCnt", 9) + asm("StopRCnt", 1));
  const name = "lib_0123456789abcdef_0::StopRCnt";
  const dump = join(root, `${name}.i.dbr`);
  writeFileSync(dump, insn("GetRCnt", 1, 9));
  fixtureContext(root, () => {
    const options = { functionName: name, sourcePath: join(root, "candidate.c"), assemblyPath: join(root, "candidate.s"),
      dumpDirectory: root, outputDirectory: root, flags: [] };
    assert.throws(() => buildTraceReportFromArtifacts(options), /No selected C\/RTL for StopRCnt.*--src/);
    writeFileSync(dump, insn("GetRCnt", 1, 9) + insn("StopRCnt", 10, 1));
    const report = buildTraceReportFromArtifacts(options);
    assert.equal(report.stages[0]!.instructionCount, 1);
    assert.equal(report.registerModel?.status, "unavailable");
    assert.ok(report.caveats.some(c => c.includes("Native RTL remains available")));
    assert.equal(report.pseudos.length, 0);
  });
});

function trace(root: string): CompilerTraceReport {
  return { schemaVersion: 2, function: "lib_0123456789abcdef_0::StopRCnt", source: "candidate.c",
    outputDirectory: root, assembly: "candidate.s", reportArtifact: "report.json", flags: [],
    stages: [{ suffix: "dbr", file: "candidate.i.dbr", bytes: 10, instructionCount: 1, noteCount: 0,
      loopRegionCount: 0, maximumLoopDepth: 0, pseudoCount: 0, pseudoOccurrences: 0 }],
    stageMetadata: [], pseudos: [], allocationOrder: [], schedulers: [], feedback: [], recurrenceHints: [],
    caveats: ["fixture: no verified pass model"] };
}
const insn = (name: string, uid: number, value: number) => `;; Function ${name}\n(insn ${uid} 0 0 (set (reg:SI 2 v0) (const_int ${value})) 1 (nil) (nil))\n`;
const asm = (name: string, value: number) => `.ent ${name}\n${name}:\nli $2,${value}\n.end ${name}\n`;

test("schedule analysis selects only the named RTL and assembly, even from a preserved whole TU", t => {
  const root = temp(t);
  writeFileSync(join(root, "candidate.i.dbr"), insn("GetRCnt", 1, 9) + insn("StopRCnt", 10, 1) + insn("StartRCnt", 20, 7));
  writeFileSync(join(root, "candidate.s"), asm("GetRCnt", 9) + asm("StopRCnt", 1) + asm("StartRCnt", 7));
  fixtureContext(root, () => {
    const selected = trace(root);
    const result = analyzeTargetScheduleFromArtifacts({ functionName: selected.function, trace: selected,
      target: [{ mnemonic: "li", operands: ["v0", "1"], canonical: "li v0,1" }],
      candidate: parseCc1Assembly(join(root, "candidate.s"), "StopRCnt"), outputDirectory: root, maxInterventions: 1 });
    assert.equal(result.candidate.length, 1);
    assert.equal(result.candidate[0]!.canonical, "li v0,1");
    assert.equal(result.candidate[0]!.uid, 10);
    assert.ok(result.caveats.includes(selected.caveats[0]!));
  });
});

test("schedule machine population comes from the selected production object, not unexpanded cc1 macro lines", t => {
  const root = temp(t), assembly = asm("GetRCnt", 9) +
    ".ent StopRCnt\n.globl StopRCnt\nStopRCnt:\nlw $2, datum\n.end StopRCnt\n" + asm("StartRCnt", 7);
  writeFileSync(join(root, "candidate.s"), assembly);
  writeFileSync(join(root, "assembled.s"), ".set noreorder\n.text\n" + assembly + ".data\ndatum: .word 0\n");
  writeFileSync(join(root, "candidate.i.dbr"), ";; Function StopRCnt\n(insn 10 0 0 (set (reg:SI 2 v0) (mem:SI (symbol_ref:SI (\"datum\")))) 1 (nil) (nil))\n");
  execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", join(root, "assembled.s"), "-o", join(root, "candidate.o")]);
  writeObjectFunctionView(join(root, "candidate.o"), "StopRCnt");
  fixtureContext(root, () => {
    const selected = { ...trace(root), function: "StopRCnt", candidateObject: "candidate.o" };
    const target = normalizeDisassembly(disassembleFunctionObject(join(root, "candidate.o"), "StopRCnt"));
    assert.equal(target.length, 2);
    assert.equal(parseCc1Assembly(join(root, "candidate.s"), "StopRCnt").length, 1);
    const options = { functionName: "StopRCnt", trace: selected, target, outputDirectory: root, maxInterventions: 1 };
    const result = analyzeTargetScheduleFromArtifacts(options);
    assert.equal(result.candidate.length, 2);
    assert.deepEqual(result.candidate.map(i => i.canonical), target.map(i => i.canonical));
    assert.equal(result.emissionCountExact, false, "unknown macro UID expansion must not become an exact link");
    assert.throws(() => analyzeTargetScheduleFromArtifacts({ ...options, trace: trace(root), functionName: trace(root).function }),
      /No assembled candidate object/);
  });
});

test("missing selected final RTL refuses neighbor constraints, even if a supplied candidate looks exact", t => {
  const root = temp(t);
  writeFileSync(join(root, "candidate.i.dbr"), insn("GetRCnt", 1, 9) + insn("StartRCnt", 20, 7));
  writeFileSync(join(root, "candidate.s"), asm("GetRCnt", 9) + asm("StartRCnt", 7));
  fixtureContext(root, () => {
    const selected = trace(root);
    const options = { functionName: selected.function, trace: selected, target: [], candidate: [], outputDirectory: root, maxInterventions: 1 };
    assert.throws(() => analyzeTargetScheduleFromArtifacts(options), /does not identify exactly one StopRCnt/);
    selected.stages[0]!.instructionCount = 0;
    assert.throws(() => analyzeTargetScheduleFromArtifacts(options), /No selected final C\/RTL.*--src/);
  });
});

function entry(label: string, population: number, stub = false): Entry {
  const objective: ResidualObjective = { functionName: "f", exact: false, key: [0, population, 0, 0],
    controlFlow: 0, population, schedule: 0, allocation: 0, undetermined: 0, degraded: false, blindBlocks: [],
    blocks: population ? [{ block: 2, population, schedule: 0, allocation: 0, coalescing: 0, suppressed: 0, blind: false, total: population, signature: "fixture" }] : [] };
  return { label, stub, objective, matchedWords: stub ? 0 : 10, totalWords: stub ? 0 : 13,
    objectHash: label, provenance: { value: { object: "candidate.o", source: `${label}.c` }, regenerated: false,
      provenance: { fingerprint: "fixture", files: {} } } as Entry["provenance"] };
}

test("JSON preserves raw evidence and interpretation; work belongs to the best measured nonstub", () => {
  const baseline = entry("live", 0, true), worse = entry("worse", 5), best = entry("draft", 2);
  best.residualOwner = "not established";
  best.analysis = { confidence: "provisional", detail: "replay not verified" };
  best.rawDifferences = { coordinate: { kind: "section", section: ".text", offset: 0, size: 52, inferredSize: false }, rows: [] };
  const entries = [baseline, worse, best];
  assert.equal(bestMeasuredEntry(entries)?.label, "draft");
  const report = residualReportJson("f", entries);
  assert.equal(report.best, "draft"); assert.equal(report.work[0]?.block.population, 2);
  assert.equal(report.entries[0]!.stub, true);
  assert.equal(report.entries[2]!.residualOwner, "not established");
  assert.deepEqual(report.entries[2]!.rawDifferences, best.rawDifferences);
  assert.equal(report.entries[2]!.interpretation.confidence, "provisional");
  best.objective = entry("zero", 0).objective;
  const zero = residualReportJson("f", entries).entries[2]!;
  assert.equal(zero.interpretation.status, "unexplained-byte-residual");
  assert.equal(zero.objective.exact, false);
  assert.equal(zero.matchedWords, 10); assert.equal(zero.totalWords, 13);
  assert.ok(Object.hasOwn(zero, "assemblerExpansion"));
  assert.equal(residualReportJson("f", [baseline]).best, null);
});

test("incomplete value comparison is explicit and candidate assembler excerpts are not the default next action", () => {
  const candidate = entry("draft", 0);
  candidate.objective.allocationCoverage = { complete: false, targetUnpaired: [2, 3], candidateUnpaired: [] };
  candidate.residualOwner = "not established — incomplete value-web correspondence";
  candidate.assemblerExpansion = { receipt: "production-receipt.json", expandedExcerpt: ["EXPAND_AT_SENTINEL"] } as Entry["assemblerExpansion"];
  const entries = [entry("live", 0, true), candidate];
  assert.equal(residualReportJson("f", entries).entries[1]!.interpretation.status, "incomplete-value-comparison");
  const text = renderResidualReport("f", entries);
  assert.match(text, /incomplete/);
  assert.match(text, /Allocation is ungraded, not zero/);
  assert.match(text, /src set to this measured candidate/);
  assert.doesNotMatch(text, /EXPAND_AT_SENTINEL/);
});

test("stub diagnostics name the real object marker for both bare and owner-qualified function keys", () => {
  for (const key of ["StopRCnt", "lib_0123456789abcdef_0::StopRCnt"]) {
    const error = new StubSourceError(key, "candidate.o");
    assert.equal(error.functionName, key);
    assert.match(error.message, /defines StopRCnt\.NON_MATCHING/);
  }
});

test("library atlas and near-miss repair refuse their unsupported coordinate/flag domain before EXE lookup", t => {
  const root = temp(t);
  writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1,
    target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["input.o"] } }));
  fixtureContext(root, () => {
    for (const call of [() => requireRecipeAtlasImageSupport("psx_recipe_atlas"), () => repairReport("StopRCnt")]) {
      assert.throws(call, error => error instanceof UnsupportedRecipeAtlasTarget && error.status === "unsupported-target" &&
        error.message.includes("No PS-X EXE lookup or recipe compilation was attempted"));
    }
    assert.equal(existsSync(join(root, "build")), false);
  });
});
