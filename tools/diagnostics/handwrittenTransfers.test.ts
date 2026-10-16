import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import { projectFixture, FIXTURE_BASE } from "../testing/projectFixture.js";
import { libraryMembers } from "../lib/libraryTargets.js";
import { scanHandwrittenAssembly, renderAssemblyScan } from "./handwrittenAssembly.js";

const installer = (name: string, source: string, bytes: number) => `
.globl ${name}
.type ${name},@function
${name}:
lui $1,%hi(saved)
sw $31,%lo(saved)($1)
jal external_service
nop
lui $10,%hi(${source})
addiu $10,$10,%lo(${source})
lui $9,%hi(${source}+${bytes})
addiu $9,$9,%lo(${source}+${bytes})
.Lloop_${name}:
lw $3,0($10)
nop
sw $3,0($4)
addiu $10,$10,4
bne $10,$9,.Lloop_${name}
addiu $4,$4,4
jal external_service
nop
lui $31,%hi(saved)
lw $31,%lo(saved)($31)
nop
jr $31
nop
.size ${name},.-${name}
`;

test("real ELF copies resolve interior entries and independently deployed RAM aliases, preserving prefix lengths", t => {
  const f = projectFixture(t, { overlays: {} });
  f.put("input/transfers.s", `.set noreorder
.set noat
.text
.space 16
${installer("install_local", ".Llocal_template", 12)}
${installer("install_fixed", ".Lfixed_template", 20)}
.globl clear_counter
.type clear_counter,@function
clear_counter:
jr $31
nop
.Llocal_template:
lui $2,%hi(.Lhandler)
addiu $2,$2,%lo(.Lhandler)
jalr $2
nop
.Lhandler:
mfc0 $26,$14
nop
jr $26
rfe
.size clear_counter,.-clear_counter
.globl template_holder
.type template_holder,@function
template_holder:
jr $31
nop
.Lfixed_template:
lui $2,0xa001
addiu $2,$2,-0x2078
jr $2
nop
nop
.size template_holder,.-template_holder
.globl word_source
.type word_source,@function
word_source:
jr $31
nop
addiu $2,$0,42
jr $31
nop
.size word_source,.-word_source
.globl copy_words
.type copy_words,@function
copy_words:
lui $10,%hi(word_source)
addiu $10,$10,%lo(word_source)
lui $9,%hi(word_source+20)
addiu $9,$9,%lo(word_source+20)
ori $2,$0,0xdf80
.Ldeploy:
lw $3,0($10)
nop
sw $3,0($2)
addiu $10,$10,4
bne $10,$9,.Ldeploy
addiu $2,$2,4
jr $31
nop
.size copy_words,.-copy_words
.bss
saved:
.space 4
`);
  execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", join(f.root, "input/transfers.s"), "-o", join(f.root, "input/transfers.o")]);
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["input/transfers.o"] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "input" } }));
  fixtureContext(f.root, () => {
    const member = libraryMembers()[0]!, directory = "src/libraries/transfers";
    f.put(`${directory}/tu.json`, JSON.stringify({ schemaVersion: 1, member: member.id,
      parts: member.functions.map(fn => ({ path: `${fn.name}.c`, symbol: fn.name })) }));
    for (const fn of member.functions) f.put(`${directory}/${fn.name}.c`, `INCLUDE_ASM("original", ${fn.name});\n`);
    const selected = scanHandwrittenAssembly({ functionNames: ["install_local", "install_fixed"] });
    assert.equal(selected.summary.scanned, 2); assert.equal(selected.summary.assemblyCandidates, 2);
    assert(selected.functions.every(row => row.confidence.score === 85 && row.copiedTransfers.length === 1));
    const local = selected.functions.find(r => r.function.endsWith("::install_local"))!.copiedTransfers[0]!;
    assert.equal(local.template.copiedBytes, 12); assert.equal(local.template.delaySlotCopied, false);
    assert.equal(local.target.kind, "local-entry");
    if (local.target.kind === "local-entry") {
      assert.equal(local.target.offset, 24); assert.deepEqual(local.target.exceptionReturns, [32]);
      assert(local.target.function.endsWith("::clear_counter"));
    }
    const fixed = selected.functions.find(r => r.function.endsWith("::install_fixed"))!.copiedTransfers[0]!;
    assert.equal(fixed.template.copiedBytes, 20); assert.equal(fixed.template.delaySlotCopied, true);
    assert.equal(fixed.target.kind, "deployed-entry");
    if (fixed.target.kind === "deployed-entry") {
      assert.equal(fixed.target.address, 0xa000df88); assert.equal(fixed.target.physicalAddress, 0xdf88);
      assert.equal(fixed.target.offset, 8); assert.equal(fixed.target.deployment.copy.bytes, 20);
    }
    assert.match(renderAssemblyScan(selected, { selected: true }), /delay slot NOT copied \(destination slot unknown\)/);
    assert.match(renderAssemblyScan(selected), /deployed-entry/);
    assert.equal(selected.modules[0]!.allFunctionsScanned, false);
    f.put(`${directory}/install_local.c`, "void install_local(void) {}\n");
    const all = scanHandwrittenAssembly(), protectedC = all.functions.find(r => r.function.endsWith("::install_local"))!;
    assert.equal(protectedC.confidence.score, 85); assert.equal(protectedC.disposition, "keep-existing-C");
    assert.equal(protectedC.eligibleForAssembly, false);
    assert(all.functions.filter(r => !r.function.endsWith("::install_local") && !r.function.endsWith("::install_fixed")).every(r => r.confidence.score === 0));
  });
});

test("linked-image witnesses cannot leak across separately owned translation units in the same container", t => {
  const address = (r: number, value: number) => [((15 << 26) | (r << 16) | Math.floor((value + 0x8000) / 0x10000)) >>> 0,
    ((9 << 26) | (r << 21) | (r << 16) | (value & 0xffff)) >>> 0];
  const holder = FIXTURE_BASE + 0x100;
  const f = projectFixture(t, { overlays: {}, exe: [
    { name: "install_words", offset: 0, words: [0x3c018004, 0xac3f0004, 0x0c001000, 0,
      ...address(10, holder + 8), ...address(9, holder + 20),
      0x8d430000, 0, 0xac830000, 0x254a0004, 0x1549fffb, 0x24840004, 0x0c001000, 0,
      0x3c1f8004, 0x8fff0004, 0, 0x03e00008, 0] },
    { name: "clear_counter", offset: 0x100, words: [0x03e00008, 0, ...address(2, holder + 24), 0x0040f809, 0,
      0x401a7000, 0, 0x03400008, 0x42000010] },
  ] });
  fixtureContext(f.root, () => {
    const report = scanHandwrittenAssembly({ functionNames: ["install_words"] }), row = report.functions[0]!;
    assert.equal(row.confidence.score, 65); assert.equal(row.copiedTransfers.length, 0);
    assert.equal(report.modules[0]!.functions.length, 1);
  });
});
