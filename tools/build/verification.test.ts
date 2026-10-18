import { test, fixtureContext } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFixture } from "../testing/projectFixture.js";
import { verifyBuiltContainers, verifyContainer } from "./pipeline.js";
import { registerVerifyBuildTool } from "../../.pi/extensions/psx-decomp/tools/verify-build.js";
import { projectAPI } from "../../.pi/extensions/shared/project-context.js";
import { runBuildCheck } from "../../.pi/extensions/shared/gates.js";
import { installedCommandFixture } from "../testing/commandFixture.js";

function fixture(t: any) {
  const f = projectFixture(t); const containers = f.containers();
  for (const c of containers) {
    f.put(c.paths.builtElf, "synthetic successful link marker");
    f.put(c.paths.builtBin, readFileSync(join(f.root, c.targetPath)));
  }
  const events: string[] = [];
  const actions = { verify: (c: any, root = f.root) => { verifyContainer(c, root); events.push(`verify:${c.id}`); },
    profile: () => { events.push("profile"); f.put("configs/project-profile.md", "fresh profile\n"); },
    rodata: (args: string[]) => { events.push(`rodata:${args.join(" ")}`); } };
  return { ...f, containers, events, actions };
}
test("executable check refreshes profile only after bytes pass, then checks its rodata", t => {
  const f = fixture(t), exe = f.containers[0]!;
  verifyBuiltContainers([exe], false, f.root, f.actions);
  assert.deepEqual(f.events, ["verify:exe", "profile", "rodata:--container exe"]);
  assert.equal(readFileSync(join(f.root, "configs/project-profile.md"), "utf8"), "fresh profile\n");
});
test("check-all skips every per-container verification rodata check and runs --all once", t => {
  const f = fixture(t); verifyBuiltContainers(f.containers, true, f.root, f.actions);
  assert.deepEqual(f.events, ["verify:exe", "profile", "verify:ovl_fixture", "rodata:--all"]);
});
for (const failure of ["mismatch", "sdk-data", "header", "trailing", "truncated", "missing-bin", "failed-link"] as const) test(`${failure} cannot refresh the executable profile or proceed to overlays`, t => {
  const f = fixture(t), exe = f.containers[0]!;
  f.put("configs/project-profile.md", "previous profile\n");
  if (failure === "failed-link") rmSync(join(f.root, exe.paths.builtElf));
  else if (failure === "missing-bin") rmSync(join(f.root, exe.paths.builtBin));
  else if (failure === "truncated") f.put(exe.paths.builtBin, Buffer.alloc(exe.payloadOffset));
  else if (failure === "trailing") f.put(exe.paths.builtBin, Buffer.concat([readFileSync(join(f.root, exe.targetPath)), Buffer.from([0])]));
  else if (failure === "header") { const bytes = readFileSync(join(f.root, exe.targetPath)); bytes[0x14] = 1; f.put(exe.paths.builtBin, bytes); }
  else if (failure === "sdk-data") { const bytes = readFileSync(join(f.root, exe.targetPath)); bytes[bytes.length - 4] = bytes[bytes.length - 4]! ^ 1; f.put(exe.paths.builtBin, bytes); }
  else { const bytes = readFileSync(join(f.root, exe.targetPath)); bytes[exe.payloadOffset] = bytes[exe.payloadOffset]! ^ 1; f.put(exe.paths.builtBin, bytes); }
  assert.throws(() => verifyBuiltContainers(f.containers, true, f.root, f.actions));
  assert.deepEqual(f.events, []);
  assert.equal(readFileSync(join(f.root, "configs/project-profile.md"), "utf8"), "previous profile\n");
});
test("a failed overlay comparison retains successful EXE profile refresh but prevents final --all", t => {
  const f = fixture(t), overlay = f.containers[1]!;
  f.put(overlay.paths.builtBin, Buffer.alloc(1));
  assert.throws(() => verifyBuiltContainers(f.containers, true, f.root, f.actions), /MISMATCH/);
  assert.deepEqual(f.events, ["verify:exe", "profile"]);
});
test("profile-generation failure prevents subsequent verification operations", t => {
  const f = fixture(t);
  assert.throws(() => verifyBuiltContainers(f.containers, true, f.root, { ...f.actions, profile: () => { throw new Error("profile failed"); } }), /profile failed/);
  assert.deepEqual(f.events, ["verify:exe"]);
});
test("provided executable verification dispatches check-exe with exactly a 120 s limit and propagates failures", async t => {
  const f = fixture(t); let definition: any; const calls: any[] = []; let code = 0;
  registerVerifyBuildTool(projectAPI({ registerTool: (tool: any) => { definition = tool; }, exec: async (...args: any[]) => { calls.push(args); return { code, stdout: "byte check", stderr: "", killed: false }; } } as any));
  const invoke = () => definition.execute("fixture", {}, new AbortController().signal, undefined, { cwd: f.root });
  await invoke();
  const [command, args, options] = calls[0]!;
  assert.equal(command, process.execPath); assert.ok(args.some((a: string) => a.endsWith("tools/build/pipeline.ts")));
  assert.deepEqual(args.slice(-3), ["--project", f.root, "check-exe"]);
  assert.equal(options.cwd, f.root); assert.equal(options.timeout, 120_000);
  code = 7; await assert.rejects(invoke(), /exit code 7/);
});
test("finalization build helper checks all containers and times out at exactly 300 s", async t => {
  const f = fixture(t);
  installedCommandFixture(t, f.root, { "tools/build/pipeline.ts": "setInterval(() => {}, 1000);\n" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const task = runBuildCheck(f.root).then(result => { settled = true; return result; });
  t.mock.timers.tick(299_999); assert.equal(settled, false);
  t.mock.timers.tick(1); const result = await task;
  assert.equal(result.timedOut, true); assert.equal(result.code, 1);
  assert.match(result.command, /pipeline\.ts.*--project.*check-all$/);
});
