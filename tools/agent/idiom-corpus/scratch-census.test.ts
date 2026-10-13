import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderedWord } from "../../lib/functionOracle.js";
import { indexedLoadScratchPatterns, scratchRegisterCensus } from "./scratch-census.js";

function words(raw: number[]): RenderedWord[] {
  return raw.map((raw, i) => ({ raw, vram: i * 4, text: "fixture original word", key: raw.toString(16),
    coordinate: { kind: "section", section: ".text", offset: i * 4 } }));
}
const destination = words([0x3c020000, 0x00441021, 0x8c420008]);
const atSeparate = words([0x3c010000, 0x00240821, 0x8c220008]);
const atConflicting = words([0x3c010000, 0x00240821, 0x8c240008]);

test("raw register census distinguishes destination scratch from both indexed-at relations", () => {
  assert.equal(indexedLoadScratchPatterns(destination)[0]?.signature, "lw:load-destination:dest!=index");
  assert.equal(indexedLoadScratchPatterns(atSeparate)[0]?.signature, "lw:at:dest!=index");
  assert.equal(indexedLoadScratchPatterns(atConflicting)[0]?.signature, "lw:at:dest=index");
  assert.equal(indexedLoadScratchPatterns(words([0x3c020000, 0x00821021, 0x8c420008]))[0]?.signature,
    "lw:load-destination:dest!=index", "ADDU input order is commutative");
});

test("the census is independent of minimum region size and retrieval n-grams", () => {
  const corpus = { short: destination, at: atConflicting };
  const result = scratchRegisterCensus(destination, Object.keys(corpus), name => corpus[name as keyof typeof corpus]);
  assert.equal(result.status, "complete");
  assert.equal(result.scannedFunctions, 2);
  assert.equal(result.patterns[0]?.occurrences, 1);
  assert.equal(result.patterns[0]?.functions, 1);
  assert.equal(result.patterns[0]?.examples[0]?.function, "short");
  assert.match(result.basis, /not proof of original compiler input or assembler behavior/);
});

test("unreadable functions prevent a zero count from being an exhaustive absence", () => {
  const result = scratchRegisterCensus(destination, ["at", "missing"], name => {
    if (name === "missing") throw new Error("missing original");
    return atConflicting;
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.scannedFunctions, 1);
  assert.equal(result.patterns[0]?.occurrences, 0);
  assert.equal(result.unreadable[0]?.function, "missing");
});

test("only adjacent original words qualify and detail limits never cap counts", () => {
  const gap = words([0x3c020000, 0x00441021, 0x8c420008]); gap[2]!.vram += 4;
  assert.deepEqual(indexedLoadScratchPatterns(gap), []);
  const repeated = words(Array.from({ length: 9 }, () => destination.map(word => word.raw)).flat());
  const result = scratchRegisterCensus(destination, ["nine"], () => repeated);
  assert.equal(result.patterns[0]?.occurrences, 9);
  assert.equal(result.patterns[0]?.examples.length, 8);
  assert.equal(result.patterns[0]?.examplesTruncated, true);
});

test("queries without this relation do not trigger a corpus scan", () => {
  let calls = 0;
  const result = scratchRegisterCensus(words([0x03e00008, 0]), ["irrelevant"], () => { calls++; return destination; });
  assert.equal(result.status, "not-applicable"); assert.equal(calls, 0);
});
