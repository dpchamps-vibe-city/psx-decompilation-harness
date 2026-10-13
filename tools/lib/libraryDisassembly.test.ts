import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import type { LibraryMember } from "./libraryTargets.js";
import { libraryDisassemblySymbols, validateLibraryDisassembly } from "./libraryDisassembly.js";

/** Diagnostic metadata fixture; the production ELF/SDK/compiler route is
 * separately exercised by libraryPreflight.test.ts. */
function fixture() {
  const bytes = Buffer.alloc(132); bytes.writeUInt32LE(52, 32); bytes.writeUInt16LE(40, 46);
  const member = { id: "synthetic", bytes, functions: [{ name: "entry", section: ".text", offset: 0, size: 16, inferredSize: true }],
    object: { sections: new Map([[".text", { index: 1, flags: 6, offset: 0x70, size: 16,
      data: Buffer.from("0800e003000000004e4f7072696e7466", "hex") }]]) } } as LibraryMember;
  const listing = ".section .text\nnonmatching entry, 0x10\nglabel entry\n" +
    "/* 000070 00000070 0800E003 */ jr $ra\n/* 000074 00000074 00000000 */ nop\n" +
    "/* 000078 00000078 4E4F7072 */ .word 0x72704f4e\n/* 00007C 0000007C 696E7466 */ .word 0x66746e69\n";
  return { member, listing };
}

test("disassembly bounds use original ELF listing coordinates, not a guessed RAM base", () => {
  const { member } = fixture();
  assert.match(libraryDisassemblySymbols(member), /entry = 0x70;.*size:0x10 vrom:0x70/);
  member.bytes.writeUInt32LE(0x1000, 52 + 40 + 12);
  assert.match(libraryDisassemblySymbols(member), /entry = 0x1000;.*vrom:0x70/);
});

test("inferred fragments retain witnessed trailing text literals and spimdisasm's unsized raw-data form", () => {
  const { member, listing } = fixture();
  validateLibraryDisassembly(member, listing);
  const tail = listing.replace("0x10", "0x8"); validateLibraryDisassembly(member, tail);
  member.functions[0]!.inferredSize = false;
  assert.throws(() => validateLibraryDisassembly(member, tail), /boundary disagrees/);
  member.functions[0]!.inferredSize = true;
  const raw = listing.replace("entry, 0x10", "entry").replace("jr $ra", ".word 0x03e00008").replace("*/ nop", "*/ .word 0");
  validateLibraryDisassembly(member, raw);
  assert.throws(() => validateLibraryDisassembly(member, raw.replace(".word 0x03e00008", "jr $ra")), /boundary disagrees/);
  assert.throws(() => validateLibraryDisassembly(member, tail.replace(".word 0x72704f4e", "nop")), /boundary disagrees/);
  assert.throws(() => validateLibraryDisassembly(member, listing.replace("0x10", "0xe")), /boundary disagrees/);
});

test("missing, changed, duplicated, misplaced or extraneous original code words fail closed", () => {
  const { member, listing } = fixture();
  for (const broken of [listing.replace(/.*000078.*\n/, ""), listing.replace("4E4F7072", "4E4F7073"),
    listing + "/* 00007C 0000007C 696E7466 */ .word 0\n", listing + "/* 000080 00000080 00000000 */ nop\n",
    listing.replace("glabel entry", "/* 000074 00000074 00000000 */ nop\nglabel entry"),
    listing.replace("nonmatching entry", "nonmatching other")]) {
    assert.throws(() => validateLibraryDisassembly(member, broken));
  }
});
