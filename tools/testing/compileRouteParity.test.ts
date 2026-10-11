import { test } from "./runtimeTestContext.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessFixture } from "./harnessFixture.js";
import { installedScriptArgs } from "../lib/installedScripts.js";
import { createRuntimeContext, inRuntimeContext } from "../lib/runtimeContext.js";
import { configuredFlags } from "../lib/toolchain.js";

for (const kind of ["exe", "overlay"] as const) test(`actual ${kind} cc1 argv agrees across build, sync/async diagnostics, loop/probe, triage, residual and preparation`, async t => {
  const f = harnessFixture(t), name = kind === "exe" ? "func_80024000" : "ovl_11_func_80140000", source = `int ${name}(int x) { return x + 3; }\n`;
  const sourcePath = kind === "exe" ? `src/${name}.c` : `src/overlays/ovl_11/${name}.c`;
  const compiled = await f.compile(name, source);
  const target = { name, offset: 0, words: compiled.words };
  if (kind === "exe") await f.install([target]);
  else await f.install([{ name: "fixture_entry", offset: 0, words: [0x03e00008, 0] }], { ovl_11: [target] });
  f.put(sourcePath, source);
  f.put(`${kind === "exe" ? "build" : "build/ovl_11"}/asm/nonmatchings/${name}/${name}.s`, `.set noreorder\n.text\n.globl ${name}\n${name}:\njr $ra\naddiu $v0,$a0,3\n`);
  const tc = JSON.parse(readFileSync(join(f.root, "toolchain.json"), "utf8"));
  const actual = tc.tools.cc1, log = join(f.root, "build/cc1-argv.jsonl"), wrapper = join(f.root, "build/cc1-wrapper.sh"), body = join(f.root, "build/cc1-wrapper.mjs");
  writeFileSync(body, `import {appendFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');const r=spawnSync(${JSON.stringify(actual)},args,{stdio:'inherit'});process.exit(r.status??1);\n`);
  writeFileSync(wrapper, `#!/bin/sh\nunset NODE_TEST_CONTEXT\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(body)} "$@"\n`, { mode: 0o755 });
  tc.tools.cc1 = wrapper;
  const defaults = JSON.parse(readFileSync(new URL("../../templates/project/toolchain.json", import.meta.url), "utf8"));
  tc.tools.m2c = defaults.tools.m2c; tc.sdk = defaults.sdk; tc.includeDirs = ["include", "library-input/psyq/INCLUDE"];
  f.put("library-input/psyq/INCLUDE/libgpu.h", "/* synthetic target constructs no GPU packets */\n");
  f.put("library-input/psyq/INCLUDE/stddef.h", "typedef unsigned long u_long;\n");
  f.put("library-input/psyq/INCLUDE/libetc.h", "#define getScratchAddr(x) ((u_long *)(0x1F800000 + (x) * 4))\n");
  f.put("toolchain.json", JSON.stringify(tc)); f.put("configs/flag_overrides.mk", `# Synthetic production argv witness\nCC1FLAGS_${name} := -O1 -fno-inline\n`);
  const context = createRuntimeContext(f.root);
  const expected = inRuntimeContext(context, () => [...configuredFlags("cc1", { kind, id: kind === "exe" ? "exe" : "ovl_11" }), "-O1", "-fno-inline"]);
  const check = async (label: string, action: () => unknown) => {
    writeFileSync(log, ""); await action();
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(argv => argv.includes("-o") && argv.some((arg: string) => arg === name + ".i" || arg.endsWith("/" + name + ".i")));
    assert.ok(calls.length, `${label}: actual compiler must be exercised`);
    for (const argv of calls) assert.deepEqual(argv.slice(0, expected.length), expected, `${label}: base/profile then applicable override`);
  };
  const pipeline = await f.load<typeof import("../build/pipeline.js")>("tools/build/pipeline.ts");
  const decomp = await f.load<typeof import("../agent/decompToolchain.js")>("tools/agent/decompToolchain.ts");
  const container = f.containers().find(c => c.kind === kind)!;
  await check("build", () => pipeline.compileObject(container, sourcePath, f.root));
  await check("diagnostic sync", () => decomp.compileSource(sourcePath, "build/parity-sync", name, { assemble: true }));
  await check("diagnostic async", () => decomp.compileSourceAsync(sourcePath, "build/parity-async", name, { assemble: true }));
  const run = (script: string, args: string[]) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, installedScriptArgs(script, [name, ...args], f.root), { cwd: f.root, env, encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`); return result;
  };
  f.put("build/parity-candidate.c", source + "/* candidate route */\n");
  for (const [script, args] of [["tools/agent/loopTrace.ts", ["--json"]], ["tools/agent/flagProbe.ts", ["--json"]], ["tools/agent/triage.ts", ["--json"]], ["tools/agent/residualObjective.ts", ["--source", "build/parity-candidate.c", "--json"]], ["tools/agent/m2cFunc.ts", ["--alternative", "--json"]]] as const)
    await check(script, () => run(script, [...args]));
  f.put("configs/flag_overrides.mk", "# unsupported directive\ninclude other.mk\n");
  assert.throws(() => pipeline.compileObject(container, sourcePath, f.root), /flag_overrides\.mk:2/);
  assert.throws(() => decomp.compileSource(sourcePath, "build/malformed", name), /flag_overrides\.mk:2/);
  for (const script of ["tools/agent/loopTrace.ts", "tools/agent/flagProbe.ts", "tools/agent/triage.ts", "tools/agent/residualObjective.ts", "tools/agent/m2cFunc.ts"]) {
    const result = spawnSync(process.execPath, installedScriptArgs(script, [name, "--json"], f.root), { cwd: f.root, encoding: "utf8", timeout: 120000 });
    assert.notEqual(result.status, 0, script); assert.match(result.stderr + result.stdout, /flag_overrides\.mk:2/, script);
  }
});
