/** The sole assembler command builder. Inputs are passed unchanged. Only
 * explicitly declared period-tool stages may change an assembled object. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileDigest, filesUnder, digest } from "./contentCache.js";
import { contextForProject } from "./runtimeContext.js";
import { finalizeDmpsx, DMPSX_VERSION } from "./stages/psyqDmpsx.js";
import { finalizeLnk, LNK_VERSION } from "./stages/psyqLnk.js";
import { projectRoot } from "./runtimeContext.js";
import { configuredAssembler, configuredFlags, configuredTool, type AssemblerKind, type AssemblerSelection, type FlagContext } from "./toolchain.js";
export { configuredAssembler } from "./toolchain.js";
export type { AssemblerKind, AssemblerSelection } from "./toolchain.js";

export interface AssemblerRules {
  indexedLoadTemp: "at" | "destination-unless-base";
  absoluteLoadTemp: "destination";
  storeTemp: "at";
  move: "addu" | "tool-version-dependent";
  hazardNops: "text-debug-markers" | "listing-object";
  branchDelaySlots: "noreorder" | "reorder-swap-default-O2";
  smallData: "declared-symbols-only" | "undeclared-externs-assumed-small-unsupported";
  gasThreshold: "force-G0-unless-opted-out" | "flags.as-exactly";
}
export function assemblerRules(kind: AssemblerKind): AssemblerRules {
  return { indexedLoadTemp: kind === "gas" ? "destination-unless-base" : "at", absoluteLoadTemp: "destination", storeTemp: "at",
    move: kind === "gas" ? "tool-version-dependent" : "addu", hazardNops: kind === "gas" ? "listing-object" : "text-debug-markers",
    branchDelaySlots: kind === "gas" ? "reorder-swap-default-O2" : "noreorder",
    smallData: kind === "gas" ? "undeclared-externs-assumed-small-unsupported" : "declared-symbols-only",
    gasThreshold: kind === "gas" ? "flags.as-exactly" : "force-G0-unless-opted-out" };
}
export interface AssemblerInvocation { command: string; args: string[]; cwd: string; assemblerInput: string }
export function assemblerInvocation(context: FlagContext | undefined, input: string, object: string, root = projectRoot(), options: { handwritten?: boolean } = {}): AssemblerInvocation {
  const selection = configuredAssembler(context, root), asFlags = configuredFlags("as", context, root);
  if (options.handwritten) return { command: configuredTool("as", root), args: [...asFlags, input, "-o", object], cwd: root, assemblerInput: input };
  if (selection.kind === "maspsx") return { command: configuredTool("python", root), args: [configuredTool("maspsx", root), ...configuredFlags("maspsx", context, root),
    "--gnu-as-path", configuredTool("as", root), "-o", object, ...asFlags, input], cwd: root, assemblerInput: input };
  return { command: configuredTool("as", root), args: [...asFlags, input, "-o", object], cwd: root, assemblerInput: input };
}
/** Tool hashes belong to effective contexts, not unused MASPSX installations. */
export function assemblerIdentity(context?: FlagContext, root = projectRoot()) {
  const selection = configuredAssembler(context, root);
  const stages = selection.postAssembly.map(name => {
    // The reader decides which bytes are executable/relocated. Its implementation
    // is part of the stage, not an unhashed dependency of a hashed launcher.
    const files = [...(name === "psyq-lnk" ? ["tools/lib/stages/psyqLnk.ts", "tools/lib/objectFormats/lnkWriter.ts"] : ["tools/lib/stages/psyqDmpsx.ts"]), "tools/lib/relocatableObject.ts", "tools/lib/elfSections.ts",
      "tools/lib/objectFormats/model.ts", "tools/lib/objectFormats/ecoff.ts", "tools/lib/objectFormats/lnk.ts",
      "tools/lib/objectFormats/view.ts", "tools/lib/objectFormats/compare.ts", "tools/lib/objectFormats/relocations.ts", "tools/lib/relocatableCode.ts",
      "tools/agent/matching-reconstruction/decode.ts"].map(path => {
      const sha256 = fileDigest(resolve(contextForProject(root).harnessRoot, path));
      if (sha256 === "absent") throw new Error(`Missing ${name} implementation: ${path}`);
      return { path, sha256 };
    });
    return { name, version: name === "psyq-lnk" ? LNK_VERSION : DMPSX_VERSION, sha256: digest(JSON.stringify(files)), implementation: files };
  });
  if (selection.kind === "gas") return { ...selection, stages };
  const path = configuredTool("maspsx", root), packageDirectory = resolve(path, "../maspsx");
  const packageFiles = filesUnder(packageDirectory).filter(p => !p.includes("__pycache__") && !p.endsWith(".pyc"));
  return { ...selection, stages, maspsx: { path, sha256: fileDigest(path), packageDirectory, packageSha256: digest(JSON.stringify(packageFiles.map(p => [p.slice(packageDirectory.length + 1), fileDigest(p)]))) } };
}
export interface AssemblerReceipt extends AssemblerSelection {
  production: AssemblerInvocation;
  assembler: ReturnType<typeof assemblerIdentity>;
  inputSha256: string;
  objectSha256: string;
  stdout: string;
  stderr: string;
  stages: Array<{ name: string; version: number; sha256: string; inputSha256: string; outputSha256: string; replacements: Array<{ section: string; offset: number; placeholder: number; result: number }> }>;
}
function checkResult(invocation: AssemblerInvocation, result: { status: number | null; error?: Error; stdout?: string | null; stderr?: string | null }) {
  if (result.error || result.status !== 0) throw new Error(`${invocation.command} failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? `exit ${result.status}`}`);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function execute(invocation: AssemblerInvocation) {
  return checkResult(invocation, spawnSync(invocation.command, invocation.args, { cwd: invocation.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}
function receipt(invocation: AssemblerInvocation, context: FlagContext | undefined, root: string, object: string, output: { stdout: string; stderr: string }, handwritten = false): AssemblerReceipt {
  const assembler = assemblerIdentity(context, root);
  const bytes = readFileSync(resolve(root, object));
  const actualFormat = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ? "elf" :
    bytes.length >= 20 && [0x162, 0x166, 0x142].includes(bytes.readUInt16LE(0)) ? "ecoff" : "unknown";
  if (actualFormat !== assembler.objectFormat) throw new Error(`Assembler emitted ${actualFormat}, configured ${assembler.objectFormat}`);
  if (assembler.postAssembly.includes("psyq-lnk")) writeFileSync(resolve(root, `${object}.ecoff`), bytes);
  const stages = assembler.postAssembly.map(name => {
    const before = fileDigest(resolve(root, object));
    const stage = name === "psyq-dmpsx" ? finalizeDmpsx(readFileSync(resolve(root, object))) :
      name === "psyq-lnk" ? finalizeLnk(readFileSync(resolve(root, object)), assembler.lnkLayout) : (() => { throw new Error(`Unknown assembly stage ${name}`); })();
    writeFileSync(resolve(root, object), stage.output);
    return { ...assembler.stages.find(s => s.name === name)!, inputSha256: before, outputSha256: fileDigest(resolve(root, object)), replacements: stage.replacements };
  });
  const result = { kind: assembler.kind, objectFormat: assembler.objectFormat, postAssembly: assembler.postAssembly,
    ...(assembler.lnkLayout ? { lnkLayout: assembler.lnkLayout, ecoff: `${object}.ecoff`, ecoffSha256: digest(bytes) } : {}), assembler, stages, production: invocation,
    inputSha256: fileDigest(resolve(root, invocation.assemblerInput)), objectSha256: fileDigest(resolve(root, object)), ...output };
  // Keep successful GAS diagnostics, including warnings, visible to verification.
  writeFileSync(resolve(root, `${object}.assembly.json`), JSON.stringify(result, null, 2) + "\n");
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
  else {
    receipt(capture, context, root, `${object}.listing.o`, output);
    if (!readFileSync(resolve(root, object)).equals(readFileSync(resolve(root, `${object}.listing.o`)))) throw new Error("GAS listing capture changed the production object");
  }
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
