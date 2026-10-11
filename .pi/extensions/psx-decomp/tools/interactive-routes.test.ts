import { installedCommandFixture } from "../../../../tools/testing/commandFixture.js";
import { seedProjectFixture } from "../../../../tools/testing/projectFixture.js";
import { test } from "../../../../tools/testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { getSessionBaseline } from "./session-baseline.ts";
import { loadLoopConfig } from "../autoloop/config.ts";
import { emptyState, readState, recordPark, statePath, withLoopExemptions, writeState } from "../autoloop/state.ts";
import { DEFAULT_CONFIG } from "../../shared/config.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check() && Date.now() < end) await delay(10);
  assert.ok(check(), "fixture reached the tested boundary");
}
function fixture(t: { after: (f: () => void | Promise<void>) => void }, names = ["f"]) {
  const root = mkdtempSync(join(tmpdir(), "interactive-routes-"));
  seedProjectFixture(root);
  for (const path of ["src", "build"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "src/f.c"), 'INCLUDE_ASM("original/f", f);\n');
  writeFileSync(join(root, "build/callGraph.json"), JSON.stringify({ functions: names.map((name) => ({ name, vram: "0x80010000", container: "exe", decompiled: false, dead: false, handwritten: false, calls: [], calledBy: [] })) }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null }>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
  const messages: string[] = [], notices: string[] = [];
  const pi = { registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendUserMessage: (text: string) => messages.push(text), getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
  extension(pi);
  const ctx = { cwd: root, signal: undefined, model: undefined, waitForIdle: async () => {}, isIdle: () => true,
    ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
  const event = async (name: string, detail: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(detail, ctx); };
  t.after(async () => { await event("session_shutdown", { reason: "quit" }); await getSessionBaseline(root); rmSync(root, { recursive: true, force: true }); });
  return { root, ctx, messages, notices, event,
    command: (name: string, args: string) => commands.get(name)!.handler(args, ctx),
    completions: (name: string, prefix = "") => commands.get(name)!.getArgumentCompletions!(prefix),
    tool: (name: string, params: any, signal = new AbortController().signal) => tools.get(name)!.execute("fixture", params, signal, undefined, ctx),
  };
}

test("actual /decompile and /fix-decomp routes cancel idle waiting, reject concurrency and never dispatch after cancel", async (t) => {
  const f = fixture(t);
  let waiting = false;
  f.ctx.waitForIdle = () => { waiting = true; return new Promise(() => {}); };
  const first = f.command("decompile", "f"); await until(() => waiting);
  await f.command("fix-decomp", "f");
  assert.ok(f.notices.some((n) => n.includes("already running")));
  await f.command("fix-decomp", "--cancel"); await first;
  assert.equal(f.messages.length, 0);
  assert.equal(existsSync(join(f.root, "build/preparation/commands")), false);
  assert.match(readFileSync(join(f.root, "src/f.c"), "utf8"), /INCLUDE_ASM/);
});

test("reload shutdown aborts and awaits installed-script preparation and its live child compiler", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t); const pidFile = join(f.root, "compiler.pid");
  installedCommandFixture(t, f.root, { "tools/agent/m2cFunc.ts": `import {spawn} from 'node:child_process';\nspawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)}],{stdio:'inherit'});\n` });
  const command = f.command("fix-decomp", "f"); await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  const running = () => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 2)[0] !== "Z"; } catch { return false; } };
  try {
    assert.ok(running()); await f.event("session_shutdown", { reason: "reload" }); await command;
    await until(() => !running()); assert.equal(f.messages.length, 0);
    await f.command("decompile", "f"); assert.equal(f.messages.length, 0, "old extension cannot dispatch after shutdown");
  } finally { if (running()) process.kill(pid, "SIGKILL"); }
});

test("a cancelled preparation does not poison the next real command; a generation error still reaches the solver handoff", async (t) => {
  const f = fixture(t); let waiting = false;
  f.ctx.waitForIdle = () => { waiting = true; return new Promise(() => {}); };
  const first = f.command("fix-decomp", "f"); await until(() => waiting);
  await f.command("decompile", "--cancel"); await first;
  f.ctx.waitForIdle = async () => {};
  installedCommandFixture(t, f.root, { "tools/agent/m2cFunc.ts": "process.stderr.write('fixture generation failure\\n');process.exitCode=7;\n" });
  await f.command("decompile", "f");
  assert.equal(f.messages.length, 1); assert.match(f.messages[0]!, /fixture generation failure/);
  assert.match(f.messages[0]!, /Preserve the current source/);
});

test("interactive parking persists to the configured state; picker, status and completions agree after reload", async (t) => {
  const first = "lib_6f830259724bafe6_0::InitHeap", next = "lib_0000000000000001_0::next_func";
  const f = fixture(t, [first, next]);
  mkdirSync(join(f.root, ".pi"), { recursive: true });
  const configText = JSON.stringify({ runtimeDir: "local-run/decomp", sourcePolicy: { allowlist: {} } });
  writeFileSync(join(f.root, ".pi/autoloop.json"), configText);
  const source = readFileSync(join(f.root, "src/f.c"), "utf8");
  await f.event("session_start");
  await f.tool("psx_park_function", { functionName: first, reason: "blocked", detail: "Original words identify a BIOS assembly veneer; implementation is in ROM, not supplied C." });
  const config = loadLoopConfig(f.root), state = readState(config);
  assert.equal(state.parked[first]?.reason, "blocked");
  assert.equal(state.parked[first]?.skipOnly, true);
  assert.ok(existsSync(join(f.root, "local-run/decomp/state.json")));
  assert.equal(existsSync(join(f.root, "run_output/autoloop/state.json")), false);
  assert.deepEqual(withLoopExemptions(DEFAULT_CONFIG, state).sourcePolicy.allowlist, {});
  assert.equal(readFileSync(join(f.root, "src/f.c"), "utf8"), source);
  assert.equal(readFileSync(join(f.root, ".pi/autoloop.json"), "utf8"), configText);
  assert.equal(existsSync(join(f.root, "notes")), false);
  assert.equal(f.messages.length, 0, "parking does not start another agent turn");
  await f.command("decomp-status", "");
  assert.ok(f.notices.some((n) => n.includes(`1 clean-C targets remain; 1 parked; next: ${next}`)));
  assert.deepEqual(f.completions("decompile")?.map((item) => item.value), [next]);
  await f.event("session_shutdown", { reason: "reload" });
  await f.event("session_start");
  installedCommandFixture(t, f.root, { "tools/agent/m2cFunc.ts": "process.stderr.write('fixture handoff\\n');process.exitCode=7;\n" });
  await f.command("decompile", "");
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0]!.startsWith(`/skill:psx-decompile-function Target: ${next}.`));
  await f.command("decompile", first);
  assert.equal(f.messages.length, 2, "explicit qualified retry remains available");
  assert.ok(f.messages[1]!.startsWith(`/skill:psx-decompile-function Target: ${first}.`));
  assert.equal(readState(config).parked[first]?.skipOnly, true, "retry does not silently remove the park");
});

test("existing autoloop parks are also skipped; an all-parked queue dispatches nothing", async (t) => {
  const f = fixture(t), config = loadLoopConfig(f.root);
  recordPark(config, emptyState(), { functionName: "f", reason: "blocked", parkedAt: new Date().toISOString(), reachedTier: "fixture", lastReport: "missing input", findings: [] });
  await f.event("session_start");
  assert.equal(f.completions("decompile"), null);
  await f.command("decompile", "");
  assert.equal(f.messages.length, 0);
  assert.ok(f.notices.includes("No decompilation target found."));
  await f.command("decomp-status", "");
  assert.ok(f.notices.some((n) => n.includes("0 clean-C targets remain; 1 parked; next: none")));
});

test("parking rejects bare library aliases, unknown/traversing names, missing evidence and cancelled writes", async (t) => {
  const key = "lib_6f830259724bafe6_0::InitHeap";
  const f = fixture(t, [key]), config = loadLoopConfig(f.root);
  const params = { functionName: key, reason: "blocked", detail: "witnessed blocker" };
  for (const functionName of ["InitHeap", "not_in_graph", "../InitHeap"]) {
    await assert.rejects(f.tool("psx_park_function", { ...params, functionName }), /Invalid function name|Unknown or ambiguous/);
  }
  await assert.rejects(f.tool("psx_park_function", { ...params, detail: "  " }), /non-empty/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tool("psx_park_function", params, controller.signal));
  assert.equal(existsSync(statePath(config)), false);
  const graphPath = join(f.root, "build/callGraph.json"), graph = JSON.parse(readFileSync(graphPath, "utf8"));
  graph.functions[0].decompiled = true; writeFileSync(graphPath, JSON.stringify(graph));
  await assert.rejects(f.tool("psx_park_function", params), /already-decompiled/);
  assert.equal(existsSync(statePath(config)), false);
});

test("parallel state-only parks merge the durable state without losing existing approvals", async (t) => {
  const f = fixture(t, ["f", "g"]), config = loadLoopConfig(f.root), state = emptyState();
  state.approvals.previous = { functionName: "previous", kinds: ["register-asm"], approvedAt: "fixture", approvedBy: "fixture", rationale: "existing record" };
  writeState(config, state);
  await Promise.all(["f", "g"].map((functionName) => f.tool("psx_park_function", { functionName, reason: "blocked", detail: "witnessed blocker" })));
  const after = readState(config);
  assert.deepEqual(Object.keys(after.parked).sort(), ["f", "g"]);
  assert.deepEqual(after.approvals, state.approvals);
});
