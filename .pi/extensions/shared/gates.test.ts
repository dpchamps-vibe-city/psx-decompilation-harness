import assert from "node:assert/strict";
import { test } from "../../../tools/testing/runtimeTestContext.js";
import { parseFunctionDiffSummary, functionDiffFailure } from "./gates.ts";

test("parses the oracle's word count and verdict", () => {
  const result = parseFunctionDiffSummary(
    "Match: 214/214 words (100.0%)\nVERDICT: MATCH — every word is byte-identical to the original after relocation.\n",
  );

  assert.deepEqual(result, {
    matchedInstructions: 214,
    totalInstructions: 214,
    matchPercent: 100,
    verdict: "match",
  });
});

test("a mismatch is reported as such even at a high word count", () => {
  const result = parseFunctionDiffSummary(
    "Match: 80/81 words (98.8%)\nVERDICT: MISMATCH — 1 word(s) differ.\n",
  );

  assert.deepEqual(result, {
    matchedInstructions: 80,
    totalInstructions: 81,
    matchPercent: 98.8,
    verdict: "mismatch",
  });
});

test("an undetermined verdict is kept distinct from a match, even at a full count", () => {
  const result = parseFunctionDiffSummary(
    "Match: 9/9 words (100.0%)\nVERDICT: UNDETERMINED — 1 word(s) could not be resolved; nothing else differs.\n",
  );

  assert.equal(result.verdict, "undetermined");
  assert.equal(result.matchedInstructions, result.totalInstructions);
});

test("whole-member failures retain local success, owning sites and scaffold evidence without granting acceptance", () => {
  const output = "Match: 150/152 words (98.68%)\nVERDICT: MISMATCH\nScope: whole relocatable member (sections, bytes, symbols and symbolic relocations)\n" +
    "Selected function: first: MATCH (63/63 words)\nOwning TU: MISMATCH\n" +
    "Scaffold blocker: unresolved generated assembly reference .L__library_section_ref_first\n" +
    "Member residual: .text+0x164 (second+0x2C): relocation targets differ\n";
  const parsed = parseFunctionDiffSummary(output);
  assert.equal(parsed.verdict, "mismatch", "a local MATCH is not the acceptance verdict");
  const failure = functionDiffFailure({ ...parsed, output });
  assert.match(failure, /^Whole-member oracle verdict is MISMATCH/);
  for (const evidence of ["Selected function: first: MATCH", "Owning TU: MISMATCH", "Scaffold blocker:", ".text+0x164 (second+0x2C)"]) assert(failure.includes(evidence));
  assert(functionDiffFailure({ ...parsed, output: output + "Member residual: " + "x".repeat(9000) }).length < 4300);
  assert.equal(functionDiffFailure({ ...parsed, output: "VERDICT: MISMATCH" }), "Function oracle verdict is MISMATCH, not MATCH (150/152 words)");
});

test("uses the last summary and reports nothing rather than a pass when there is none", () => {
  assert.deepEqual(
    parseFunctionDiffSummary("Match: 1/2 words (50.0%)\nVERDICT: MISMATCH\nMatch: 2/2 words (100.0%)\nVERDICT: MATCH\n"),
    { matchedInstructions: 2, totalInstructions: 2, matchPercent: 100, verdict: "match" },
  );
  assert.deepEqual(
    parseFunctionDiffSummary("diff command failed before producing a summary\n"),
    { matchedInstructions: 0, totalInstructions: 0, matchPercent: 0, verdict: "unknown" },
  );
});
