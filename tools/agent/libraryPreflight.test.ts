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
import { splitLibrary, measureLibraryFunction, prepareLibraryFunction, checkLibrary, writeLibraryGraph } from "./libraryTarget.js";
import { planPark } from "../../.pi/extensions/psx-decomp/autoloop/park.js";
import { eligible } from "../../.pi/extensions/shared/call-graph.js";
import { preflightLibraryFunction, checkLibrarySplits } from "./libraryPreflight.js";
import { classifyLibraryCode } from "./libraryCodeClass.js";

/** Synthetic SDK-style mixed member: one size-zero export, two unnamed private
 * callees, an old BIOS veneer and data. No proprietary SDK/game bytes. */
function fixture(t: { after: (cleanup: () => void) => void }, addressTaken = false) {
  const root = mkdtempSync(join(tmpdir(), "psx-library-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  config.compiler.source = { origin: "harness", path: config.compiler.source };
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.tools.m2c = prepareM2c(ROOT).script;
  config.includeDirs = ["include", "sdk/include"]; config.profiles = {}; config.containerProfiles = {};
  config.flags.cpp.unshift("-nostdinc");
  config.flags.cc1 = config.flags.cc1.map((f: string) => f === "-G8" ? "-G0" : f);
  config.flags.as = config.flags.as.map((f: string) => f === "-G8" ? "-G0" : f);
  config.assembler = { kind: "gas" };
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
  if (addressTaken) writeFileSync(join(root, "include/hooks.h"), "#ifndef HOOKS_H\n#define HOOKS_H\nstruct HookPair { int (*first)(void); int (*second)(void); };\nextern struct HookPair hooks;\n#endif\n");
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const originalC = addressTaken
    ? '#include "hooks.h"\nint private_helper(void); int bios_entry(void);\nint entry(unsigned int x) { hooks.first = private_helper; hooks.second = bios_entry; return x + 1; }\n'
    : "int private_helper(unsigned int); int bios_entry(unsigned int);\nint entry(unsigned int x) { if (!x) return 0; return private_helper(x) + bios_entry(x); }\n";
  const project = { schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["original.o"] },
    headers: { reference: ["sdk/include"], owned: ["include"], context: ["common.h", "api.h"] },
    output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "." } };
  const create = () => {
    const source = join(root, "original.c"); writeFileSync(source, originalC);
    const artifacts = compileSource(source, join(root, "seed"), "original", { containerKind: "exe", assemble: false });
    const asm = readFileSync(artifacts.assembly, "utf8");
    const helpers = addressTaken
      ? `\n.set noreorder\n.text\n.local private_helper\nprivate_helper:\naddiu $v0,$zero,7\njr $ra\nnop\n.local bios_entry\nbios_entry:\naddiu $v0,$zero,9\njr $ra\nnop\n.data\n.globl hooks\nhooks:\n.word 0,0\n.word 7\n`
      : `\n.set noreorder\n.text\n.local private_helper\nprivate_helper:\naddiu $v0,$a0,7\njr $ra\nnop\n.local bios_entry\nbios_entry:\nand $t2,$t2,$zero\nori $t2,$t2,0xb0\nand $t1,$t1,$zero\njr $t2\nori $t1,$t1,0x18\njr $ra\nnop\n.data\n.word 7\n`;
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
      functions.slice(1).map(f => `int ${f.name}(${addressTaken ? "void" : "SdkWord"});`).join("\n") +
      (addressTaken ? '\n#include "hooks.h"' : "") + "\n#endif\n";
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
    assert.equal(classifyLibraryCode(member.object, member.functions[2]!)?.kind, "bios-dispatch", "private BIOS veneer is fingerprinted from its original words");
    splitLibrary();
    const graph = writeLibraryGraph(), veneer = libraryTargetKey(member, member.functions[2]!.name);
    const veneerPart = readLibraryTu(member, f.root).parts.find(p => p.symbol === member.functions[2]!.name)!;
    assert.deepEqual(veneerPart.retained, { kind: "handwritten-assembly", evidence: "bios-dispatch", originalSha256: member.originalObject?.sha256 ?? member.sha256 }, "split records the hand-written veneer in the manifest");
    assert.ok(graph.functions.filter(fn => fn.name !== veneer).every(fn => fn.libraryStub && fn.handwritten === false && eligible(fn)), "ordinary C stubs stay targets");
    const veneerEntry = graph.functions.find(fn => fn.name === veneer)!;
    assert.equal(veneerEntry.handwritten, "asm"); assert.equal(eligible(veneerEntry), false, "a retained hand-written function is never a C target");
    const manifestText = readFileSync(join(f.root, member.source), "utf8");
    splitLibrary();
    assert.equal(readFileSync(join(f.root, member.source), "utf8"), manifestText, "recording retained functions is idempotent");
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
    assert.equal(eligible(writeLibraryGraph().functions.find(fn => fn.name === key)!), false, "a C definition is not a stub target");
    const attempt = candidate.replace("return 0;", "return 9;");
    assert.notEqual(attempt, candidate);
    const park = await planPark({ projectRoot: f.root, runtimeDir: join(f.root, "build/park"), functionName: key, committedSource: entryStub.toString(), attemptSource: attempt, reason: "escalation-exhausted", reachedTier: "test", notePath: "notes/test.md", parkedAt: "2026-10-18" });
    assert.equal(park.preserved, true);
    writeFileSync(join(sourceDir, "entry.c"), park.source);
    assert.equal(libraryTuStatus(member, f.root)!.find(p => p.symbol === "entry")!.stub, true);
    checkLibrary([], f.root);
    const resumed = await prepareLibraryFunction(key);
    assert.equal(resumed.packet.primary!.origin, "existing-attempt");
    assert.ok(resumed.packet.primary!.text.includes("return 9;"), "prep resumes the preserved draft, not m2c");
    assert.equal(resumed.packet.compilation.status, "succeeded");
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
    assert.equal(checkLibrarySplits().status, "passed", "fresh split checking does not reuse previously published fragments");
    writeFileSync(assemblyData, beforeAssembly);
    const listing = join(f.root, member.assembly), beforeListing = readFileSync(listing, "utf8");
    writeFileSync(listing, beforeListing.replace(/\.word\s+0x0*7\b/, ".word 0x8"));
    assert.equal(checkLibrarySplits().status, "failed", "fresh split checking rejects wrong neighboring original data");
    writeFileSync(listing, beforeListing);
    // Re-running splitting neither expands the assignment nor overwrites C.
    splitLibrary(); assert(readFileSync(join(sourceDir, "entry.c")).equals(entryStub));
    // Member finishing: once every function is C or retained, the data part becomes a target.
    const dataKey = `${member.id}::__library_member_data`, helper = libraryTuStatus(member, f.root)!.find(p => p.symbol === member.functions[1]!.name)!;
    assert.ok(!writeLibraryGraph().functions.some(fn => "finishing" in fn), "no finishing target while a function is still a stub");
    const helperStub = readFileSync(helper.source, "utf8");
    writeFileSync(join(sourceDir, "entry.c"), candidate);
    writeFileSync(helper.source, `int ${member.functions[1]!.name}(unsigned int x) { return x + 7; }\n`);
    const finishing = writeLibraryGraph().functions.find(fn => fn.name === dataKey)!;
    assert.equal(finishing.finishing, "data"); assert.equal(eligible(finishing), true);
    assert.ok(!writeLibraryGraph().functions.some(fn => fn.name === `${member.id}::__library_member_symbols`), "symbol order waits for the data");
    const prepared = await prepareLibraryFunction(dataKey);
    assert.equal(prepared.packet.preparationScope, "member-finishing");
    assert.equal(prepared.packet.primary!.origin, "generated-part");
    assert.match(prepared.packet.primary!.text, /Member data as C/);
    assert.equal(measureLibraryFunction(dataKey).functionComparison.symbol, "__library_member_data", "a finishing target measures the whole member");
    writeFileSync(join(sourceDir, "entry.c"), entryStub); writeFileSync(helper.source, helperStub);
  });
});

test("end-to-end: address-only callbacks split and migrate into individual files before one-function preparation", async t => {
  const f = fixture(t, true);
  await fixtureContext(f.root, async () => {
    const { member, key, bytes, candidate } = f.create();
    assert.deepEqual(member.functions.slice(1).map(fn => fn.discovery?.kind), ["address-relocation", "address-relocation"]);
    splitLibrary();
    const directory = dirname(join(f.root, member.source)), manifest = readLibraryTu(member, f.root);
    assert.equal(manifest.parts.filter(p => p.symbol && p.symbol !== "__library_member_data").length, 3);
    const entry = readFileSync(join(directory, "entry.c")), data = readFileSync(join(directory, "_data.c"));
    // Reproduce an existing directory TU from the old JAL-only census. It has
    // one initializer part; newly witnessed callbacks must subdivide backlog.
    const callbacks = new Set(member.functions.slice(1).map(fn => fn.name));
    for (const part of manifest.parts.filter(p => callbacks.has(p.symbol!))) rmSync(join(directory, part.path));
    manifest.parts = manifest.parts.filter(p => !callbacks.has(p.symbol!));
    writeFileSync(join(f.root, member.source), JSON.stringify(manifest));
    splitLibrary();
    assert.equal(libraryTuStatus(member, f.root)!.filter(p => p.symbol && p.symbol !== "__library_member_data").length, 3);
    assert(readFileSync(join(directory, "entry.c")).equals(entry));
    assert(readFileSync(join(directory, "_data.c")).equals(data));
    for (const fn of member.functions) {
      const listing = readFileSync(join(f.root, `build/libraries/nonmatchings/${member.id}/${fn.name}.s`), "utf8");
      for (const other of member.functions.filter(other => other !== fn)) assert(!listing.includes(`glabel ${other.name} `));
    }
    assert.equal(checkLibrarySplits().status, "passed", "splitting preserves the entire original member");
    const prepared = await preflightLibraryFunction(key);
    assert.equal(prepared.status, "passed", JSON.stringify(prepared));
    assert.equal(prepared.preparation!.compilation, "succeeded", JSON.stringify(prepared.preparation));
    const latest = join(f.root, "build/preparation", key, "latest-library.json"), oldDraft = join(f.root, "obsolete.c");
    const stale = "/* obsolete compound extent */\nint entry(unsigned int x) { return 1234; }\n";
    writeFileSync(oldDraft, stale);
    // A draft produced for the former compound extent must not be inherited
    // merely because its destination and one top-level signature still match.
    for (const generationContract of ["directory-tu-selected-related-v2", "directory-tu-selected-related-v3"]) {
      writeFileSync(latest, JSON.stringify({ draft: "obsolete.c", destination: join(dirname(member.source), "entry.c"), generationContract, boundaryIdentity: "obsolete" }));
      const fresh = await prepareLibraryFunction(key);
      assert.notEqual(fresh.packet.primary!.path, "obsolete.c");
      assert(!fresh.packet.primary!.text.includes("obsolete compound extent"));
      assert.equal(readFileSync(oldDraft, "utf8"), stale, "stale draft evidence is preserved, not overwritten");
    }
    const recorded = JSON.parse(readFileSync(latest, "utf8"));
    assert.equal(recorded.generationContract, "directory-tu-selected-related-v3");
    assert.equal(typeof recorded.boundaryIdentity, "string");
    assert.notEqual(recorded.boundaryIdentity, "obsolete");
    const retained = join(f.root, "retained.c"), retainedText = readFileSync(join(f.root, recorded.draft), "utf8") + "\n/* keep this measured draft */\n";
    writeFileSync(retained, retainedText);
    writeFileSync(latest, JSON.stringify({ ...recorded, draft: "retained.c" }));
    assert.equal((await prepareLibraryFunction(key)).packet.primary!.path, "retained.c", "unchanged function partitions still retain edited drafts");
    assert.equal(readFileSync(retained, "utf8"), retainedText);
    const source = join(f.root, "candidate.c"); writeFileSync(source, candidate);
    assert.equal(measureLibraryFunction(key, source).comparison.verdict, "match", "initializer-only C retains callback backlog and the whole-object identity");
    assert(readFileSync(join(f.root, "original.o")).equals(bytes));
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
