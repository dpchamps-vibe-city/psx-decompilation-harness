import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelSchema } from "./types.js";
import { CONTROL_MARKER, createWorkerControl, type SteeringReceipt } from "./worker-control.js";

/* Public pi-subagents 0.82.1 event contracts. No imports from package internals:
 * independently installed Pi packages do not share Node resolution roots. */
export const DELEGATION = "prompt-template:subagent:";
export interface WorkerUpdate {
  runId?: string;
  currentTool?: string;
  recentOutput?: string;
  tokens?: number;
}
export interface WorkerResult {
  status: string;
  error?: string;
  runId?: string;
  result?: { kind: string; text?: string };
}
export interface WorkerHandle {
  update: WorkerUpdate;
  result?: WorkerResult;
  done: Promise<WorkerResult>;
  readonly steering?: SteeringReceipt[];
  cancel(): void;
  steer(message: string): Promise<unknown>;
}

export function subagentRpc(pi: ExtensionAPI, method: string, params: object = {}, timeoutMs = 10_000): Promise<any> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
      if (reply?.version !== 1 || reply.requestId !== requestId) return;
      clearTimeout(timer); off();
      if (reply.success) resolve(reply.data);
      else reject(new Error(reply.error?.message ?? "pi-subagents RPC failed"));
    });
    const timer = setTimeout(() => { off(); reject(new Error(`pi-subagents ${method} timed out; install npm:pi-subagents@0.82.1 and use Pi >=1.2.0`)); }, timeoutMs);
    pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
  });
}

/** Registration and readiness are checked before child launch. */
export async function workerAgent(pi: ExtensionAPI, extension: string): Promise<{ name: string; dispose(): void }> {
  await subagentRpc(pi, "ping");
  const name = `psx-worker-${randomUUID()}`;
  const request: any = { version: 1, name, definition: {
    description: "One PSX build-candidate worker, supervised by the main autoloop",
    systemPrompt: "Work only on your assigned function in your assigned cwd. Follow repository instructions and the matching skill. " +
      "The controller owns selection, integration, parking and commits. Never run another loop, delegate, commit, stage, reset or clean Git. " +
      "Preserve experiments and report evidence, changed paths and blockers when yielding. A claim of success is not verification.",
    extensions: [extension], excludeTools: ["psx_park_function", "subagent", "subagents_enable"],
    inheritProjectContext: true, inheritSkills: true,
    systemPromptMode: "append", defaultContext: "fresh", allowNestedSubagents: false,
    defaultAcceptance: { level: "none", reason: "The harness independently runs the production finalization gates" },
  } };
  pi.events.emit("pi-subagents:runtime-agent-register:v1", request);
  if (!request.result) throw new Error("pi-subagents runtime agent registration unavailable; install pi-subagents@0.82.1 and reload Pi");
  if (!request.result.ok) throw request.result.error;
  return { name, dispose: () => request.result.registration.dispose() };
}

/** Concurrent foreground leaves use the package's owned delegation API. The
 * controller remains free to run; terminal responses, not cancel requests or
 * output files, establish settlement. There are no detached writer processes. */
export function startWorker(pi: ExtensionAPI, input: {
  ownerRunId: string; nodeId: string; agent: string; task: string; cwd: string; model: ModelSchema; timeoutMs: number;
}): WorkerHandle {
  const identity = { requestId: randomUUID(), ownerRunId: input.ownerRunId, nodeId: input.nodeId };
  const control = createWorkerControl(input.cwd);
  const matches = (data: any) => data?.requestId === identity.requestId && data.ownerRunId === identity.ownerRunId && data.nodeId === identity.nodeId;
  let finish!: (result: WorkerResult) => void;
  const handle: WorkerHandle = {
    update: {}, done: new Promise(resolve => { finish = resolve; }),
    cancel: () => { if (!handle.result) pi.events.emit(DELEGATION + "cancel", identity); },
    get steering() { return control.receipts(); },
    steer: message => control.steer(message),
  };
  const offUpdate = pi.events.on(DELEGATION + "update", (data: any) => {
    if (!matches(data)) return;
    handle.update = { ...(data.runId ?? handle.update.runId ? { runId: data.runId ?? handle.update.runId } : {}),
      ...(data.currentTool ? { currentTool: data.currentTool } : {}), ...(typeof data.tokens === "number" ? { tokens: data.tokens } : {}),
      ...(typeof data.recentOutput === "string" ? { recentOutput: data.recentOutput.slice(-3000) } : {}) };
  });
  const offResponse = pi.events.on(DELEGATION + "response", (data: any) => {
    if (!matches(data) || handle.result) return;
    offUpdate(); offResponse();
    handle.result = data as WorkerResult;
    control.close();
    finish(handle.result);
  });
  pi.events.emit(DELEGATION + "request", { ...identity, agent: input.agent,
    task: `${input.task}\n\n${CONTROL_MARKER}${control.token}\n`, cwd: input.cwd,
    context: "fresh", model: `${input.model.provider}/${input.model.model}`, thinking: input.model.thinking,
    timeoutMs: input.timeoutMs, artifacts: true, intercomBridge: { mode: "off" }, result: { kind: "text" } });
  return handle;
}
