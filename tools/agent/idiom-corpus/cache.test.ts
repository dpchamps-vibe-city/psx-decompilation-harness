import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { harnessFixture } from "../../testing/harnessFixture.js";
import { FIXTURE_BASE } from "../../testing/projectFixture.js";

const fixture = harnessFixture({ after });
const sources = {
  fixture_offset: "int fixture_offset(int n) { return n * 3 + 4; }\n",
  fixture_mask: "int fixture_mask(int n) { return (n & 7) + 2; }\n",
};
const functions = []; let offset = 0;
for (const [name, source] of Object.entries(sources)) {
  const built = await fixture.compile(name, source, FIXTURE_BASE + offset);
  functions.push({ name, offset, words: built.words }); offset += built.words.length * 4;
  fixture.put(`src/${name}.c`, source);
}
await fixture.install(functions);
fixture.put("build/callGraph.json", JSON.stringify({ functions: functions.map(f => ({
  name: f.name, vram: `0x${(FIXTURE_BASE + f.offset).toString(16)}`, container: "exe",
  decompiled: true, dead: false, handwritten: false, source: `src/${f.name}.c`, calls: [], calledBy: [],
})) }));
const { targetProgram } = await fixture.load<typeof import("../idiomSearch.js")>("tools/agent/idiomSearch.ts");
const { requireFunctionLocation, withSymbolMetadata } = await fixture.load<typeof import("../../lib/symbolIndex.js")>("tools/lib/symbolIndex.ts");
const { buildCorpus, corpusCandidates, excludedReason, loadCorpus } = await fixture.load<typeof import("./corpus.js")>("tools/agent/idiom-corpus/corpus.ts");

test("incremental regions equal a frozen full build and exclusions do not poison later queries", () => withSymbolMetadata(() => {
  const candidates = corpusCandidates();
  const eligible = candidates.filter(c => !excludedReason(readFileSync(c.sourcePath, "utf8"), c.assemblyMacros)).map(c => c.functionName);
  assert.equal(eligible.length, 2);
  for (const name of eligible) {
    const { container } = requireFunctionLocation(name);
    rmSync(join(fixture.root, "build/idiomCorpus/regions", container.id, "tier0", name + ".json"), { force: true });
  }
  const full = buildCorpus(targetProgram);
  let calls = 0; const lift = (name: string) => { calls++; return targetProgram(name); };
  assert.deepEqual(loadCorpus(lift), full); assert.equal(calls, 2);
  calls = 0; assert.deepEqual(loadCorpus(lift), full); assert.equal(calls, 0);
  loadCorpus(lift, { exclude: [eligible[0]!] }); assert.equal(calls, 0);
  assert.deepEqual(loadCorpus(lift), full); assert.equal(calls, 0);
}));

test("current assembly-macro eligibility is checked before reusing original-region caches", () => withSymbolMetadata(() => {
  const graphPath = join(fixture.root, "build/callGraph.json");
  const saved = readFileSync(graphPath, "utf8"), graph = JSON.parse(saved);
  const name = "fixture_offset", macro = "FIXTURE_ASM_WRAPPER";
  graph.functions.find((entry: { name: string }) => entry.name === name).platformMacro = { macro };
  fixture.put("build/callGraph.json", JSON.stringify(graph));
  fixture.put(`src/${name}.c`, `${macro}(int, ${name}, (int n), 0xA0, 7);\n`);
  try {
    assert.deepEqual(corpusCandidates().find(c => c.functionName === name)?.assemblyMacros, [macro]);
    const check = (corpus: ReturnType<typeof buildCorpus>) => {
      assert.ok(!corpus.included.includes(name));
      assert.ok(!corpus.regions.some(region => region.functionName === name));
      assert.ok(corpus.excluded.some(entry => entry.functionName === name && entry.reason === "asm-macro"));
    };
    check(buildCorpus(targetProgram));
    check(loadCorpus(targetProgram));
  } finally {
    fixture.put("build/callGraph.json", saved);
    fixture.put(`src/${name}.c`, sources.fixture_offset);
  }
}));
