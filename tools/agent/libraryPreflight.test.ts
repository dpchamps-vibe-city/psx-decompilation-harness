import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredTool, type ToolName } from "../lib/toolchain.js";
import { prepareM2c } from "../build/prepareM2c.js";
import { libraryMembers, libraryTargetKey } from "../lib/libraryTargets.js";
import { readRelocatableObject, objectFunctions } from "../lib/relocatableObject.js";
import { libraryTuStatus, readLibraryTu } from "../lib/libraryTranslationUnit.js";
import { compileSource } from "./decompToolchain.js";
import { splitLibrary, measureLibraryFunction } from "./libraryTarget.js";
import { preflightLibraryFunction, checkLibrarySplits } from "./libraryPreflight.js";
import { classifyLibraryCode } from "./libraryCodeClass.js";

/** Synthetic SDK-style mixed member: one size-zero export, two unnamed private
 * callees, an old BIOS veneer and data. No proprietary SDK/game bytes. */
function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "psx-library-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.tools.m2c = prepareM2c(ROOT).script;
  config.includeDirs = ["include", "sdk/include"]; config.profiles = {}; config.containerProfiles = {};
  config.flags.cpp.unshift("-nostdinc");
  config.flags.cc1 = config.flags.cc1.map((f: string) => f === "-G8" ? "-G0" : f);
  config.flags.as = config.flags.as.map((f: string) => f === "-G8" ? "-G0" : f);
  config.assembler = { kind: "gas", inputRewrites: ["move-addu"] };
  config.sdk.headers = { origin: "project", path: "sdk/include" };
  mkdirSync(join(root, "include")); mkdirSync(join(root, "sdk/include/sys"), { recursive: true });
  mkdirSync(join(root, "sdk/INCLUDE/SYS"), { recursive: true });
  writeFileSync(join(root, "include/common.h"), "#ifndef COMMON_H\n#define COMMON_H\ntypedef int s32; typedef unsigned int u32;\n#endif\n");
  for (const file of ["include_asm.h", "macro.inc", "gte_macros.inc"]) copyFileSync(join(ROOT, "include", file), join(root, "include", file));
  const headers: Record<string, string> = {
    "kernel.h": "#ifndef SDK_KERNEL_H\n#define SDK_KERNEL_H\ntypedef unsigned int SdkWord;\n#endif\n",
    "file.h": "#include <sys/fcntl.h>\n",
    "sys/fcntl.h": "#define SDK_READ 1\n",
  };
  for (const [path, text] of Object.entries(headers)) {
    writeFileSync(join(root, "sdk/include", path), text);
    writeFileSync(join(root, "sdk/INCLUDE", path.toUpperCase()), text);
  }
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const originalC = "int private_helper(unsigned int); int bios_entry(unsigned int);\nint entry(unsigned int x) { if (!x) return 0; return private_helper(x) + bios_entry(x); }\n";
  const project = { schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["original.o"] },
    headers: { reference: ["sdk/include"], owned: ["include"], context: ["common.h", "api.h"] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "." } };
  const create = () => {
    const source = join(root, "original.c"); writeFileSync(source, originalC);
    const artifacts = compileSource(source, join(root, "seed"), "original", { containerKind: "exe", assemble: false });
    const asm = readFileSync(artifacts.assembly, "utf8").replace(/^\s*move\s+([^,\n]+),([^\n#]+)/gm, "\taddu $1,$2,$0");
    const helpers = `\n.set noreorder\n.text\n.local private_helper\nprivate_helper:\naddiu $v0,$a0,7\njr $ra\nnop\n.local bios_entry\nbios_entry:\nand $t2,$t2,$zero\nori $t2,$t2,0xb0\nand $t1,$t1,$zero\njr $t2\nori $t1,$t1,0x18\njr $ra\nnop\n.data\n.word 7\n`;
    writeFileSync(join(root, "original.s"), asm + helpers);
    execFileSync(config.tools.as, [...config.flags.as, join(root, "original.s"), "-o", join(root, "original.o")]);
    execFileSync(config.tools.objcopy, ["--strip-symbol=private_helper", "--strip-symbol=bios_entry", join(root, "original.o")]);
    const bytes = readFileSync(join(root, "original.o")), object = readRelocatableObject(bytes);
    const symtab = object.sections.get(".symtab")!;
    const entry = object.symbols.findIndex(s => s.name === "entry"); bytes.writeUInt32LE(0, symtab.offset + entry * 16 + 8);
    writeFileSync(join(root, "original.o"), bytes);
    const functions = objectFunctions(readRelocatableObject(bytes));
    assert.equal(functions.length, 3, JSON.stringify(functions));
    const api = "#ifndef SDK_API_H\n#define SDK_API_H\n#include \"kernel.h\"\nint entry(SdkWord);\n" +
      functions.slice(1).map(f => `int ${f.name}(SdkWord);`).join("\n") + "\n#endif\n";
    writeFileSync(join(root, "sdk/include/api.h"), api); writeFileSync(join(root, "sdk/INCLUDE/API.H"), api);
    writeFileSync(join(root, "project.json"), JSON.stringify(project));
    const member = libraryMembers(root)[0]!;
    // Existing matched C uses spimdisasm's established helper names. Derive
    // those independently from original listing coordinates, not our naming
    // choice, so a generator rename that creates a bogus import is caught.
    const legacyName = (offset: number) => `func_${((member.object.sections.get(".text")!.address || member.object.sections.get(".text")!.offset) + offset).toString(16).toUpperCase().padStart(8, "0")}`;
    return { member, key: libraryTargetKey(member, "entry"), bytes,
      candidate: originalC.replace(/\bprivate_helper\b/g, legacyName(functions[1]!.offset)).replace(/\bbios_entry\b/g, legacyName(functions[2]!.offset)) };
  };
  return { root, config, project, create };
}

test("end-to-end: configured headers, relocation-aware splits, production C substitution, whole-member oracle and m2c", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const { member, key, bytes, candidate } = f.create();
    assert(member.object.sections.get(".text")!.offset > 0, "nonzero ELF file base exercises the relocated-call bug");
    assert.equal(classifyLibraryCode(member.object, member.functions[0]!), undefined, "ordinary caller stays eligible");
    assert.equal(classifyLibraryCode(member.object, member.functions[2]!)?.kind, "bios-dispatch", "private BIOS veneer is not queued as ordinary C");
    splitLibrary();
    const manifest = readLibraryTu(member, f.root);
    assert.equal(manifest.parts.filter(p => p.symbol && p.symbol !== "__library_member_data").length, 3);
    const sourceDir = dirname(join(f.root, member.source)), entryStub = readFileSync(join(sourceDir, "entry.c"));
    assert(!readFileSync(join(f.root, `build/libraries/nonmatchings/${member.id}/entry.s`), "utf8").includes(`glabel ${member.functions[1]!.name}`));
    const result = await preflightLibraryFunction(key);
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.preparation!.generation, "generated");
    assert.equal(result.preparation!.compilation, "succeeded", JSON.stringify(result.preparation));
    assert.equal(result.memberComparison!.verdict, "match");
    assert.equal(checkLibrarySplits().status, "passed", "published original splits preserve the complete member");
    const measured = join(f.root, "candidate.c"); writeFileSync(measured, candidate);
    assert.equal(measureLibraryFunction(key, measured).comparison.verdict, "match", "clean C substitutes only the selected function; private helpers/data remain exact backlog");
    assert(readFileSync(join(sourceDir, "entry.c")).equals(entryStub), "no source promotion");
    assert(readFileSync(join(f.root, "original.o")).equals(bytes), "pristine target never patched");
    // Re-splitting must preserve already-matched callers' local callee names,
    // source bodies and strict member identity, not merely original stubs.
    writeFileSync(join(sourceDir, "entry.c"), candidate); splitLibrary();
    assert.equal(readFileSync(join(sourceDir, "entry.c"), "utf8"), candidate);
    const liveC = await preflightLibraryFunction(key);
    assert.equal(liveC.memberComparison!.verdict, "match", JSON.stringify(liveC));
    writeFileSync(join(sourceDir, "entry.c"), entryStub);
    // Negative control: matching caller words cannot hide neighboring storage.
    const data = libraryTuStatus(member, f.root)!.find(p => p.symbol === "__library_member_data")!;
    const originalDataStub = readFileSync(data.source, "utf8");
    writeFileSync(data.source, "int wrong_neighbor = 8;\n");
    const failed = await preflightLibraryFunction(key);
    assert.equal(failed.status, "failed"); assert.equal(failed.memberComparison!.verdict, "mismatch");
    assert.equal(checkLibrarySplits().status, "passed", "split fidelity is explicitly NOT live-C acceptance");
    writeFileSync(data.source, originalDataStub);
    const assemblyData = join(f.root, `build/libraries/nonmatchings/${member.id}/__library_member_data.s`);
    const beforeAssembly = readFileSync(assemblyData, "utf8");
    const wrongAssembly = beforeAssembly.replace(/\.word\s+0x0*7\b/, ".word 0x8");
    assert.notEqual(wrongAssembly, beforeAssembly); writeFileSync(assemblyData, wrongAssembly);
    assert.equal(checkLibrarySplits().status, "failed", "split checking rejects wrong neighboring original data");
    writeFileSync(assemblyData, beforeAssembly);
    // Re-running splitting neither expands the assignment nor overwrites C.
    splitLibrary(); assert(readFileSync(join(sourceDir, "entry.c")).equals(entryStub));
  });
});

test("preflight records a malformed split contract instead of throwing before its report", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const { member, key } = f.create(); splitLibrary();
    const path = join(f.root, member.source), manifest = readLibraryTu(member, f.root);
    manifest.parts = manifest.parts.filter(p => p.symbol !== "entry"); writeFileSync(path, JSON.stringify(manifest));
    const result = await preflightLibraryFunction(key);
    assert.equal(result.status, "failed");
    assert.match(result.stages[0]!.detail, /every original function exactly once/);
    assert.equal(JSON.parse(readFileSync(join(f.root, result.report), "utf8")).status, "failed");
    assert.equal(result.preparation, undefined);
  });
});

test("end-to-end preflight catches DOS header casing before any model dispatch", async t => {
  const f = fixture(t);
  await fixtureContext(f.root, async () => {
    const { key } = f.create(); splitLibrary();
    const api = readFileSync(join(f.root, "sdk/INCLUDE/API.H"));
    f.config.includeDirs = ["include", "sdk/INCLUDE"]; f.config.sdk.headers.path = "sdk/INCLUDE";
    f.project.headers.reference = ["sdk/INCLUDE"];
    writeFileSync(join(f.root, "toolchain.json"), JSON.stringify(f.config));
    writeFileSync(join(f.root, "project.json"), JSON.stringify(f.project));
    const result = await preflightLibraryFunction(key);
    assert.equal(result.status, "failed");
    assert.equal(result.stages[0]!.name, "SDK header preprocessing");
    assert.match(result.stages[0]!.detail, /kernel.h|sys\/fcntl.h/);
    assert.equal(result.preparation, undefined);
    assert(readFileSync(join(f.root, "sdk/INCLUDE/API.H")).equals(api), "reference inputs remain immutable");
  });
});
