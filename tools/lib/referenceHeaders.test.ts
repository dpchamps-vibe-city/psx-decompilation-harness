import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "../testing/runtimeTestContext.js";
import { projectFixture } from "../testing/projectFixture.js";
import { configuredFlags, configuredTool } from "./toolchain.js";

test("production include flags use an LF-only content-addressed reference tree without editing originals", t => {
  const f = projectFixture(t), original = "#define VALUE (1 + \\\r\n2)\r\n";
  f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", standaloneObjects: ["input.o"] }, headers: { reference: ["reference"], owned: ["include"], context: ["common.h"] } }));
  f.toolchain.includeDirs = ["include", "reference"];
  f.put("toolchain.json", JSON.stringify(f.toolchain));
  f.put("reference/value.h", original);
  f.put("probe.c", "#include <value.h>\nint probe = VALUE;\n");
  const flags = configuredFlags("cpp", { kind: "library" }, f.root);
  const copied = flags.find(f => f.startsWith("-I") && f.includes("/build/headers/reference/"))!.slice(2);
  assert.equal(readFileSync(join(copied, "value.h"), "utf8"), original.replace(/\r\n/g, "\n"));
  assert.equal(readFileSync(join(f.root, "reference/value.h"), "utf8"), original);
  const output = execFileSync(configuredTool("cpp", f.root), [...flags, join(f.root, "probe.c")], { encoding: "utf8" });
  assert.match(output, /int probe = \(1 \+\s*2\);/);
  f.put("reference/value.h", original.replace("2)", "3)"));
  const next = configuredFlags("cpp", { kind: "library" }, f.root);
  assert.notDeepEqual(next, flags, "a header content change selects a different copy");
  assert.equal(readFileSync(join(copied, "value.h"), "utf8"), original.replace(/\r\n/g, "\n"));
});
