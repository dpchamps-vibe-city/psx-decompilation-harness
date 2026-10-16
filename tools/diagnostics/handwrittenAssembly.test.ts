import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import { projectFixture, FIXTURE_BASE, FIXTURE_OVERLAY_BASE } from "../testing/projectFixture.js";
import { harnessFixture } from "../testing/harnessFixture.js";
import { implementationPath, installedDependency, installedScriptArgs } from "../lib/installedScripts.js";
import { libraryMembers } from "../lib/libraryTargets.js";
import { scanHandwrittenAssembly, assemblySourceStatus, parseAssemblyScanArguments, renderAssemblyScan } from "./handwrittenAssembly.js";

const contextWords = [0xac900000, 0xac910004, 0xac920008, 0xac93000c, 0xac940010, 0xac950014, 0xac9d0018, 0xac9f001c, 0x03e00008, 0];
const ordinaryWords = [0x24820001, 0x03e00008, 0];
const script = "tools/diagnostics/handwrittenAssembly.ts";

test("project census uses original bytes, not disassembler comments, spelling or source guesses", t => {
  const f = projectFixture(t, { exe: [
    { name: "context_save", offset: 0, words: contextWords },
    { name: "_patch_looks_handwritten", offset: 0x40, words: ordinaryWords },
  ], overlays: {} });
  f.put("src/context_save.c", 'INCLUDE_ASM("build/asm/nonmatchings/context_save", context_save);\n');
  f.put("src/_patch_looks_handwritten.c", "long _patch_looks_handwritten(long x) { return x + 1; }\n");
  f.put("build/asm/nonmatchings/_patch_looks_handwritten/_patch_looks_handwritten.s", "/* Handwritten function */\nglabel _patch_looks_handwritten\nmfc0 $k0,$14\njr $k0\nrfe\n");
  fixtureContext(f.root, () => {
    const report = scanHandwrittenAssembly();
    assert.equal(report.summary.scanned, 2);
    assert.equal(report.complete, true);
    assert.equal(report.summary.assemblyCandidates, 1);
    assert.equal(report.modules.length, 2, "image containers are not translation units");
    assert(report.modules.every(m => m.functions.length === 1 && m.allFunctionsScanned && !m.wholeAssemblyCandidate));
    const context = report.functions.find(r => r.function === "context_save")!;
    assert.equal(context.disposition, "assembly-candidate");
    assert.deepEqual(context.coordinate, { kind: "image", vram: FIXTURE_BASE });
    const ordinary = report.functions.find(r => r.function === "_patch_looks_handwritten")!;
    assert.equal(ordinary.confidence.score, 0);
    assert.equal(ordinary.disposition, "keep-existing-C");
    const before = report.functions[0]!.originalSha256;
    f.put("src/context_save.c", "int context_save(void) { return 0; }\n");
    const again = scanHandwrittenAssembly({ functionNames: ["context_save"] });
    assert.equal(again.functions[0]!.confidence.level, "high", "source is not scoring evidence");
    assert.equal(again.functions[0]!.originalSha256, before);
    assert.equal(again.functions[0]!.eligibleForAssembly, false);
    assert.equal(again.functions[0]!.disposition, "keep-existing-C");
    assert.equal(readFileSync(join(f.root, "src/context_save.c"), "utf8"), "int context_save(void) { return 0; }\n");
  });
});

test("image/overlay ownership and filters remain explicit; display limits do not truncate the census", t => {
  const f = projectFixture(t, { exe: [{ name: "exe_save", offset: 0, words: contextWords }], overlays: {
    ovl_other: [{ name: "other_save", offset: 0, words: contextWords }],
  } });
  fixtureContext(f.root, () => {
    const report = scanHandwrittenAssembly();
    assert.equal(report.functions.length, 2);
    assert.equal(report.summary.assemblyCandidates, 2);
    assert(report.functions.some(r => r.coordinate.kind === "image" && r.coordinate.vram === FIXTURE_OVERLAY_BASE));
    assert.match(renderAssemblyScan(report, { all: true, limit: 1 }), /Showing 1 of 2/);
    assert.equal(report.functions.length, 2);
    const overlay = scanHandwrittenAssembly({ containerIds: ["ovl_other"] });
    assert.equal(overlay.scope, "selected-containers"); assert.equal(overlay.functions.length, 1);
    assert.equal(overlay.functions[0]!.container, "ovl_other");
    assert.throws(() => scanHandwrittenAssembly({ functionNames: ["absent"] }), /Unknown function/);
    assert.throws(() => scanHandwrittenAssembly({ containerIds: ["absent"] }), /Unknown or unscannable container/);
    assert.throws(() => scanHandwrittenAssembly({ functionNames: ["exe_save"], containerIds: ["ovl_other"] }), /select no functions/);
  });
});

test("source protection is AST-based and conservative about conditionals and malformed C", t => {
  const f = projectFixture(t, { overlays: {} });
  fixtureContext(f.root, () => {
    const source = (text: string) => { f.put("src/sample.c", text); return assemblySourceStatus("src/sample.c", "sample"); };
    assert.equal(source("/* INCLUDE_ASM(\"x\", sample); */\nint sample(void) { return 1; }\n").status, "C");
    assert.equal(source('INCLUDE_ASM("original", sample);\n').status, "INCLUDE_ASM");
    assert.equal(source('#if 0\nINCLUDE_ASM("original", sample);\n#endif\nint sample(void) { return 1; }\n').status, "C");
    assert.equal(source('#if 0\nint sample(void) { return 1; }\n#else\nINCLUDE_ASM("original", sample);\n#endif\n').status, "unresolved");
    assert.equal(source('#ifdef UNKNOWN\nINCLUDE_ASM("original", sample);\n#endif\n').status, "unresolved");
    assert.equal(source('asm("nop");\n').status, "unresolved");
    assert.equal(source("int sample(void) {\n").status, "unresolved");
    f.put("src/sample.s", ".text\nsample:\njr $31\nnop\n");
    assert.equal(assemblySourceStatus("src/sample.s", "sample").status, "assembly");
    assert.equal(assemblySourceStatus("src/missing.c", "sample").status, "missing");
  });
});

test("ELF census pairs real HI16/LO16 relocations and preserves original member ownership", t => {
  const f = projectFixture(t, { overlays: {} });
  f.put("input/module.s", `.set noreorder
.set noat
.text
.globl raw_patch
.type raw_patch,@function
raw_patch:
lui $1,%hi(saved+0x10000)
sw $31,%lo(saved+0x10000)($1)
jal external_service
nop
addi $2,$2,4
lui $31,%hi(saved+0x10000)
lw $31,%lo(saved+0x10000)($31)
nop
jr $31
nop
.size raw_patch,.-raw_patch
.globl neighbour
.type neighbour,@function
neighbour:
jr $31
nop
.size neighbour,.-neighbour
.bss
saved:
.space 0x10008
`);
  execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", join(f.root, "input/module.s"), "-o", join(f.root, "input/module.o")]);
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["input/module.o"] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "input" } }));
  fixtureContext(f.root, () => {
    const member = libraryMembers()[0]!;
    const directory = "src/libraries/module";
    f.put(`${directory}/tu.json`, JSON.stringify({ schemaVersion: 1, member: member.id, parts: [{ path: "raw_patch.c", symbol: "raw_patch" }, { path: "neighbour.c", symbol: "neighbour" }] }));
    f.put(`${directory}/raw_patch.c`, `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", raw_patch);\n`);
    f.put(`${directory}/neighbour.c`, "int neighbour(void) { return 0; }\n");
    const report = scanHandwrittenAssembly();
    assert.equal(report.summary.scanned, 2);
    assert.equal(report.summary.existingC, 1);
    const row = report.functions.find(r => r.function.endsWith("::raw_patch"))!;
    assert.equal(row.confidence.score, 85);
    assert.equal(row.disposition, "assembly-candidate");
    assert(row.signals.find(s => s.id === "external-return-state")!.evidence.some(e => e.storage === "symbol:section:.bss|65536"));
    assert.equal(row.owner.sha256, member.sha256);
    assert.equal(row.owner.input, "input/module.o");
    assert.equal(row.coordinate.kind, "section");
    assert.equal(report.modules.length, 1);
    assert.equal(report.modules[0]!.wholeAssemblyCandidate, false, "one assembly function cannot replace its C neighbour/module");
    assert.equal(report.modules[0]!.allFunctionsScanned, true);
    const one = scanHandwrittenAssembly({ functionNames: ["raw_patch"] });
    assert.equal(one.functions[0]!.function, `${member.id}::raw_patch`);
    assert.equal(one.modules[0]!.allFunctionsScanned, false);
    assert.throws(() => scanHandwrittenAssembly({ functionNames: ["absent"] }), /Unknown library function/);
  });
});

test("real ELF self-references distinguish copied handler fragments from executed instructions", t => {
  const f = projectFixture(t, { overlays: {} });
  f.put("input/installer.s", `.set noreorder
.set noat
.text
.space 32
.globl kernel_installer
.type kernel_installer,@function
kernel_installer:
lui $1,%hi(saved)
sw $31,%lo(saved)($1)
jal opaque_service
nop
lui $10,%hi(.Lpayload)
addiu $10,$10,%lo(.Lpayload)
lui $9,%hi(.Lpayload_end)
addiu $9,$9,%lo(.Lpayload_end)
.Lcopy:
lw $3,0($10)
nop
sw $3,0($2)
addiu $10,$10,4
bne $10,$9,.Lcopy
addiu $2,$2,4
lui $31,%hi(saved)
lw $31,%lo(saved)($31)
nop
jr $31
nop
.Lpayload:
sw $1,4($26)
sw $2,8($26)
mfc0 $2,$13
sw $3,12($26)
mfc0 $3,$14
sw $31,124($26)
.Lpayload_end:
.size kernel_installer,.-kernel_installer
.bss
saved:
.space 4
`);
  execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", join(f.root, "input/installer.s"), "-o", join(f.root, "input/installer.o")]);
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["input/installer.o"] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "input" } }));
  fixtureContext(f.root, () => {
    const member = libraryMembers()[0]!, directory = "src/libraries/installer";
    f.put(`${directory}/tu.json`, JSON.stringify({ schemaVersion: 1, member: member.id, parts: [{ path: "kernel_installer.c", symbol: "kernel_installer" }] }));
    f.put(`${directory}/kernel_installer.c`, `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", kernel_installer);\n`);
    const report = scanHandwrittenAssembly(), row = report.functions[0]!;
    assert.equal(report.scannerVersion, 4);
    assert.equal(row.coordinate.kind, "section");
    if (row.coordinate.kind === "section") assert.equal(row.coordinate.offset, 32);
    assert.equal(row.confidence.score, 85); assert(row.eligibleForAssembly);
    assert.deepEqual(row.embeddedCopies[0]!.source, { offset: 76, size: 24 });
    assert.equal(row.embeddedCopies[0]!.interpretation, "kernel-context-fragment");
    assert.equal(row.analysis.unreachableWords, 6);
    assert(!row.signals.some(s => ["privileged-operations", "kernel-gpr-use"].includes(s.id)));
    const text = renderAssemblyScan(report, { selected: true });
    assert.match(text, /embedded \+0x4c\.\.\+0x64: 6 copied words/);
    assert.match(text, /not directly executed/); assert.match(text, /\[copied payload\]/);
    f.put(`${directory}/kernel_installer.c`, "void kernel_installer(void) {}\n");
    const protectedRow = scanHandwrittenAssembly().functions[0]!;
    assert.equal(protectedRow.confidence.score, 85); assert.equal(protectedRow.disposition, "keep-existing-C");
  });
});

test("actual production-compiler C stays below the assembly threshold", { timeout: 120_000 }, async t => {
  const f = harnessFixture(t);
  const source = "extern void external_service(int);\nint ordinary(int *p, int x) { external_service(x); *p = x + 3; return x * 5; }\n";
  const built = await f.compile("ordinary", source, FIXTURE_BASE, { external_service: 0x80030000 });
  await f.install([{ name: "ordinary", offset: 0, words: built.words }]);
  f.put("src/ordinary.c", source);
  // harnessFixture establishes its own runtime context for production helpers;
  // the independent scanner is explicitly run against the same target root.
  fixtureContext(f.root, () => {
    const row = scanHandwrittenAssembly({ functionNames: ["ordinary"] }).functions[0]!;
    assert.equal(row.confidence.level, "low");
    assert.equal(row.disposition, "keep-existing-C");
    assert.equal(row.eligibleForAssembly, false);
    assert(row.signals.some(s => s.id === "conventional-call-frame"));
  });
});

test("CLI works through installed script hosting and writes only an explicit build report", t => {
  const f = projectFixture(t, { exe: [{ name: "context_save", offset: 0, words: contextWords }], overlays: {} });
  const run = (...args: string[]) => spawnSync(process.execPath, installedScriptArgs(script, args, f.root), { cwd: f.root, encoding: "utf8" });
  const result = run("--function", "context_save", "--json", "--output", "build/handwrittenAssembly/report.json");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.scanned, 1);
  assert.equal(report.functions[0].function, "context_save");
  assert.equal(report.functions[0].eligibleForAssembly, true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "build/handwrittenAssembly/report.json"), "utf8")), report);
  assert.equal(existsSync(join(f.root, "src/context_save.s")), false);
  for (const args of [["--threshold", "101"], ["--emit"], ["--function", "missing"], ["--output", "src/wrong.json"]]) {
    const rejected = run(...args); assert.notEqual(rejected.status, 0, JSON.stringify(args));
  }
  assert.equal(existsSync(join(f.root, "src/wrong.json")), false);
  f.put("src/untouched.json", "{}\n");
  symlinkSync(join(f.root, "src"), join(f.root, "build/source-link"));
  const throughLink = run("--output", "build/source-link/untouched.json");
  assert.notEqual(throughLink.status, 0); assert.match(throughLink.stderr, /symlink/);
  assert.equal(readFileSync(join(f.root, "src/untouched.json"), "utf8"), "{}\n");
});

test("help is asset/configuration-free and argument errors are explicit", t => {
  const root = mkdtempSync(join(tmpdir(), "psx-handwritten-help-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  // Enter directly: installedScriptArgs intentionally requires a configured
  // project, whereas this CLI's --help must not need any project context.
  const help = spawnSync(process.execPath, ["--import", installedDependency("tsx"), implementationPath(script), "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage:/);
  assert.equal(parseAssemblyScanArguments(["--function", "a", "--function", "b", "--threshold", "90"]).threshold, 90);
  assert.deepEqual(parseAssemblyScanArguments(["--function", "a", "--function", "b"]).functionNames, ["a", "b"]);
  for (const args of [["--bogus"], ["--function"], ["--limit", "0"], ["--threshold", "NaN"], ["--threshold", "1.5"]])
    assert.throws(() => parseAssemblyScanArguments(args), /Unknown|requires a value|integer/);
});
