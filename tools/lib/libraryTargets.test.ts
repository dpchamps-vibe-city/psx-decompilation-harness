import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT, configuredFlags } from "./toolchain.js";
import { loadLibraryProject, libraryContext } from "./project.js";
import { libraryMembers, requireLibraryFunction, type LibraryMember } from "./libraryTargets.js";
import { compareRelocatableObjects, readRelocatableObject, objectFunctions, relocatableOutputIdentity } from "./relocatableObject.js";
import { libraryAssemblyParts } from "./libraryAssembly.js";
import { libraryMemberSource, librarySourceInputRoot, legacyLibrarySource } from "./librarySourceLayout.js";
import type { LibraryProject } from "./project.js";
import { resolveFunctionTarget, sourceFlagContext, functionSymbol } from "./targetAdapter.js";
import { functionPaths } from "../../.pi/extensions/shared/call-graph.js";
import { validateFunctionName } from "../../.pi/extensions/psx-decomp/tools/shared.js";
import { checkSourcePolicy } from "../../.pi/extensions/shared/source-policy.js";
import { DEFAULT_CONFIG } from "../../.pi/extensions/shared/config.js";
import { compareWords, type RenderedWord } from "./functionOracle.js";
import { compilerAssemblyOrigin, projectCompilerArtifacts, resetCompilerArtifacts } from "./compilerArtifacts.js";
import { extractWebPartition } from "../diagnostics/webPartition.js";
import { decodeFunctionWords } from "../agent/matching-reconstruction/decode.js";
import { buildMachineIrFrom } from "../agent/machine-ir/index.js";

/** Tiny synthetic MIPS ET_REL; no compiler, SDK, game assets or addresses. */
function objectFixture(): Buffer {
  const names = "\0first\0second\0ext_a\0ext_b\0common\0";
  const syms = Buffer.alloc(7 * 16);
  const symbol = (i: number, name: string, value: number, size: number, info: number, section: number) => {
    const at = i * 16; syms.writeUInt32LE(name ? names.indexOf(name) : 0, at);
    syms.writeUInt32LE(value, at + 4); syms.writeUInt32LE(size, at + 8);
    syms[at + 12] = info; syms.writeUInt16LE(section, at + 14);
  };
  symbol(1, "first", 0, 8, 0x12, 1); symbol(2, "second", 8, 8, 0x12, 1);
  symbol(3, "ext_a", 0, 0, 0x10, 0); symbol(4, "ext_b", 0, 0, 0x10, 0);
  symbol(5, "common", 4, 4, 0x11, 0xfff2); symbol(6, "", 0, 0, 3, 2);
  const rels = Buffer.alloc(24);
  for (const [i, off, sym, kind] of [[0, 0, 3, 5], [1, 4, 3, 6], [2, 8, 6, 2]]) {
    rels.writeUInt32LE(off!, i! * 8); rels.writeUInt32LE((sym! << 8) | kind!, i! * 8 + 4);
  }
  const specs = [
    { name: "", type: 0, flags: 0, data: Buffer.alloc(0), align: 0 },
    { name: ".text", type: 1, flags: 6, data: Buffer.from("0100023c02004224000000000800e003", "hex"), align: 4 },
    { name: ".data", type: 1, flags: 3, data: Buffer.from([1, 2, 3, 4]), align: 4 },
    { name: ".bss", type: 8, flags: 3, data: Buffer.alloc(0), size: 8, align: 4 },
    { name: ".symtab", type: 2, flags: 0, data: syms, align: 4, link: 5, entsize: 16 },
    { name: ".strtab", type: 3, flags: 0, data: Buffer.from(names), align: 1 },
    { name: ".rel.text", type: 9, flags: 0, data: rels, align: 4, link: 4, info: 1, entsize: 8 },
    { name: ".shstrtab", type: 3, flags: 0, data: Buffer.alloc(0), align: 1 },
  ];
  const strings = "\0" + specs.slice(1).map(s => s.name + "\0").join("");
  specs[7]!.data = Buffer.from(strings);
  const dataStart = 52 + specs.length * 40;
  const b = Buffer.alloc(dataStart + specs.reduce((n, s) => n + s.data.length, 0));
  b.write("\x7fELF", 0, "binary"); b[4] = b[5] = b[6] = 1;
  b.writeUInt16LE(1, 16); b.writeUInt16LE(8, 18); b.writeUInt32LE(1, 20);
  b.writeUInt32LE(52, 32); b.writeUInt16LE(52, 40); b.writeUInt16LE(40, 46);
  b.writeUInt16LE(specs.length, 48); b.writeUInt16LE(7, 50);
  let pos = dataStart;
  for (const [i, s] of specs.entries()) {
    const at = 52 + i * 40;
    for (const [offset, value] of [[0, s.name ? strings.indexOf(s.name) : 0], [4, s.type], [8, s.flags], [16, pos],
      [20, s.size ?? s.data.length], [24, s.link ?? 0], [28, s.info ?? 0], [32, s.align], [36, s.entsize ?? 0]]) b.writeUInt32LE(value!, at + offset!);
    s.data.copy(b, pos); pos += s.data.length;
  }
  return b;
}
function archive(objects: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from("!<arch>\n"), ...objects.flatMap(bytes => [
    Buffer.from("member.o/".padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "100644".padEnd(8) + String(bytes.length).padEnd(10) + "`\n"),
    bytes, ...(bytes.length & 1 ? [Buffer.from("\n")] : []),
  ])]);
}

test("member oracle retains relocation targets/addends, data/BSS/COMMON and rejects unknown relocations", () => {
  const original = objectFixture(), parsed = readRelocatableObject(original);
  assert.equal(compareRelocatableObjects(original, original).verdict, "match");
  const changed = (mutate: (b: Buffer) => void) => { const b = Buffer.from(original); mutate(b); return compareRelocatableObjects(original, b); };
  const relocation = parsed.sections.get(".rel.text")!.offset;
  assert.equal(changed(b => b.writeUInt32LE((4 << 8) | 5, relocation + 4)).verdict, "mismatch");
  assert.equal(changed(b => b[parsed.sections.get(".text")!.offset] = b[parsed.sections.get(".text")!.offset]! ^ 1).verdict, "mismatch");
  assert.equal(changed(b => b[parsed.sections.get(".data")!.offset] = b[parsed.sections.get(".data")!.offset]! ^ 1).verdict, "mismatch");
  assert.equal(changed(b => b.writeUInt32LE(12, 52 + parsed.sections.get(".bss")!.index * 40 + 20)).verdict, "mismatch");
  assert.equal(changed(b => b.writeUInt32LE(8, parsed.sections.get(".symtab")!.offset + 5 * 16 + 8)).verdict, "mismatch");
  assert.equal(changed(b => b.writeUInt32LE((3 << 8) | 255, relocation + 4)).verdict, "undetermined");
  const a: RenderedWord = { vram: 0, raw: 0x0c000000, text: "jal ext_a", key: "jal ext_a", relocations: [{ type: "R_MIPS_26", reference: "import:ext_a", addend: 0 }] };
  const b: RenderedWord = { ...a, relocations: [{ type: "R_MIPS_26", reference: "import:ext_b", addend: 0 }] };
  assert.equal(compareWords([a], [b]).verdict, "mismatch", "identical fields cannot hide a changed relocation target");
  const neighbor = Buffer.from(original); neighbor[parsed.sections.get(".data")!.offset] = 9;
  assert.notEqual(relocatableOutputIdentity(parsed), relocatableOutputIdentity(readRelocatableObject(neighbor)), "ledger identity includes neighboring TU data");
});

test("independent relocation packaging can move, but HI16/LO16 pairing order stays exact", () => {
  const original = objectFixture(), offset = readRelocatableObject(original).sections.get(".rel.text")!.offset;
  const rows = [0, 1, 2].map(n => original.subarray(offset + n * 8, offset + (n + 1) * 8));
  const independentFirst = Buffer.from(original);
  Buffer.concat([rows[2]!, rows[0]!, rows[1]!]).copy(independentFirst, offset);
  assert.equal(compareRelocatableObjects(original, independentFirst).verdict, "match");
  const reorderedPair = Buffer.from(original);
  Buffer.concat([rows[1]!, rows[0]!, rows[2]!]).copy(reorderedPair, offset);
  assert.equal(compareRelocatableObjects(original, reorderedPair).verdict, "mismatch");
});

test("library mode is opt-in; duplicate members stay distinct, profiles and immutable header roles are explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "psx-library-"));
  try {
    assert.equal(loadLibraryProject(root), null, "absent manifest retains EXE path");
    writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1, target: { kind: "linked-image" } }));
    assert.equal(loadLibraryProject(root), null, "explicit linked-image retains EXE path");
    const image = resolveFunctionTarget("fixture", root);
    assert.equal(image.source, "src/fixture.c");
    assert.deepEqual(image.includeAsm, { folder: "build/asm/nonmatchings/fixture", symbol: "fixture" });
    assert.deepEqual(image.verification, { scope: "function", mode: "linked-bytes" });
    const config = JSON.parse(readFileSync(join(HARNESS_ROOT, "toolchain.json"), "utf8"));
    config.profiles.library_test = { cpp: ["-DLIBRARY_TEST"], includeDirs: ["include/library"] };
    writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
    writeFileSync(join(root, "original.a"), archive([objectFixture(), objectFixture()]));
    const manifest = { schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", archives: ["original.a"] },
      headers: { reference: ["include/psyq"], owned: ["include/library"], context: ["libcd.h"] }, toolchainProfile: "library_test" };
    writeFileSync(join(root, "project.json"), JSON.stringify(manifest));
    const members = libraryMembers(root);
    assert.equal(members.length, 2); assert.notEqual(members[0]!.id, members[1]!.id);
    assert.deepEqual(members.map(m => m.source), ["src/libraries/original/0-member.c", "src/libraries/original/1-member.c"]);
    assert.throws(() => requireLibraryFunction("first", root), /Ambiguous/);
    const key = `${members[0]!.id}::first`;
    assert.equal(requireLibraryFunction(key, root).member.id, members[0]!.id);
    validateFunctionName(key);
    const target = resolveFunctionTarget(key, root);
    assert.equal(target.source, members[0]!.source);
    assert.equal(target.symbol, "first");
    assert.equal(functionSymbol(key), "first");
    assert.equal(target.translationUnit.functions.length, 2);
    assert.deepEqual(target.verification, { scope: "translation-unit", mode: "relocatable-object" });
    assert.deepEqual(target.coordinate, { kind: "section", section: ".text", offset: 0, size: 8, inferredSize: false });
    assert.equal(target.assembly.function, `${target.includeAsm.folder}/first.s`);
    assert.deepEqual(functionPaths(root, key), { container: target.owner.id, source: target.source, includeAsmPath: target.includeAsm.folder });
    assert.deepEqual(sourceFlagContext(join(root, target.source), root), target.flags);
    assert.deepEqual(configuredFlags("cpp", libraryContext(members[0]!.id, root), root), [`-I${join(root, "include/library")}`, "-DLIBRARY_TEST"]);
    const policy = checkSourcePolicy({ projectRoot: root, config: DEFAULT_CONFIG, changedFiles: ["include/psyq/libcd.h"], patch: "" });
    assert.equal(policy.pass, false); assert.match(policy.hardFailures[0]!.message, /immutable/);
    writeFileSync(join(root, "project.json"), JSON.stringify({ ...manifest, output: { sourceDir: "src/libraries", sourceLayout: "member-id" } }));
    const legacy = libraryMembers(root);
    assert.deepEqual(legacy.map(m => m.id), members.map(m => m.id), "source layout never changes target identity");
    assert.equal(legacy[0]!.source, `src/libraries/${members[0]!.id}/member.c`);
    for (const output of [{ sourceDir: "src/libraries", sourceLayout: "unknown" },
      { sourceDir: "src/libraries", inputRoot: "../outside" }, { sourceDir: "src/libraries", inputRoot: "library-input/*" }]) {
      writeFileSync(join(root, "project.json"), JSON.stringify({ ...manifest, output }));
      assert.throws(() => loadLibraryProject(root), /output\.(?:sourceLayout|inputRoot)/);
    }
    writeFileSync(join(root, "project.json"), JSON.stringify({ ...manifest, headers: { ...manifest.headers, owned: ["include"] } }));
    assert.throws(() => loadLibraryProject(root), /overlap/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("grouped source paths derive from configured roots and ordinals, not glob results or basenames alone", () => {
  const project = { target: { archives: ["library-input/redux/**/*.a"], standaloneObjects: ["library-input/redux/**/*.o"] },
    output: { sourceDir: "src/libraries" } } as LibraryProject;
  assert.equal(librarySourceInputRoot(project), "library-input/redux");
  assert.equal(libraryMemberSource(project, { path: "library-input/redux/libspu/52-s_gtsa.o", archive: false },
    { name: "52-s_gtsa.o", ordinal: 0 }, "id"), "src/libraries/libspu/52-s_gtsa.c");
  assert.equal(libraryMemberSource(project, { path: "library-input/redux/a/lib.a", archive: true },
    { name: "duplicate.o", ordinal: 3 }, "id"), "src/libraries/a/lib/3-duplicate.c");
  assert.equal(libraryMemberSource(project, { path: "library-input/redux/b/lib.a", archive: true },
    { name: "duplicate.o", ordinal: 4 }, "id"), "src/libraries/b/lib/4-duplicate.c");
  assert.equal(legacyLibrarySource(project, "id", "path/member.o"), "src/libraries/id/member.c");
  const explicit = { ...project, output: { ...project.output, inputRoot: "library-input" } };
  assert.equal(librarySourceInputRoot(explicit), "library-input");
  assert.throws(() => libraryMemberSource(explicit, { path: "other/unit.o", archive: false },
    { name: "unit.o", ordinal: 0 }, "id"), /outside output.inputRoot/);
  assert.equal(librarySourceInputRoot({ ...project, target: { archives: ["a/lib.a"], standaloneObjects: ["b/unit.o"] } }), ".");
});

test("grouped archive/standalone source collisions fail without changing member identities", () => {
  const root = mkdtempSync(join(tmpdir(), "psx-library-layout-"));
  try {
    writeFileSync(join(root, "toolchain.json"), readFileSync(join(HARNESS_ROOT, "toolchain.json")));
    mkdirSync(join(root, "input/lib"), { recursive: true });
    writeFileSync(join(root, "input/lib.a"), archive([objectFixture()]));
    const distinct = objectFixture(), offset = readRelocatableObject(distinct).sections.get(".text")!.offset;
    distinct[offset] = distinct[offset]! ^ 1;
    writeFileSync(join(root, "input/lib/0-member.o"), distinct);
    const manifest = { schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar",
      archives: ["input/*.a"], standaloneObjects: ["input/**/*.o"] } };
    writeFileSync(join(root, "project.json"), JSON.stringify(manifest));
    assert.throws(() => libraryMembers(root), /Library source path collision/);
    writeFileSync(join(root, "project.json"), JSON.stringify({ ...manifest,
      output: { sourceDir: "src/libraries", sourceLayout: "member-id" } }));
    assert.equal(libraryMembers(root).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("INCLUDE_ASM assembly parts retain member neighbors/data and don't repeat section alignment", () => {
  const bytes = objectFixture(), object = readRelocatableObject(bytes);
  const member = { id: "fixture", object, functions: objectFunctions(object) } as LibraryMember;
  const parts = libraryAssemblyParts(member, '.section .text\n.align 4\nnonmatching first, 8\nglabel first\n nop\nendlabel first\nnonmatching second, 8\nglabel second\n nop\nendlabel second\n.section .data\n.word 7\n');
  assert.deepEqual(parts.map(p => p.symbol), ["first", "second", "__library_member_data"]);
  assert.match(parts[0]!.text, /\.align 4/); assert.doesNotMatch(parts[1]!.text, /\.align 4/);
  assert.match(parts[2]!.text, /\.word 7/); assert.match(parts[2]!.text, /\.comm common, 4, 4/);
  assert.throws(() => libraryAssemblyParts(member, ".section .text\n nop\n"), /No independent assembly boundary/);
});

test("metadata-only members retain explicit stubs; missing program listings still fail closed", () => {
  const original = readRelocatableObject(objectFixture());
  const object = { ...original, sections: new Map([...original.sections].filter(([, s]) => !(s.flags & 2))),
    symbols: [{ name: "template.c", value: 0, size: 0, binding: 0, type: 4, visibility: 0, section: "ABS" }], relocations: [] };
  const member = { id: "metadata_only", object, functions: [] } as unknown as LibraryMember;
  const parts = libraryAssemblyParts(member, "");
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.symbol, "__library_member_data");
  assert.deepEqual(parts[0]!.functions, []);
  assert.match(parts[0]!.text, /nonmatching __library_member_data, 0/);
  assert.doesNotMatch(parts[0]!.text, /\.(?:word|space|comm)\b/);
  assert.throws(() => libraryAssemblyParts({ ...member, object: { ...object,
    sections: original.sections } }, ""), /No assembly sections found/);
  for (const section of ["UND", "ABS"]) {
    const symbols = [{ name: "required", value: 4, size: 4, binding: 1, type: 0, visibility: 0, section }];
    assert.throws(() => libraryAssemblyParts({ ...member, object: { ...object, symbols } }, ""), /No assembly sections found/);
  }
  const commonOnly = libraryAssemblyParts({ ...member, object: { ...object,
    symbols: original.symbols.filter(s => s.section === "COMMON") } }, "");
  assert.match(commonOnly[0]!.text, /\.comm common, 4, 4/);
  assert.doesNotMatch(commonOnly[0]!.text, /Metadata-only/);
  assert.throws(() => libraryAssemblyParts({ ...member, object: { ...object,
    relocations: original.relocations } }, ""), /No assembly sections found/);
});

test("shared diagnostics isolate TU views and retain symbolic values instead of invented addresses", () => {
  const root = mkdtempSync(join(tmpdir(), "psx-tu-view-"));
  try {
    const assembly = ".text\n.ent first\nfirst:\n jr $ra\n nop\n.end first\n.ent second\nsecond:\n jr $ra\n nop\n.end second\n";
    writeFileSync(join(root, "key.s"), assembly);
    writeFileSync(join(root, "key.i.rtl"), ";; Function first\n(insn 1 first)\n;; Function second\n(insn 1 second)\n");
    projectCompilerArtifacts(root, "key", "first", { kind: "library", id: "member" });
    assert.doesNotMatch(readFileSync(join(root, "key.i.rtl"), "utf8"), /second/);
    assert.equal(readFileSync(compilerAssemblyOrigin(join(root, "key.s"))!.assembly, "utf8"), assembly);
    writeFileSync(join(root, "key.s"), "changed diagnostic fragment");
    assert.throws(() => compilerAssemblyOrigin(join(root, "key.s")), /changed/);
    resetCompilerArtifacts(root, "key");
    assert.equal(compilerAssemblyOrigin(join(root, "key.s")), null);
    const words = [0x3c020000, 0x24420000, 0x8c430000, 0, 0x00601021, 0x0c000000, 0, 0x03e00008, 0];
    const relocation = (type: string, reference: string) => ({ type, reference, addend: 0 });
    const rs = new Map([[0, relocation("R_MIPS_HI16", "import:value")], [1, relocation("R_MIPS_LO16", "import:value")], [5, relocation("R_MIPS_26", "import:callee")]]);
    const bytes = Buffer.alloc(words.length * 4); words.forEach((w, i) => bytes.writeUInt32LE(w, i * 4));
    const partition = extractWebPartition({ functionName: "first", bytes, vram: 0, symbolicRelocations: rs });
    assert(partition.webs.some(w => w.identity?.key === "symbol:value:0"));
    assert(partition.webs.some(w => w.identity?.memory?.addressKey === "symbol:value:0" && w.identity.memory.address === null));
    const mismatched = extractWebPartition({ functionName: "first", bytes, vram: 0, symbolicRelocations: new Map([...rs].map(([i, r]) => [i, i === 1 ? { ...r, reference: "import:other" } : r])) });
    assert(!mismatched.webs.some(w => w.identity?.key === "symbol:other:0"), "unpaired low cannot acquire a guessed symbol address");
    const rendered: RenderedWord[] = words.map((raw, i) => ({ vram: i * 4, raw, text: "", key: "", ...(rs.has(i) ? { relocations: [rs.get(i)!] } : {}) }));
    const decoded = decodeFunctionWords(rendered);
    assert.equal(decoded[5]!.target, undefined, "imported JAL field zero is not a call to function entry");
    const ir = buildMachineIrFrom("first", decoded).ir;
    assert(ir.values.some(v => v.op.kind === "symbol" && v.op.part === "address" && v.op.reference === "import:value"));
    assert(ir.effects.some(e => e.op.kind === "call" && e.op.targetSymbol?.reference === "import:callee" && e.op.target === undefined));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
