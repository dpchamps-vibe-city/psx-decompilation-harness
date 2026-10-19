import { strict as assert } from "node:assert";
import { test } from "../testing/runtimeTestContext.js";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyScaffold, PACKAGE_ROOT, planScaffold, provisionScaffoldVendors, vendorSources } from "./scaffoldProject.js";

function fixture(t: { after(fn: () => void): void }, populated = true) {
  const base = mkdtempSync(join(tmpdir(), "psx-scaffold-test-")), harness = join(base, "installed package"), root = join(base, "consumer repo");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (dir: string, path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  cpSync(join(PACKAGE_ROOT, "templates"), join(harness, "templates"), { recursive: true });
  for (const path of ["include/include_asm.h", "include/macro.inc", "include/labels.inc", "include/gte_macros.inc", "include/debughook.h", "include/scratchpad.h"])
    put(harness, path, readFileSync(join(PACKAGE_ROOT, path), "utf8"));
  put(harness, "package.json", '{"dependencies":{"tsx":"^4"},"devDependencies":{"@earendil-works/pi-coding-agent":"0.83.0"}}');
  for (const path of ["tools/probe.ts", ".pi/extensions/probe.ts", ".pi/skills/probe/SKILL.md", "prompts/reference/probe.md", "lib/bundled.o", "tools/vendor/psyq47/LIB/test.LIB", "include/psyq/libgpu.h"])
    put(harness, path, "must remain package-owned\n");
  if (populated) for (const spec of vendorSources(harness)) for (const path of spec.required) put(harness, `tools/vendor/${spec.name}/${path}`, "public source fixture\n");
  return { base, harness, root, put };
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

test("bootstrap only authors project files; settings, instructions, npm dependencies and original inputs remain byte-identical", async t => {
  const { harness, root, put } = fixture(t);
  const originals = { ".pi/settings.json": '{"packages":["reviewed-package"]}\n', "AGENTS.md": "user-owned sentinel\n", "package.json": '{"scripts":{"identify":"my-task"},"dependencies":{"mine":"*"}}\n', "lib/member.o": "authoritative object", "lib/library.a": "authoritative archive", "library-input/original.a": "supplied original", "extracted/game": "supplied game", "configs/flag_overrides.mk": "# user evidence\nCC1FLAGS_existing := -O1\n" };
  for (const [path, text] of Object.entries(originals)) put(root, path, text);
  const plan = planScaffold(root, "exe", harness);
  assert.deepEqual(await provisionScaffoldVendors(plan, { packageRoot: harness }), []);
  const report = await applyScaffold(plan);
  for (const [path, text] of Object.entries(originals)) assert.equal(read(root, path), text, path);
  for (const path of ["tools/probe.ts", ".pi/extensions", ".pi/skills", "prompts", "templates", "docs", ".pi/psx-scaffold.json", "lib/bundled.o", "include/psyq", "tools/vendor"])
    assert.equal(existsSync(join(root, path)), false, path);
  assert.ok(existsSync(join(root, "tools/resource-parsers/parser-plugins.ts")));
  assert.equal(JSON.parse(read(root, "toolchain.json")).sdk.originalDir, "library-input/psyq/LIB");
  assert.ok(report.preserved.includes("configs/flag_overrides.mk"));
  const before = read(root, ".gitignore");
  const repeated = await applyScaffold(planScaffold(root, "exe", harness));
  assert.deepEqual(repeated.created, []); assert.deepEqual(repeated.updated, []); assert.equal(read(root, ".gitignore"), before);
  execFileSync("git", ["init", "--quiet", root]);
  for (const path of ["lib/member.o", "lib/library.a"]) assert.equal(spawnSync("git", ["check-ignore", "--no-index", path], { cwd: root }).status, 1, path);
  for (const path of ["build/object.o", "library-input/original.a", "extracted/game", ".pi/git/package/data", ".pi/npm/package/data"])
    assert.equal(spawnSync("git", ["check-ignore", "--no-index", path], { cwd: root }).status, 0, path);
});

test("fresh EXE and library scaffolds require no consumer package or duplicated Pi/runtime dependency", async t => {
  for (const mode of ["exe", "library"] as const) {
    const { harness, root } = fixture(t);
    await applyScaffold(planScaffold(root, mode, harness));
    assert.equal(existsSync(join(root, "package.json")), false);
    assert.equal(existsSync(join(root, "AGENTS.md")), false);
    const project = JSON.parse(read(root, "project.json"));
    assert.equal(project.target.kind, mode === "exe" ? "linked-image" : "relocatable-library");
    if (mode === "library") {
      assert.deepEqual(project.target.archives, ["library-input/**/*.a"]);
      assert.deepEqual(project.target.standaloneObjects, []);
      assert.deepEqual(project.headers.reference, ["library-input/psyq/INCLUDE"]);
    }
    assert.deepEqual(readdirSync(join(root, "lib")), []);
    assert.deepEqual(readdirSync(join(root, "library-input/psyq/INCLUDE")), []);
    assert.match(read(root, "configs/flag_overrides.mk"), /^# Per-file cc1 overrides/);
    assert.match(read(root, "tools/resource-parsers/parser-plugins.ts"), /export const EXTRA_PARSERS = \[\];/);
  }
});

test("a project whose toolchain selects the ECOFF period assembler gets the period include templates", async t => {
  const { harness, root, put } = fixture(t);
  put(root, "toolchain.json", JSON.stringify({ assembler: { objectFormat: "ecoff" } }) + "\n");
  await applyScaffold(planScaffold(root, "library", harness));
  for (const path of ["include/include_asm.h", "include/macro.inc"])
    assert.equal(read(root, path), readFileSync(join(harness, "templates/period", path), "utf8"), path);
  assert.match(read(root, "include/macro.inc"), /^\.macro glabel label$/m, "positional macros for the period assembler");
});

test("dry runs do not write; project plugin/configuration files are preserved rather than upgraded", async t => {
  const { harness, root, put } = fixture(t);
  await applyScaffold(planScaffold(root, "exe", harness), true);
  assert.equal(existsSync(root), false);
  put(root, "tools/resource-parsers/parser-plugins.ts", "export default [myPlugin];\n");
  put(root, "toolchain.json", '{"user":"custom configuration"}\n');
  await applyScaffold(planScaffold(root, "exe", harness));
  assert.equal(read(root, "toolchain.json"), '{"user":"custom configuration"}\n');
  assert.equal(read(root, "tools/resource-parsers/parser-plugins.ts"), "export default [myPlugin];\n");
});

test("reject symlink escape, malformed managed ignores, mode changes and preflight races", async t => {
  const { harness, root, put, base } = fixture(t);
  const outside = join(base, "outside"); mkdirSync(outside); mkdirSync(root);
  symlinkSync(outside, join(root, "include"));
  assert.throws(() => planScaffold(root, "exe", harness), /refuses symlink/);
  assert.deepEqual(readdirSync(outside), []); unlinkSync(join(root, "include"));
  put(root, ".gitignore", "# BEGIN PSX harness\n");
  assert.throws(() => planScaffold(root, "exe", harness), /Malformed/);
  put(root, ".gitignore", "old ignore\n");
  const plan = planScaffold(root, "exe", harness); put(root, ".gitignore", "concurrent edit\n");
  await assert.rejects(applyScaffold(plan), /changed after preflight/);
  assert.equal(existsSync(join(root, "include")), false);
  await applyScaffold(planScaffold(root, "library", harness));
  assert.throws(() => planScaffold(root, "exe", harness), /mode conflicts/);
});

test("pinned public sources are prepared in disposable dependency caches, never copied tools or proprietary SDKs", async t => {
  const { harness, root, put } = fixture(t, false), specs = vendorSources(harness), calls: string[] = [];
  const plan = planScaffold(root, "exe", harness);
  const downloaded = await provisionScaffoldVendors(plan, { packageRoot: harness, download: async (spec, destination) => {
    assert.equal(existsSync(root), false); calls.push(spec.name);
    for (const path of spec.required) put(destination, path, "fetched fixture\n");
    put(destination, ".git/config", "temporary metadata\n");
  } });
  assert.deepEqual(downloaded, specs.map(s => s.name)); assert.deepEqual(calls, downloaded);
  await applyScaffold(plan);
  for (const spec of specs) {
    assert.equal(read(root, `build/dependencies/${spec.name}/${spec.revision}/${spec.required[0]}`), "fetched fixture\n");
    assert.equal(existsSync(join(root, "build/dependencies", spec.name, spec.revision, ".git")), false);
  }
  assert.equal(existsSync(join(root, "tools/vendor")), false);
  assert.deepEqual(await provisionScaffoldVendors(planScaffold(root, "exe", harness), { packageRoot: harness, download: async () => { throw new Error("must not refetch"); } }), []);
});

test("failed downloads and dry-run dependency checks never mutate project or package", async t => {
  const { harness, root } = fixture(t, false);
  await assert.rejects(provisionScaffoldVendors(planScaffold(root, "exe", harness), { packageRoot: harness, download: async () => { throw new Error("offline"); } }), /Check Git\/network access/);
  assert.equal(existsSync(root), false);
  assert.equal((await provisionScaffoldVendors(planScaffold(root, "exe", harness), { packageRoot: harness, dryRun: true, download: async () => { throw new Error("must not run"); } })).length, 4);
  assert.equal(existsSync(root), false);
});
