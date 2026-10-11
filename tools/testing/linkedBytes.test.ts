import { test } from "./runtimeTestContext.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessFixture } from "./harnessFixture.js";
import { installedScriptArgs } from "../lib/installedScripts.js";

test("requested linked-byte verification fails on failed/missing/truncated/different builds, never accepts a stale image", async t => {
  const f = harnessFixture(t), name = "byte_fixture", source = "int byte_fixture(int x) { return x + 5; }\n";
  const c = await f.compile(name, source); await f.install([{ name, offset: 0, words: c.words }]); f.put(`src/${name}.c`, source);
  f.put("configs/splat/exe.yaml", readFileSync(join(f.root, "configs/splat/exe.yaml"), "utf8").replace("    subsegments:\n", "    subsegments:\n      - [0x800, rodata]\n"));
  const tc = JSON.parse(readFileSync(join(f.root, "toolchain.json"), "utf8"));
  const defaults = JSON.parse(readFileSync(new URL("../../templates/project/toolchain.json", import.meta.url), "utf8"));
  tc.sdk = defaults.sdk;
  f.put("library-input/psyq/LIB/.keep", "");
  f.put("build/fixture_image.ld", "/* Synthetic configured linker fixture: no Makefile. */\n");
  const linker = join(f.root, "build/fixture-linker.sh"), copier = join(f.root, "build/fixture-objcopy.sh");
  const realObjcopy = tc.tools.objcopy;
  tc.tools.ld = linker; tc.tools.objcopy = copier; f.put("toolchain.json", JSON.stringify(tc));
  // These configured external fixture executables exercise the real build API;
  // they are not replacements for any production script or byte comparison.
  const tool = (path: string, body: string) => writeFileSync(path, "#!/bin/sh\n" + (path === copier ? `case "$*" in *--only-section*) exec ${JSON.stringify(realObjcopy)} "$@";; esac\nfor last; do :; done\n` : "") + body + "\n", { mode: 0o755 });
  tool(linker, 'while [ "$1" != "-o" ]; do shift; done; shift; printf "fixture link" > "$1"');
  const original = readFileSync(join(f.root, "extracted/FIXTURE.EXE")); f.put("build/link-fixture.bin", original);
  const successful = `cp ${JSON.stringify(join(f.root, "build/link-fixture.bin"))} "$last"`;
  tool(copier, successful);
  const run = () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, installedScriptArgs("tools/agent/diffFunc.ts", [name, "--bytes"], f.root), { cwd: f.root, env, encoding: "utf8", timeout: 30000 });
  };
  let result = run(); assert.equal(result.status, 0, result.stderr + result.stdout); assert.match(result.stdout, /VERIFIED: byte-identical/);
  assert.equal(existsSync(join(f.root, "Makefile")), false);
  tool(linker, "exit 7"); result = run(); assert.notEqual(result.status, 0); assert.match(result.stdout, /BYTE VERIFY UNAVAILABLE/); assert.doesNotMatch(result.stdout, /VERIFIED:/);
  tool(linker, 'while [ "$1" != "-o" ]; do shift; done; shift; printf "fixture link again" > "$1"');
  tool(copier, "exit 0"); result = run(); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /VERIFIED:/);
  tool(copier, `head -c 2050 ${JSON.stringify(join(f.root, "build/link-fixture.bin"))} > "$last"`); result = run(); assert.notEqual(result.status, 0); assert.match(result.stdout, /truncated/);
  const different = Buffer.from(original); different[0x800] = different[0x800]! ^ 1; f.put("build/link-fixture.bin", different);
  tool(copier, successful); result = run(); assert.notEqual(result.status, 0); assert.match(result.stdout, /LINKED BYTES DIFFER/);
  f.put("build/link-fixture.bin", original); tool(copier, successful + "\n# restored fixture bytes"); result = run(); assert.equal(result.status, 0, result.stderr + result.stdout);
});
