import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import { projectFixture } from "../testing/projectFixture.js";
import { libraryMembers } from "./libraryTargets.js";
import { libraryAssemblyParts } from "./libraryAssembly.js";
import { cutListingSection, libraryRodataLayout } from "./libraryRodata.js";
import { libraryGeneratedFunction, libraryGeneratedSymbols, readLibraryTu } from "./libraryTranslationUnit.js";
import { ensureRodataParts } from "../agent/libraryTarget.js";

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
const record = (...parts: Array<number | Buffer>) => Buffer.concat(parts.map(p => typeof p === "number" ? Buffer.from([p]) : p));
const RDATA = 0xf001, TEXT = 0xf002;
/** LNK `base(section) + value`, right operand first. */
const at = (section: number, value: number) => value ? record(44, 0, u32(value), 4, u16(section)) : record(4, u16(section));
/* first: loads its switch table (.rdata+8) and the string before it (.rdata+0);
   second: loads the string after the table (.rdata+16). The table's two cases
   are first+16 and first+24, as cc1 lays out a switch between two strings.
   Without `tail`, the table ends the member's data and second loads nothing. */
function setup(t: Parameters<typeof projectFixture>[0], options: { tail?: boolean } = {}) {
  const tail = options.tail !== false, f = projectFixture(t);
  const code = [0x3c010000, 0x8c220000, 0x00400008, 0, 0x3c040000, 0x24840000, 0x03e00008, 0,
    tail ? 0x3c040000 : 0, tail ? 0x24840000 : 0, 0x03e00008, 0, 0, 0, 0, 0];
  const rdata = Buffer.concat([Buffer.from("abc\0\0\0\0\0", "latin1"), Buffer.alloc(8), ...(tail ? [Buffer.from("xyz\0\0\0\0\0", "latin1")] : [])]);
  f.toolchain.assembler = { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-dmpsx", "psyq-lnk"] };
  f.toolchain.flags.as = ["-EL", "-G0", "-mips1"];
  f.toolchain.includeDirs = ["include"];
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  f.put("include/asm.h", "#define v0 $2\n#define a0 $4\n#define ra $31\n#define zero $0\n");
  f.put("include/inline_s.h", "");
  const textBytes = Buffer.alloc(code.length * 4);
  code.forEach((word, i) => textBytes.writeUInt32LE(word, i * 4));
  f.put("unit.OBJ", Buffer.concat([Buffer.from("LNK\x02"), record(46, 7),
    ...[".rdata", ".text", ".data", ".sdata", ".sbss", ".bss"].map((s, i) => record(16, u16(0xf001 + i), u16(0), 8, str(s))),
    record(12, u16(3), u16(TEXT), u32(0), str("first")), record(12, u16(4), u16(TEXT), u32(32), str("second")),
    record(6, u16(TEXT)), record(2, u16(textBytes.length), textBytes),
    record(10, 82, u16(0), at(RDATA, 8)), record(10, 84, u16(4), at(RDATA, 8)),
    record(10, 82, u16(16), at(RDATA, 0)), record(10, 84, u16(20), at(RDATA, 0)),
    ...(tail ? [record(10, 82, u16(32), at(RDATA, 16)), record(10, 84, u16(36), at(RDATA, 16))] : []),
    record(6, u16(RDATA)), record(2, u16(rdata.length), rdata),
    record(10, 16, u16(8), at(TEXT, 16)), record(10, 16, u16(12), at(TEXT, 24)), record(0)]));
  // Local labels make the view's REL targets the section symbols the LNK patches name.
  f.put("view.s", ".set noreorder\n.set noat\n.text\n.globl first\n.globl second\nfirst:\nlui $1, %hi(jtbl)\nlw $2, %lo(jtbl)($1)\njr $2\nnop\n" +
    "case0:\nlui $4, %hi(str0)\naddiu $4, $4, %lo(str0)\ncase1:\njr $31\nnop\nsecond:\n" + (tail ? "lui $4, %hi(str2)\naddiu $4, $4, %lo(str2)\n" : "nop\nnop\n") + "jr $31\n" + "nop\n".repeat(5) +
    '.section .rdata,"a"\nstr0:\n.asciz "abc"\n.space 4\njtbl:\n.word case0, case1\n' + (tail ? 'str2:\n.asciz "xyz"\n.space 4\n' : ""));
  execFileSync(f.toolchain.tools.as as string, [...f.toolchain.flags.as, join(f.root, "view.s"), "-o", join(f.root, "view.o")]);
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "psyq-lib", standaloneObjects: ["unit.OBJ"] }, views: { elf: { unit: "view.o" } }, verification: { mode: "original-object" }, output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "." } }));
  return { f, run: <T>(body: (member: ReturnType<typeof libraryMembers>[number], listing: string) => T) => fixtureContext(f.root, () => {
    const member = libraryMembers()[0]!, view = member.viewObject ?? member.object;
    const off = (section: string, offset: number) => (view.sections.get(section)!.offset + offset).toString(16).padStart(6, "0");
    const word = (offset: number, instruction: string) => `/* ${off(".text", offset)} 00000000 ${u32(code[offset / 4]!).toString("hex")} */ ${instruction}\n`;
    const data = (offset: number, text: string, bytes?: number) => `/* ${off(".rdata", offset)} 00000000${bytes === undefined ? "" : ` ${u32(bytes).toString("hex")}`} */ ${text}\n`;
    const listing = ".section .text\nnonmatching first, 32\nglabel first\n" + word(0, "lui $at, %hi(jtbl)") + word(4, "lw $v0, %lo(jtbl)($at)") + word(8, "jr $v0") + word(12, "nop") +
      word(16, "lui $a0, %hi(str0)") + word(20, "addiu $a0, $a0, %lo(str0)") + word(24, "jr $ra") + word(28, "nop") + "endlabel first\n" +
      "nonmatching second, 32\nglabel second\n" + (tail ? word(32, "lui $a0, %hi(str2)") + word(36, "addiu $a0, $a0, %lo(str2)") : word(32, "nop") + word(36, "nop")) + word(40, "jr $ra") +
      [44, 48, 52, 56, 60].map(o => word(o, "nop")).join("") + "endlabel second\n" +
      ".section .rdata\n\n.align 4\n\n.align 2\nnonmatching str0\n\n/* static variable */\ndlabel str0\n" + data(0, '.asciz "abc"') + ".align 2\n" + data(4, '.asciz ""') + ".align 2\nenddlabel str0\n\n" +
      "nonmatching jtbl\n\ndlabel jtbl\n" + data(8, ".word .L00000010", 0) + data(12, ".word .L00000018", 0) + "enddlabel jtbl\n" +
      (tail ? "\n.align 2\nnonmatching str2\n\ndlabel str2\n" + data(16, '.asciz "xyz"') + ".align 2\n" + data(20, '.asciz ""') + ".align 2\nenddlabel str2\n" : "");
    return body(member, listing);
  }) };
}

test("a switch table between strings belongs to its owner; the data before it is its own part", t => {
  setup(t).run((member, listing) => {
    assert.deepEqual(libraryRodataLayout(member), { tables: [{ owner: "first", start: 8, end: 16 }],
      segments: [{ symbol: "__library_member_rodata_0", start: 0, end: 8, owner: "first" }], tail: 16, size: 24 });
    const parts = libraryAssemblyParts(member, listing);
    assert.deepEqual(parts.map(p => p.symbol), ["__library_member_symbols", "__library_member_rodata_0", "first", "second", "__library_member_data"]);
    const part = (symbol: string) => parts.find(p => p.symbol === symbol)!.text;
    assert.match(part("__library_member_rodata_0"), /\.rdata\n\n\.align 4[^]*\.asciz "abc"[^]*\.text\n$/);
    assert.doesNotMatch(part("__library_member_rodata_0"), /xyz|\.word/);
    assert.match(part("first"), /jr\s+ra[^]*\.rdata\n\.align 3\n[^]*\$Ljtbl:\n.*\.word first\+16\n.*\.word first\+24\n[^]*\.text\n$/);
    // References land on the storage their own region defines.
    assert.match(part("first"), /%hi\(\$Ljtbl\)[^]*%lo\(\$Ljtbl\)[^]*%hi\(\$Lstr0\)/);
    assert.match(part("second"), /%hi\(\$Lstr2\)/);
    assert.match(part("__library_member_data"), /\.rdata\n[^]*\.asciz "xyz"/);
    assert.doesNotMatch(part("__library_member_data"), /\.align 4|abc|\.word first/);
    assert.deepEqual(libraryGeneratedSymbols(member), ["__library_member_data", "__library_member_symbols", "__library_member_rodata_0"]);
    assert.equal(libraryGeneratedFunction("__library_member_rodata_0").generated, "data");
  });
});

test("split adds the read-only data part in front of the table owner while the data is extraction", t => {
  const { f, run } = setup(t);
  run((member, listing) => {
    const directory = dirname(member.source), stub = (symbol: string) => `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", ${symbol});\n`;
    const parts = [{ path: "_shared.h" }, { path: "first.c", symbol: "first" }, { path: "second.c", symbol: "second" }, { path: "_data.c", symbol: "__library_member_data" }];
    f.put(member.source, JSON.stringify({ schemaVersion: 1, member: member.id, parts }));
    f.put(join(directory, "_shared.h"), "");
    for (const p of parts.slice(1)) f.put(join(directory, p.path), stub(p.symbol!));
    const generated = libraryAssemblyParts(member, listing);
    ensureRodataParts(member, generated, f.root);
    assert.deepEqual(readLibraryTu(member, f.root).parts.map(p => p.path), ["_shared.h", "_rodata-0.c", "first.c", "second.c", "_data.c"]);
    assert.equal(readFileSync(join(f.root, directory, "_rodata-0.c"), "utf8"), stub("__library_member_rodata_0"));
    const text = readFileSync(join(f.root, member.source), "utf8");
    ensureRodataParts(member, generated, f.root);
    assert.equal(readFileSync(join(f.root, member.source), "utf8"), text, "idempotent");
    // Finished data no longer has generated .rdata to place.
    f.put(member.source, JSON.stringify({ schemaVersion: 1, member: member.id, parts }));
    f.put(join(directory, "_data.c"), "const char str2[] = \"xyz\";\n");
    ensureRodataParts(member, generated, f.root);
    assert.deepEqual(readLibraryTu(member, f.root).parts.map(p => p.path), parts.map(p => p.path));
  });
});

test("split drops the data stub of a member whose switch table was all the data it had left", t => {
  const { f, run } = setup(t, { tail: false });
  run((member, listing) => {
    const directory = dirname(member.source), stub = (symbol: string) => `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", ${symbol});\n`;
    const parts = [{ path: "first.c", symbol: "first" }, { path: "second.c", symbol: "second" }, { path: "_data.c", symbol: "__library_member_data" }];
    f.put(member.source, JSON.stringify({ schemaVersion: 1, member: member.id, parts }));
    for (const p of parts) f.put(join(directory, p.path), stub(p.symbol));
    const generated = libraryAssemblyParts(member, listing);
    assert.deepEqual(generated.map(p => p.symbol), ["__library_member_symbols", "__library_member_rodata_0", "first", "second"]);
    ensureRodataParts(member, generated, f.root);
    assert.deepEqual(readLibraryTu(member, f.root).parts.map(p => p.path), ["_rodata-0.c", "first.c", "second.c"]);
    assert.equal(existsSync(join(f.root, directory, "_data.c")), false);
  });
});

test("a read-only data part must be one of the member's segments, under its own path, in front of its owner", t => {
  const { f, run } = setup(t);
  run(member => {
    const manifest = (parts: Array<{ path: string; symbol?: string }>) => {
      for (const p of parts) f.put(join(dirname(member.source), p.path), "");
      f.put(member.source, JSON.stringify({ schemaVersion: 1, member: member.id, parts }));
    };
    const fn = [{ path: "first.c", symbol: "first" }, { path: "second.c", symbol: "second" }];
    manifest([fn[0]!, { path: "_rodata-0.c", symbol: "__library_member_rodata_0" }, fn[1]!]);
    assert.throws(() => readLibraryTu(member, f.root), /_rodata-0\.c must come before first/);
    manifest([{ path: "_rodata-1.c", symbol: "__library_member_rodata_1" }, ...fn]);
    assert.throws(() => readLibraryTu(member, f.root), /not a read-only data segment/);
    manifest([{ path: "_rodata-9.c", symbol: "__library_member_rodata_0" }, ...fn]);
    assert.throws(() => readLibraryTu(member, f.root), /must be _rodata-0\.c/);
    manifest([{ path: "_rodata-0.c", symbol: "__library_member_rodata_0" }, ...fn]);
    assert.equal(readLibraryTu(member, f.root).parts.length, 3);
  });
});

test("listing cuts keep a word's labels with it, leave alignment behind, and fail inside a directive", () => {
  const text = [".section .rdata", "dlabel a", "/* 000010 00000010 */ .asciz \"abcdefg\"", ".align 2", "enddlabel a", "", "nonmatching b", "dlabel b",
    "/* 000018 00000018 01000000 */ .word 1", "/* 00001C 0000001C 02000000 */ .word 2", ".align 2", "/* 000020 00000020 */ .asciz \"z\""].join("\n");
  const [head, table, tail] = cutListingSection(text, 0x10, [8, 16]);
  assert.match(head!, /abcdefg"\n\.align 2\nenddlabel a$/);
  assert.match(table!, /^\nnonmatching b\ndlabel b\n[^]*\.word 2\n\.align 2$/);
  assert.equal(tail, "dlabel RO_00000020\n/* 000020 00000020 */ .asciz \"z\"", "an unlabeled region gets its own label");
  assert.throws(() => cutListingSection(text, 0x10, [4]), /no word at \.rdata\+0x4/);
});
