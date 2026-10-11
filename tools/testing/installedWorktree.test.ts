import { test } from "./runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { harnessFixture } from "./harnessFixture.js";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";
import { snapshot } from "../lib/contentCache.js";

const pkg = process.env.PSX_PRODUCTION_PACKAGE, host = process.env.PSX_PI_085_HOST;
test("real installed-runtime worktree splits/prepares with isolated inputs and integrates the .mk/evidence/allowlist idiom", {
  skip: !pkg || !host ? "Requires production-only package and Pi 0.85.1" : false,
}, async t => {
  const f = harnessFixture(t), name = "__start", source = "int __start(int x) { return x + 2; }\n";
  const c = await f.compile(name, source); await f.install([{ name, offset: 0, words: c.words }]);
  f.put(`src/${name}.c`, source);
  const originalYaml = readFileSync(join(f.root, "configs/splat/exe.yaml"), "utf8");
  f.put("configs/splat/exe.yaml", originalYaml.replace("options:\n", "options:\n  platform: psx\n  base_path: ../..\n  build_path: build\n  asm_path: build/asm\n  src_path: src\n  ld_script_path: build/fixture_image.ld\n  symbol_addrs_path: configs/symbols/exe.txt\n  undefined_funcs_auto_path: build/undefined_funcs_auto.txt\n  undefined_syms_auto_path: build/undefined_syms_auto.txt\n  subalign: 4\n").replace("  compiler: PSYQ", "  compiler: GCC").replace("segments:\n", "segments:\n  - {name: header, type: header, start: 0, align: 4, subalign: 4}\n").replace("  - name: code\n", "  - name: code\n    type: code\n    align: 4\n    subalign: 4\n"));
  const tc = JSON.parse(readFileSync(join(f.root, "toolchain.json"), "utf8"));
  const defaults = JSON.parse(readFileSync(join(pkg!, "templates/project/toolchain.json"), "utf8"));
  tc.tools.m2c = defaults.tools.m2c;
  tc.sdk = defaults.sdk;
  tc.includeDirs = ["include", "library-input/psyq/INCLUDE"];
  f.put("toolchain.json", JSON.stringify(tc));
  f.put("library-input/psyq/LIB/.keep", "");
  f.put("library-input/psyq/INCLUDE/stddef.h", "typedef unsigned long u_long;\n");
  f.put("library-input/psyq/INCLUDE/libetc.h", "#define getScratchAddr(x) ((u_long *)(0x1F800000 + (x) * 4))\n");
  f.put("library-input/psyq/INCLUDE/user.h", "/* supplied SDK header */\n");
  f.put("library-input/original.a", "synthetic raw input"); f.put("lib/member.o", readFileSync(c.art.object!));
  f.put("extracted/overlays/private.bin", "derived private input");
  f.put(".gitignore", "build/\nextracted/\nlibrary-input/\n");
  f.put("configs/flag_overrides.mk", "# Pre-existing unrelated evidence\nCC1FLAGS_unrelated := -O1\n");
  f.put(".pi/autoloop.json", JSON.stringify({ runtimeDir: "build/autodecomp", integration: { allowedRoots: ["src", "include", "configs/flag_overrides.mk", ".pi/autoloop.json"] }, sourcePolicy: { allowlist: {} } }));
  execFileSync(process.execPath, [resolve(dirname(host!), "cli.js"), "install", "--local", pkg!], { cwd: f.root, stdio: "pipe" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
  git("init", "--quiet");
  const invoke = (tool: string, parameters: object, cwd = f.root) => execFileSync(process.execPath,
    ["--import", "tsx", join(HARNESS_ROOT, "tools/testing/installedToolInvocation.ts"), f.root, host!, tool,
      JSON.stringify(parameters), join(pkg!, ".pi/extensions/psx-decomp/index.ts"), cwd], { cwd: HARNESS_ROOT, stdio: "pipe", timeout: 120000 });
  // The fixture's abbreviated CSV isn't disassembler/layout evidence. Start
  // this acceptance split cold so installed tooling produces both real tables.
  rmSync(join(f.root, "build/functions.csv"));
  invoke("psx_split_project", { all: true });
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic project without copied harness tools");
  assert.equal(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").some(path => path.startsWith("tools/")), false);
  const packageBefore = snapshot(pkg!, [pkg!]), inputBefore = snapshot(f.root, ["extracted", "library-input", "lib"]);
  const ws = await import(pathToFileURL(join(pkg!, ".pi/extensions/shared/workspace.ts")).href);
  const configModule = await import(pathToFileURL(join(pkg!, ".pi/extensions/shared/config.ts")).href);
  const policyModule = await import(pathToFileURL(join(pkg!, ".pi/extensions/shared/source-policy.ts")).href);
  const parentConfig = configModule.loadConfig(f.root);
  const worker = await ws.createWorkspace(f.root, parentConfig, "installed-worker", ["exe"]);
  t.after(() => existsSync(f.root) ? ws.removeWorkspace(f.root, worker.path) : undefined);
  for (const path of ["tools/agent", "tools/build", "tools/vendor", ".pi/extensions", ".pi/skills", "node_modules", "AGENTS.md"]) assert.equal(existsSync(join(worker.path, path)), false, path);
  assert.equal(lstatSync(join(worker.path, "extracted/FIXTURE.EXE")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(worker.path, "library-input/psyq/INCLUDE/user.h")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(worker.path, "lib/member.o")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(worker.path, "extracted/overlays/private.bin")).isSymbolicLink(), false);
  assert.ok(existsSync(join(worker.path, "build/fixture_image.ld")), "installed split generated the worker linker script");
  assert.ok(existsSync(join(worker.path, "build/functions.csv")));
  invoke("psx_check_configuration", {}, worker.path);
  const header = join(worker.path, "include/common.h"), headerBefore = readFileSync(header);
  try {
    writeFileSync(header, Buffer.concat([headerBefore, Buffer.from("\n/* deliberate tracked configuration drift */\n")]));
    assert.throws(() => invoke("psx_check_configuration", {}, worker.path), /Command failed/, "configuration tool must fail tracked header drift");
  } finally { writeFileSync(header, headerBefore); }
  invoke("psx_m2c", { functionName: name, alternative: true }, worker.path);
  writeFileSync(join(worker.path, "lib/member.o"), "worker-private write");
  const overrides = readFileSync(join(worker.path, "configs/flag_overrides.mk"), "utf8") + `# Synthetic compiler matrix witness for ${name}\nCC1FLAGS_${name} := -O1\n`;
  writeFileSync(join(worker.path, "configs/flag_overrides.mk"), overrides);
  const changed = ["configs/flag_overrides.mk", ".pi/autoloop.json", `src/${name}.c`];
  writeFileSync(join(worker.path, `src/${name}.c`), source + "/* worker source */\n");
  let tree = await ws.createTreeFromWorktree(f.root, worker.path, parentConfig.integration.allowedRoots);
  let patch = await ws.treePatch(f.root, worker.baselineTree, tree, parentConfig.integration.allowedRoots);
  const check = () => policyModule.checkSourcePolicy({ projectRoot: worker.path, config: configModule.loadConfig(worker.path), functionName: name, scanFunctions: [name], changedFiles: changed, patch });
  assert.equal(check().pass, false, "changed override without its allowlist fails");
  const configured = JSON.parse(readFileSync(join(worker.path, ".pi/autoloop.json"), "utf8"));
  configured.sourcePolicy.allowlist[name] = ["flag-override"];
  writeFileSync(join(worker.path, ".pi/autoloop.json"), JSON.stringify(configured));
  tree = await ws.createTreeFromWorktree(f.root, worker.path, parentConfig.integration.allowedRoots);
  patch = await ws.treePatch(f.root, worker.baselineTree, tree, parentConfig.integration.allowedRoots);
  assert.equal(check().pass, true, JSON.stringify(check()));
  const unrelated = policyModule.checkSourcePolicy({ projectRoot: worker.path, config: configModule.loadConfig(worker.path), functionName: name, scanFunctions: [name], changedFiles: [`src/${name}.c`], patch: "" });
  assert.equal(unrelated.pass, true, "pre-existing unallowlisted lines do not become repository-wide blockers");
  const patchPath = join(f.root, "build/worker-integration.patch"); writeFileSync(patchPath, patch);
  await ws.applyPatch(f.root, patchPath);
  assert.equal(readFileSync(join(f.root, "configs/flag_overrides.mk"), "utf8"), overrides);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".pi/autoloop.json"), "utf8")).sourcePolicy.allowlist[name], ["flag-override"]);
  assert.equal(readFileSync(join(f.root, `src/${name}.c`), "utf8"), source + "/* worker source */\n");
  assert.deepEqual(snapshot(f.root, ["extracted", "library-input", "lib"]), inputBefore);
  assert.deepEqual(snapshot(pkg!, [pkg!]), packageBefore);
  await ws.removeWorkspace(f.root, worker.path);
});
