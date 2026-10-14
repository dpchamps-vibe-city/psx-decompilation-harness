import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "../testing/runtimeTestContext.js";
import { evaluateMacroEvidence, macroDefinitions, macroDefinitionHash, macroWitnessCounterfactual, opaqueMacroHazard, originalMacroWitnessIdentity, type MacroEvidenceEntry, type MacroEvidenceHooks, type MacroEvidenceWitness } from "./macroEvidence.js";

const transfer = '#define TRANSFER(destination) do { register void *entry __asm__("$9") = (destination); goto *entry; } while (0)\n';
const loadedWords = [0x3c090000, 0x8d290118, 0, 0x01200008, 0];
function fixture(t: { after: (action: () => void) => void }, header = transfer) {
  const root = mkdtempSync(join(tmpdir(), "macro-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["configs", "include", "sdk"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "include/operations.h"), header);
  const definition = macroDefinitions(header)[0]!;
  const entry: MacroEvidenceEntry = {
    name: definition.name, header: "include/operations.h", definitionSha256: macroDefinitionHash(definition.text),
    operation: "Transfer to an entry loaded from a BIOS slot", rationale: "Two original loaded-entry veneers use this ABI operation", witnesses: ["owner::first", "owner::second"],
  };
  const save = (entries: MacroEvidenceEntry[] = [entry]) => writeFileSync(join(root, "configs/macro-evidence.json"), JSON.stringify({ version: 1, macros: entries }));
  save();
  const hooks: MacroEvidenceHooks = {
    sdkHeaders: () => ["sdk"],
    verify: (_entry, _definition, witness) => ({ identity: witness, source: `void target(void) { ${entry.name}(slot); }`, originalWords: loadedWords, exact: true, withoutMacro: "mismatch" }),
  };
  const run = (override: Partial<MacroEvidenceWitness> = {}) => evaluateMacroEvidence(root, { ...hooks, verify: (e, d, w) => ({ ...hooks.verify(e, d, w), ...override }) });
  return { root, entry, save, hooks, run };
}

test("two independent material original-word uses earn an operation macro without approval", t => {
  const f = fixture(t), result = f.run();
  assert.deepEqual(result.failures, []);
  assert.equal(result.definitions.get("include/operations.h")?.get("TRANSFER"), 1);
  assert.equal(Object.hasOwn(f.entry, "approved"), false);
});

test("absent and empty evidence files create no grants", t => {
  const f = fixture(t);
  f.save([]);
  assert.equal(f.run().definitions.size, 0);
  rmSync(join(f.root, "configs/macro-evidence.json"));
  assert.deepEqual(f.run().failures, []);
  assert.equal(f.run().definitions.size, 0);
});

test("malformed manifests and duplicate names fail closed", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "configs/macro-evidence.json"), '{"version":2,"macros":[]}');
  assert.match(f.run().failures[0]!.message, /version:1/);
  f.save([f.entry, f.entry]);
  assert.match(f.run().failures[0]!.message, /unique/);
});

test("a changed definition must be remeasured and fingerprinted", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "include/operations.h"), transfer.replace('$9', '$8'));
  const result = f.run();
  assert.equal(result.definitions.size, 0);
  assert.match(result.failures[0]!.message, /definition changed/);
});

test("one use, duplicate keys and original-code aliases are insufficient", t => {
  const f = fixture(t);
  for (const witnesses of [["owner::first"], ["owner::first", "owner::first"]]) {
    f.entry.witnesses = witnesses; f.save();
    assert.match(f.run().failures[0]!.message, /two independent/);
  }
  f.entry.witnesses = ["owner::first", "alias::first"]; f.save();
  assert.match(f.run({ identity: "same-owner:same-offset" }).failures[0]!.message, /aliases/);
});

test("stub, non-match, dead and compilation-inconclusive uses cannot earn a grant", t => {
  const f = fixture(t);
  assert.match(f.run({ exact: false }).failures[0]!.message, /not MATCH/);
  for (const withoutMacro of ["match", "inconclusive", undefined] as const) {
    const result = f.run({ withoutMacro });
    assert.equal(result.definitions.size, 0);
    assert.match(result.failures[0]!.message, /dead or inconclusive/);
  }
});

test("mentions, inactive uses and wrong-arity calls are not original-code uses", t => {
  const f = fixture(t);
  for (const source of [
    '/* TRANSFER(slot); */\nvoid target(void) {}',
    '#if 0\nvoid target(void) { TRANSFER(slot); }\n#endif\n',
    'void target(void) { TRANSFER(); }',
    'void target(void) { TRANSFER(slot, other); }',
    'INCLUDE_ASM("original", target);',
  ]) assert.match(f.run({ source }).failures[0]!.message, /no active invocation/);
});

test("ordinary allocation difficulty is not positive ABI evidence", t => {
  const f = fixture(t, '#define PIN(value) ({ register int x __asm__("$9") = (value); x; })\n');
  assert.match(f.run({ originalWords: [0x24090001, 0x03e00008, 0] }).failures[0]!.message, /allocation difficulty/);
});

test("comments and ordinary strings do not manufacture hardware-operation evidence", t => {
  for (const hint of ['__asm__("nop # mfc0 syscall break 0");', 'const char *hint = "mfc0 syscall break 0";']) {
    const f = fixture(t, `#define PIN(value) ({ ${hint} register int x __asm__("$9") = (value); x; })\n`);
    assert.match(f.run({ originalWords: [0x40096000, 0x0000000c, 0x0000000d] }).failures[0]!.message, /no positive original/);
  }
});

test("actual coprocessor templates and raw command words have positive witnesses", t => {
  for (const [header, word] of [
    ['#define READ(value) __asm__("mfc0 %0,$12" : "=r"(value))\n', 0x40026000],
    ['#define READ(value) __asm__("lwc2 $0,0(%0)" :: "r"(value))\n', 0xc8000000],
    ['#define READ(value) __asm__(".word 0x4a000001" :: "r"(value))\n', 0x4a000001],
  ] as const) assert.deepEqual(fixture(t, header).run({ originalWords: [word] }).failures, []);
});

test("loaded-transfer evidence comes from actual instruction relationships", t => {
  const f = fixture(t);
  for (const words of [[], [0x24090001, 0, 0x01200008, 0], [0x3c090000, 0x8d280118, 0, 0x01200008, 0]])
    assert.match(f.run({ originalWords: words }).failures[0]!.message, /no positive original/);
});

test("whole-function assembly and new stubs cannot be laundered through macros", t => {
  for (const header of [
    '#define OP(value) __asm__(".globl target; .ent target; syscall; .end target")\n',
    '#define OP(value) INCLUDE_ASM("original", target)\n',
    '#define OP(value) __asm__(".incbin \\\"target.bin\\\"")\n',
  ]) assert.match(fixture(t, header).run().failures[0]!.message, /not operation macros/);
});

test("exceptional definitions must remain inside project include files", t => {
  const f = fixture(t);
  for (const header of ["../escape.h", "/tmp/operations.h", "include/../operations.h", "src/operations.h"]) {
    f.entry.header = header; f.save();
    assert.equal(f.run().definitions.size, 0);
  }
  const outside = mkdtempSync(join(tmpdir(), "macro-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "operations.h"), transfer);
  symlinkSync(join(outside, "operations.h"), join(f.root, "include/escape.h"));
  f.entry.header = "include/escape.h"; f.save();
  assert.match(f.run().failures[0]!.message, /escapes the project/);
});

test("an authoritative SDK binding plus one production use earns an operation", t => {
  const header = '#define READ(value) __asm__("mfc0 %0,$12" : "=r"(value))\n', f = fixture(t, header);
  writeFileSync(join(f.root, "sdk/reference.h"), header.replace("READ", "SDK_READ"));
  f.entry.sdk = { header: "sdk/reference.h", macro: "SDK_READ" };
  f.entry.witnesses = ["owner::first"]; f.save();
  assert.deepEqual(f.run({ originalWords: [], withoutMacro: undefined }).failures, []);
  const wrongRoots = evaluateMacroEvidence(f.root, { ...f.hooks, sdkHeaders: () => ["include"] });
  assert.match(wrongRoots.failures[0]!.message, /immutable reference headers/);
});

test("SDK binding comparison ignores code whitespace but never changes string contents", t => {
  const header = '#define READ(value) __asm__("mfc0 %0, $12 /* literal */" : "=r"(value))\n', f = fixture(t, header);
  f.entry.sdk = { header: "sdk/reference.h", macro: "SDK_READ" };
  f.entry.witnesses = ["owner::first"]; f.save();
  writeFileSync(join(f.root, "sdk/reference.h"), header.replace("READ", "SDK_READ").replace(' : ', '  /* syntax comment */ :  '));
  assert.deepEqual(f.run().failures, []);
  writeFileSync(join(f.root, "sdk/reference.h"), header.replace("READ", "SDK_READ").replace(' /* literal */', ''));
  assert.match(f.run().failures[0]!.message, /does not reproduce/);
});

test("original-code identity does not count aliases with different inferred spans twice", () => {
  const owner = { id: "member", kind: "library" as const };
  const coordinate = { kind: "section" as const, section: ".text", offset: 12, size: 20, inferredSize: false };
  const first = originalMacroWitnessIdentity({ owner, coordinate });
  assert.equal(originalMacroWitnessIdentity({ owner, coordinate: { ...coordinate, size: 24, inferredSize: true } }), first);
  assert.notEqual(originalMacroWitnessIdentity({ owner, coordinate: { ...coordinate, offset: 16 } }), first);
  assert.throws(() => originalMacroWitnessIdentity({ owner: { id: "exe", kind: "exe" }, coordinate: { kind: "image" } }), /no resolved code coordinate/);
});

test("header and manifest changes during proof invalidate the audit", t => {
  for (const change of ["header", "manifest"]) {
    const f = fixture(t);
    const result = evaluateMacroEvidence(f.root, { ...f.hooks, verify: (e, d, w) => {
      const proof = f.hooks.verify(e, d, w);
      if (change === "header") writeFileSync(join(f.root, "include/operations.h"), transfer + "/* concurrent edit */");
      else writeFileSync(join(f.root, "configs/macro-evidence.json"), '{"version":1,"macros":[]}');
      return proof;
    } });
    assert(result.failures.some(failure => /changed during/.test(failure.message)), change);
  }
});

test("SDK tokens distinguish adjacent operators from separated tokens", t => {
  const f = fixture(t, '#define ADVANCE(value) (++value)\n');
  f.entry.sdk = { header: "sdk/reference.h", macro: "SDK_ADVANCE" };
  f.entry.witnesses = ["owner::first"]; f.save();
  writeFileSync(join(f.root, "sdk/reference.h"), '#define SDK_ADVANCE(value) (+ +value)\n');
  assert.match(f.run().failures[0]!.message, /does not reproduce/);
});

test("material-use counterfactual edits only the selected function, not a shared-TU neighbor", () => {
  const source = 'void first(void) { TRANSFER(first_slot); }\nvoid second(void) { TRANSFER(second_slot); }\n';
  const proof = macroWitnessCounterfactual(source, "first", "TRANSFER");
  assert.equal(proof.uses, 1);
  assert.equal(proof.witnessSource, 'void first(void) { TRANSFER(first_slot); }');
  assert.match(proof.candidate, /\(\(void\)\(first_slot\), 0\)/);
  assert.match(proof.candidate, /void second\(void\) \{ TRANSFER\(second_slot\); \}/);
  const missing = macroWitnessCounterfactual(source, "absent", "TRANSFER");
  assert.equal(missing.witnessSource, ""); assert.equal(missing.uses, 0); assert.equal(missing.candidate, source);
});

test("material-use counterfactual preserves argument evaluation and ignores disabled calls", () => {
  const source = 'int target(void) {\n#if 0\n TRANSFER(dead_slot);\n#endif\n TRANSFER(next_slot()); return 0; }';
  const proof = macroWitnessCounterfactual(source, "target", "TRANSFER");
  assert.equal(proof.uses, 1);
  assert.match(proof.candidate, /TRANSFER\(dead_slot\)/);
  assert.match(proof.candidate, /\(\(void\)\(next_slot\(\)\), 0\)/);
});

test("opaque syntax detection is lexical even in unparsable replacement lists", () => {
  assert.equal(opaqueMacroHazard(transfer), true);
  assert.equal(opaqueMacroHazard('goto *pointer'), true);
  assert.equal(opaqueMacroHazard('left ## right'), true);
  assert.equal(opaqueMacroHazard('/* asm("nop"); */ "goto *pointer // __asm__"'), false);
  assert.equal(opaqueMacroHazard('(value) + 1'), false);
});
