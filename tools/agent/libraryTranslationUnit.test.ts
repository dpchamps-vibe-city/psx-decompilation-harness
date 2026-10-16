import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { LibraryMember } from "../lib/libraryTargets.js";
import { planLibraryTu, writeLibraryTu, extendLibraryBacklog } from "./librarySources.js";
import { inspectLibraryPart, libraryAssemblyTu, libraryCompileInput, librarySourceFiles, libraryTuStatus, readLibraryTu } from "../lib/libraryTranslationUnit.js";
import { libraryAssemblyParts } from "../lib/libraryAssembly.js";
import { compareRelocatableObjects, readRelocatableObject, objectFunctions } from "../lib/relocatableObject.js";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";
import { libraryMemberSource } from "../lib/librarySourceLayout.js";
import type { LibraryProject } from "../lib/project.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "psx-directory-tu-"));
  const member = { id: "lib_0123456789abcdef_0", source: "src/lib/counter/tu.json", functions: [{ name: "first" }, { name: "second" }] } as LibraryMember;
  const stub = (name: string) => `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", ${name});\n`;
  return { root, member, stub, directory: join(root, dirname(member.source)) };
}

test("directory layout retains original member grouping and archive ordinals", () => {
  const p = { output: { sourceDir: "src/lib", sourceLayout: "tu-directory", inputRoot: "input" }, target: { archives: [], standaloneObjects: ["input/**/*.o"] } } as LibraryProject;
  assert.equal(libraryMemberSource(p, { path: "input/liba/counter.o", archive: false }, { name: "counter.o", ordinal: 0 }, "id"), "src/lib/liba/counter/tu.json");
  assert.equal(libraryMemberSource(p, { path: "input/liba.a", archive: true }, { name: "counter.o", ordinal: 7 }, "id"), "src/lib/liba/7-counter/tu.json");
});

test("AST split preserves private declarations, function order and separate data backlog", () => {
  const f = fixture();
  try {
    const text = `/* original */\n#include "common.h"\nstatic int private_data;\nint first(void) { return private_data; }\nstatic int between;\n${f.stub("second")}${f.stub("__library_member_data")}`;
    const plan = planLibraryTu(f.member, text);
    assert.deepEqual(plan.manifest.parts.map(p => p.path), ["_shared-0.h", "first.c", "_shared-1.h", "second.c", "_data.c"]);
    assert.match(plan.files.get("_shared-0.h")!, /static int private_data/);
    assert.match(plan.files.get("_shared-1.h")!, /static int between/);
    writeLibraryTu(f.member, text, f.root);
    assert.equal(libraryTuStatus(f.member, f.root)!.find(p => p.symbol === "first")!.stub, false);
    assert.equal(libraryTuStatus(f.member, f.root)!.find(p => p.symbol === "second")!.stub, true);
    assert.equal(libraryTuStatus(f.member, f.root)!.find(p => p.symbol === "__library_member_data")!.stub, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("normal TU compile input and one-function variants use the SAME ordered composition", () => {
  const f = fixture();
  try {
    writeLibraryTu(f.member, `static int private_data = 7;\nint first(void) { return private_data; }\nint second(void) { return first(); }\n`, f.root);
    const normal = libraryCompileInput(f.member, join(f.root, f.member.source), join(f.root, "build/normal"), f.root);
    const candidate = join(f.root, "candidate.c"); writeFileSync(candidate, "int first(void) { return private_data + 1; }\n");
    const variant = libraryCompileInput(f.member, candidate, join(f.root, "build/variant"), f.root, "first");
    const originalLines = readFileSync(normal, "utf8").split("\n"), variantLines = readFileSync(variant, "utf8").split("\n");
    assert.deepEqual(originalLines.map((s, i) => s === variantLines[i] ? null : [s, variantLines[i]]).filter(Boolean), [[`#include ${JSON.stringify(join(f.directory, "first.c"))}`, `#include ${JSON.stringify(candidate)}`]]);
    // Host compiler only verifies the C composition contract, not MIPS matching.
    for (const input of [normal, variant]) execFileSync("cc", ["-std=c89", "-c", input, "-o", `${input}.o`]);
    assert.equal(readFileSync(join(f.directory, "first.c"), "utf8").trim(), "int first(void) { return private_data; }");
    const inferred = libraryCompileInput(f.member, candidate, join(f.root, "build/inferred"), f.root);
    assert.equal(readFileSync(inferred, "utf8"), readFileSync(variant, "utf8"));
    writeFileSync(candidate, "int foreign(void) { return 0; }\n");
    assert.throws(() => libraryCompileInput(f.member, candidate, join(f.root, "build/unknown"), f.root), /identify one function/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("mixed stubs, multi-function candidates and wrong assembly ownership are rejected", () => {
  const f = fixture();
  try {
    assert.throws(() => inspectLibraryPart(f.stub("first") + "int second(void) { return 0; }", { path: "first.c", symbol: "first" }), /mixed\/partial/);
    assert.throws(() => inspectLibraryPart("int first(void) { return 0; } int second(void) { return 0; }", { path: "first.c", symbol: "first" }), /define only first/);
    assert.throws(() => inspectLibraryPart("int first(void) { int nested(void) { return 1; } return nested(); }", { path: "first.c", symbol: "first" }), /nested function definitions/);
    assert.throws(() => inspectLibraryPart(f.stub("second"), { path: "first.c", symbol: "first" }), /mixed\/partial/);
    assert.throws(() => inspectLibraryPart("int first(void) { return 0; }", { path: "_shared.h" }), /cannot define functions/);
    writeLibraryTu(f.member, f.stub("first") + f.stub("second"), f.root);
    writeFileSync(join(f.directory, "first.c"), 'INCLUDE_ASM("elsewhere", first);\n');
    assert.throws(() => libraryTuStatus(f.member, f.root), /original assembly/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("manifest cannot drop neighbors, alias parts, pin flags or escape its directory", () => {
  for (const mutate of [
    (m: any) => m.parts.pop(),
    (m: any) => m.parts.push(m.parts[0]),
    (m: any) => m.flags = ["-O0"],
    (m: any) => m.parts[0].path = "../first.c",
  ]) {
    const f = fixture();
    try {
      writeLibraryTu(f.member, f.stub("first") + f.stub("second"), f.root);
      const manifest = readLibraryTu(f.member, f.root); mutate(manifest);
      writeFileSync(join(f.root, f.member.source), JSON.stringify(manifest));
      assert.throws(() => readLibraryTu(f.member, f.root), /Invalid|every original function/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = fixture();
  try {
    writeLibraryTu(f.member, f.stub("first") + f.stub("second"), f.root);
    const outside = join(f.root, "outside.c"); writeFileSync(outside, "int first(void) { return 0; }");
    rmSync(join(f.directory, "first.c")); symlinkSync(outside, join(f.directory, "first.c"));
    assert.throws(() => readLibraryTu(f.member, f.root), /escapes its directory/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("safe migration refuses ambiguous conditional boundaries without publishing files", () => {
  const f = fixture();
  try {
    for (const source of [`#if CONDITION\n${f.stub("first")}#endif\n${f.stub("second")}`, `int first(void) { return __LINE__; }\n${f.stub("second")}`]) {
      assert.throws(() => writeLibraryTu(f.member, source, f.root), /source review|directive review/);
      assert.equal(existsSync(f.directory), false);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("case-distinct symbols get stable, non-colliding function files", () => {
  const f = fixture();
  try {
    f.member.functions = [{ name: "StartGun" }, { name: "StartGUN" }] as LibraryMember["functions"];
    writeLibraryTu(f.member, f.stub("StartGun") + f.stub("StartGUN"), f.root);
    assert.deepEqual(readLibraryTu(f.member, f.root).parts.map(p => p.path), ["0-StartGun.c", "1-StartGUN.c"]);
    f.member.object = { symbols: [{ name: "StartGun" }, { name: "StartGUN" }] } as LibraryMember["object"];
    f.member.functions.reverse(); // Address sorting may differ from symbol-table order.
    f.member.functions.unshift({ name: "func_text_00000010", section: ".text", offset: 16, size: 8,
      inferredSize: true, discovery: { kind: "call-relocation", sites: [] } });
    assert.deepEqual(readLibraryTu(f.member, f.root, { allowDiscoveredBacklog: true }).parts.map(p => p.path),
      ["0-StartGun.c", "1-StartGUN.c"], "private discovery must not renumber existing function paths");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("generated reference stubs preserve the strict whole-object oracle, private relocations and public symbol population", () => {
  const f = fixture();
  try {
    const pristine = `.set noreorder\n.section .text\n.globl first\n.type first, @function\nfirst:\nlui $2, %hi(.Lprivate+4)\nlw $2, %lo(.Lprivate+4)($2)\njr $31\nnop\n.size first, .-first\n.globl second\n.type second, @function\nsecond:\njr $31\nnop\n.size second, .-second\n.section .data\n.Lprivate:\n.word 0\n.word 7\n`;
    writeFileSync(join(f.root, "original.s"), pristine);
    execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", join(f.root, "original.s"), "-o", join(f.root, "original.o")]);
    const bytes = readFileSync(join(f.root, "original.o")), object = readRelocatableObject(bytes);
    f.member.object = object; f.member.functions = objectFunctions(object);
    const listing = `.section .text\nnonmatching first, 16\nglabel first\nlui $2, %hi(private_value)\nlw $2, %lo(private_value)($2)\njr $31\nnop\nendlabel first\nnonmatching second, 8\nglabel second\njr $31\nnop\nendlabel second\n.section .data\nnonmatching private_base\ndlabel private_base\n.word 0\nenddlabel private_base\nnonmatching private_value\ndlabel private_value\n.word 7\nenddlabel private_value\n`;
    const parts = libraryAssemblyParts(f.member, listing);
    writeFileSync(join(f.root, "candidate.s"), parts.map(p => p.text).join("\n"));
    const assemble = () => { execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", "-I", join(HARNESS_ROOT, "include"), join(f.root, "candidate.s"), "-o", join(f.root, "candidate.o")]); return readFileSync(join(f.root, "candidate.o")); };
    assert.equal(compareRelocatableObjects(bytes, assemble()).verdict, "match");
    const candidate = readRelocatableObject(readFileSync(join(f.root, "candidate.o")));
    assert(candidate.symbols.some(s => s.name === "first.NON_MATCHING" && s.binding === 0));
    assert.equal(candidate.relocations[0]!.reference, ".data@0");
    writeFileSync(join(f.root, "candidate.s"), parts.map(p => p.text).join("\n").replace(".word 7", ".word 8"));
    assert.equal(compareRelocatableObjects(bytes, assemble()).verdict, "mismatch", "wrong shared data cannot be hidden by matching function words");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("private split extends only original backlog, preserves neighbors and is idempotent", () => {
  const f = fixture();
  try {
    f.member.functions = [{ name: "first", section: ".text", offset: 0 }, { name: "second", section: ".text", offset: 32 }] as LibraryMember["functions"];
    writeLibraryTu(f.member, '#include "common.h"\n' + f.stub("first") + f.stub("second") + f.stub("__library_member_data"), f.root);
    const first = readFileSync(join(f.directory, "first.c")), data = readFileSync(join(f.directory, "_data.c"));
    f.member.functions.splice(1, 0, { name: "func_text_00000010", section: ".text", offset: 16, size: 16, inferredSize: true,
      discovery: { kind: "call-relocation", sites: [{ section: ".text", offset: 4 }] } });
    assert.throws(() => readLibraryTu(f.member, f.root), /every original function/);
    extendLibraryBacklog([f.member], f.root);
    assert.deepEqual(readLibraryTu(f.member, f.root).parts.map(p => p.symbol).filter(Boolean), ["first", "func_text_00000010", "second", "__library_member_data"]);
    assert(readFileSync(join(f.directory, "first.c")).equals(first));
    assert(readFileSync(join(f.directory, "_data.c")).equals(data));
    assert.equal(libraryTuStatus(f.member, f.root)!.filter(p => p.stub).length, 4);
    extendLibraryBacklog([f.member], f.root);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("address-taken callbacks extend only their original backlog into separate ordered function files", () => {
  const f = fixture();
  try {
    f.member.functions = [{ name: "first", section: ".text", offset: 0 }, { name: "second", section: ".text", offset: 64 }] as LibraryMember["functions"];
    writeLibraryTu(f.member, '#include "common.h"\n' + f.stub("first") + f.stub("second") + f.stub("__library_member_data"), f.root);
    const preserved = ["_shared-0.h", "first.c", "second.c", "_data.c"].map(path => [path, readFileSync(join(f.directory, path))] as const);
    f.member.functions.splice(1, 0, ...[32, 40].map(offset => ({ name: `callback_${offset}`, section: ".text", offset, size: 8, inferredSize: true,
      discovery: { kind: "address-relocation" as const, sites: [{ section: ".text", offset: offset - 32 }] } })));
    assert.throws(() => readLibraryTu(f.member, f.root), /every original function/);
    extendLibraryBacklog([f.member], f.root);
    assert.deepEqual(readLibraryTu(f.member, f.root).parts.map(p => p.symbol).filter(Boolean),
      ["first", "callback_32", "callback_40", "second", "__library_member_data"]);
    for (const name of ["callback_32", "callback_40"]) assert.equal(readFileSync(join(f.directory, `${name}.c`), "utf8"), f.stub(name));
    for (const [path, before] of preserved) assert(readFileSync(join(f.directory, path)).equals(before));
    const manifest = readFileSync(join(f.root, f.member.source));
    extendLibraryBacklog([f.member], f.root);
    assert(readFileSync(join(f.root, f.member.source)).equals(manifest), "migration is idempotent");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("private split refuses real C, missing original functions and unlisted edits without partial publication", () => {
  for (const kind of ["call-relocation", "address-relocation"] as const) for (const mode of ["real-c", "missing-original", "unlisted-file"]) {
    const f = fixture();
    try {
      f.member.functions = [{ name: "first", section: ".text", offset: 0 }, { name: "second", section: ".text", offset: 32 }] as LibraryMember["functions"];
      writeLibraryTu(f.member, f.stub("first") + f.stub("second"), f.root);
      f.member.functions.splice(1, 0, { name: "func_text_00000010", section: ".text", offset: 16, size: 16, inferredSize: true,
        discovery: { kind: "call-relocation", sites: [{ section: ".text", offset: 4 }] } });
      f.member.functions[1]!.discovery!.kind = kind;
      if (mode === "real-c") writeFileSync(join(f.directory, "first.c"), "int first(void) { return 7; }\n");
      if (mode === "missing-original") {
        const manifest = JSON.parse(readFileSync(join(f.root, f.member.source), "utf8")); manifest.parts.pop();
        writeFileSync(join(f.root, f.member.source), JSON.stringify(manifest));
      }
      if (mode === "unlisted-file") writeFileSync(join(f.directory, "func_text_00000010.c"), "/* preserved attempt */\n");
      const before = readFileSync(join(f.root, f.member.source));
      assert.throws(() => extendLibraryBacklog([f.member], f.root), /source review|every original function|already exists/);
      assert(readFileSync(join(f.root, f.member.source)).equals(before));
      if (mode !== "unlisted-file") assert.equal(existsSync(join(f.directory, "func_text_00000010.c")), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("canonical BIOS definition stays one function fragment, not generated instructions", () => {
  const f = fixture();
  try {
    const source = '#include "library/psx_bios_tailjump.h"\nPSX_BIOS_FUNCTION(int, first, (int arg), 0xa0, 0x39);\n' + f.stub("second");
    const plan = planLibraryTu(f.member, source);
    assert.equal(plan.files.get("first.c")!.trim(), "PSX_BIOS_FUNCTION(int, first, (int arg), 0xa0, 0x39);");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("assembly translation unit: one .s part lists every original function, is inspected for backlog markers and has no C candidates", () => {
  const f = fixture();
  try {
    mkdirSync(f.directory, { recursive: true });
    const source = `/* counter.s */\n\t.include "gte_macros.inc"\n\t.text\n\t.set\tnoreorder\n\t.globl\tfirst\nfirst:\n\tjr\t$ra\n\tnop\n\t.globl\tsecond\nsecond:\n\tjal\tfirst\n\tnop\n\tjr\t$ra\n\tnop\n`;
    writeFileSync(join(f.directory, "counter.s"), source);
    const manifest = { schemaVersion: 1, member: f.member.id, parts: [{ path: "counter.s", symbols: ["first", "second"] }] };
    writeFileSync(join(f.root, f.member.source), JSON.stringify(manifest));
    assert.deepEqual(readLibraryTu(f.member, f.root).parts, manifest.parts);
    const tu = libraryAssemblyTu(f.member, f.root)!;
    assert.equal(tu.source, join(f.directory, "counter.s"));
    assert.deepEqual(tu.symbols, ["first", "second"]);
    assert.deepEqual(libraryTuStatus(f.member, f.root)!.map(p => [p.symbol, p.stub, p.form, p.source]),
      [["first", false, "assembly", tu.source], ["second", false, "assembly", tu.source]]);
    assert.deepEqual(librarySourceFiles(f.member, f.root), [f.member.source, "src/lib/counter/counter.s"]);
    assert.throws(() => libraryCompileInput(f.member, join(f.root, f.member.source), join(f.root, "build/asm"), f.root), /assembled, not preprocessed/);
    assert.throws(() => libraryTuStatus(f.member, f.root, { symbol: "first", source: join(f.root, "x.c") }), /C candidates do not apply/);
    for (const [mutate, reason] of [
      [(m: any) => m.parts[0].symbols.pop(), /every original function/],
      [(m: any) => m.parts[0].symbols.push("first"), /duplicate TU symbol/],
      [(m: any) => m.parts.push({ path: "_data.c", symbol: "__library_member_data" }), /one \.s part/],
      [(m: any) => m.parts[0].symbol = "first", /Invalid\/duplicate TU part/],
    ] as Array<[(m: any) => void, RegExp]>) {
      const broken = JSON.parse(JSON.stringify(manifest)); mutate(broken);
      writeFileSync(join(f.root, f.member.source), JSON.stringify(broken));
      assert.throws(() => readLibraryTu(f.member, f.root), reason);
    }
    writeFileSync(join(f.root, f.member.source), JSON.stringify(manifest));
    const part = manifest.parts[0]!;
    assert.throws(() => inspectLibraryPart(source.replace("second:\n", ""), part), /must define second/);
    assert.throws(() => inspectLibraryPart(source + `\t.include "build/libraries/nonmatchings/${f.member.id}/first.s"\n`, part), /bare macro files/);
    assert.throws(() => inspectLibraryPart(source + "\t.incbin \"blob.bin\"\n", part), /\.incbin is not reconstructed source/);
    assert.throws(() => inspectLibraryPart(source + ".L__library_rel_1_0:\n\t.reloc .L__library_rel_1_0, R_MIPS_26, .text\n", part), /backlog markers|\.reloc/);
    assert.throws(() => inspectLibraryPart(source + "nonmatching third, 8\n", part), /backlog markers/);
    assert.equal(inspectLibraryPart(source.replace("first:\n", "glabel first\n"), part).stub, false, "macro.inc label spellings define the symbol too");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
