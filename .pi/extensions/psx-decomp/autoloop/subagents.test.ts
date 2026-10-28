import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATION, startWorker, subagentRpc, workerAgent } from "./subagents.ts";

function bus() {
  const events = new EventEmitter();
  const pi = { events: { emit: (name: string, data: unknown) => { events.emit(name, data); },
    on: (name: string, callback: (...args: any[]) => void) => { events.on(name, callback); return () => events.off(name, callback); } } } as unknown as ExtensionAPI;
  return { events, pi };
}
const model = { provider: "provider", model: "path/model", thinking: "high" as const, label: "worker" };

test("delegation binds the exact owned tuple, cwd and model; cancellation waits for a terminal reply", async () => {
  const { pi, events } = bus();
  let request: any, cancel: any;
  events.on(DELEGATION + "request", data => { request = data; });
  events.on(DELEGATION + "cancel", data => { cancel = data; });
  const handle = startWorker(pi, { ownerRunId: "controller", nodeId: "slot-1", agent: "psx-worker", task: "match f", cwd: "/private/worktree", model, timeoutMs: 5000 });
  assert.equal(request.model, "provider/path/model");
  assert.equal(request.thinking, "high");
  assert.equal(request.context, "fresh");
  assert.equal(request.cwd, "/private/worktree");
  assert.equal(request.toolBudget, undefined, "writers have no hard tool budget");
  events.emit(DELEGATION + "update", { ...request, ownerRunId: "unrelated", runId: "wrong" });
  assert.equal(handle.update.runId, undefined);
  events.emit(DELEGATION + "update", { ...request, runId: "run-1", recentOutput: "x".repeat(8000) });
  assert.equal(handle.update.runId, "run-1");
  assert.equal(handle.update.recentOutput!.length, 3000);
  handle.cancel();
  assert.equal(cancel.requestId, request.requestId);
  assert.equal(cancel.ownerRunId, request.ownerRunId);
  assert.equal(handle.result, undefined, "a cancel request is not terminal proof");
  events.emit(DELEGATION + "response", { ...request, nodeId: "somebody-else", status: "cancelled" });
  assert.equal(handle.result, undefined);
  events.emit(DELEGATION + "response", { ...request, status: "cancelled" });
  assert.equal((await handle.done).status, "cancelled");
  assert.equal(events.listenerCount(DELEGATION + "update"), 0);
  assert.equal(events.listenerCount(DELEGATION + "response"), 0);
});

test("RPC uses a correlated receipt and cleans up timeout listeners", async () => {
  const { pi, events } = bus();
  await assert.rejects(subagentRpc(pi, "ping", {}, 1), /install.*pi-subagents/);
  assert.deepEqual(events.eventNames(), []);
  events.on("subagents:rpc:v1:request", request => {
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: "wrong", success: true });
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { delivered: true } });
  });
  assert.deepEqual(await subagentRpc(pi, "steer", { id: "run-1", message: "audit declarations" }), { delivered: true });
  assert.equal(events.eventNames().length, 1);
});

test("runtime registration explicitly loads the worker tools and prevents nested delegation", async () => {
  const { pi, events } = bus();
  let definition: any, disposed = false;
  events.on("subagents:rpc:v1:request", request => events.emit(`subagents:rpc:v1:reply:${request.requestId}`,
    { version: 1, requestId: request.requestId, success: true, data: {} }));
  events.on("pi-subagents:runtime-agent-register:v1", request => {
    definition = request.definition;
    request.result = { ok: true, registration: { dispose() { disposed = true; } } };
  });
  const registered = await workerAgent(pi, "/package/worker.ts");
  assert.deepEqual(definition.extensions, ["/package/worker.ts"]);
  assert.equal(definition.allowNestedSubagents, false);
  assert.equal(definition.inheritProjectContext, true);
  assert.ok(definition.excludeTools.includes("psx_park_function"));
  registered.dispose();
  assert.equal(disposed, true);
});
