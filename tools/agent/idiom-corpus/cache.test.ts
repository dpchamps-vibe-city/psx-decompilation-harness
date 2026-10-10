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
  const eligible = candidates.filter(c => !excludedReason(readFileSync(c.sourcePath, "utf8"))).map(c => c.functionName);
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
