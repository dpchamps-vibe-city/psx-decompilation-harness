import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredSdkHeader } from "./toolchain.js";
import { loadPrimitiveTable } from "../agent/sdkIdioms.js";
import { harvestTypedefs } from "../agent/sdkTypes.js";
import { sdkPrototypes } from "../agent/calleeTruth.js";

function fixture(action: (root: string, config: any) => void): void {
  const root = mkdtempSync(join(tmpdir(), "psx-sdk-headers-"));
  try {
    const config = JSON.parse(readFileSync(join(ROOT, "toolchain.json"), "utf8"));
    config.sdk.headers = { origin: "project", path: "sdk/INCLUDE" };
    config.includeDirs = ["include"];
    mkdirSync(join(root, "sdk/INCLUDE"), { recursive: true });
    mkdirSync(join(root, "include"));
    writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
    fixtureContext(root, () => action(root, config));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("SDK lookup accepts original DOS header names without modifying them", () => fixture(root => {
  const text = "typedef struct { u_long tag; u_char r0, g0, b0, code; short x0, y0; } TILE;\n#define setTile(p) setlen(p, 3), setcode(p, 0x60)\n";
  const path = join(root, "sdk/INCLUDE/LIBGPU.H");
  writeFileSync(path, text);
  writeFileSync(join(root, "include/libgpu.h"), "not the selected SDK");
  assert.equal(configuredSdkHeader("libgpu.h"), path);
  assert.equal(loadPrimitiveTable()[0]?.name, "TILE");
  assert.equal(readFileSync(path, "utf8"), text);
}));

test("SDK lookup rejects ambiguous case spellings even when one is exact", () => fixture(root => {
  writeFileSync(join(root, "sdk/INCLUDE/LIBGPU.H"), "upper");
  writeFileSync(join(root, "sdk/INCLUDE/libgpu.h"), "lower");
  assert.throws(() => configuredSdkHeader("libgpu.h"), /Ambiguous SDK header/);
}));

test("explicit SDK ownership does not fall back to unrelated include directories", () => fixture(root => {
  writeFileSync(join(root, "include/libgpu.h"), "unrelated");
  assert.equal(configuredSdkHeader("libgpu.h"), undefined);
  assert.throws(() => configuredSdkHeader("../libgpu.h"), /filename/);
}));

test("typedef and callee scanners also read configured uppercase SDK headers", () => fixture(root => {
  writeFileSync(join(root, "sdk/INCLUDE/MALLOC.H"), "typedef unsigned long SdkWord;\nvoid sdk_fixture(SdkWord *, unsigned long);\n");
  assert.equal(harvestTypedefs(root).get("SdkWord"), "typedef unsigned long SdkWord;");
  assert.ok(sdkPrototypes().has("sdk_fixture"));
}));

test("without an explicit SDK root, lookup preserves configured include order", () => fixture((root, config) => {
  delete config.sdk.headers;
  config.includeDirs = ["missing", "include", "sdk/INCLUDE"];
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  writeFileSync(join(root, "include/LibGpu.h"), "selected");
  writeFileSync(join(root, "sdk/INCLUDE/LIBGPU.H"), "later");
  assert.equal(configuredSdkHeader("libgpu.h"), join(root, "include/LibGpu.h"));
}));
