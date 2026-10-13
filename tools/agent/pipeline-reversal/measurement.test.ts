import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeasurementRun, snapshotMeasurementSource, assertMeasurementSourceUnchanged } from "./measurement.js";

function fixture(t: { after(f: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "residual-measurement-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("same-basename measurements retain independent artifacts and source snapshots", t => {
  const root = fixture(t), source = join(root, "candidate.c"), name = "member::selected";
  writeFileSync(source, "int selected(void) { return 1; }\n");
  const first = createMeasurementRun(name, [source], root);
  const firstSnapshot = snapshotMeasurementSource(source, join(first, "v1"));
  writeFileSync(join(first, "v1/candidate.o"), "first object evidence");
  assertMeasurementSourceUnchanged(source, firstSnapshot);
  writeFileSync(source, "int selected(void) { return 2; }\n");
  const second = createMeasurementRun(name, [source], root);
  const secondSnapshot = snapshotMeasurementSource(source, join(second, "v1"));
  writeFileSync(join(second, "v1/candidate.o"), "second object evidence");
  assert.notEqual(first, second);
  assert.equal(readFileSync(firstSnapshot, "utf8"), "int selected(void) { return 1; }\n");
  assert.equal(readFileSync(secondSnapshot, "utf8"), "int selected(void) { return 2; }\n");
  assert.equal(readFileSync(join(first, "v1/candidate.o"), "utf8"), "first object evidence");
  assert.throws(() => snapshotMeasurementSource(source, join(first, "v1")), /EEXIST/);
  assert.throws(() => assertMeasurementSourceUnchanged(source, firstSnapshot), /changed during measurement/);
});

test("inline C, missing source paths and directories fail before creating artifact state", t => {
  const root = fixture(t), name = "member::selected";
  mkdirSync(join(root, "directory.c"));
  for (const source of ["int selected(void) { return 1; }", "missing.c", "directory.c"]) {
    assert.throws(() => createMeasurementRun(name, [source], root), /existing \.c file/);
    assert.equal(existsSync(join(root, "build")), false);
  }
  writeFileSync(join(root, "candidate.c"), "int selected(void) { return 1; }\n");
  assert.throws(() => createMeasurementRun(name, ["candidate.c", "missing.c"], root), /existing \.c file/);
  assert.equal(existsSync(join(root, "build")), false, "the whole source list is preflighted");
  assert.ok(existsSync(createMeasurementRun(name, ["candidate.c"], root)));
});
