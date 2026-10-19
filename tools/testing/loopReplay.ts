/**
 * loopReplay.ts — drive the real autoloop with a scripted agent, to measure the
 * harness's own time between solved functions (plans/optimization/00-measurement.md §0.6).
 *
 * The loop, its oracles, commits and folds are production code. Only Pi is
 * faked: the scripted agent answers an opening prompt for a target named in the
 * manifest by writing that target's recorded source and calling the real
 * psx_finalize_function tool, and answers any other prompt by ending its turn.
 * A target the manifest does not name stops the replay. There is no model, so
 * the event log measures harness time only.
 *
 * Usage (against a disposable bench copy only):
 *   node --import tsx tools/testing/loopReplay.ts --project <dir> --manifest <file> \
 *     --events <out.jsonl> [--max N]
 * Not through scriptHost: like the loop command, the replay runs in a runtime
 * context with no invocation-wide content memo or library metadata scope.
 * Manifest: { "matches": { "<target>": { "files": { "<project-relative path>": "<text>" } } } }
 * Targets and sources come from the manifest supplied with the run, never from
 * harness code. The project must carry a `.psx-bench-disposable` marker (in it
 * or its parent): the replay commits to that repository.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withContentMemo } from "../lib/contentCache.js";
import { cliRuntimeContext, createRuntimeContext, inRuntimeContext } from "../lib/runtimeContext.js";
import { runLoop, type LoopDeps } from "../../.pi/extensions/psx-decomp/autoloop/loop.ts";
import { loadLoopConfig } from "../../.pi/extensions/psx-decomp/autoloop/config.ts";
import { createTurnGate } from "../../.pi/extensions/psx-decomp/autoloop/turn-gate.ts";
import { createVerdictSink } from "../../.pi/extensions/psx-decomp/autoloop/policy-verdict.ts";
import { createHandoffSink } from "../../.pi/extensions/psx-decomp/autoloop/handoff.ts";
import { registerFinalizeFunctionTool } from "../../.pi/extensions/psx-decomp/tools/finalize-function.ts";
import { getSessionBaseline } from "../../.pi/extensions/psx-decomp/tools/session-baseline.ts";
import { prefetchLibraryGraph } from "../../.pi/extensions/psx-decomp/autoloop/oracles.ts";

const { context, args: argv } = cliRuntimeContext(process.argv.slice(2), process.cwd());
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const root = context.projectRoot;
if (![root, dirname(root)].some(dir => existsSync(join(dir, ".psx-bench-disposable"))))
  throw new Error(`Refusing to replay into ${root}: no .psx-bench-disposable marker (the replay commits)`);
const manifest = JSON.parse(readFileSync(option("--manifest") ?? "", "utf8")) as { matches: Record<string, { files: Record<string, string> }> };
const eventsPath = option("--events") ?? join(root, "build/loop-replay-events.jsonl");
mkdirSync(dirname(eventsPath), { recursive: true });
writeFileSync(eventsPath, "");
const started = performance.now();
const event = (kind: string, detail: Record<string, unknown> = {}) =>
  appendFileSync(eventsPath, JSON.stringify({ t: Math.round(performance.now() - started), kind, ...detail }) + "\n");

/* Pi, reduced to what the loop and the finalize tool touch. */
const gate = createTurnGate();
let busy = false, idleWaiters: Array<() => void> = [];
const settle = () => { gate.settled += 1; busy = false; for (const wake of idleWaiters.splice(0)) wake(); };
const model = { provider: "replay", id: "scripted-agent" };
let finalizeTool: { execute: (...args: any[]) => Promise<any> } | undefined;
const ui = {
  notify: (message: string, level: string) => event("notify", { level, message: message.slice(0, 300) }),
  setStatus: (_key: string, text: string | undefined) => event("status", { text }),
  theme: { fg: (_color: string, text: string) => text },
  setEditorText: () => {},
};
const ctx: any = {
  cwd: root, model, ui, isIdle: () => !busy,
  waitForIdle: () => busy ? new Promise<void>(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
  getContextUsage: () => undefined,
  modelRegistry: { find: () => model },
  sessionManager: { getEntries: () => [], getBranch: () => [] },
  navigateTree: async () => {}, abort: () => {},
};
const pi: any = {
  registerTool: (definition: any) => { if (definition.name === "psx_finalize_function") finalizeTool = definition; },
  setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel: () => {},
  getActiveTools: () => [], setActiveTools: () => {}, on: () => {},
  sendUserMessage: (message: string) => {
    busy = true;
    void answer(message).catch(error => { event("agent-error", { error: String(error) }); flag.aborted = true; }).finally(settle);
  },
};
/* Registered as the extension registers it while the loop is active. */
registerFinalizeFunctionTool(pi, undefined, () => prefetchLibraryGraph(root));
const flag = { aborted: false };

async function answer(message: string): Promise<void> {
  const opening = /^\/skill:psx-decompile-function Target: (\S+?)\. /.exec(message);
  const kind = opening ? "opening" : /^\/skill:([\w-]+)/.exec(message)?.[1] ?? "nudge";
  event("prompt", { prompt: kind, ...(opening ? { target: opening[1] } : {}) });
  if (!opening) return;
  const target = opening[1]!, match = manifest.matches[target];
  if (!match) { event("replay-exhausted", { target }); flag.aborted = true; return; }
  for (const [path, text] of Object.entries(match.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  event("finalize-start", { target });
  /* As Pi runs every registered tool: runtime context plus one content memo. */
  const result = await inRuntimeContext(createRuntimeContext(root), () => withContentMemo(() =>
    finalizeTool!.execute("replay", { functionName: target }, undefined, undefined, ctx)));
  event("finalize-end", { target, pass: result.details?.pass === true, timings: result.details?.timings });
}

await inRuntimeContext(context, async () => {
  const config = loadLoopConfig(root);
  const sink = { verdict: createVerdictSink(), handoff: createHandoffSink(), prep: {}, gate, checkpoint: {} } as LoopDeps["sink"];
  event("loop-start");
  const outcomes = await runLoop({ pi, ctx, projectRoot: root, config, sink, flag, baseline: await getSessionBaseline(root) },
    { ...(option("--max") ? { maxFunctions: Number(option("--max")) } : {}) });
  event("loop-end", { outcomes: outcomes.map(o => ({ kind: o.kind, functionName: o.functionName })) });
  console.log(JSON.stringify(outcomes.map(o => `${o.kind} ${o.functionName}`)));
});
