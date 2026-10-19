import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { libraryDataObjects, lnkSymbolOrder, m2cGlobalDefinitions, renderSymbolOrder } from "./libraryFinishing.js";

test("data listing objects carry section, extent and linkage", () => {
  const listing = [".rdata", ".align 2", "RO_STR_00000010:", "    /* 000010 00000010 */ .asciz \"%d\\n\"", ".data", ".globl table", "table:",
    "    /* 000020 */ .word 0x1, table", "    /* 000028 */ .short 0x2", "local_byte:", "    /* 00002C */ .byte 0x1, 0x2, 0x3",
    ".bss", "B_00000040:", "    /* 000040 */ .space 0x10", ".comm pool, 8, 4", ".lcomm scratch, 4"].join("\n");
  assert.deepEqual(libraryDataObjects(listing), [
    { name: "RO_STR_00000010", section: ".rdata", size: 4, global: false },
    { name: "table", section: ".data", size: 10, global: true },
    { name: "local_byte", section: ".data", size: 3, global: false },
    { name: "B_00000040", section: ".bss", size: 16, global: false },
    { name: "pool", section: "COMMON", size: 8, global: true },
    { name: "scratch", section: ".bss", size: 4, global: false },
  ]);
});

test("m2c global definitions keep data, not functions or extern prototypes", () => {
  const output = [
    "? sprintf(? *, ? *, s32);                           /* extern */",
    "static ? B_000000C8;",
    "s32 table[2] = {",
    "    1,",
    "    2,",
    "};",
    "",
    "s32 *f(s32 arg0) {",
    "    return &table[arg0];",
    "}",
    "static u8 *last = NULL;",
  ].join("\n");
  assert.deepEqual(m2cGlobalDefinitions(output), ["static ? B_000000C8;", "s32 table[2] = {\n    1,\n    2,\n};", "static u8 *last = NULL;"]);
});

test("LNK symbol order shows a file static ahead of the first definition", () => {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
  const object = (entry: number) => Buffer.concat([Buffer.from("LNK\x02"), Buffer.from([46, 7]),
    ...[".rdata", ".text", ".data", ".sdata", ".sbss", ".bss"].map((s, i) => Buffer.concat([Buffer.from([16]), u16(0xf001 + i), u16(0), Buffer.from([8]), str(s)])),
    Buffer.from([12]), u16(entry), u16(0xf002), u32(0), str("strtok"), Buffer.from([14]), u16(entry + 1), str("strchr"), Buffer.from([0])]);
  const original = lnkSymbolOrder(object(4)), rebuilt = lnkSymbolOrder(object(3));
  assert.deepEqual(original.map(s => [s.id, s.kind, s.name]), [[4, "defined", "strtok"], [5, "external", "strchr"]]);
  const report = renderSymbolOrder(original, rebuilt);
  assert.match(report, /!\s+3\s+static \(file static\)\s+defined strtok/);
  assert.match(report, /First divergence at ID 3/);
  assert.match(renderSymbolOrder(original, original), /Orders agree/);
});
