import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { implicatedByPark } from "./family.ts";
import { projectFixture } from "../../../../tools/testing/projectFixture.js";
import { HARNESS_ROOT } from "../../../../tools/lib/toolchain.js";

function fixture(t: { after: (cleanup: () => void) => void }): string {
  const { root, put } = projectFixture(t);
  put("notes/file-groupings.md", readFileSync(join(HARNESS_ROOT, "test-fixtures/harness/file-groupings.md")));
  return root;
}

test("parking a function implicates its suspected translation unit", (t) => {
  const implicated = implicatedByPark(fixture(t), "FixtureParked");
  assert.deepEqual(implicated.sort(), ["FixtureDisplay", "FixtureSibling"]);
  assert.equal(implicated.includes("FixtureParked"), false, "a function does not implicate itself");
});

test("prose bullets in a members list are not read as function names", (t) => {
  const implicated = implicatedByPark(fixture(t), "FixtureParked");
  assert.equal(implicated.includes("shared"), false);
  assert.equal(implicated.includes("FixtureUnrelated"), false, "membership stays within its heading");
});

test("a function in no recorded group implicates nothing", (t) => {
  assert.deepEqual(implicatedByPark(fixture(t), "fixture_does_not_exist"), []);
});
