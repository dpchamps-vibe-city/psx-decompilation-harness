import type { WorkerHandle } from "./subagents.js";
import type { WorkerDraft } from "./controller-integration.js";

/** A member of ONE main-loop work turn, not an independently scheduled loop. */
export interface WorkerJob {
  slot: number;
  functionName: string;
  cwd: string;
  draft?: WorkerDraft;
  handle: WorkerHandle;
  feedback?: string;
  stopped?: boolean;
  takenOver?: boolean;
  takeover?: { integrated: boolean; feedback: string; commit?: string };
}

export async function settled(handle: WorkerHandle, timeoutMs = 15_000): Promise<void> {
  if (handle.result) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([handle.done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker cancellation has not settled; build candidates and active.json lock must be retained")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Fixed fan-out for one existing autoloop turn. Only the main loop owns
 * selection across turns, the ladder, returns, finalization, parking and folds. */
export class WorkBatch {
  readonly jobs: WorkerJob[] = [];
  constructor(readonly launch: (slot: number, functionName: string, message?: string) => Promise<WorkerJob>,
    readonly next: () => Promise<string | undefined>,
    readonly takeOver?: (job: WorkerJob) => Promise<{ integrated: boolean; feedback: string; commit?: string }>) {}

  async add(functionName: string, message?: string): Promise<WorkerJob> {
    const job = await this.launch(this.jobs.length, functionName, message);
    this.jobs.push(job);
    return job;
  }

  snapshot() {
    return this.jobs.map(job => ({ slot: job.slot, functionName: job.functionName, cwd: job.cwd, candidate: job.draft?.candidate,
      status: job.takeover?.integrated ? "integrated" : job.takenOver ? "taken-over" : job.stopped ? "stopped" : job.handle.result?.status ?? "working", feedback: job.feedback, commit: job.takeover?.commit,
      progress: job.handle.update, steering: job.handle.steering,
      report: job.handle.result?.result?.text?.slice(-4000), error: job.handle.result?.error?.slice(-2000) }));
  }

  async control(action: "steer" | "stop" | "reroute" | "wait" | "takeover" | "integrate", slot?: number, message = ""): Promise<unknown> {
    if (action === "wait") {
      await Promise.race([Promise.all(this.jobs.map(job => job.handle.done)), new Promise(resolve => setTimeout(resolve, 1000))]);
      return this.snapshot();
    }
    const job = this.jobs.find(job => job.slot === slot);
    if (!job) throw new Error("No assignment in that slot");
    if (action === "steer") return job.handle.steer(message);
    if (action === "integrate" && !this.takeOver) throw new Error("This batch has no main-loop integration callback");
    job.handle.cancel();
    await settled(job.handle);
    if (action === "takeover" || action === "integrate") {
      job.takenOver = true;
      job.stopped = false;
      if (action === "integrate") {
        job.takeover = await this.takeOver!(job);
        job.feedback = job.takeover.feedback;
        return { slot: job.slot, functionName: job.functionName, ...job.takeover };
      }
      job.feedback = message || "Main orchestrator owns this unfinished build candidate; continue it there, then integrate when ready";
      return { slot: job.slot, functionName: job.functionName, takenOver: true,
        candidate: job.draft?.candidate, feedback: job.feedback, progress: job.handle.update, report: job.handle.result?.result };
    }
    job.stopped = true;
    job.feedback = message || "Stopped by the main-loop controller; private work preserved";
    if (action === "reroute") {
      const next = await this.next();
      if (next) {
        const replacement = await this.launch(job.slot, next, message);
        this.jobs[this.jobs.indexOf(job)] = replacement;
      }
    }
    return this.snapshot();
  }

  async finish(aborted: () => boolean): Promise<void> {
    while (this.jobs.some(job => !job.handle.result)) {
      if (aborted()) { await this.close(); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([...this.jobs.filter(job => !job.handle.result).map(job => job.handle.done),
          new Promise(resolve => { timer = setTimeout(resolve, 100); })]);
      } finally { clearTimeout(timer); }
    }
  }

  async close(): Promise<void> {
    const live = this.jobs.filter(job => !job.handle.result);
    live.forEach(job => job.handle.cancel());
    const results = await Promise.allSettled(live.map(job => settled(job.handle)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
