import assert from "node:assert/strict";
import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import { projectFixture } from "../testing/projectFixture.js";
import { libraryMembers } from "./libraryTargets.js";
import { libraryAssemblyParts, writeLibraryAssemblyParts, libraryAssemblyInputs } from "./libraryAssembly.js";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
const record = (...parts: Array<number | Buffer>) => Buffer.concat(parts.map(p => typeof p === "number" ? Buffer.from([p]) : p));
function setup(t: Parameters<typeof projectFixture>[0], options: { assembly?: boolean; branch?: boolean; move?: boolean; slotLabel?: boolean } = {}) {
  const f = projectFixture(t);
  f.toolchain.assembler = { kind: "gas", objectFormat: "ecoff", postAssembly: ["psyq-dmpsx", "psyq-lnk"] };
  f.toolchain.flags.as = ["-EL", "-G0", "-mips1"];
  f.toolchain.includeDirs = ["include"];
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  f.put("include/asm.h", "#define ra $31\n#define v0 $2\n#define a0 $4\n#define zero $0\n");
  f.put("include/inline_s.h", "");
  const code = Buffer.alloc(32), words = [options.move ? 0x00801025 : options.slotLabel ? 0x10000002 : 0, 0x3c020000, options.branch ? 0x14400003 : 0x0c000000, 0x24420004, 0x03e00008, 0, 0, 0];
  words.forEach((word, i) => code.writeUInt32LE(word, i * 4));
  const entry = options.assembly ? 1 : 3, callee = entry + 1, common = entry + 4;
  const expression = (value = 0) => value ? record(44, 0, u32(value), 2, u16(callee)) : record(2, u16(callee));
  const input = Buffer.concat([Buffer.from("LNK\x02"), record(46, 7),
    ...[".rdata", ".text", ".data", ".sdata", ".sbss", ".bss"].map((s, i) => record(16, u16(0xf001 + i), u16(0), 8, str(s))),
    record(12, u16(entry), u16(0xf002), u32(0), str("entry")), record(14, u16(callee), str("callee")), record(48, u16(common), u16(0xf006), u32(4), str("pool")),
    record(6, u16(0xf002)), record(2, u16(code.length), code), record(10, 82, u16(4), expression(4)), record(10, 84, u16(12), expression(4)),
    ...(options.branch ? [] : [record(10, 74, u16(8), expression())]),
    record(6, u16(0xf003)), record(2, u16(16), u32(0x1000), u32(4), u32(0), u32(0)), record(10, 16, u16(4), expression(4)), record(0)]);
  f.put("unit.OBJ", input);
  f.put("view.s", '.set noreorder\n.text\n.globl entry\n.globl callee\nentry:\n' + words.map(w => `.word 0x${w.toString(16)}\n`).join("") + '.reloc entry+4,R_MIPS_HI16,callee\n.reloc entry+12,R_MIPS_LO16,callee\n' + (options.branch ? '' : '.reloc entry+8,R_MIPS_26,callee\n') + '.data\nview_data:\n.word 0x1000,4,0,0\n.reloc view_data+4,R_MIPS_32,callee\n.comm pool,4,4\n');
  execFileSync(f.toolchain.tools.as as string, [...f.toolchain.flags.as, join(f.root, "view.s"), "-o", join(f.root, "view.o")]);
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "psyq-lib", standaloneObjects: ["unit.OBJ"] }, views: { elf: { unit: "view.o" } }, verification: { mode: "original-object" }, output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "." } }));
  return { f, run: (body: (member: ReturnType<typeof libraryMembers>[number], listing: string) => void) => fixtureContext(f.root, () => {
    const member = libraryMembers()[0]!, directory = dirname(member.source);
    f.put(join(directory, "tu.json"), JSON.stringify({ schemaVersion: 1, member: member.id, parts: options.assembly ? [{ path: "backlog.ASM", symbols: ["entry"], backlog: true }] : [{ path: "_shared.h" }, { path: "entry.c", symbol: "entry" }] }));
    f.put(join(directory, "_shared.h"), "extern int local_data;\n");
    f.put(join(directory, "entry.c"), `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", entry);\n`);
    f.put(join(directory, "backlog.ASM"), `.include "build/libraries/nonmatchings/${member.id}/__library_member_symbols.s"\n.include "build/libraries/nonmatchings/${member.id}/__library_member_assembly.s"\n`);
    const line = (section: string, off: number, word: number, instruction: string) => `/* ${((member.viewObject ?? member.object).sections.get(section)!.offset + off).toString(16).padStart(6, "0")} 00000000 ${u32(word).toString("hex")} */ ${instruction}\n`;
    const listing = '.section .text\nnonmatching entry, 32\nglabel entry\n' +
      line(".text", 0, words[0]!, options.move ? "move $v0, $a0" : options.slotLabel ? "b private_slot" : "nop") +
      line(".text", 4, words[1]!, "lui $v0, %hi(callee)") + line(".text", 8, words[2]!, options.branch ? "bnez $v0, private_exit" : "jal callee") +
      (options.slotLabel ? "jlabel private_slot\n" : "") + line(".text", 12, words[3]!, "addiu $v0, $v0, %lo(callee)") +
      line(".text", 16, words[4]!, "jr $ra") + line(".text", 20, 0, "nop") + 'jlabel private_exit\n' + line(".text", 24, 0, "nop") + line(".text", 28, 0, "nop") + 'endlabel entry\n.section .data\ndlabel local_data\n' +
      line(".data", 0, 0x1000, ".word D_00001000") + 'dlabel private_data\n' + line(".data", 4, 4, ".word callee") + line(".data", 8, 0, ".word 0") + line(".data", 12, 0, ".word 0");
    body(member, listing);
  }) };
}

test("ECOFF extraction: symbol part is first, reserves holes, and has a fresh cpp receipt", t => {
  const { f, run } = setup(t);
  run((member, listing) => {
    const parts = libraryAssemblyParts(member, listing);
    assert.equal(parts[0]!.symbol, "__library_member_symbols");
    assert.match(parts[0]!.text, /\.globl entry\n\.globl callee\n__lnk_hidden_5:\n__lnk_hidden_6:\n\.globl pool/);
    assert.deepEqual(parts[0]!.functions, []);
    writeLibraryAssemblyParts(member, parts);
    assert.ok(libraryAssemblyInputs(member, "__library_member_symbols").some(p => p.endsWith(".cpp.json")));
    assert.match(readFileSync(join(f.root, `build/libraries/nonmatchings/${member.id}/__library_member_symbols.s`), "utf8"), /__lnk_hidden_5:/);
  });
});
test("ECOFF extraction: private labels use $L, except names the C TU references", t => {
  setup(t).run((member, listing) => {
    const text = libraryAssemblyParts(member, listing).map(p => p.text).join("\n");
    assert.match(text, /local_data:/); assert.match(text, /\$Lprivate_data:/); assert.match(text, /\$Lprivate_exit:/);
    assert.doesNotMatch(text, /\.NON_MATCHING|\.reloc/);
  });
});
test("ECOFF extraction: witnessed jump and branch slots are written in assembler source order", t => {
  for (const branch of [false, true]) setup(t, { branch }).run((member, listing) => {
    const text = libraryAssemblyParts(member, listing).find(p => p.symbol === "entry")!.text;
    assert.match(text, /\.set reorder\n[^]*lui v0[^]*addiu v0[^]*(?:jal callee|bnez v0)[^]*\.set noreorder/);
    assert.ok(text.indexOf("addiu v0") < text.indexOf(branch ? "bnez v0" : "jal callee"));
  });
  setup(t, { slotLabel: true }).run((member, listing) => {
    const text = libraryAssemblyParts(member, listing).find(p => p.symbol === "entry")!.text;
    assert.ok(text.indexOf("jal callee") < text.indexOf("addiu v0"), "referenced slot labels forbid moving the slot");
  });
});
test("ECOFF extraction: data words are symbolic only at original patches", t => {
  setup(t).run((member, listing) => {
    const data = libraryAssemblyParts(member, listing).find(p => p.symbol === "__library_member_data")!.text;
    assert.match(data, /\.word 0x00001000/); assert.match(data, /\.word callee\+4/); assert.doesNotMatch(data, /D_00001000/);
    assert.throws(() => libraryAssemblyParts(member, listing.replace(".word D_00001000", ".word 0x1001")), /literal disagrees/);
  });
});
test("ECOFF extraction: COMMON declarations survive both split and whole generated backlogs", t => {
  for (const assembly of [false, true]) setup(t, { assembly }).run((member, listing) => {
    const parts = libraryAssemblyParts(member, listing);
    const data = parts.find(p => p.symbol === "__library_member_data")!.text;
    assert.equal([...data.matchAll(/^\.comm pool, 4$/gm)].length, 1);
    if (assembly) {
      const whole = parts.find(p => p.symbol === "__library_member_assembly")!.text;
      assert.equal([...whole.matchAll(/^\.comm pool, 4$/gm)].length, 1);
      assert.doesNotMatch(parts[0]!.translationUnit!, /\.comm/);
    }
  });
});
test("ECOFF extraction: OR encodings are spelled OR rather than the ADDU move pseudo", t => {
  setup(t, { move: true }).run((member, listing) => assert.match(libraryAssemblyParts(member, listing).find(p => p.symbol === "entry")!.text, /or v0, a0, zero/));
});
test("ECOFF extraction: assembly backlog stays generated; instructions are not re-rendered", t => {
  setup(t, { assembly: true }).run((member, listing) => {
    const parts = libraryAssemblyParts(member, listing), source = parts[0]!.translationUnit!;
    assert.match(source, /^\.include[^]*__library_member_symbols\.s[^]*\.include[^]*__library_member_assembly\.s/);
    assert.doesNotMatch(source, /jr|lui|\.word/);
    assert.match(parts[0]!.text, /\.globl entry\n\.globl callee\n__lnk_hidden_3:/);
    const literal = listing.replace(/jr \$ra/, ".word 0x03e00008");
    assert.match(libraryAssemblyParts(member, literal).find(p => p.symbol === "__library_member_assembly")!.text, /\.word 0x03e00008/);
    assert.throws(() => libraryAssemblyParts(member, listing + "\n.section .sbss\n"), /\.sbss data/);
  });
});
