import { projectRoot } from "../lib/runtimeContext.js";
/**
 * diffFunc.ts — the per-function oracle: are these the right bytes?
 *
 * Usage: npx tsx tools/agent/diffFunc.ts func_8001FE00
 *        npx tsx tools/agent/diffFunc.ts func_8001FE00 --watch
 *        npx tsx tools/agent/diffFunc.ts func_8001FE00 --columns  (side-by-side)
 *        npx tsx tools/agent/diffFunc.ts func_8001FE00 --src notes/scratch/cand.c
 *        npx tsx tools/agent/diffFunc.ts func_8001FE00 --bytes    (linked binary)
 *
 * The source is compiled, its `.text` is relocated to the function's original
 * addresses, and the result is compared with the original image's own bytes.
 * The diff and the verdict come out of that one comparison, so a MATCH means
 * byte-identical code including every relocation value — a transposed pair of
 * same-shaped globals shows up in the diff itself. There is no provisional
 * stage and nothing to escalate; see tools/lib/functionOracle.ts.
 *
 * What it does not check: that the function lands at the right address in the
 * real link, or that anything else in the binary is right. `make check` is the
 * authority for those, and `--bytes` is the same check narrowed to one
 * function (it needs a clean full build, so it is opt-in).
 */

import { execFileSync } from "node:child_process";
import { buildContainer } from "../build/pipeline.js";
import { watchFile, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  compileSource,
} from "./decompToolchain.js";
import {
  type OracleResult,
  type RenderedWord,
  compareFunction,
  renderDiff,
  renderVerdict,
} from "../lib/functionOracle.js";
import { requireFunctionLocation } from "../lib/symbolIndex.js";
import { containerPath, containerTargetPath, vramToRom, type Container } from "../lib/container.js";

import { loadLibraryProject } from "../lib/project.js";
import { measureLibraryFunction, renderLibraryComparison } from "./libraryTarget.js";


// Compilation is shared with builds/analysis via toolchain.json.

/**
 * Compile one source through the configured toolchain.
 *
 * Artifacts are named after the *function*, not the source file, so a
 * candidate compiled from elsewhere still lands where the rest of the
 * diagnostics look for it (`build/diffFunc/<func>.s`), and picks up the same
 * per-file flag override the build would apply to that function.
 */
function compile(src: string, stem: string, container: Container): string {
  return compileSource(src, "build/diffFunc", stem, { assemble: true, containerKind: container.kind, containerId: container.id }).object!;
}

/** Mnemonic-level multiset difference — names the missing/extra instructions
 *  behind an instruction-count delta instead of leaving a wall of ± lines. */
function mnemonicDelta(target: RenderedWord[], compiled: RenderedWord[]): string | null {
  const mnemonic = (word: RenderedWord) => word.text.split(/\s+/)[0].toLowerCase();
  const counts = new Map<string, number>();
  for (const word of target) counts.set(mnemonic(word), (counts.get(mnemonic(word)) || 0) + 1);
  for (const word of compiled) counts.set(mnemonic(word), (counts.get(mnemonic(word)) || 0) - 1);
  const targetOnly: string[] = [];
  const compiledOnly: string[] = [];
  for (const [name, count] of [...counts.entries()].sort()) {
    if (count > 0) targetOnly.push(count > 1 ? `${count}× ${name}` : name);
    else if (count < 0) compiledOnly.push(count < -1 ? `${-count}× ${name}` : name);
  }
  if (targetOnly.length === 0 && compiledOnly.length === 0) return null;
  const parts: string[] = [];
  if (targetOnly.length > 0) parts.push(`target has ${targetOnly.join(", ")} the compiled side lacks`);
  if (compiledOnly.length > 0) parts.push(`compiled has extra ${compiledOnly.join(", ")}`);
  return parts.join("; ");
}

/** Side-by-side view via GNU diff over the two symbolised instruction streams. */
function renderColumns(result: OracleResult): void {
  const ltmp = join(projectRoot(), "build/diffFunc", `columns-${process.pid}-target.txt`);
  const rtmp = join(projectRoot(), "build/diffFunc", `columns-${process.pid}-compiled.txt`);
  writeFileSync(ltmp, result.targetWords.map((word) => word.text).join("\n") + "\n");
  writeFileSync(rtmp, result.candidateWords.map((word) => word.text).join("\n") + "\n");
  try {
    process.stdout.write(execFileSync("diff", ["--color=always", "-y", "-W", "120", ltmp, rtmp], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e: any) {
    if (e.stdout) process.stdout.write(e.stdout);
  }
}

function doDiff(funcName: string, src: string, container: Container): void {
  console.log(`target:  original bytes of ${funcName}${container.kind === "exe" ? "" : ` in ${container.id}`}`);
  console.log(`source:  ${src}\n`);
  let result: OracleResult;
  try {
    const object = compile(src, funcName, container);
    result = compareFunction(funcName, { objectPath: object, container });
  } catch (e: any) {
    console.error("Compile error:", e.stderr || e.message);
    return;
  }

  /* A stub has no candidate program: rendering a diff of the original against
     nothing, or a mnemonic delta that lists the whole function, would dress a
     non-comparison up as a very bad one. */
  if (result.verdict === "stub") {
    for (const line of renderVerdict(result)) console.log(line);
    return;
  }

  if (columnsMode) renderColumns(result);
  else for (const line of renderDiff(result)) console.log(line);

  console.log("");
  for (const line of renderVerdict(result)) console.log(line);

  if (result.targetWords.length !== result.candidateWords.length) {
    const delta = mnemonicDelta(result.targetWords, result.candidateWords);
    if (delta) console.log(`  count delta: ${delta}`);
  }

  /* Both artifacts on disk, for tools that want to read the streams. */
  writeFileSync("/tmp/diffFunc-target.txt", result.targetWords.map((word) => word.text).join("\n") + "\n");
  writeFileSync("/tmp/diffFunc-compiled.txt", result.candidateWords.map((word) => word.text).join("\n") + "\n");
}

/**
 * The same function's bytes in the *linked* binary.
 *
 * This is `make check` narrowed to one function: it additionally proves the
 * function was placed where the original put it. It needs the whole build to
 * link, so it is opt-in rather than something the oracle depends on.
 */
function verifyLinkedBytes(funcName: string, container: Container): boolean {
  const span = requireFunctionLocation(funcName, container.id).span;
  try {
    buildContainer(container);
  } catch (e: any) {
    console.log("BYTE VERIFY UNAVAILABLE: the full build does not link. The per-function");
    console.log("  verdict above does not depend on this; fix the build to check placement:");
    console.log((e.stderr || e.message || "").trim().split("\n").slice(-4).join("\n"));
    return false;
  }
  const offset = vramToRom(container, span.vram);
  const orig = readFileSync(containerTargetPath(container)).subarray(offset, offset + span.size);
  const built = readFileSync(containerPath(container, "builtBin")).subarray(offset, offset + span.size);
  if (orig.length !== span.size || built.length !== span.size) {
    console.log("BYTE VERIFY UNAVAILABLE: original or linked function bytes are truncated.");
    return false;
  }
  if (orig.equals(built)) {
    console.log("VERIFIED: byte-identical in the linked binary, at the original address.");
    return true;
  }
  console.log("LINKED BYTES DIFFER — the function does not match in place.");
  for (let w = 0; w + 4 <= span.size; w += 4) {
    const ow = orig.readUInt32LE(w);
    const bw = built.readUInt32LE(w);
    if (ow === bw) continue;
    const vram = span.vram + w;
    console.log(`  0x${vram.toString(16).toUpperCase()}: original ${ow.toString(16).padStart(8, "0")}  built ${bw.toString(16).padStart(8, "0")}`);
  }
  return false;
}

// --- Main ---
const rawArgs = process.argv.slice(2);
const watchMode = rawArgs.includes("--watch");
const columnsMode = rawArgs.includes("--columns");
const bytesMode = rawArgs.includes("--bytes");
const srcIndex = rawArgs.indexOf("--src");
const srcOverride = srcIndex >= 0 ? rawArgs[srcIndex + 1] : undefined;
const containerIndex = rawArgs.indexOf("--container");
const containerOverride = containerIndex >= 0 ? rawArgs[containerIndex + 1] : undefined;
const consumed = new Set([srcIndex + 1, containerIndex + 1].filter((i) => i > 0));
const positional = rawArgs.filter((arg, index) => !arg.startsWith("--") && !consumed.has(index));

if (positional.length !== 1) {
  console.error(
    "Usage: npx tsx tools/agent/diffFunc.ts <func_name> [--container <id>] [--src <file.c>] [--watch|--columns|--bytes]"
  );
  process.exit(1);
}

if (loadLibraryProject()) {
  if (watchMode || columnsMode || containerOverride) throw new Error("Library diff supports <member::symbol> [--src FILE] [--bytes]; no image containers/watch/columns adapter");
  try {
    const measured = measureLibraryFunction(positional[0]!, srcOverride);
    console.log(`target: ${measured.key} (${measured.member.input}[${measured.member.ordinal}])`);
    console.log(`source: ${measured.artifacts.source}`);
    console.log(renderLibraryComparison(measured.comparison));
    console.log(`Report: ${measured.report}`);
    process.exit(measured.comparison.verdict === "match" ? 0 : 1);
  } catch (error) { console.error(String(error)); process.exit(1); }
}
const funcName = positional[0].replace(/^src\//, "").replace(/\.c$/, "");

/* The container a function belongs to is derived, not typed by the operator.
   `--container` only settles a genuine ambiguity: two overlays that share a RAM
   slot can hold different functions with the same name. */
let location;
try {
  location = requireFunctionLocation(funcName, containerOverride);
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}
const container = location.container;

const src = srcOverride ?? join(container.paths.srcDir, `${funcName}.c`);
if (!existsSync(join(projectRoot(), src)) && !existsSync(src)) {
  console.error(`Not found: ${src}`);
  process.exit(1);
}

if (bytesMode) {
  const object = compile(src, funcName, container);
  const compared = compareFunction(funcName, { objectPath: object, container });
  if (compared.verdict !== "match" || !verifyLinkedBytes(funcName, container)) process.exitCode = 1;
} else {
  doDiff(funcName, src, container);
}

if (watchMode) {
  watchFile(src, { interval: 500 }, () => {
    doDiff(funcName, src, container);
  });
}
