import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import { projectFixture } from "../testing/projectFixture.js";
import { libraryMembers } from "../lib/libraryTargets.js";
import { scanHandwrittenAssembly, renderAssemblyScan } from "./handwrittenAssembly.js";

test("ELF module witnesses survive a single-function query and do not overwrite existing C", t => {
  const f = projectFixture(t, { overlays: {} });
  f.put("input/lifecycle.s", `.set noreorder
.set noat
.text
.globl install_operation
.type install_operation,@function
install_operation:
lui $1,%hi(state+4)
sw $31,%lo(state+4)($1)
lui $2,%hi(state)
lw $2,%lo(state)($2)
nop
lui $10,%hi(runtime_buffer)
addiu $10,$10,%lo(runtime_buffer)
lui $9,%hi(runtime_buffer+12)
addiu $9,$9,%lo(runtime_buffer+12)
.Lsave:
lw $3,0($2)
nop
sw $3,0($10)
addiu $10,$10,4
bne $10,$9,.Lsave
addiu $2,$2,4
lui $2,%hi(state)
lw $2,%lo(state)($2)
nop
lui $10,%hi(call_template)
addiu $10,$10,%lo(call_template)
lui $9,%hi(call_template+16)
addiu $9,$9,%lo(call_template+16)
.Linstall:
lw $3,0($10)
nop
sw $3,0($2)
addiu $10,$10,4
bne $10,$9,.Linstall
addiu $2,$2,4
jal external_service
nop
lui $31,%hi(state+4)
lw $31,%lo(state+4)($31)
nop
jr $31
nop
.size install_operation,.-install_operation
.globl restore_operation
.type restore_operation,@function
restore_operation:
lui $1,%hi(state+4)
sw $31,%lo(state+4)($1)
lui $2,%hi(state)
lw $2,%lo(state)($2)
nop
lui $10,%hi(runtime_buffer)
addiu $10,$10,%lo(runtime_buffer)
lui $9,%hi(runtime_buffer+12)
addiu $9,$9,%lo(runtime_buffer+12)
.Lrestore:
lw $3,0($10)
nop
sw $3,0($2)
addiu $10,$10,4
bne $10,$9,.Lrestore
addiu $2,$2,4
jal external_service
nop
lui $31,%hi(state+4)
lw $31,%lo(state+4)($31)
nop
jr $31
nop
.size restore_operation,.-restore_operation
.globl call_template
.type call_template,@function
call_template:
lui $2,%hi(callback_entry)
addiu $2,$2,%lo(callback_entry)
jalr $2
nop
.size call_template,.-call_template
.globl callback_entry
.type callback_entry,@function
callback_entry:
jr $31
nop
.size callback_entry,.-callback_entry
.globl runtime_buffer
.type runtime_buffer,@function
runtime_buffer:
nop
nop
nop
nop
jr $31
nop
.size runtime_buffer,.-runtime_buffer
.data
state:
.space 8
`);
  execFileSync("mips-linux-gnu-as", ["-EL", "-G0", "-march=r3000", join(f.root, "input/lifecycle.s"), "-o", join(f.root, "input/lifecycle.o")]);
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["input/lifecycle.o"] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "input" } }));
  fixtureContext(f.root, () => {
    const member = libraryMembers()[0]!, directory = "src/libraries/lifecycle";
    f.put(`${directory}/tu.json`, JSON.stringify({ schemaVersion: 1, member: member.id,
      parts: member.functions.map(fn => ({ path: `${fn.name}.c`, symbol: fn.name })) }));
    for (const fn of member.functions) f.put(`${directory}/${fn.name}.c`, `INCLUDE_ASM("original", ${fn.name});\n`);
    const selected = scanHandwrittenAssembly({ functionNames: ["restore_operation"] }), row = selected.functions[0]!;
    assert.equal(selected.scannerVersion, 4); assert.equal(selected.summary.scanned, 1);
    assert.equal(row.confidence.score, 85); assert(row.eligibleForAssembly);
    const hook = row.codeHooks[0]!;
    assert.equal(hook.save.bytes, 12); assert.equal(hook.install.bytes, 16); assert.equal(hook.restore.bytes, 12);
    assert.equal(hook.witnesses.length, 5);
    assert(hook.save.function.endsWith("::install_operation"));
    assert(hook.buffer.function.endsWith("::runtime_buffer"));
    assert(hook.trampoline.target.endsWith("::callback_entry"));
    assert.equal(selected.modules[0]!.allFunctionsScanned, false, "witness discovery does not claim all functions were selected");
    assert.match(renderAssemblyScan(selected, { selected: true }), /code hook \(restorer\): save 12, install 16, restore 12/);
    f.put(`${directory}/install_operation.c`, "void install_operation(void) {}\n");
    const all = scanHandwrittenAssembly(), installer = all.functions.find(fn => fn.function.endsWith("::install_operation"))!;
    assert.equal(installer.confidence.score, 85); assert.equal(installer.disposition, "keep-existing-C");
    assert.equal(installer.eligibleForAssembly, false);
    assert.equal(all.functions.find(fn => fn.function.endsWith("::restore_operation"))!.confidence.score, 85);
    assert(all.functions.filter(fn => !["install_operation", "restore_operation"].some(name => fn.function.endsWith(`::${name}`))).every(fn => !fn.eligibleForAssembly));
  });
});
