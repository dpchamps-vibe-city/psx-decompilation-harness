import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import { createRuntimeContext, inRuntimeContext } from "./runtimeContext.js";
import { compilationIdentity, stableHash } from "./cacheIdentity.js";
import { buildInputIdentity } from "../build/buildInputs.js";
import { configuredCppFrontend } from "./toolchain.js";

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
