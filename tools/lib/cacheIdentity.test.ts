import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import { createRuntimeContext, inRuntimeContext } from "./runtimeContext.js";
import { compilationIdentity, stableHash } from "./cacheIdentity.js";
import { buildInputIdentity } from "../build/buildInputs.js";
import { configuredCppFrontend, loadToolchain } from "./toolchain.js";

test("toolchain text is validated whenever it changes, and callers share one immutable configuration", t => {
  const f = projectFixture(t);
  const first = loadToolchain(f.root);
  assert.equal(loadToolchain(f.root), first, "unchanged text is neither validated nor parsed again");
  assert.throws(() => first.flags.cc1.push("-caller-local"), TypeError, "no caller can change what the next one reads");
  f.put("toolchain.json", JSON.stringify({ ...f.toolchain, unexpected: true }));
  assert.throws(() => loadToolchain(f.root), /unknown config\.unexpected/);
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  assert.deepEqual(loadToolchain(f.root).flags, f.toolchain.flags);
});

test("a cpp driver rewritten in place is asked for its frontend again", t => {
  const f = projectFixture(t), driver = join(f.root, "fixture-cpp.sh");
  const answer = (path: string) => writeFileSync(driver, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(join(f.root, path))}\n`, { mode: 0o755 });
  f.put("frontend-a", "a"); f.put("frontend-b", "b");
  answer("frontend-a"); f.toolchain.tools.cpp = driver; f.put("toolchain.json", JSON.stringify(f.toolchain));
  inRuntimeContext(createRuntimeContext(f.root), () => {
    assert.equal(configuredCppFrontend(), join(f.root, "frontend-a"));
    answer("frontend-b"); // same size, written within the same second
    assert.equal(configuredCppFrontend(), join(f.root, "frontend-b"));
  });
});

test("the configured cpp frontend is independently witnessed by preparation/comparison and build identities", t => {
  const f = projectFixture(t), driver = join(f.root, "fixture-cpp.sh"), frontend = join(f.root, "fixture-frontend");
  f.put("fixture-frontend", "frontend-version-one");
  writeFileSync(driver, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(frontend)}\n`, { mode: 0o755 });
  f.toolchain.tools.cpp = driver; f.put("toolchain.json", JSON.stringify(f.toolchain));
  inRuntimeContext(createRuntimeContext(f.root), () => {
    assert.equal(configuredCppFrontend(), frontend);
    const first = stableHash(compilationIdentity(f.root, { kind: "exe", id: "exe" }, "fixture_entry"));
    const built = buildInputIdentity(f.root), driverBytes = readFileSync(driver);
    f.put("fixture-frontend", "frontend-version-two");
    assert.notEqual(stableHash(compilationIdentity(f.root, { kind: "exe", id: "exe" }, "fixture_entry")), first);
    assert.notEqual(buildInputIdentity(f.root), built);
    assert.deepEqual(readFileSync(driver), driverBytes, "a frontend change must invalidate without a driver change");
    f.put("fixture-frontend", "frontend-version-one");
    assert.equal(stableHash(compilationIdentity(f.root, { kind: "exe", id: "exe" }, "fixture_entry")), first);
  });
});
