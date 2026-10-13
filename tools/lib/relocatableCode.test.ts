import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { objectFunctions, type RelocatableObject } from "./relocatableObject.js";
import type { Elf32Section } from "./elfSections.js";

function fixture(): RelocatableObject {
  const words = [0x27bdffe8, 0xafbf0010, 0x0c00000a, 0, 0x8fbf0010, 0x27bd0018, 0x03e00008, 0, 0, 0, 0x03e00008, 0x24020007];
  const data = Buffer.alloc(words.length * 4); words.forEach((w, i) => data.writeUInt32LE(w, i * 4));
  const text: Elf32Section = { index: 1, type: 1, flags: 6, alignment: 4, offset: 0x70, size: data.length, data, link: 0, info: 0, entsize: 0 };
  return { flags: 0, sections: new Map([[".text", text]]),
    symbols: [{ name: "entry", value: 0, size: 0, binding: 1, type: 2, visibility: 0, section: ".text" }],
    relocations: [{ section: ".text", offset: 8, type: 4, reference: ".text@0" }] };
}
test("private entries use section-relative JAL relocations, not ELF file offsets or exports alone", () => {
  const object = fixture(), before = Buffer.from(object.sections.get(".text")!.data);
  const functions = objectFunctions(object);
  assert.deepEqual(functions.map(f => [f.name, f.offset, f.size]), [["entry", 0, 40], ["func_00000098", 40, 8]]);
  assert.equal(functions[1]!.inferredSize, true);
  assert.deepEqual(functions[1]!.discovery, { kind: "call-relocation", sites: [{ section: ".text", offset: 8 }] });
  assert(object.sections.get(".text")!.data.equals(before));
  object.relocations[0]!.reference = ".text@8"; object.sections.get(".text")!.data.writeUInt32LE(0x0c000008, 8);
  assert.equal(objectFunctions(object)[1]!.offset, 40, "local symbol value contributes to the REL addend");
});
test("private-entry discovery refuses imports, raw jump fields, tail branches and interior sized symbols", () => {
  for (const mutate of [
    (o: RelocatableObject) => o.relocations = [],
    (o: RelocatableObject) => o.relocations[0]!.reference = "import:callee",
    (o: RelocatableObject) => o.relocations[0]!.reference = "named:entry",
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0x0800000a, 8),
    (o: RelocatableObject) => o.symbols[0]!.size = 48,
  ]) {
    const object = fixture(); mutate(object);
    assert.equal(objectFunctions(object).length, 1);
  }
});
test("a call into a shared block does not manufacture an independent function", () => {
  const fallthrough = fixture(); fallthrough.sections.get(".text")!.data.writeUInt32LE(0x24420001, 36);
  assert.equal(objectFunctions(fallthrough).length, 1);
  const crossed = fixture(); crossed.sections.get(".text")!.data.writeUInt32LE(0x10000005, 16);
  assert.equal(objectFunctions(crossed).length, 1, "conditional branch into the helper keeps the original region intact");
  const interiorJump = fixture(); interiorJump.sections.get(".text")!.data.writeUInt32LE(0x0800000b, 16);
  interiorJump.relocations.push({ section: ".text", offset: 16, type: 4, reference: ".text@0" });
  assert.equal(objectFunctions(interiorJump).length, 1, "direct branch into the helper interior keeps the original region intact");
  const tailJump = fixture(); tailJump.sections.get(".text")!.data.writeUInt32LE(0x0800000a, 16);
  tailJump.relocations.push({ section: ".text", offset: 16, type: 4, reference: ".text@0" });
  assert.equal(objectFunctions(tailJump).length, 2, "a tail jump to a witnessed entry is allowed");
  const collision = fixture(); collision.symbols.push({ ...collision.symbols[0]!, name: "func_00000098", section: "UND" });
  assert.throws(() => objectFunctions(collision), /collides/);
});
