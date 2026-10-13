/** The sole assembler command builder. Compiler output uses the configured
 * backend; reference/handwritten assembly always goes unchanged to GNU as. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileDigest } from "./contentCache.js";
import { projectRoot } from "./runtimeContext.js";
import { configuredAssembler, configuredFlags, configuredTool, type AssemblerKind, type AssemblerSelection, type FlagContext } from "./toolchain.js";
export { configuredAssembler } from "./toolchain.js";
export type { AssemblerKind, AssemblerSelection } from "./toolchain.js";

export interface AssemblerRules {
  indexedLoadTemp: "at" | "destination-unless-base";
  absoluteLoadTemp: "destination";
  storeTemp: "at";
  move: "addu" | "or-unless-rewritten";
  hazardNops: "text-debug-markers" | "listing-object";
  branchDelaySlots: "noreorder" | "reorder-swap-default-O2";
  smallData: "declared-symbols-only" | "undeclared-externs-assumed-small-unsupported";
  gasThreshold: "force-G0-unless-opted-out" | "flags.as-exactly";
}
export function assemblerRules(kind: AssemblerKind): AssemblerRules {
  return { indexedLoadTemp: kind === "gas" ? "destination-unless-base" : "at", absoluteLoadTemp: "destination", storeTemp: "at",
    move: kind === "gas" ? "or-unless-rewritten" : "addu", hazardNops: kind === "gas" ? "listing-object" : "text-debug-markers",
    branchDelaySlots: kind === "gas" ? "reorder-swap-default-O2" : "noreorder",
    smallData: kind === "gas" ? "undeclared-externs-assumed-small-unsupported" : "declared-symbols-only",
    gasThreshold: kind === "gas" ? "flags.as-exactly" : "force-G0-unless-opted-out" };
}
const REGISTER = "\\$(?:[0-9]|[12][0-9]|3[01]|zero|at|v[01]|a[0-3]|t[0-9]|s[0-8]|k[01]|gp|sp|fp|ra)";
const MOVE = new RegExp(`^(\\s*)move([ \\t]+)(${REGISTER})[ \\t]*,[ \\t]*(${REGISTER})([ \\t]*(?:#[^\\r\\n]*)?)(\\r?)$`);
/** Closed rewrite set; no labels, include targets or #APP handwritten regions. */
export function rewriteAssemblerInput(text: string, rewrites: readonly string[]): string {
  for (const id of rewrites) if (id !== "move-addu") throw new Error(`Unknown assembler input rewrite: ${id}`);
  let handwritten = false;
  return text.split("\n").map(line => {
    if (/^\s*#APP\s*$/.test(line)) handwritten = true;
    if (/^\s*#NO_APP\s*$/.test(line)) { handwritten = false; return line; }
    if (handwritten || !rewrites.includes("move-addu")) return line;
    return line.replace(MOVE, (_all, indent, gap, dest, source, tail, cr) => `${indent}addu${gap}${dest},${source},$0${tail}${cr}`);
  }).join("\n");
}
export interface AssemblerInvocation { command: string; args: string[]; cwd: string; assemblerInput: string }
export function assemblerInvocation(context: FlagContext | undefined, input: string, object: string, root = projectRoot(), options: { handwritten?: boolean } = {}): AssemblerInvocation {
  const selection = configuredAssembler(context, root), asFlags = configuredFlags("as", context, root);
  if (options.handwritten) return { command: configuredTool("as", root), args: [...asFlags, input, "-o", object], cwd: root, assemblerInput: input };
  if (selection.kind === "maspsx") return { command: configuredTool("python", root), args: [configuredTool("maspsx", root), ...configuredFlags("maspsx", context, root),
    "--gnu-as-path", configuredTool("as", root), "-o", object, ...asFlags, input], cwd: root, assemblerInput: input };
  const assemblerInput = `${object}.as-input.s`;
  writeFileSync(resolve(root, assemblerInput), rewriteAssemblerInput(readFileSync(resolve(root, input), "utf8"), selection.inputRewrites));
  return { command: configuredTool("as", root), args: [...asFlags, assemblerInput, "-o", object], cwd: root, assemblerInput };
}
/** Tool hashes belong to effective contexts, not unused MASPSX installations. */
export function assemblerIdentity(context?: FlagContext, root = projectRoot()) {
  const selection = configuredAssembler(context, root);
  if (selection.kind === "gas") return selection;
  const path = configuredTool("maspsx", root);
  return { ...selection, maspsx: { path, sha256: fileDigest(path), packageDirectory: resolve(path, "../maspsx") } };
}
export interface AssemblerReceipt extends AssemblerSelection {
  production: AssemblerInvocation;
  assembler: ReturnType<typeof assemblerIdentity>;
  inputSha256: string;
  objectSha256: string;
  stdout: string;
  stderr: string;
}
function checkResult(invocation: AssemblerInvocation, result: { status: number | null; error?: Error; stdout?: string | null; stderr?: string | null }) {
  if (result.error || result.status !== 0) throw new Error(`${invocation.command} failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? `exit ${result.status}`}`);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function execute(invocation: AssemblerInvocation) {
  return checkResult(invocation, spawnSync(invocation.command, invocation.args, { cwd: invocation.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}
function receipt(invocation: AssemblerInvocation, context: FlagContext | undefined, root: string, object: string, output: { stdout: string; stderr: string }, handwritten = false): AssemblerReceipt {
  const assembler = handwritten ? { kind: "gas" as const, inputRewrites: [] } : assemblerIdentity(context, root);
  const result = { kind: assembler.kind, inputRewrites: assembler.inputRewrites, assembler, production: invocation,
    inputSha256: fileDigest(resolve(root, invocation.assemblerInput)), objectSha256: fileDigest(resolve(root, object)), ...output };
  // Keep successful GAS diagnostics, including warnings, visible to verification.
  if (assembler.kind === "gas" && !handwritten) writeFileSync(resolve(root, `${object}.assembly.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}
export function assemble(context: FlagContext | undefined, input: string, object: string, root = projectRoot(), options: { handwritten?: boolean } = {}): AssemblerReceipt {
  const invocation = assemblerInvocation(context, input, object, root, options);
  return receipt(invocation, context, root, object, execute(invocation), options.handwritten);
}
export async function assembleAsync(context: FlagContext | undefined, input: string, object: string, root = projectRoot(), signal?: AbortSignal): Promise<AssemblerReceipt> {
  const invocation = assemblerInvocation(context, input, object, root);
  const output = await new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], signal });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", status => {
      try { accept(checkResult(invocation, { status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })); }
      catch (error) { reject(error); }
    });
  });
  return receipt(invocation, context, root, object, output);
}
export interface AssemblerExpansion {
  kind: AssemblerKind;
  compilerAssembly: string;
  expandedAssembly: string;
  assemblerInput: string;
  listing?: string;
  receipt: string;
  compilerExcerpt: string[];
  expandedExcerpt: string[];
}
/** Capture without changing production flags; GAS listing object must be exact. */
export function captureAssemblerExpansion(context: FlagContext | undefined, input: string, object: string, symbol: string, root = projectRoot()): AssemblerExpansion {
  const selection = configuredAssembler(context, root), production = assemblerInvocation(context, input, object, root);
  const expandedAssembly = selection.kind === "gas" ? `${object}.listing.txt` : `${object}.expanded.s`;
  let capture: AssemblerInvocation;
  if (selection.kind === "maspsx") {
    if (!production.args.includes("--run-assembler")) throw new Error("Production MASPSX does not declare --run-assembler; expansion trace is unavailable");
    capture = { ...production, args: production.args.filter(arg => arg !== "--run-assembler") };
  } else {
    capture = { ...production, args: [...configuredFlags("as", context, root), `-alm=${expandedAssembly}`, production.assemblerInput, "-o", `${object}.listing.o`] };
  }
  const output = execute(capture);
  if (selection.kind === "maspsx") writeFileSync(resolve(root, expandedAssembly), output.stdout);
  else if (!readFileSync(resolve(root, object)).equals(readFileSync(resolve(root, `${object}.listing.o`)))) throw new Error("GAS listing capture changed the production object");
  const excerpt = (text: string): string[] => {
    const lines = text.split("\n"), name = symbol.split("::").pop()!;
    const start = lines.findIndex(line => selection.kind === "gas" ? line.trim().endsWith(`${name}:`) : line.trim() === `${name}:`);
    if (start < 0) return [];
    const end = lines.findIndex((line, index) => index > start && /\.end\s+/.test(line) && line.trim().endsWith(name));
    return lines.slice(start, end < 0 ? start + 45 : end + 1).slice(0, 60);
  };
  const result: AssemblerExpansion = { kind: selection.kind, compilerAssembly: input, expandedAssembly, assemblerInput: production.assemblerInput,
    ...(selection.kind === "gas" ? { listing: expandedAssembly } : {}), receipt: `${object}.assembler.json`,
    compilerExcerpt: excerpt(readFileSync(resolve(root, input), "utf8")), expandedExcerpt: excerpt(readFileSync(resolve(root, expandedAssembly), "utf8")) };
  const hash = (path: string) => fileDigest(resolve(root, path));
  writeFileSync(resolve(root, result.receipt), JSON.stringify({ schemaVersion: 1, ...result, ...selection, assembler: assemblerIdentity(context, root), context, compilerAssemblySha256: hash(input),
    inputSha256: hash(production.assemblerInput), expandedAssemblySha256: hash(expandedAssembly), objectSha256: hash(object),
    ...(selection.kind === "gas" ? { listingSha256: hash(expandedAssembly), listingObjectSha256: hash(`${object}.listing.o`), objectsIdentical: true } : {}),
    production, capture, stderr: output.stderr }, null, 2) + "\n");
  return result;
}
