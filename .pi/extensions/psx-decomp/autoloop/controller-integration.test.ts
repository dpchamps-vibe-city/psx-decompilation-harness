import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, fixtureContext } from "../../../../tools/testing/runtimeTestContext.js";
import { libraryProjectFixture } from "../../../../tools/testing/libraryProjectFixture.js";
import { snapshotSource, stageWorkerDraft } from "./controller-integration.js";

function fixture(t: { after(action: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "psx-build-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["src", "build/worker"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "src/f.c"), "int f(void) { return 0; }\n");
  const draft = { source: snapshotSource(root, "src/f.c"), candidate: join(root, "build/worker/candidate.c"), headerPatch: join(root, "build/worker/headers.patch") };
  writeFileSync(draft.candidate, "int f(void) { return 1; }\n");
  return { root, draft };
}

test("workers test files under build; only the main loop promotes the candidate", async t => {
  const f = fixture(t);
  assert.match(readFileSync(join(f.root, "src/f.c"), "utf8"), /return 0/);
  const result = await stageWorkerDraft(f.root, f.draft);
  assert.equal(result.applied, true, result.feedback);
  assert.match(result.feedback, /ordinary verification/);
  assert.match(readFileSync(join(f.root, "src/f.c"), "utf8"), /return 1/);
  assert.match(readFileSync(f.draft.candidate, "utf8"), /return 1/);
  await result.rollback!();
  assert.match(readFileSync(join(f.root, "src/f.c"), "utf8"), /return 0/);
  await result.rollback!(); // idempotent
});

test("promotion preserves a main source changed since the worker started", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "src/f.c"), "int f(void) { return 2; }\n");
  const result = await stageWorkerDraft(f.root, f.draft);
  assert.equal(result.applied, false);
  assert.match(readFileSync(join(f.root, "src/f.c"), "utf8"), /return 2/);
  assert.match(readFileSync(f.draft.candidate, "utf8"), /return 1/);
});

function headerPatch(f: ReturnType<typeof fixture>) {
  execFileSync("git", ["init", "--quiet"], { cwd: f.root });
  mkdirSync(join(f.root, "include"));
  writeFileSync(join(f.root, "include/owned.h"), "/* before */\n");
  writeFileSync(f.draft.headerPatch, "diff --git a/include/owned.h b/include/owned.h\n--- a/include/owned.h\n+++ b/include/owned.h\n@@ -1 +1 @@\n-/* before */\n+/* after */\n" +
    "diff --git a/include/new.h b/include/new.h\nnew file mode 100644\n--- /dev/null\n+++ b/include/new.h\n@@ -0,0 +1 @@\n+/* new */\n");
}

test("rollback restores source and declaration patches, including newly created headers", async t => {
  const f = fixture(t); headerPatch(f);
  const result = await stageWorkerDraft(f.root, f.draft);
  assert.equal(result.applied, true, result.feedback);
  assert.equal(readFileSync(join(f.root, "include/owned.h"), "utf8"), "/* after */\n");
  assert.equal(f.draft.headerApplied, true);
  await result.rollback!();
  assert.equal(readFileSync(join(f.root, "include/owned.h"), "utf8"), "/* before */\n");
  assert.equal(existsSync(join(f.root, "include/new.h")), false);
  assert.equal(f.draft.headerApplied, undefined);
  assert.equal((await stageWorkerDraft(f.root, f.draft)).applied, true, "restored draft can be revised/retried");
});

test("rollback refuses to overwrite concurrent source or header edits", async t => {
  for (const file of ["src/f.c", "include/owned.h"]) {
    const f = fixture(t); headerPatch(f);
    const result = await stageWorkerDraft(f.root, f.draft);
    writeFileSync(join(f.root, file), "/* independent edit */\n");
    await assert.rejects(result.rollback!(), /concurrent edits/);
    assert.equal(readFileSync(join(f.root, file), "utf8"), "/* independent edit */\n");
  }
});

test("invalid C is rejected before either source or headers change", async t => {
  const f = fixture(t); headerPatch(f);
  writeFileSync(f.draft.candidate, "int f(void) {\n");
  const result = await stageWorkerDraft(f.root, f.draft);
  assert.equal(result.applied, false);
  assert.match(result.feedback, /Invalid candidate C/);
  assert.match(readFileSync(join(f.root, "src/f.c"), "utf8"), /return 0/);
  assert.equal(readFileSync(join(f.root, "include/owned.h"), "utf8"), "/* before */\n");
  assert.equal(existsSync(join(f.root, "include/new.h")), false);
});

function libraryFixture(t: Parameters<typeof libraryProjectFixture>[0]) {
  const f = libraryProjectFixture(t, 1), member = f.members[0]!, path = join(dirname(member.source), "fn0.c");
  writeFileSync(join(f.root, member.source), JSON.stringify({ schemaVersion: 1, member: member.id, parts: [{ path: "fn0.c", symbol: "fn0" }] }));
  writeFileSync(join(f.root, path), `INCLUDE_ASM("build/libraries/nonmatchings/${member.id}", fn0);\n`);
  const directory = join(f.root, "build/worker"); mkdirSync(directory, { recursive: true });
  const draft = { source: snapshotSource(f.root, path), candidate: join(directory, "candidate.c"), headerPatch: join(directory, "headers.patch") };
  return { ...f, member, path, draft };
}

test("a two-callback draft cannot poison a single-function library part", async t => {
  const f = libraryFixture(t);
  await fixtureContext(f.root, async () => {
    const source = readFileSync(join(f.root, f.path), "utf8");
    writeFileSync(f.draft.candidate, "static int fn0(void) { return 1; }\nstatic int rx(void) { return 0; }\n");
    const result = await stageWorkerDraft(f.root, f.draft);
    assert.equal(result.applied, false);
    assert.match(result.feedback, /must define only fn0/);
    assert.equal(readFileSync(join(f.root, f.path), "utf8"), source);
    assert.match(readFileSync(f.draft.candidate, "utf8"), /int rx/);
  });
});

test("a single-function draft cannot outlive its assignment's partition contract", async t => {
  const f = libraryFixture(t);
  await fixtureContext(f.root, async () => {
    writeFileSync(f.draft.candidate, "int fn0(void) { return 1; }\n");
    writeFileSync(join(f.root, f.member.source), JSON.stringify({ schemaVersion: 1, member: f.member.id, parts: [{ path: "fn0.c", symbols: ["fn0"] }] }));
    const result = await stageWorkerDraft(f.root, f.draft);
    assert.equal(result.applied, false);
    assert.match(result.feedback, /partition changed/);
    assert.match(readFileSync(join(f.root, f.path), "utf8"), /INCLUDE_ASM/);
  });
});
