import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { normalizeM2cJumpTables } from "./m2cAssembly.js";

const listing = (name = "RO_0010", section = ".rdata", body = ".word .Lcase\n.word .Ldefault\n.word 0x00000000") =>
  `.section .text\nlui $at, %hi(${name})\nlw $v0, %lo(${name})($at)\njr $v0\nnop\njlabel .Lcase\njr $ra\nnop\njlabel .Ldefault\njr $ra\nnop\n.section ${section}\nnonmatching ${name}\ndlabel ${name}\n${body}\nenddlabel ${name}\n`;

test("m2c gets diagnostic jump-table names, without modifying strings or comments", () => {
  const source = listing("RO_0010", ".rdata", ".word .Lcase\n.align 2\n.word .Ldefault\n.word 0x00000000") + 'dlabel message\n.asciz "RO_0010" # RO_0010\nenddlabel message\n/* RO_0010 */\n';
  const result = normalizeM2cJumpTables(source);
  assert.deepEqual(result.renames, [{ from: "RO_0010", to: "jtbl_RO_0010" }]);
  assert.match(result.text, /%hi\(jtbl_RO_0010\)/);
  assert.match(result.text, /%lo\(jtbl_RO_0010\)/);
  assert.match(result.text, /dlabel jtbl_RO_0010/);
  assert.ok(result.text.includes('.asciz "RO_0010" # RO_0010'));
  assert.ok(result.text.includes('/* RO_0010 */'));
  assert.deepEqual(normalizeM2cJumpTables(result.text), { text: result.text, renames: [] });
});

test("mutable arrays, callback arrays and mixed data are not renamed", () => {
  for (const source of [listing("RO_0010", ".data"), listing("RO_0010", ".rodata", ".word function_a\n.word function_b"),
    listing("RO_0010", ".rdata", '.word .Lcase\n.asciz "text"'), listing("RO_0010", ".rdata", ".word .Lcase\n.word 0\n.word .Ldefault")])
    assert.deepEqual(normalizeM2cJumpTables(source), { text: source, renames: [] });
});

test("existing jump-table names survive and aliases cannot collide", () => {
  for (const name of ["jtbl_0010", "jpt_0010", "lbl_0010", "jumptable_0010"])
    assert.deepEqual(normalizeM2cJumpTables(listing(name)).renames, []);
  const source = listing() + "dlabel jtbl_RO_0010\n.word 0\nenddlabel jtbl_RO_0010\n";
  assert.equal(normalizeM2cJumpTables(source).renames[0]!.to, "jtbl_RO_0010_1");
  assert.equal(normalizeM2cJumpTables(listing() + "lui $v1, %hi(jtbl_RO_0010)\n").renames[0]!.to, "jtbl_RO_0010_1", "undefined imports also reserve their names");
});
