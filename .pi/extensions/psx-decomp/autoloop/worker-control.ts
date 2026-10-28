import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* Native foreground children share this process, but NOT the parent's Pi event
 * bus. Use our explicitly loaded child extension and Pi's native steering
 * queue, rather than pi-subagents' workflow-only foreground RPC route. */
const REGISTRY = Symbol.for("psx.autoloop.worker-control.v1");
export const CONTROL_MARKER = "PSX_WORKER_CONTROL_V1=";
export const STEER_MESSAGE = "psx-autoloop-supervisor";
export interface SteeringReceipt {
  requestId: string;
  deliveryStatus: "queued" | "delivered" | "failed";
  error?: string;
}
interface Request {
  receipt: SteeringReceipt;
  message: string;
  dispatched: boolean;
  listeners: Set<() => void>;
}
interface Control {
  token: string;
  cwd: string;
  requests: Request[];
  send?: (request: Request) => void;
  sessionId?: string;
  closed: boolean;
}
const controls = () => {
  const host = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, Control> };
  return host[REGISTRY] ??= new Map();
};
function notify(request: Request) { for (const listener of request.listeners) listener(); }
function fail(request: Request, error: string) {
  if (request.receipt.deliveryStatus !== "queued") return;
  request.receipt.deliveryStatus = "failed";
  request.receipt.error = error;
  notify(request);
}
function dispatch(control: Control) {
  if (!control.send || control.closed) return;
  for (const request of control.requests) {
    if (request.dispatched || request.receipt.deliveryStatus !== "queued") continue;
    request.dispatched = true;
    try { control.send(request); }
    catch (error) { fail(request, String(error)); }
  }
}
function close(control: Control, reason: string) {
  if (control.closed) return;
  control.closed = true;
  delete control.send;
  if (controls().get(control.token) === control) controls().delete(control.token);
  for (const request of control.requests) fail(request, reason);
}

export function createWorkerControl(cwd: string, ackTimeoutMs = 3000) {
  const control: Control = { token: randomUUID(), cwd: resolve(cwd), requests: [], closed: false };
  controls().set(control.token, control);
  return {
    token: control.token,
    receipts: () => control.requests.map(request => ({ ...request.receipt })),
    close: (reason = "Worker settled before this guidance reached model context") => close(control, reason),
    async steer(message: string): Promise<SteeringReceipt> {
      if (!message.trim()) throw new Error("Steering requires a non-empty message");
      if (control.closed) throw new Error("Worker has already settled; guidance was not sent");
      /* Bound history without dropping undelivered guidance. */
      while (control.requests.length >= 32) {
        const index = control.requests.findIndex(request => request.receipt.deliveryStatus !== "queued");
        if (index < 0) throw new Error("Worker steering queue is full; wait for queued guidance to be delivered");
        control.requests.splice(index, 1);
      }
      const request: Request = { receipt: { requestId: randomUUID(), deliveryStatus: "queued" }, message,
        dispatched: false, listeners: new Set() };
      control.requests.push(request);
      dispatch(control);
      if (request.receipt.deliveryStatus === "queued") await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); request.listeners.delete(finish); done(); };
        const timer = setTimeout(finish, ackTimeoutMs);
        request.listeners.add(finish);
      });
      return { ...request.receipt };
    },
  };
}

/** Loaded only in the package-owned matching child. No timers, new sessions,
 * alternate launcher, tool execution or workflow is introduced. */
export function registerWorkerControl(pi: ExtensionAPI): void {
  let bound: Control | undefined;
  pi.on("before_agent_start", (event, ctx) => {
    if (bound || !("prompt" in event)) return;
    const token = event.prompt.match(/(?:^|\n)PSX_WORKER_CONTROL_V1=([a-f0-9-]{36})(?:\r?\n|$)/)?.[1];
    const control = token ? controls().get(token) : undefined;
    if (!control || control.closed || control.send || control.cwd !== resolve(ctx.cwd)) return;
    bound = control;
    control.sessionId = ctx.sessionManager.getSessionId();
    control.send = request => pi.sendMessage({ customType: STEER_MESSAGE,
      content: `Main autoloop controller guidance for your current function:\n${request.message}`,
      display: true, details: { token: control.token, requestId: request.receipt.requestId },
    }, { deliverAs: "steer" });
    dispatch(control);
  });
  pi.on("context", (event, ctx) => {
    if (!bound || bound.closed || bound.sessionId !== ctx.sessionManager.getSessionId()) return;
    for (const message of event.messages) {
      if (message.role !== "custom" || message.customType !== STEER_MESSAGE) continue;
      const details = message.details as { token?: string; requestId?: string } | undefined;
      if (details?.token !== bound.token) continue;
      const request = bound.requests.find(request => request.receipt.requestId === details.requestId);
      if (!request || request.receipt.deliveryStatus !== "queued") continue;
      /* DELIVERED means observed in the exact child's next model context,
       * not merely accepted by a transport, and never claims model compliance. */
      request.receipt.deliveryStatus = "delivered";
      notify(request);
    }
  });
  pi.on("session_shutdown", () => {
    if (bound) close(bound, "Worker session ended before this guidance reached model context");
    bound = undefined;
  });
}
