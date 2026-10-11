import { test } from "./runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harnessFixture } from "./harnessFixture.js";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";

const pkg = process.env.PSX_PRODUCTION_PACKAGE, host = process.env.PSX_PI_085_HOST;
for (const kind of ["exe", "library"] as const) test(`installed ${kind} update preserves measured packets, history and equal output; only relevant changes invalidate`, {
  skip: !pkg || !host ? "Requires the production-only installed package and Pi 0.85.1" : false,
}, async t => {
  const f = harnessFixture(t), symbol = "upgrade_fixture", source = "int upgrade_fixture(int x) { return x + 1; }\n";
  const compiled = await f.compile(symbol, source);
  await f.install([{ name: symbol, offset: 0, words: compiled.words }]);
  let name = symbol, overrideStem = symbol, originalPath = "extracted/FIXTURE.EXE";
  const configured = JSON.parse(readFileSync(join(f.root, "toolchain.json"), "utf8"));
  const defaults = JSON.parse(readFileSync(join(pkg!, "templates/project/toolchain.json"), "utf8"));
  configured.tools.m2c = defaults.tools.m2c;
  f.put("toolchain.json", JSON.stringify(configured));
  if (kind === "library") {
    originalPath = "library-input/supplied.o"; f.put(originalPath, readFileSync(compiled.art.object!));
    f.put("project.json", JSON.stringify({ schemaVersion: 1, target: { kind: "relocatable-library", format: "elf-ar", archives: [], standaloneObjects: [originalPath] }, headers: { reference: ["library-input/psyq/INCLUDE"], owned: ["include/library"], context: ["common.h"] } }));
    f.put("library-input/psyq/INCLUDE/libgpu.h", "/* synthetic target builds no GPU packets */\n");
    const runtime = await import(pathToFileURL(join(pkg!, "tools/lib/runtimeContext.ts")).href);
    const members = await import(pathToFileURL(join(pkg!, "tools/lib/libraryTargets.ts")).href);
    const member = runtime.inRuntimeContext(runtime.createRuntimeContext(f.root), () => members.libraryMembers(f.root)[0]);
    name = member.id + "::" + symbol; overrideStem = member.id; f.put(member.source, source);
  } else f.put(`src/${name}.c`, source);
  const updated = join(dirname(pkg!), `psx-harness-update-${kind}-test`);
  t.after(() => rmSync(updated, { recursive: true, force: true }));
  cpSync(pkg!, updated, { recursive: true });
  writeFileSync(join(updated, "tools/agent/fileGroupings.ts"), readFileSync(join(updated, "tools/agent/fileGroupings.ts"), "utf8") + "\n/* unrelated package update */\n");
  const manifest = JSON.parse(readFileSync(join(updated, "package.json"), "utf8")); manifest.version = "1.0.1";
  writeFileSync(join(updated, "package.json"), JSON.stringify(manifest));
  async function install(packagePath: string) {
    execFileSync(process.execPath, [resolve(dirname(host!), "cli.js"), "install", "--local", "--approve", packagePath], { cwd: f.root, stdio: "pipe" });
  }
  function invoke(packagePath: string, tool: string, parameters: unknown): string {
    return execFileSync(process.execPath, ["--import", "tsx", join(HARNESS_ROOT, "tools/testing/installedToolInvocation.ts"), f.root, host!, tool,
      JSON.stringify(parameters), join(packagePath, ".pi/extensions/psx-decomp/index.ts")], { cwd: HARNESS_ROOT, encoding: "utf8", timeout: 120000 });
  }
  async function fresh(packagePath: string, packet: any): Promise<boolean> {
    const runtime = await import(pathToFileURL(join(packagePath, "tools/lib/runtimeContext.ts")).href);
    const preparation = await import(pathToFileURL(join(packagePath, "tools/agent/prepareFunction.ts")).href);
    return runtime.inRuntimeContext(runtime.createRuntimeContext(f.root), () => preparation.packetIsFresh(packet, f.root));
  }
  await install(pkg!);
  invoke(pkg!, "psx_m2c", { functionName: name, alternative: true });
  const directory = join(f.root, "build/preparation", name);
  const packetPaths = readdirSync(directory).filter(p => !p.endsWith(".json")).flatMap(p => {
    try { return [join(directory, p, "packet.json")].filter(p => readFileSync(p).length); } catch { return []; }
  });
  assert.equal(packetPaths.length, 1);
  const packetBytes = readFileSync(packetPaths[0]!), packet = JSON.parse(packetBytes.toString());
  assert.equal(packet.compilation.status, "succeeded", packet.compilation.diagnostics);
  assert.equal(await fresh(pkg!, packet), true);
  invoke(pkg!, "psx_residual_objective", { functionName: name, json: true });
  const history = join(f.root, "build/experimentLedger", name + ".jsonl"), oldHistory = readFileSync(history);
  const rows = oldHistory.toString().trim().split("\n").map(line => JSON.parse(line));
  assert.ok(rows[0].comparisonDomain);
  await install(updated);
  // Pi owns the declaration; remove only the previous test installation, so a
  // duplicate registration is an error rather than silently choosing a donor.
  execFileSync(process.execPath, [resolve(dirname(host!), "cli.js"), "remove", "--local", "--approve", pkg!], { cwd: f.root, stdio: "pipe" });
  assert.equal(await fresh(updated, packet), true);
  invoke(updated, "psx_residual_objective", { functionName: name, json: true });
  assert.deepEqual(readFileSync(history), oldHistory, "equal source/output must not become a new experiment after relocation/update");
  assert.deepEqual(readFileSync(packetPaths[0]!), packetBytes, "existing preparation evidence is unchanged");
  const runtime = await import(pathToFileURL(join(updated, "tools/lib/runtimeContext.ts")).href);
  const ledger = await import(pathToFileURL(join(updated, "tools/agent/experimentLedger.ts")).href);
  const identity = await import(pathToFileURL(join(updated, "tools/lib/cacheIdentity.ts")).href);
  runtime.inRuntimeContext(runtime.createRuntimeContext(f.root), () => {
    assert.ok(ledger.priorMeasurement(name, source, rows[0].outputHash, rows[0].comparisonDomain).sameOutput);
    const legacy = { ...rows[0] }; delete legacy.comparisonDomain;
    assert.equal(ledger.comparisonIndex([legacy], rows[0].comparisonDomain).undetermined.length, 1);
    assert.match(ledger.renderLedger(name, [legacy]), /compatibility is undetermined/);
    assert.equal(identity.compatibleDomains(rows[0].comparisonDomain, { ...rows[0].comparisonDomain, interpretation: "different-schema" }), false);
  });
  const change = async (path: string, bytes: string | Buffer) => {
    const previous = readFileSync(join(f.root, path)); writeFileSync(join(f.root, path), bytes);
    try { assert.equal(await fresh(updated, packet), false, path); }
    finally { writeFileSync(join(f.root, path), previous); }
    assert.equal(await fresh(updated, packet), true);
  };
  await change(originalPath, Buffer.alloc(readFileSync(join(f.root, originalPath)).length));
  await change("include/common.h", readFileSync(join(f.root, "include/common.h"), "utf8") + "\n/* changed consumed header */\n");
  f.put("configs/flag_overrides.mk", "# unrelated TU\nCC1FLAGS_unrelated := -O1\n");
  assert.equal(await fresh(updated, packet), true, "unrelated overrides do not invalidate this TU");
  await change("configs/flag_overrides.mk", `# relevant TU\nCC1FLAGS_${overrideStem} := -O1\n`);
  const tc = JSON.parse(readFileSync(join(f.root, "toolchain.json"), "utf8"));
  const compiler = tc.tools.cc1; f.put("build/test-cc1", readFileSync(compiler)); tc.tools.cc1 = join(f.root, "build/test-cc1");
  f.put("toolchain.json", JSON.stringify(tc));
  assert.equal(await fresh(updated, packet), true, "same compiler bytes at another path are compatible");
  await change("build/test-cc1", "changed compiler bytes");
  const compilationBefore = runtime.inRuntimeContext(runtime.createRuntimeContext(f.root), () => identity.stableHash(identity.compilationIdentity(f.root, { kind, id: kind === "exe" ? "exe" : overrideStem }, overrideStem)));
  const contractFile = join(updated, "tools/lib/cacheIdentity.ts");
  writeFileSync(contractFile, readFileSync(contractFile, "utf8").replace('preparation: "preparation-v2"', 'preparation: "preparation-v3-test"'));
  // A new process observes the changed producing component, not an ESM cache.
  const probe = join(f.root, "build/upgrade-probe.ts");
  writeFileSync(probe, `import {createRuntimeContext,inRuntimeContext} from ${JSON.stringify(join(updated, "tools/lib/runtimeContext.ts"))};\nimport {packetIsFresh} from ${JSON.stringify(join(updated, "tools/agent/prepareFunction.ts"))};\nimport {stableHash,compilationIdentity} from ${JSON.stringify(contractFile)};\ninRuntimeContext(createRuntimeContext(${JSON.stringify(f.root)}),()=>console.log(JSON.stringify({fresh:packetIsFresh(${JSON.stringify(packet)},${JSON.stringify(f.root)}),compilation:stableHash(compilationIdentity(${JSON.stringify(f.root)},${JSON.stringify({kind, id: kind === "exe" ? "exe" : overrideStem})},${JSON.stringify(overrideStem)}))})));\n`);
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", probe], { cwd: HARNESS_ROOT, encoding: "utf8" }));
  assert.equal(result.fresh, false); assert.equal(result.compilation, compilationBefore);
  assert.deepEqual(readFileSync(history), oldHistory);
});
