import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkBatch, settled } from "./controller-pool.js";
import type { WorkerHandle, WorkerResult } from "./subagents.js";

function worker() {
  let finish!: (result: WorkerResult) => void;
  const handle: WorkerHandle = { update: {}, done: new Promise(resolve => { finish = resolve; }),
    cancel() { complete("cancelled"); }, steer: async message => message };
  const complete = (status = "completed") => { handle.result = { status }; finish(handle.result); };
  return { handle, complete };
}
function fixture() {
  const handles: ReturnType<typeof worker>[] = [], launched: string[] = [];
  const queue = ["replacement", "unused"];
  const batch = new WorkBatch(async (slot, functionName) => {
    const w = worker(); handles.push(w); launched.push(functionName);
    return { slot, functionName, cwd: `/private/${functionName}`, initialTree: "tree", handle: w.handle };
  }, async () => queue.shift());
  return { batch, handles, launched };
}

test("one main-loop turn fans out N single-function workers; settlement never pulls or retries another function", async () => {
  const f = fixture();
  await f.batch.add("a"); await f.batch.add("b"); await f.batch.add("c");
  assert.deepEqual(f.launched, ["a", "b", "c"]);
  assert.ok(f.handles.every(w => !w.handle.result));
  f.handles.forEach(w => w.complete());
  await f.batch.finish(() => false);
  assert.deepEqual(f.launched, ["a", "b", "c"], "no independent worker loop or rolling queue");
  assert.equal(f.batch.snapshot().filter(job => job.status === "completed").length, 3);
});

test("the main controller can suggest, stop and reroute an exact slot within its work turn", async () => {
  const f = fixture();
  await f.batch.add("a"); await f.batch.add("b");
  assert.equal(await f.batch.control("steer", 0, "check callee truth"), "check callee truth");
  await f.batch.control("stop", 0);
  assert.equal(f.batch.jobs[0]!.stopped, true);
  await f.batch.control("reroute", 1);
  assert.equal(f.handles[1]!.handle.result?.status, "cancelled");
  assert.equal(f.batch.jobs[1]!.functionName, "replacement");
  assert.deepEqual(f.launched, ["a", "b", "replacement"]);
  await f.batch.close();
  assert.ok(f.handles.every(w => w.handle.result));
});

test("a failed worker is returned to the ordinary main-loop owner, never independently escalated or parked", async () => {
  const f = fixture();
  await f.batch.add("a");
  f.handles[0]!.complete("failed");
  await f.batch.finish(() => false);
  assert.deepEqual(f.launched, ["a"]);
  assert.equal(f.batch.jobs[0]!.handle.result?.status, "failed");
});

test("takeover accepts an unfinished candidate without promoting it; integrate verifies it while siblings keep running", async () => {
  const handles: ReturnType<typeof worker>[] = [];
  let integrations = 0;
  const batch = new WorkBatch(async (slot, functionName) => {
    const w = worker(); handles.push(w);
    return { slot, functionName, cwd: "/project", handle: w.handle,
      draft: { source: { path: `src/${functionName}.c`, text: "stub" }, candidate: `/project/build/${functionName}.c`, headerPatch: "/project/build/headers.patch" } };
  }, async () => undefined, async job => {
    integrations++;
    assert.ok(job.handle.result, "the owning worker must settle before main takes over its candidate");
    assert.equal(handles[1]!.handle.result, undefined, "other workers continue while main integrates");
    return { integrated: true, feedback: "existing finalization passed" };
  });
  await batch.add("partial"); await batch.add("sibling");
  const handoff = await batch.control("takeover", 0) as any;
  assert.equal(handoff.takenOver, true);
  assert.equal(handoff.candidate, "/project/build/partial.c");
  assert.equal(handles[0]!.handle.result?.status, "cancelled");
  assert.equal(handles[1]!.handle.result, undefined);
  assert.equal(integrations, 0, "unfinished takeover stays under build until the orchestrator requests integration");
  const result = await batch.control("integrate", 0) as any;
  assert.equal(result.integrated, true);
  assert.equal(integrations, 1);
  assert.equal(batch.snapshot()[0]!.status, "integrated");
  await batch.close();
});

test("user abort cancels and awaits all workers without selecting more work", async () => {
  const f = fixture();
  await f.batch.add("a"); await f.batch.add("b");
  await f.batch.finish(() => true);
  assert.deepEqual(f.launched, ["a", "b"]);
  assert.ok(f.handles.every(w => w.handle.result?.status === "cancelled"));
});

test("a cancellation request does not release an unsettled child", async () => {
  const w = worker();
  w.handle.cancel = () => {};
  w.handle.cancel();
  await assert.rejects(settled(w.handle, 1), /active.json lock must be retained/);
  assert.equal(w.handle.result, undefined);
  w.complete("cancelled");
  await settled(w.handle, 1);
});
