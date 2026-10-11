import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProjectInput, createRuntimeContext, discoverProjectRoot, inRuntimeContext, projectRoot, resolveOwnedPath } from "./runtimeContext.js";

function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), "psx-runtime-context-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const roots = ["package", "exe", "library"].map(name => { const root = join(base, name); mkdirSync(root); writeFileSync(join(root, "toolchain.json"), "{}"); return root; });
  return { base, roots };
}
test("discovery depends on configuration, never copied implementation or AGENTS", t => {
  const { roots: [, exe] } = fixture(t); mkdirSync(join(exe!, "src"));
  assert.equal(discoverProjectRoot(join(exe!, "src")), exe);
  assert.throws(() => projectRoot(), /Missing explicit/);
});
test("explicit concurrent invocation contexts isolate same-process project switches", async t => {
  const { roots: [harness, exe, library] } = fixture(t);
  const read = (root: string, wait: number) => inRuntimeContext(createRuntimeContext(root, { harnessRoot: harness! }), async () => {
    await new Promise(resolve => setTimeout(resolve, wait));
    return projectRoot();
  });
  assert.deepEqual(await Promise.all([read(exe!, 10), read(library!, 0)]), [exe, library]);
  assert.throws(() => projectRoot(), /Missing explicit/);
});
test("path origins have one owner, never trial roots or target fallback", t => {
  const { roots: [harness, exe] } = fixture(t), context = createRuntimeContext(exe!, { harnessRoot: harness! });
  assert.equal(resolveOwnedPath("include", context), join(exe!, "include"));
  assert.equal(resolveOwnedPath({ origin: "harness", path: "tools/support" }, context), join(harness!, "tools/support"));
  assert.equal(resolveOwnedPath({ origin: "runtime", path: "dependencies" }, context), join(exe!, "build/dependencies"));
  assert.throws(() => resolveOwnedPath({ origin: "harness", path: "../exe" }, context), /escapes/);
  assert.throws(() => resolveOwnedPath({ origin: "external", path: "relative" }, context), /absolute/);
});
test("workspaces can share only declared immutable parent input mounts", t => {
  const { roots: [harness, parent, worker] } = fixture(t);
  mkdirSync(join(parent!, "library-input")); writeFileSync(join(parent!, "library-input/original.a"), "pristine");
  symlinkSync(join(parent!, "library-input"), join(worker!, "library-input"));
  const context = createRuntimeContext(worker!, { harnessRoot: harness!, parentProjectRoot: parent!, sharedInputs: [{ path: "library-input", source: join(parent!, "library-input") }] });
  assertProjectInput("library-input/original.a", context);
  assert.throws(() => assertProjectInput("library-input/original.a", createRuntimeContext(worker!)), /declared/);
  assert.equal(readFileSync(join(parent!, "library-input/original.a"), "utf8"), "pristine");
  assert.throws(() => createRuntimeContext(worker!, { runtimeRoot: join(parent!, "build") }), /isolated/);
});
