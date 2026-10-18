/** Opt-in whole-project acceptance, using the project's real npm/CLI route.
 * No project names, SDK bytes or acceptance substitutes live in this test. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "../testing/runtimeTestContext.js";
import { createRuntimeContext, inRuntimeContext } from "../lib/runtimeContext.js";
import { loadLibraryProject } from "../lib/project.js";
import { libraryMembers, withLibraryMetadata } from "../lib/libraryTargets.js";
import { verifiedLibraryMembers } from "./libraryTarget.js";
const selected = process.env.PSX_NATIVE_LIBRARY_PROJECT;
test("real native library CLI re-verifies every original with current provenance", { skip: !selected, timeout: 3_600_000 }, () => {
  const root = resolve(selected!);
  inRuntimeContext(createRuntimeContext(root), () => {
    assert.equal(loadLibraryProject(root)?.verification.mode, "original-object", "the opt-in project must select native acceptance");
  });
  execFileSync("npm", ["run", "check-all"], { cwd: root, stdio: "inherit", timeout: 3_500_000 });
  inRuntimeContext(createRuntimeContext(root), () => {
    const members = libraryMembers(root);
    assert.ok(members.length > 0);
    // Use the production batch's invocation-local lookup scope, not thousands
    // of independent catalogue reloads. Identity and input guards still run.
    withLibraryMetadata(() => {
      const verified = verifiedLibraryMembers(members, root);
      assert.equal(verified.size, members.length);
      assert.ok([...verified.values()].every(Boolean), "every record must bind the current original and toolchain");
    }, members, root);
  });
});
