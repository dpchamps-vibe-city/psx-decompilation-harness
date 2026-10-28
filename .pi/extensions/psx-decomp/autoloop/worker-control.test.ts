import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CONTROL_MARKER, createWorkerControl } from "./worker-control.js";
import { HARNESS_ROOT } from "../../../../tools/lib/runtimeContext.js";

/* A REAL Pi SDK child, native extension hooks and native steering queue. Only
 * the model stream is synthetic: no provider/network call or mocked RPC route. */
test("foreground guidance reaches the exact child's next model context and is acknowledged only then", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "psx-native-steering-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fixture", { api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "worker", name: "Worker", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [join(HARNESS_ROOT, ".pi/extensions/psx-decomp/worker.ts")] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  let started!: () => void, release!: () => void;
  const toolStarted = new Promise<void>(done => { started = done; });
  const toolRelease = new Promise<void>(done => { release = done; });
  const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime: runtime,
    model: new ModelRegistry(runtime).find("fixture", "worker")!, settingsManager, sessionManager: SessionManager.inMemory(cwd),
    tools: ["pause"], customTools: [{ name: "pause", label: "Pause", description: "Wait for the test's release", parameters: Type.Object({}),
      execute: async () => { started(); await toolRelease; return { content: [{ type: "text", text: "released" }], details: {} }; } }] });
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => { errors.push(String(error)); } });
  const child = createWorkerControl(cwd, 0), otherChild = createWorkerControl(cwd, 0);
  const contexts: string[] = [];
  let calls = 0;
  session.agent.streamFunction = (_model, context) => {
    contexts.push(JSON.stringify(context));
    const first = calls++ === 0;
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "worker", timestamp: Date.now(),
      content: first ? [{ type: "toolCall", id: "pause-1", name: "pause", arguments: {} }] : [{ type: "text", text: "done" }],
      stopReason: first ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(message); });
    return stream;
  };
  let prompt: Promise<unknown> | undefined;
  try {
    const early = await child.steer("START_WITH_TYPED_DECLARATIONS");
    assert.equal(early.deliveryStatus, "queued");
    prompt = session.prompt(`Work on the assigned build candidate.\n${CONTROL_MARKER}${child.token}\n`);
    await Promise.race([toolStarted, prompt.then(() => { throw new Error("Worker ended before its pause tool: " + session.getLastAssistantText()); })]);
    const receipt = await child.steer("CHECK_THE_CALLEE_SIGNATURE");
    assert.equal(receipt.deliveryStatus, "queued", "an active tool has not yet delivered guidance to model context");
    await otherChild.steer("DO_NOT_DELIVER_TO_THIS_CHILD");
    assert.equal(contexts.length, 1);
    assert.ok(!contexts[0]!.includes("CHECK_THE_CALLEE_SIGNATURE"));
    assert.ok(contexts[0]!.includes("START_WITH_TYPED_DECLARATIONS"), "startup guidance reaches the first real request");
    release();
    await prompt;
    assert.equal(contexts.length, 2, "same child continues, without a replacement workflow or new session");
    assert.ok(contexts[1]!.includes("CHECK_THE_CALLEE_SIGNATURE"), "the real model request contains supervisor guidance");
    assert.ok(!contexts[1]!.includes("DO_NOT_DELIVER_TO_THIS_CHILD"), "sibling ownership is exact");
    assert.equal(child.receipts().find(row => row.requestId === early.requestId)!.deliveryStatus, "delivered");
    assert.equal(child.receipts().find(row => row.requestId === receipt.requestId)!.deliveryStatus, "delivered");
    assert.equal(otherChild.receipts()[0]!.deliveryStatus, "queued");
    assert.deepEqual(errors, []);
  } finally {
    release(); await session.abort(); await prompt?.catch(() => {});
    child.close(); otherChild.close(); session.dispose();
  }
});

test("guidance queued before child startup is retained; closing the owned attempt fails it explicitly", async () => {
  const control = createWorkerControl("/not-started-yet", 0);
  const receipt = await control.steer("Keep the current function and check declarations");
  assert.equal(receipt.deliveryStatus, "queued");
  control.close("cancelled before worker startup");
  assert.equal(control.receipts()[0]!.deliveryStatus, "failed");
  assert.match(control.receipts()[0]!.error!, /cancelled before worker startup/);
  await assert.rejects(control.steer("late guidance"), /already settled/);
});
