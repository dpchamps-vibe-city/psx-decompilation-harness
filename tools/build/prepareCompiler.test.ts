import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeContext, inRuntimeContext } from "../lib/runtimeContext.js";
import { configuredTool } from "../lib/toolchain.js";
import { digest, snapshot } from "../lib/contentCache.js";

function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), "compiler-provision-")), root = join(base, "project"), harnessRoot = join(base, "package"), bin = join(base, "bin");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const path of [root, bin, join(harnessRoot, "tools/vendor/old-gcc/patches"), join(harnessRoot, "tools/vendor/old-gcc/tests")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(harnessRoot, "tools/vendor/old-gcc/gcc-2.95.2-psx.Dockerfile"), "# Explicit synthetic public recipe fixture\n");
  writeFileSync(join(harnessRoot, "tools/vendor/old-gcc/patches/example.diff"), "patch bytes\n");
  const config = JSON.parse(readFileSync(new URL("../../templates/project/toolchain.json", import.meta.url), "utf8"));
  config.tools.cc1 = { origin: "runtime", path: "dependencies/compiler/gcc-2.95.2-psx/cc1" };
  writeFileSync(join(root, "toolchain.json"), JSON.stringify(config));
  const log = join(base, "docker-argv.jsonl"), docker = join(bin, "docker");
  writeFileSync(docker, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(fs.existsSync(${JSON.stringify(join(base, "fail"))}))process.exit(17);
const output=args[args.indexOf('--output')+1].replace('type=local,dest=','');
fs.writeFileSync(path.join(output,'cc1'),'#!${process.execPath}\\nconsole.log("synthetic gcc-2.95.2-psx compiler probe");\\n',{mode:0o755});
`); chmodSync(docker, 0o755);
  const context = createRuntimeContext(root, { harnessRoot });
  const invoke = () => {
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try { return inRuntimeContext(context, () => configuredTool("cc1")); }
    finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  };
  return { base, root, harnessRoot, log, invoke };
}
test("missing supported compiler automatically provisions with explicit Docker argv into runtime only", t => {
  const f = fixture(t), before = snapshot(f.harnessRoot, [f.harnessRoot]), compiler = f.invoke();
  assert.equal(compiler, join(f.root, "build/dependencies/compiler/gcc-2.95.2-psx/cc1"));
  assert.equal(existsSync(compiler), true);
  const [{ args, cwd }] = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(args.slice(0, 3), ["build", "--file", join(f.harnessRoot, "tools/vendor/old-gcc/gcc-2.95.2-psx.Dockerfile")]);
  assert.equal(args[3], "--output"); assert.match(args[4], /^type=local,dest=/);
  assert.equal(args[5], join(f.harnessRoot, "tools/vendor/old-gcc")); assert.equal(cwd, f.root);
  const provenance = JSON.parse(readFileSync(join(compiler, "../compiler-provenance.json"), "utf8"));
  assert.equal(provenance.compilerHash, digest(readFileSync(compiler))); assert.match(provenance.recipeHash, /^[a-f0-9]{64}$/);
  assert.match(provenance.probe, /synthetic/);
  assert.equal(f.invoke(), compiler); assert.equal(readFileSync(f.log, "utf8").trim().split("\n").length, 1);
  assert.deepEqual(snapshot(f.harnessRoot, [f.harnessRoot]), before);
  assert.equal(existsSync(join(f.root, "tools")), false); assert.equal(existsSync(join(f.root, "library-input")), false);
});
test("failed compiler provision propagates and preserves inputs and incomplete cache", t => {
  const f = fixture(t), destination = join(f.root, "build/dependencies/compiler/gcc-2.95.2-psx");
  mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, "user-evidence.txt"), "preserve");
  writeFileSync(join(f.base, "fail"), "");
  assert.throws(f.invoke, /Cannot provision.*Supply Docker\/BuildKit/);
  assert.equal(readFileSync(join(destination, "user-evidence.txt"), "utf8"), "preserve");
  assert.deepEqual(readdirSync(join(destination, "..")), ["gcc-2.95.2-psx"]);
  rmSync(join(f.base, "fail"));
  assert.throws(f.invoke, /Incomplete compiler cache is preserved/);
  assert.equal(readFileSync(join(destination, "user-evidence.txt"), "utf8"), "preserve");
  assert.equal(existsSync(join(destination, "cc1")), false);
});
