import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { libraryProjectFixture } from "../testing/libraryProjectFixture.js";
import { measureCounts } from "./perfCounters.js";
import { libraryContext, loadLibraryProject } from "./project.js";
import { configuredFlags, loadToolchain } from "./toolchain.js";
import { libraryMembers } from "./libraryTargets.js";
import { fileDigest, withContentMemo } from "./contentCache.js";
import { writeLibraryGraph } from "../agent/libraryTarget.js";

/* Work budgets (plans/optimization §0.4): how often a call repeats work that a
 * fingerprint already settled. A regression here fails with the counter name,
 * not as a slower loop. */

test("a library configuration is validated once per text, then shared frozen", async t => {
  const f = libraryProjectFixture(t);
  await fixtureContext(f.root, async () => {
    loadLibraryProject(f.root);
    const { counts } = await measureCounts(() => { for (let i = 0; i < 200; i++) libraryContext(f.members[0]!.id, f.root); });
    assert.equal(counts["project.validate"] ?? 0, 0, "unchanged text is not validated again");
    assert.equal(counts["toolchain.validate"] ?? 0, 0);
    const project = loadLibraryProject(f.root)!;
    assert.throws(() => { (project.output as { sourceDir: string }).sourceDir = "src/elsewhere"; }, TypeError, "callers share one frozen configuration");
    const text = readFileSync(join(f.root, "project.json"), "utf8");
    writeFileSync(join(f.root, "project.json"), text.replace('"schemaVersion":1', '"schemaVersion": 1'));
    const changed = await measureCounts(() => loadLibraryProject(f.root));
    assert.equal(changed.counts["project.validate"], 1, "a changed text is validated");
    assert.notEqual(changed.value, project);
  });
});

test("an unchanged inventory is parsed once; a changed input object is parsed again", async t => {
  const f = libraryProjectFixture(t, 3);
  await fixtureContext(f.root, async () => {
    const first = await measureCounts(() => [libraryMembers(f.root), libraryMembers(f.root), libraryMembers(f.root)]);
    assert.ok((first.counts["inventory.parse"] ?? 0) <= 1, JSON.stringify(first.counts));
    assert.ok((first.counts["inventory.reuse"] ?? 0) >= 2, JSON.stringify(first.counts));
    const [a, b] = first.value;
    assert.notEqual(a, b, "each caller owns its array");
    assert.equal(a![0], b![0], "members are shared read-only data");
    const before = a!.find(m => m.input === "inputs/fn1.o")!.sha256;
    f.assemble("fn1", 99);
    const changed = await measureCounts(() => libraryMembers(f.root));
    assert.equal(changed.counts["inventory.parse"], 1, "a changed input is parsed");
    assert.notEqual(changed.value.find(m => m.input === "inputs/fn1.o")!.sha256, before);
  });
});

test("reference headers are snapshotted once per invocation, not per flag lookup", async t => {
  const f = libraryProjectFixture(t, 2, { referenceHeaders: true });
  await fixtureContext(f.root, async () => {
    const { counts, value } = await measureCounts(() => withContentMemo(() => {
      const flags = Array.from({ length: 50 }, () => configuredFlags("cpp", libraryContext(f.members[0]!.id, f.root), f.root));
      return flags[0]!;
    }));
    assert.ok(value.some(flag => flag.includes("build/headers/reference/")), value.join(" "));
    assert.equal(counts["referenceHeaders.snapshot"], 1, JSON.stringify(counts));
  });
});

test("a settled file is hashed once; a rewrite is hashed again", async t => {
  const f = libraryProjectFixture(t, 1);
  await fixtureContext(f.root, async () => {
    const path = join(f.root, "toolchain.json");
    const first = fileDigest(path);
    const settled = await measureCounts(() => [fileDigest(path), fileDigest(path)]);
    /* Written just now: not yet settled, so it may be hashed again, never reused wrongly. */
    assert.deepEqual(settled.value, [first, first]);
    writeFileSync(path, readFileSync(path, "utf8").replace(/}\s*$/, ', "schemaVersion": 1 }'));
    loadToolchain(f.root);
    assert.notEqual(fileDigest(path), first, "same path, new bytes, new digest");
  });
});

test("one call graph rebuild parses the inventory and configuration once", async t => {
  const f = libraryProjectFixture(t, 3, { referenceHeaders: true });
  await fixtureContext(f.root, async () => {
    const { counts } = await measureCounts(() => withContentMemo(() => writeLibraryGraph(f.root)));
    assert.ok((counts["inventory.parse"] ?? 0) <= 1, JSON.stringify(counts));
    assert.ok((counts["project.validate"] ?? 0) <= 1, JSON.stringify(counts));
    assert.ok((counts["referenceHeaders.snapshot"] ?? 0) <= 1, JSON.stringify(counts));
    assert.equal(counts["verification.batch"], 1, JSON.stringify(counts));
  });
});
