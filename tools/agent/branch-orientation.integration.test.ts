import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { harnessFixture } from "../testing/harnessFixture.js";
import { FIXTURE_OVERLAY_BASE } from "../testing/projectFixture.js";
import { HARNESS_ROOT } from "../lib/toolchain.js";

const fixture = harnessFixture({ after }), fn = "ovl_fixture_branch";
const source = readFileSync(join(HARNESS_ROOT, "test-fixtures/harness/branch-tail.c"), "utf8");
const built = await fixture.compile(fn, source, FIXTURE_OVERLAY_BASE, { fixture_storage: 0x80090000 });
await fixture.install([{ name: "fixture_entry", offset: 0, words: [0x03e00008, 0] }], {
  ovl_fixture: [{ name: fn, offset: 0, words: built.words }],
});
fixture.put(`src/overlays/ovl_fixture/${fn}.c`, source);
for (const container of ["exe", "ovl_fixture"]) {
  const path = `configs/symbols/${container}.txt`;
  fixture.put(path, readFileSync(join(fixture.root, path), "utf8") + "fixture_storage = 0x80090000;\n");
}
const cut = source.indexOf("    if (*(s16 *)(p + 0x5476) == 6)");
const nested = source.slice(0, cut) + "    if (*(s16 *)(p + 0x5476) == 6) {\n        if ((*cell & 8) == 0) return 1;\n    }\n    return 0;\n}\n";
fixture.put("build/branch-nested.c", nested);
fixture.put("build/branch-short-circuit.c", readFileSync(join(HARNESS_ROOT, "test-fixtures/harness/branch-tail-unhoisted.c"), "utf8"));
const nestedPath = join(fixture.root, "build/branch-nested.c");
const { targetWordsOf } = await fixture.load<typeof import("../lib/functionOracle.js")>("tools/lib/functionOracle.ts");
const { liftWords } = await fixture.load<typeof import("./pipeline-reversal/lift.js")>("tools/agent/pipeline-reversal/lift.ts");
const { branchOrientations } = await fixture.load<typeof import("./branch-orientation.js")>("tools/agent/branch-orientation.ts");
const { detectBranchOrientation } = await fixture.load<typeof import("./triage.js")>("tools/agent/triage.ts");
const { controlShapeSweep } = await fixture.load<typeof import("./controlShapeSweep.js")>("tools/agent/controlShapeSweep.ts");

test("production compiler distinguishes short-circuit and nested-tail witnesses; the byte-exact fixture stays clean", () => {
  const shortCircuit = detectBranchOrientation(fn, join(fixture.root, "build/branch-short-circuit.c"));
  assert.equal(shortCircuit.length, 1);
  assert.match(shortCircuit[0]!.summary, /opposite-sense/);
  assert.match(shortCircuit[0]!.evidence.join("\n"), /NOT an assignment-hoist witness/);
  const findings = detectBranchOrientation(fn, nestedPath);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.summary, /assignment-hoist.*jump.c:596/);
  assert.deepEqual(detectBranchOrientation(fn, join(fixture.root, `src/overlays/ovl_fixture/${fn}.c`)), []);
});

test("inverted fixture words detect the opposite direction against the original MIR tail", () => {
  const words = targetWordsOf(fn, { container: "ovl_fixture" });
  const tail = words.findLastIndex(w => /^b(?:eq|ne)z /.test(w.text));
  assert.ok(tail >= 0);
  const sense = words[tail]!.text.startsWith("beqz") ? "beqz" : "bnez";
  const other = sense === "beqz" ? "bnez" : "beqz";
  const inverted = words.map((w, i) => ({ ...w, text: i === tail ? w.text.replace(sense, other) :
    i === tail + 1 ? (other === "beqz" ? "li v0,1" : "move v0,zero") :
    i === tail + 2 ? (other === "beqz" ? "move v0,zero" : "li v0,1") : w.text }));
  const findings = branchOrientations(liftWords({ functionName: fn, words: inverted }), liftWords({ functionName: fn, words }));
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.target, new RegExp(`^${other}`));
  assert.match(findings[0]!.candidate, new RegExp(`^${sense}`));
});

test("complete-source sweep fixes a nested-tail residual and preserves the exact outer duplicate else", () => {
  const original = readFileSync(nestedPath, "utf8");
  const report = controlShapeSweep(fn, nestedPath);
  assert.equal(report.baseline.exact, false);
  assert.equal(report.coverage.exhaustive, true);
  assert.equal(report.coverage.failed, 0);
  const duplicate = report.variants.find(v => v.form === "nested-duplicate-1")!;
  assert.equal(duplicate.objective?.exact, true);
  assert.match(readFileSync(join(fixture.root, duplicate.source), "utf8"), /else \{\nreturn 0;\n\}\nreturn 0;/);
  for (const form of ["and", "nested-duplicate-0"]) assert.ok(report.variants.find(v => v.form === form)?.trace?.passes[0]?.changes.some(c => c.classification === "assignment-hoist"));
  assert.ok(report.variants.find(v => v.form === "early-returns")?.trace?.passes[0]?.changes.some(c => c.classification === "store-flag-fold"));
  assert.ok(report.variants.find(v => v.form === "or-inverted")?.trace?.passes[0]?.changes.some(c => c.classification === "undetermined"));
  assert.equal(readFileSync(nestedPath, "utf8"), original);
  assert.ok(report.exact.every(p => p.startsWith("build/")));
  assert.equal(report.targetHash.length, 64);
});

test("sweep refuses a result typedef hiding narrowing or volatile storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "control-result-"));
  try {
    const path = join(directory, "input.c");
    for (const type of ["short", "volatile int"]) {
      writeFileSync(path, `typedef ${type} u32;\nint ${fn}(int a) { u32 r; r=0; if (a) r=65536; return r; }\n`);
      assert.throws(() => controlShapeSweep(fn, path), /expanded result-local type/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("sweep refuses an expression macro hiding a call rather than treating it as a read", () => {
  const directory = mkdtempSync(join(tmpdir(), "control-shape-"));
  try {
    const path = join(directory, "input.c");
    writeFileSync(path, `#define C g()\nint g(void);\nint ${fn}(void) { if (C) return 1; return 0; }\n`);
    assert.throws(() => controlShapeSweep(fn, path), /raw\/preprocessed tail tokens differ/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
