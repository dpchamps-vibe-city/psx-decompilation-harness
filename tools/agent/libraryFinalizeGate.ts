/**
 * libraryFinalizeGate.ts — a library finalization's machine work in one process.
 *
 * The three steps the finalizer used to run as three CLIs, in the same order
 * and with the same gating: the function diff (diffFunc.ts), then the active
 * and previously accepted member check (library.ts check --member), then
 * context publication (contextExport.ts). A step runs only when the one before
 * it passed. Each step reports exactly what its own CLI would print and exit
 * with; the steps share one process, inventory and content memo instead of
 * three. Internal: the finalizer is its only caller.
 *
 * Usage: libraryFinalizeGate.ts <member::symbol> --member <id> [--member <id> ...] [--publish <name>]
 * The diff and check measure the member-qualified key; publication uses the
 * name the finalizer was given, as contextExport.ts did.
 * Prints one LIBRARY_GATE_STATUS line: { steps: [{ step, code, stdout, stderr, durationMs }] }.
 */
import { CONTEXT_EXPORT_STATUS } from "./contextExport.js";
import { checkLibrary, measureLibraryFunction, renderLibraryComparison } from "./libraryTarget.js";
import { exportRelocatableContext } from "./relocatableContext.js";
import { projectRoot } from "../lib/runtimeContext.js";

export const LIBRARY_GATE_STATUS = "LIBRARY_GATE_STATUS ";
/** Printed as soon as the diff and the member check have both passed. */
export const LIBRARY_GATE_VERIFIED = "LIBRARY_GATE_VERIFIED";
export interface LibraryGateStep { step: "diff" | "check" | "publish"; code: number; stdout: string; stderr: string; durationMs: number }

/** Run `body` with this process's stdout/stderr captured; `body` returns its exit status. */
function captured(step: LibraryGateStep["step"], body: (out: (line: string) => void, err: (line: string) => void) => number): LibraryGateStep {
  const stdout: string[] = [], stderr: string[] = [], started = performance.now();
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let code: number;
  try { code = body(line => console.log(line), line => console.error(line)); }
  finally { process.stdout.write = write.out; process.stderr.write = write.err; }
  return { step, code, stdout: stdout.join(""), stderr: stderr.join(""), durationMs: Math.round(performance.now() - started) };
}

export function libraryFinalizeGate(name: string, members: string[], root = projectRoot(), publishName = name): LibraryGateStep[] {
  const steps: LibraryGateStep[] = [];
  // diffFunc.ts, library route.
  steps.push(captured("diff", (out, err) => {
    try {
      const measured = measureLibraryFunction(name);
      out(`target: ${measured.key} (${measured.member.input}[${measured.member.ordinal}])`);
      out(`source: ${measured.artifacts.source}`);
      out(renderLibraryComparison(measured.comparison, measured.functionComparison));
      out(`Report: ${measured.report}`);
      return measured.comparison.verdict === "match" ? 0 : 1;
    } catch (error) { err(String(error)); return 1; }
  }));
  if (steps.at(-1)!.code !== 0) return steps;
  // library.ts check --member ...
  steps.push(captured("check", (_out, err) => {
    try { checkLibrary(members.flatMap(id => ["--member", id]), root); return 0; }
    catch (error) { err(String(error)); return 1; }
  }));
  if (steps.at(-1)!.code !== 0) return steps;
  console.log(LIBRARY_GATE_VERIFIED);
  // contextExport.ts, library route.
  steps.push(captured("publish", (out, err) => {
    try {
      const result = exportRelocatableContext(publishName, root);
      out(CONTEXT_EXPORT_STATUS + JSON.stringify(result));
      if (result.skipped) { out(`Skipped: ${result.reason}`); return 1; }
      return 0;
    } catch (error) { err(error instanceof Error ? error.message : String(error)); return 1; }
  }));
  return steps;
}

if (process.argv[1]?.endsWith("libraryFinalizeGate.ts")) {
  const args = process.argv.slice(2), name = args.find((a, i) => !a.startsWith("--") && !["--member", "--publish"].includes(args[i - 1] ?? ""));
  const members = args.flatMap((a, i) => a === "--member" ? [args[i + 1] ?? ""] : []), publish = args[args.indexOf("--publish") + 1];
  if (!name || !members.length || members.includes("") || (args.includes("--publish") && !publish))
    throw new Error("Usage: libraryFinalizeGate.ts <member::symbol> --member <id> [--member <id> ...] [--publish <name>]");
  console.log(LIBRARY_GATE_STATUS + JSON.stringify({ steps: libraryFinalizeGate(name, members, projectRoot(), args.includes("--publish") ? publish : name) }));
}
