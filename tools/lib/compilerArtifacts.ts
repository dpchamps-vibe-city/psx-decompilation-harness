/** Per-function diagnostic projections of a production translation-unit compile.
 * Never compile an extracted C body: neighbors still affect code generation.
 * Keep the full assembly/dumps and object, then select the compiler's own
 * function boundaries for the existing single-function analysis consumers. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FlagContext } from "./toolchain.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function selectRtlFunction(text: string, symbol: string): string {
  const boundaries = [...text.matchAll(/^;; Function ([^\s(]+).*$/gm)];
  if (!boundaries.length) return text; // preserved single-function fixture/older dump
  const found = boundaries.filter(m => m[1] === symbol);
  if (found.length !== 1) throw new Error(`RTL dump does not identify exactly one ${symbol}`);
  const i = boundaries.indexOf(found[0]!);
  return text.slice(found[0]!.index, boundaries[i + 1]?.index ?? text.length);
}
export function selectAssemblyFunction(text: string, symbol: string): string {
  const escape = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = new RegExp(`^\\s*\\.ent\\s+${escape}(?:\\s|$)`, "m").exec(text);
  const end = new RegExp(`^\\s*\\.end\\s+${escape}(?:\\s|$)[^\\n]*(?:\\n|$)`, "m").exec(text);
  if (!start || !end || end.index <= start.index) throw new Error(`Assembly does not bound ${symbol} with .ent/.end`);
  return text.slice(start.index, end.index + end[0].length);
}
interface AssemblyOrigin {
  schemaVersion: 1; symbol: string; context: FlagContext;
  fullAssembly: string; fullHash: string; viewHash: string;
}
const originPath = (assembly: string) => `${assembly}.translation-unit.json`;
/** cc1 appends RTL dumps; every new compile must start a fresh view and origin. */
export function resetCompilerArtifacts(directory: string, stem: string): void {
  for (const file of readdirSync(directory)) {
    if (file.startsWith(`${stem}.i.`) || file === `${stem}.s.translation-unit.json` || file === `${stem}.c.o.function-view.json`)
      rmSync(join(directory, file), { force: true });
  }
}
export function projectCompilerArtifacts(directory: string, stem: string, symbol: string, context: FlagContext): string {
  const assembly = join(directory, `${stem}.s`), text = readFileSync(assembly, "utf8");
  const raw = join(directory, "translation-unit"); mkdirSync(raw, { recursive: true });
  const fullAssembly = join(raw, `${stem}.s`); writeFileSync(fullAssembly, text);
  const view = selectAssemblyFunction(text, symbol);
  writeFileSync(assembly, view);
  for (const file of readdirSync(directory).filter(f => f.startsWith(`${stem}.i.`))) {
    const content = readFileSync(join(directory, file), "utf8");
    writeFileSync(join(raw, file), content);
    writeFileSync(join(directory, file), selectRtlFunction(content, symbol));
  }
  const origin: AssemblyOrigin = { schemaVersion: 1, symbol, context, fullAssembly: `translation-unit/${stem}.s`, fullHash: hash(text), viewHash: hash(view) };
  writeFileSync(originPath(assembly), JSON.stringify(origin) + "\n");
  return fullAssembly;
}
/** Reassembly must use the complete production TU, not its diagnostic fragment.
 * A modified fragment refuses reassembly rather than silently ignoring edits. */
export function compilerAssemblyOrigin(assembly: string): { assembly: string; context: FlagContext; symbol: string } | null {
  if (!existsSync(originPath(assembly))) return null;
  const origin = JSON.parse(readFileSync(originPath(assembly), "utf8")) as AssemblyOrigin;
  const full = resolve(dirname(assembly), origin.fullAssembly);
  if (origin.schemaVersion !== 1 || !full.startsWith(resolve(dirname(assembly), "translation-unit") + "/") ||
    hash(readFileSync(assembly, "utf8")) !== origin.viewHash || hash(readFileSync(full, "utf8")) !== origin.fullHash)
    throw new Error("Diagnostic assembly or its owning TU changed; recompile the complete source before reassembly");
  return { assembly: full, context: origin.context, symbol: origin.symbol };
}
export function writeObjectFunctionView(object: string, symbol: string): void {
  writeFileSync(`${object}.function-view.json`, JSON.stringify({ schemaVersion: 1, symbol }) + "\n");
}
export function objectFunctionView(object: string): string | undefined {
  if (!existsSync(`${object}.function-view.json`)) return undefined;
  const view = JSON.parse(readFileSync(`${object}.function-view.json`, "utf8"));
  if (view.schemaVersion !== 1 || typeof view.symbol !== "string") throw new Error("Invalid object function view");
  return view.symbol;
}
