import { strict as assert } from "node:assert";
import { test } from "../testing/runtimeTestContext.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileOverrideFlags, readFlagOverrides } from "./flagOverrides.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "psx-overrides-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "configs"));
  const put = (text: string) => writeFileSync(join(root, "configs/flag_overrides.mk"), text);
  return { root, put };
}
test("one reader preserves existing := grammar, order and live project edits", t => {
  const { root, put } = fixture(t);
  assert.deepEqual([...readFlagOverrides(root)], []);
  put("# measured evidence\nCC1FLAGS_target := -fno-schedule-insns -G0\n\n# member evidence\nCC1FLAGS_lib_0123456789abcdef_1 := -O1\n");
  assert.deepEqual(fileOverrideFlags(root, "target"), ["-fno-schedule-insns", "-G0"]);
  assert.deepEqual(fileOverrideFlags(root, "unrelated"), []);
  put("# another measurement\nCC1FLAGS_target := -O1\n");
  assert.deepEqual(fileOverrideFlags(root, "target"), ["-O1"]);
});
for (const bad of ["CC1FLAGS_target = -O1", "CC1FLAGS_target += -G0", "include other.mk", "export CC1FLAGS_target := -O1", " CC1FLAGS_target := -O1", "CC1FLAGS_target :=   ", "$(shell touch dangerous)"]) {
  test(`unsupported override fails with exact file/line: ${bad}`, t => {
    const { root, put } = fixture(t); put(`# evidence\n${bad}\n`);
    assert.throws(() => readFlagOverrides(root), /configs\/flag_overrides\.mk:2: unsupported override/);
  });
}
