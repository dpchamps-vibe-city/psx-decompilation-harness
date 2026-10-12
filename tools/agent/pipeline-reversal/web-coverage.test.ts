import { test } from "../../testing/runtimeTestContext.js";
import { strict as assert } from "node:assert";
import { liftWords } from "./lift.js";
import { inverseAlloc } from "./inverse-alloc.js";
import { inverseAssembler } from "./inverse-assembler.js";
import { inverseDbr } from "./inverse-dbr.js";
import { compareProgramsAtWaypoint } from "./compare.js";
import { compareObjectives, rankBlocks, residualObjective, summarizeObjective } from "./objective.js";
import type { RenderedWord } from "../../lib/functionOracle.js";

/* Original and production candidate words from the witnessed section-relative
 * residual. No compiler invocation, linked addresses or assembler hypothesis. */
const original: Array<[number, string]> = [
  [0x3084ffff, "andi a0,a0,0xffff"], [0x00042080, "sll a0,a0,2"],
  [0x3c050000, "lui a1,%hi(.data@0)"], [0x8ca50000, "lw a1,%lo(.data@0)(a1)"],
  [0x3c020000, "lui v0,%hi(.data@0+8)"], [0x00441021, "addu v0,v0,a0"],
  [0x8c420008, "lw v0,%lo(.data@0+8)(v0)"], [0x8ca30004, "lw v1,4(a1)"],
  [0x00021027, "nor v0,zero,v0"], [0x00621824, "and v1,v1,v0"],
  [0x24020001, "addiu v0,zero,1"], [0x03e00008, "jr ra"], [0xaca30004, "sw v1,4(a1)"],
];
const candidate = original.map(([raw, text]) => [raw, text] as [number, string]);
candidate[4] = [0x3c010000, "lui at,%hi(.data@0+8)"];
candidate[5] = [0x00240821, "addu at,at,a0"];
candidate[6] = [0x8c220008, "lw v0,%lo(.data@0+8)(at)"];

function allocated(entries: Array<[number, string]>) {
  const words: RenderedWord[] = entries.map(([raw, text], i) => ({
    raw, text, key: text, vram: 0x104 + i * 4,
    coordinate: { kind: "section", section: ".text", offset: 0x104 + i * 4 },
  }));
  return inverseAlloc(inverseDbr(inverseAssembler(liftWords({ functionName: "StopRCnt", words })).program).program);
}

test("unpaired address values cannot disappear into a zero allocation agreement", () => {
  const left = allocated(original), right = allocated(candidate);
  assert.equal(left.webs.length, 12); assert.equal(right.webs.length, 10);
  const comparison = compareProgramsAtWaypoint(left.program, right.program, left.webs, right.webs);
  assert.equal(comparison.populationParity, true);
  assert.equal(comparison.allocationDifferences, 0, "the matched subset alone has no register differences");
  assert.equal(comparison.allocationCoverage?.complete, false);
  assert.equal(comparison.allocationCoverage?.targetUnpaired.length, 2);
  const objective = residualObjective("StopRCnt", comparison, left.program, right.program, false);
  assert.match(objective.reason!, /Incomplete value-web correspondence/);
  assert.match(summarizeObjective(objective), /allocation ungraded/);
  const complete = { ...objective, allocation: 5, key: [0, 0, 0, 5] as [number, number, number, number],
    allocationCoverage: { complete: true, targetUnpaired: [], candidateUnpaired: [] } };
  assert.equal(compareObjectives(objective, complete), 0, "partial zero must not outrank an actually compared allocation");
  assert.equal(compareObjectives(objective, complete, { block: 0 }), 0);
  const partialAllocationOnly = { ...objective, blocks: objective.blocks.map(b => ({ ...b, allocation: 5, total: 5 })) };
  assert.equal(rankBlocks(partialAllocationOnly).length, 0, "no allocator research is licensed by incomplete correspondence");
});

test("complete byte-identical value streams retain full allocation coverage", () => {
  const left = allocated(original), right = allocated(original);
  const comparison = compareProgramsAtWaypoint(left.program, right.program, left.webs, right.webs);
  assert.deepEqual(comparison.allocationCoverage, { complete: true, targetUnpaired: [], candidateUnpaired: [] });
  const exact = residualObjective("StopRCnt", comparison, left.program, right.program, true);
  assert.deepEqual(exact.key, [0, 0, 0, 0]); assert.equal(exact.exact, true);
});

test("coalesced representatives are compared once, not mistaken for missing values", () => {
  const left = allocated([[0x34020005, "li v0,5"], [0x00401821, "move v1,v0"],
    [0xac830000, "sw v1,0(a0)"], [0x03e00008, "jr ra"], [0, "nop"]]);
  const right = allocated([[0x34020005, "li v0,5"], [0xac820000, "sw v0,0(a0)"],
    [0x03e00008, "jr ra"], [0, "nop"]]);
  const comparison = compareProgramsAtWaypoint(left.program, right.program, left.webs, right.webs);
  assert.ok(comparison.coalescedCopies.length > 0);
  assert.equal(comparison.allocationCoverage?.complete, true);
});
