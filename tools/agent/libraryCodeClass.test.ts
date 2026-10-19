import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import type { RelocatableObject } from "../lib/relocatableObject.js";
import { classifyLibraryCode, gccImpossibleWord } from "./libraryCodeClass.js";

const JR_RA = 0x03e00008, NOP = 0;
/** A synthetic one-section object holding `words`; no SDK bytes. */
export function wordObject(words: number[], relocatedOffsets: number[] = []): RelocatableObject {
  const data = Buffer.alloc(words.length * 4);
  words.forEach((word, i) => data.writeUInt32LE(word >>> 0, i * 4));
  return { flags: 0, symbols: [], sections: new Map([[".text", { data, flags: 6, size: data.length } as never]]),
    relocations: relocatedOffsets.map(offset => ({ section: ".text", offset, type: 5 }) as never) };
}
const classify = (words: number[], relocatedOffsets: number[] = []) =>
  classifyLibraryCode(wordObject(words, relocatedOffsets), { section: ".text", offset: 0, size: words.length * 4 });

test("instructions GCC never emits outside an asm statement fingerprint a function as hand-written", () => {
  const cases: Array<[string, number]> = [
    ["syscall", 0x0000000c], ["break outside the division traps", 0x0001000d], ["COP0 or rfe", 0x40026000],
    ["COP0 or rfe", 0x42000010], ["trapping addi", 0x20420001], ["trapping add", 0x00431020], ["trapping sub", 0x00431022],
    ["k0/k1 register", 0x0040d021], ["k0/k1 register", 0x8f5a0000],
  ];
  for (const [reason, word] of cases) {
    assert.equal(gccImpossibleWord(word), reason, word.toString(16));
    const found = classify([0x24020001, word, JR_RA, NOP]);
    assert.equal(found?.kind, "gcc-impossible", word.toString(16));
    assert.match(found!.detail, new RegExp(`${reason.replace(/\//g, "\\/")} at \\+0x4`));
  }
});

test("compiler output, division traps and GTE (COP2) words are never fingerprints", () => {
  for (const word of [0x0007000d, 0x0006000d, 0xc89a0000 /* lwc2 $26 */, 0x4882d800 /* mtc2 v0,$27 */, 0x4842d800 /* cfc2 v0,$27 */, 0x4a280030 /* RTPT */])
    assert.equal(gccImpossibleWord(word), undefined, word.toString(16));
  assert.equal(classify([0x8fbf0010, 0x27bd0018, JR_RA, NOP]), undefined, "ordinary epilogue");
  assert.equal(classify([0x0082001a, 0x0007000d, 0x00001012, JR_RA, NOP]), undefined, "divide with its trap");
  assert.equal(classify([0xc8800000, 0x4a280030, 0x48024800, JR_RA, NOP]), undefined, "GTE code is C with INLINE_C macros");
});

test("inline BIOS calls need a literal table vector and a literal $t1 selector", () => {
  const call = [0x24090056 /* addiu t1,zero,0x56 */, 0x240a00b0 /* addiu t2,zero,0xb0 */, 0x0140f809 /* jalr t2 */, NOP, JR_RA, NOP];
  const found = classify(call, [0]);
  assert.equal(found?.kind, "bios-inline-dispatch");
  assert.match(found!.detail, /BIOS call to 0xb0 with \$t1=0x56/);
  assert.equal(classify([0x240a00b0, 0x0140f809, NOP, JR_RA, NOP]), undefined, "a call through a constant pointer sets no selector");
  assert.equal(classify([0x8c8a0000 /* lw t2,0(a0) */, 0x24090056, 0x0140f809, NOP, JR_RA, NOP]), undefined, "a loaded pointer is not a table vector");
  assert.equal(classify([0x24090056, 0x240a00b0, 0x10800002 /* beqz a0 */, NOP, 0x0140f809, NOP, JR_RA, NOP]), undefined, "a branch ends the straight-line setup");
});

test("the exact BIOS veneer stays recognized from unrelocated words; relocated words fall to the general rules", () => {
  const veneer = [0x01405024 /* and t2,t2,zero */, 0x354a00b0, 0x01204824 /* and t1,t1,zero */, 0x01400008 /* jr t2 */, 0x35290018, JR_RA, NOP];
  assert.equal(classify(veneer)?.kind, "bios-dispatch");
  assert.equal(classify(veneer, [4])?.kind, "bios-inline-dispatch");
});
