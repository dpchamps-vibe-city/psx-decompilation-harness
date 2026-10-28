import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { objectFunctions, type RelocatableObject } from "./relocatableObject.js";
import type { Elf32Section } from "./elfSections.js";
import { assemble } from "../agent/matching-reconstruction/fixture-asm.js";

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
  object.relocations[0]!.reference = ".text@0"; object.relocations[0]!.addend = 40;
  assert.equal(objectFunctions(object)[1]!.offset, 40, "explicit native operand replaces, not adds to, the raw jump field");
  object.relocations[0]!.addend = null;
  assert.equal(objectFunctions(object).length, 1, "unknown native operands never fall back to raw fields");
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

/** An initializer publishes two callback addresses; neither has a JAL or an
 * original function symbol. This is the PAD/FIRST shape, without SDK bytes. */
function callbacks(offset = 0x20): RelocatableObject {
  const data = Buffer.alloc(offset + 16);
  const hi = (value: number) => ((value + 0x8000) >>> 16) & 0xffff;
  const words = [0x3c020000 | hi(offset), 0x24420000 | (offset & 0xffff),
    0x3c030000 | hi(offset + 8), 0x24630000 | ((offset + 8) & 0xffff),
    0xac820000, 0xac830004, 0x03e00008, 0];
  words.forEach((w, i) => data.writeUInt32LE(w >>> 0, i * 4));
  [0x03e00008, 0x24020001, 0x03e00008, 0x00001021].forEach((w, i) => data.writeUInt32LE(w, offset + i * 4));
  const object = fixture(), section = object.sections.get(".text")!;
  section.data = data; section.size = data.length;
  object.relocations = [0, 4, 8, 12].map((at, i) => ({ section: ".text", offset: at, type: i % 2 ? 6 : 5, reference: ".text@0" }));
  return object;
}

test("address-taken private callbacks receive separate function extents and relocation provenance", () => {
  const object = callbacks(), before = Buffer.from(object.sections.get(".text")!.data);
  const functions = objectFunctions(object);
  assert.deepEqual(functions.map(f => [f.name, f.offset, f.size]),
    [["entry", 0, 32], ["func_00000090", 32, 8], ["func_00000098", 40, 8]]);
  assert.deepEqual(functions[1]!.discovery, { kind: "address-relocation", sites: [{ section: ".text", offset: 0 }, { section: ".text", offset: 4 }] });
  assert.deepEqual(functions[2]!.discovery, { kind: "address-relocation", sites: [{ section: ".text", offset: 8 }, { section: ".text", offset: 12 }] });
  assert(object.sections.get(".text")!.data.equals(before), "discovery never changes original encoded addends");
  object.relocations.forEach((r, i) => { r.addend = i < 2 ? 32 : 40; });
  assert.deepEqual(objectFunctions(object).map(f => f.offset), [0, 32, 40], "native HI full operands are not added to the raw low field again");
  object.relocations.forEach(r => { r.addend = null; });
  assert.equal(objectFunctions(object).length, 1, "unknown native pairs do not manufacture callbacks");
});

test("a private entry with both call and address witnesses retains actual call-site provenance", () => {
  const object = callbacks(), section = object.sections.get(".text")!;
  const data = Buffer.alloc(64); section.data.copy(data);
  [0x0c000008, 0, 0x03e00008, 0].forEach((word, i) => data.writeUInt32LE(word, 48 + i * 4));
  section.data = data; section.size = data.length;
  object.symbols.push({ name: "caller", section: ".text", value: 48, size: 16, binding: 1, type: 2, visibility: 0 });
  object.relocations.push({ section: ".text", offset: 48, type: 4, reference: ".text@0" });
  assert.deepEqual(objectFunctions(object).find(f => f.offset === 32)!.discovery,
    { kind: "call-relocation", sites: [{ section: ".text", offset: 48 }] });
});

test("callback publication includes a direct jump's delay slot, not the jump itself", () => {
  const object = callbacks(), d = object.sections.get(".text")!.data;
  d.writeUInt32LE(0x08000006, 16); d.writeUInt32LE(0xac820000, 20);
  object.relocations.push({ section: ".text", offset: 16, type: 4, reference: ".text@0" });
  assert(objectFunctions(object).some(f => f.offset === 32), "FIRST-style store in a delay slot is a real pointer use");
});

test("a call's link write kills an old address before a delay-slot store", () => {
  const object = callbacks(), d = object.sections.get(".text")!.data;
  d.writeUInt32LE(0x3c1f0000, 0); d.writeUInt32LE(0x27ff0020, 4);
  d.writeUInt32LE(0x0c000000, 8); d.writeUInt32LE(0xac9f0000, 12);
  object.relocations = object.relocations.slice(0, 2).concat([{ section: ".text", offset: 8, type: 4, reference: "import:callee" }]);
  assert(!objectFunctions(object).some(f => f.offset === 32), "the stored link is not the former callback address in ra");
});

/** DsInit's registration shape: the low half completes the argument in the
 * delay slot of the call that consumes it. */
function slotRegistration(hiReg = 4, between = 0x0c000000): RelocatableObject {
  const object = callbacks(), d = object.sections.get(".text")!.data;
  [0x3c000000 | hiReg << 16, between, 0x24000020 | hiReg << 21 | hiReg << 16, 0x03e00008, 0, 0, 0, 0].forEach((w, i) => d.writeUInt32LE(w >>> 0, i * 4));
  object.relocations = [{ section: ".text", offset: 0, type: 5, reference: ".text@0" },
    ...(between >>> 26 === 3 ? [{ section: ".text", offset: 4, type: 4, reference: "import:register_callback" }] : []),
    { section: ".text", offset: 8, type: 6, reference: ".text@0" }];
  return object;
}

test("a callback completed in its registration call's delay slot is published", () => {
  assert.deepEqual(objectFunctions(slotRegistration()).map(f => [f.name, f.offset, f.discovery?.kind]),
    [["entry", 0, undefined], ["func_00000090", 32, "address-relocation"]]);
  assert(!objectFunctions(slotRegistration(8)).some(f => f.offset === 32), "a non-argument register in the slot is not the call's argument");
  assert(!objectFunctions(slotRegistration(31)).some(f => f.offset === 32), "the link write clobbers a high half held in $ra");
  assert(!objectFunctions(slotRegistration(4, 0x10000002)).some(f => f.offset === 32), "a branch between the halves is still a transfer");
});

test("callback address decoding honors local symbol values and signed-low HI16 carry", () => {
  const nonzero = callbacks();
  for (const r of nonzero.relocations) r.reference = ".text@16";
  nonzero.sections.get(".text")!.data.writeUInt32LE(0x24420010, 4);
  nonzero.sections.get(".text")!.data.writeUInt32LE(0x24630018, 12);
  assert.deepEqual(objectFunctions(nonzero).map(f => f.offset), [0, 32, 40]);
  assert.deepEqual(objectFunctions(callbacks(0x8000)).map(f => f.offset), [0, 0x8000, 0x8008]);
});

test("callback discovery does not turn loads, raw constants, imports or protected symbol interiors into functions", () => {
  for (const mutate of [
    (o: RelocatableObject) => o.relocations = [],
    (o: RelocatableObject) => o.relocations.forEach(r => r.reference = "import:callback"),
    (o: RelocatableObject) => o.relocations.forEach(r => r.reference = "named:entry"),
    (o: RelocatableObject) => { o.symbols[0]!.size = 48; },
    (o: RelocatableObject) => { const d = o.sections.get(".text")!.data; d.writeUInt32LE(0x8c420020, 4); d.writeUInt32LE(0x8c630028, 12); },
    // A switch dispatch uses a code address as a jump destination, not as a callback.
    (o: RelocatableObject) => { const d = o.sections.get(".text")!.data; d.writeUInt32LE(0x00400008, 16); d.writeUInt32LE(0, 20); },
  ]) {
    const object = callbacks(); mutate(object);
    assert.equal(objectFunctions(object).length, 1);
  }
});

test("callback relocation pairs must be ordered, unambiguous and connected by an unclobbered register", () => {
  for (const mutate of [
    (o: RelocatableObject) => o.relocations.splice(1, 1), // orphan HI16
    (o: RelocatableObject) => o.relocations[0]!.reference = ".text@4", // mixed-symbol pair
    (o: RelocatableObject) => o.relocations.reverse(),
    (o: RelocatableObject) => o.relocations.push({ ...o.relocations[0]! }), // overlapping fixup
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0x24620020, 4), // wrong base
    (o: RelocatableObject) => {
      const d = o.sections.get(".text")!.data;
      d.writeUInt32LE(0x24020007, 4); d.writeUInt32LE(0x24420020, 8); d.writeUInt32LE(0, 12);
      o.relocations = [{ section: ".text", offset: 0, type: 5, reference: ".text@0" }, { section: ".text", offset: 8, type: 6, reference: ".text@0" }];
    },
  ]) {
    const object = callbacks(); mutate(object);
    assert(!objectFunctions(object).some(f => f.offset === 32), "ambiguous address formation is not an entry witness");
  }
});

/** Two published callbacks, the second using a readonly relocated switch.
 * The final table word belongs to a neighbour and is deliberately not in the bound. */
function switchCallback(native = false): RelocatableObject {
  const object = callbacks(), section = object.sections.get(".text")!;
  const words = assemble([
    ["slti", "t0", "a0", 3], ["beq", "t0", "zero", "default"], ["sll", "v0", "a0", 2],
    ["lui", "at", 0], ["addu", "at", "at", "v0"], ["lw", "v0", 0, "at"], ["nop"], ["jr", "v0"], ["nop"],
    ["jr", "ra"], ["addiu", "v0", "zero", 11],
    ["jr", "ra"], ["addiu", "v0", "zero", 22],
    ["label", "default"], ["jr", "ra"], ["addiu", "v0", "zero", 33],
  ], 40);
  words[0]!.raw = ((words[0]!.raw & 0x03ffffff) | (0x0b << 26)) >>> 0;
  const data = Buffer.alloc(40 + words.length * 4); section.data.copy(data, 0, 0, 40);
  words.forEach(w => data.writeUInt32LE(w.raw, w.vram)); section.data = data; section.size = data.length;
  const table = Buffer.alloc(16), targets = [76, 84, 92, 0];
  targets.forEach((at, i) => table.writeUInt32LE(native ? 0 : at, i * 4));
  object.sections.set(".rdata", { ...section, index: 2, flags: 2, offset: 0, size: table.length, data: table });
  object.relocations.push({ section: ".text", offset: 52, type: 5, reference: ".rdata@0", ...(native ? { addend: 0 } : {}) },
    { section: ".text", offset: 60, type: 6, reference: ".rdata@0", ...(native ? { addend: 0 } : {}) },
    ...targets.map((at, i) => ({ section: ".rdata", offset: i * 4, type: 2, reference: ".text@0", ...(native ? { addend: at } : {}) })));
  return object;
}

test("published switch callbacks get independent extents from exact bounded relocation edges", () => {
  for (const native of [false, true]) {
    const object = switchCallback(native), before = Buffer.from(object.sections.get(".text")!.data);
    assert.deepEqual(objectFunctions(object).map(f => [f.offset, f.size]), [[0, 32], [32, 8], [40, 60]]);
    assert(object.sections.get(".text")!.data.equals(before));
  }
});

test("switch callback discovery rejects unknown, mutable, cross-boundary and delay-slot case targets", () => {
  for (const mutate of [
    (o: RelocatableObject) => { o.relocations.splice(o.relocations.findIndex(r => r.section === ".rdata" && r.offset === 4), 1); },
    (o: RelocatableObject) => { o.relocations.find(r => r.section === ".rdata")!.addend = null; },
    (o: RelocatableObject) => { o.relocations.find(r => r.section === ".rdata")!.reference = "import:unknown"; },
    (o: RelocatableObject) => { o.sections.get(".rdata")!.flags |= 1; },
    (o: RelocatableObject) => { o.sections.get(".rdata")!.data.writeUInt32LE(32, 0); },
    (o: RelocatableObject) => { o.sections.get(".rdata")!.data.writeUInt32LE(72, 0); },
    (o: RelocatableObject) => { o.sections.get(".text")!.data.writeUInt32LE(0x00400008, 76); },
  ]) {
    const object = switchCallback(); mutate(object);
    assert(!objectFunctions(object).some(f => f.offset === 40), "unsupported edges must not license a new partition");
  }
});

test("address witnesses retain the fallthrough/shared-block guards and reject non-code tails", () => {
  for (const mutate of [
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0x24420001, 24), // falls through
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0x10000002, 20), // branch into callback
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0x1000fffd, 32), // callback branches back into caller
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0xffffffff, 32), // literal data, not instructions
    (o: RelocatableObject) => o.sections.get(".text")!.data.writeUInt32LE(0x00451021, 16), // indexed address, not the original callback value
  ]) {
    const object = callbacks(); mutate(object);
    assert(!objectFunctions(object).some(f => f.offset === 32));
  }
});
