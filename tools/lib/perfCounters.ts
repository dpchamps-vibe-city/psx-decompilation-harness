/** Work counters for performance budgets. Counting is off unless a test scope
 * is open or PSX_PERF_COUNTERS names a JSONL file, to which every process
 * appends one record on exit so totals aggregate across child processes. Off,
 * a count is one property read. Counters observe; they never change behavior. */
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const target = process.env.PSX_PERF_COUNTERS;
let active: Map<string, number> | undefined = target ? new Map() : undefined;

export function count(name: string, amount = 1): void {
  if (active) active.set(name, (active.get(name) ?? 0) + amount);
}

/** One process spawn, labelled by tool, or by entry script for node. */
export function countSpawn(command: string, args: readonly string[]): void {
  if (!active) return;
  const script = command === process.execPath ? args.find(a => a.endsWith(".ts") && !a.endsWith("scriptHost.ts")) : undefined;
  count("spawn"); count(`spawn:${basename(script ?? command)}`);
}

/** The counts `task` caused in this process, also added to any enclosing scope. */
export async function measureCounts<T>(task: () => Promise<T> | T): Promise<{ value: T; counts: Record<string, number> }> {
  const outer = active, inner = new Map<string, number>();
  active = inner;
  try {
    const value = await task();
    return { value, counts: Object.fromEntries([...inner].sort(([a], [b]) => a.localeCompare(b))) };
  } finally {
    active = outer;
    if (outer) for (const [name, n] of inner) outer.set(name, (outer.get(name) ?? 0) + n);
  }
}

if (target) process.on("exit", () => {
  const counts = Object.fromEntries([...active!].sort(([a], [b]) => a.localeCompare(b)));
  try { appendFileSync(target, JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1), counts }) + "\n"); }
  catch { /* observation only */ }
});
