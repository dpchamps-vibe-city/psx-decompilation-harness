import { test, ROOT, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { libraryProjectFixture } from "../testing/libraryProjectFixture.js";
import { verificationClosure } from "./verificationClosure.js";
import { configuredCompilerSource, configuredTool, executablePath, loadToolchain, type ToolName } from "./toolchain.js";

/* The verification key names the harness that verifies a member; a module or
   data file that a real member check uses but the key omits would let an edit
   to it leave stale records standing. Run a check and look. */
test("the verification closure names every harness module and file a member check uses", t => {
  const f = libraryProjectFixture(t, 2);
  const out = join(f.root, "recorded.jsonl");
  writeFileSync(out, "");
  execFileSync(process.execPath, ["--import", join(ROOT, "node_modules/tsx/dist/loader.mjs"), "--import", join(ROOT, "tools/testing/moduleRecorder.mjs"),
    join(ROOT, "tools/lib/scriptHost.ts"), join(ROOT, "tools/agent/library.ts"), "--project", f.root, "check"],
  { cwd: f.root, env: { ...process.env, MODULE_RECORDER_OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
  const closure = new Set(verificationClosure(ROOT));
  /* The project's configured tools (here the harness's vendored ones) and its
     compiler-source pin are project toolchain inputs, hashed into every member's
     build identity, not part of the harness key. */
  const configured = fixtureContext(f.root, () => {
    const tools = Object.keys(loadToolchain(f.root).tools).flatMap(name => {
      const path = executablePath(configuredTool(name as ToolName, f.root, { prepare: false }), f.root);
      return path ? [relative(ROOT, path)] : [];
    });
    const source = configuredCompilerSource(f.root);
    return { tools: new Set(tools), source: source ? relative(ROOT, source) + "/" : undefined };
  });
  const harnessPath = (value: string) => {
    const path = value.startsWith("file:") ? fileURLToPath(value) : value;
    const inside = relative(ROOT, path);
    return inside.startsWith("..") || inside.startsWith("node_modules/") || inside.startsWith("build/") || !existsSync(path) ? undefined : inside;
  };
  const used = new Set<string>();
  for (const line of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as { module?: string; read?: string }, path = harnessPath(entry.module ?? entry.read!);
    if (!path || path === "tools/testing/moduleRecorder.mjs" || configured.tools.has(path) || (configured.source && path.startsWith(configured.source))) continue;
    used.add(path);
  }
  assert.ok(used.size > 20, `the recorder saw the check (${used.size} harness paths)`);
  const missing = [...used].filter(path => !closure.has(path)).sort();
  assert.deepEqual(missing, [], "harness files a member check used but the verification key does not name; " +
    "add an entry point or runtime data path in tools/lib/verificationClosure.ts");
});

test("the verification closure is narrower than the harness", () => {
  const closure = verificationClosure(ROOT);
  assert.ok(closure.includes("tools/agent/libraryTarget.ts"));
  assert.ok(closure.includes("tools/vendor/tree-sitter-c/tree-sitter-c.wasm"));
  assert.ok(!closure.some(path => path.startsWith("tools/testing/")), "test support never keys a record");
  assert.ok(!closure.some(path => path.endsWith(".test.ts")));
});
