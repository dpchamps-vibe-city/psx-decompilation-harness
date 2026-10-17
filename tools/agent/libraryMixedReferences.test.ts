import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configuredTool, type ToolName } from "../lib/toolchain.js";
import { libraryMembers, libraryTargetKey } from "../lib/libraryTargets.js";
import { compareRelocatableFunction } from "../lib/relocatableFunctionOracle.js";
import { readLibraryTu } from "../lib/libraryTranslationUnit.js";
import { compileSource } from "./decompToolchain.js";
import { measureLibraryFunction, renderLibraryComparison, splitLibrary } from "./libraryTarget.js";

// No SDK bytes: the production compiler seeds the object, then a local entry
// label gives it the section-relative recursion/intra-TU calls found in LNK.
const sources = {
  entry: "int entry(unsigned int x) { if (x > 1) return entry(x - 1) + entry(x - 2); return x; }\n",
  caller: "int entry(unsigned int);\nint caller(unsigned int x) { return entry(x) + 1; }\n",
};

test("mixed C/backlog references survive either replacement order; local matches never hide neighbor/scaffold failures", async t => {
  const root = mkdtempSync(join(tmpdir(), "psx-mixed-references-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
  for (const name of Object.keys(config.tools) as ToolName[]) config.tools[name] = configuredTool(name, ROOT);
  config.includeDirs = ["include"]; config.profiles = {}; config.containerProfiles = {};
  config.flags.cc1 = config.flags.cc1.map((f: string) => f === "-G8" ? "-G0" : f);
  config.flags.as = config.flags.as.map((f: string) => f === "-G8" ? "-G0" : f);
  config.assembler = { kind: "gas", inputRewrites: ["move-addu"] };
  mkdirSync(join(root, "include"));
  for (const file of ["include_asm.h", "macro.inc", "gte_macros.inc"]) copyFileSync(join(ROOT, "include", file), join(root, "include", file));
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  await fixtureContext(root, async () => {
    const seed = join(root, "seed.c"); writeFileSync(seed, sources.entry + sources.caller);
    const artifacts = compileSource(seed, join(root, "seed"), "seed", { containerKind: "exe", assemble: false });
    const assembly = readFileSync(artifacts.assembly, "utf8")
      .replace(/^\s*move\s+([^,\n]+),([^\n#]+)/gm, "\taddu $1,$2,$0")
      .replace(/^entry:/m, ".Lentry:\nentry:").replace(/\bjal\s+entry\b/g, "jal .Lentry");
    writeFileSync(join(root, "original.s"), assembly);
    execFileSync(config.tools.as, [...config.flags.as, join(root, "original.s"), "-o", join(root, "original.o")]);
    writeFileSync(join(root, "project.json"), JSON.stringify({ schemaVersion: 1,
      target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["original.o"] },
      headers: { reference: [], owned: ["include"], context: [] },
      output: { sourceDir: "src/libraries", sourceLayout: "tu-directory", inputRoot: "." } }));
    const member = libraryMembers()[0]!, directory = dirname(join(root, member.source));
    assert(member.object.relocations.filter(r => r.type === 4 && r.reference === ".text@0").length >= 3, "fixture witnesses recursive and neighbor calls");
    splitLibrary();
    const paths = new Map(readLibraryTu(member, root).parts.filter(p => p.symbol).map(p => [p.symbol!, join(directory, p.path)]));
    const stubs = new Map([...paths].map(([symbol, path]) => [symbol, readFileSync(path, "utf8")]));
    const key = (symbol: string) => libraryTargetKey(member, symbol);
    const assemblyCaller = join(root, `build/libraries/nonmatchings/${member.id}/caller.s`);
    const callerStub = readFileSync(assemblyCaller, "utf8");
    assert.doesNotMatch(callerStub, /\.L__library_section_ref_entry/, "strong exports do not acquire stub-owned aliases");
    for (const order of [["entry", "caller"], ["caller", "entry"]] as const) {
      for (const [symbol, path] of paths) writeFileSync(path, stubs.get(symbol)!);
      for (const symbol of order) {
        const candidate = join(root, `${symbol}-candidate.c`); writeFileSync(candidate, sources[symbol]);
        const measured = measureLibraryFunction(key(symbol), candidate);
        assert.equal(measured.comparison.verdict, "match", JSON.stringify(measured.comparison));
        assert.equal(measured.functionComparison.verdict, "match");
        const local = compareRelocatableFunction(key(symbol), measured.artifacts.object!);
        assert.equal(local.verdict, "match");
        assert.equal(local.verification!.verdict, "match");
        assert(local.rawCandidateWords!.some(w => w.relocations?.some(r => r.reference === "named:entry")));
        writeFileSync(paths.get(symbol)!, sources[symbol]);
      }
    }
    writeFileSync(paths.get("caller")!, sources.caller.replace("+ 1", "+ 2"));
    const wrongNeighbor = measureLibraryFunction(key("entry"));
    assert.equal(wrongNeighbor.functionComparison.verdict, "match");
    assert.equal(wrongNeighbor.comparison.verdict, "mismatch");
    assert(wrongNeighbor.comparison.wordDifferences!.some(site => site.owner?.startsWith("caller+")));
    // Reproduce the old missing-label failure independently of the fixed
    // generator. Neither the comparator nor the local MATCH may forgive it.
    writeFileSync(paths.get("caller")!, stubs.get("caller")!);
    assert.match(callerStub, /jal\s+entry\b/);
    writeFileSync(assemblyCaller, callerStub.replace(/\bjal\s+entry\b/g, "jal .L__library_section_ref_entry"));
    const blocked = measureLibraryFunction(key("entry"));
    assert.equal(blocked.functionComparison.verdict, "match");
    assert.equal(blocked.comparison.verdict, "mismatch");
    assert.equal(blocked.comparison.scaffoldBlockers!.length, 1);
    const text = renderLibraryComparison(blocked.comparison, blocked.functionComparison);
    assert.match(text, /Selected function: entry: MATCH/);
    assert.match(text, /Owning TU: MISMATCH/);
    assert.match(text, /Scaffold blocker: unresolved generated assembly reference/);
    assert.match(text, /Member residual: \.text\+0x[\dA-F]+ \(caller\+0x/);
    writeFileSync(assemblyCaller, callerStub);
    assert.equal(measureLibraryFunction(key("entry")).comparison.verdict, "match");
  });
});
