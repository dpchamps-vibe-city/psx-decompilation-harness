import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import { configuredTool } from "../lib/toolchain.js";
import { sourceDependencyFiles } from "./decompToolchain.js";

/** Files written moments ago are never recorded, so each reuse is measured
 * only after the fixture has settled. */
const settle = () => new Promise(resolve => setTimeout(resolve, 2_100));

test("a dependency list is reused only while its inputs and every searched directory are unchanged", async t => {
  const f = projectFixture(t), log = join(f.root, "cpp-runs.log"), wrapper = join(f.root, "cpp-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-M" ] && echo run >> ${JSON.stringify(log)}; done\nexec ${configuredTool("cpp", ROOT)} "$@"\n`, { mode: 0o755 });
  f.toolchain.tools.cpp = wrapper; f.toolchain.flags.cpp.unshift("-nostdinc"); f.toolchain.includeDirs = ["include"]; f.put("toolchain.json", JSON.stringify(f.toolchain));
  f.put("include/dep_a.h", '#include "dep_b.h"\n'); f.put("include/dep_b.h", "#define B 1\n");
  f.put("src/dep_fixture.c", '#include "dep_a.h"\n#include "dep_later.h"\nint dep_fixture(void) { return B; }\n');
  const runs = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  const deps = () => fixtureContext(f.root, () => sourceDependencyFiles("src/dep_fixture.c", { kind: "exe", id: "exe" }, f.root))
    .map(p => relative(f.root, p)).sort();

  await settle();
  assert.deepEqual(deps(), ["dep_later.h", "include/dep_a.h", "include/dep_b.h", "src/dep_fixture.c"], "-MG keeps the absent header by name");
  assert.equal(runs(), 1);
  deps();
  assert.equal(runs(), 1, "unchanged inputs reuse the recorded list");

  f.put("include/dep_b.h", '#include "dep_c.h"\n'); f.put("include/dep_c.h", "#define B 2\n");
  assert(deps().includes("include/dep_c.h"), "a changed header's new include is listed");
  assert.equal(runs(), 2);
  deps();
  assert.equal(runs(), 3, "a list read from files written moments ago is not recorded");

  await settle(); deps(); const settled = runs(); deps();
  assert.equal(runs(), settled, "settled inputs are recorded and reused");
  f.put("src/dep_a.h", "#define B 3\n");
  const shadowed = deps();
  assert(shadowed.includes("src/dep_a.h") && !shadowed.includes("include/dep_a.h"), `a header earlier in the search shadows: ${shadowed}`);

  await settle(); deps(); const before = runs(); deps();
  assert.equal(runs(), before);
  f.put("include/dep_later.h", "\n");
  const available = deps();
  assert(available.includes("include/dep_later.h") && !available.includes("dep_later.h"), `an absent header that appears is found: ${available}`);
  assert.equal(runs(), before + 1);
});
