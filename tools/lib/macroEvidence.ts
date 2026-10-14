/** Project-owned macro exceptions earned by evidence, not by an approval bit.
 * Ordinary C macros need no entry. Exceptional definitions are checked against
 * original instructions and fresh production byte comparisons on every audit. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseC, field, namedChildren } from "../agent/residual-source-search/tree-sitter-c.js";
import { walkActiveC } from "../agent/cSourceGuard.js";
import { targetWordsOf } from "./functionOracle.js";
import { resolveFunctionTarget, type FunctionTarget } from "./targetAdapter.js";
import { configuredSdkHeaders } from "./toolchain.js";
import { contextForProject, inRuntimeContext } from "./runtimeContext.js";
import { installedScriptArgs } from "./installedScripts.js";

export const MACRO_EVIDENCE_FILE = "configs/macro-evidence.json";
export const macroDefinitionHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export interface MacroDefinition { name: string; text: string; parameters: string; arity: number; body: string }
export interface MacroEvidenceEntry {
  name: string;
  header: string;
  definitionSha256: string;
  operation: string;
  rationale: string;
  witnesses: string[];
  sdk?: { header: string; macro: string };
}
export interface MacroEvidenceWitness {
  identity: string;
  source: string;
  originalWords: number[];
  exact: boolean;
  /** Must be a compiled non-match, never a compilation error or missing verdict. */
  withoutMacro?: "match" | "mismatch" | "inconclusive";
}
export interface MacroEvidenceHooks {
  verify: (entry: MacroEvidenceEntry, definition: MacroDefinition, witness: string) => MacroEvidenceWitness;
  sdkHeaders: () => string[];
}
export interface MacroEvidenceResult {
  definitions: Map<string, Map<string, number>>;
  failures: Array<{ file: string; message: string }>;
}

export function macroDefinitions(source: string): MacroDefinition[] {
  const tree = parseC(source), result: MacroDefinition[] = [];
  try { walkActiveC(tree.rootNode, node => {
    if (node.type !== "preproc_function_def") return true;
    const name = field(node, "name"), parameters = field(node, "parameters"), value = field(node, "value");
    if (name && parameters && value && !parameters.text.includes("...")) result.push({
      name: name.text, text: node.text, parameters: parameters.text,
      arity: namedChildren(parameters).filter(child => child.type === "identifier").length,
      body: value.text.replace(/\\\r?\n/g, "\n"),
    });
    return true;
  }); } finally { tree.delete(); }
  return result;
}

/** Small lexical view, not a C parser: preserve literals exactly and discard
 * comments only outside literals. Macro replacement lists need not parse as C. */
function macroTokens(body: string): string[] {
  return body.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_]\w*|(?:0[xX][\da-fA-F]+|\d+)[\w.]*|>>=|<<=|\.\.\.|->|\+\+|--|&&|\|\||<<|>>|<=|>=|==|!=|[+\-*/%&|^]=|##|[^\s]/g)
    ?.filter(token => !token.startsWith("/*") && !token.startsWith("//")) ?? [];
}
const codeTokens = (body: string) => macroTokens(body).map(token => /^["']/.test(token) ? "_literal_" : token).join(" ");

/** Ignore quoted mentions/comments, but never silently ignore opaque syntax. */
export function opaqueMacroControlHazard(body: string): boolean {
  return /\bgoto\s*\*|##/.test(codeTokens(body));
}
export function opaqueMacroHazard(body: string): boolean {
  return /\b(?:asm|__asm__|__asm|INCLUDE_ASM|INCLUDE_RODATA)\b/.test(codeTokens(body)) || opaqueMacroControlHazard(body);
}

function safeFile(root: string, path: string, includeOnly = false): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => part === ".." || part === "."))
    throw new Error("evidence paths must be safe project-relative paths");
  if (includeOnly && (!path.startsWith("include/") || !path.endsWith(".h")))
    throw new Error("exceptional macros belong in project include/*.h files");
  const file = resolve(root, path), actual = realpathSync(file), rel = relative(realpathSync(root), actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("evidence path escapes the project");
  return file;
}
function sameBinding(a: MacroDefinition, b: MacroDefinition): boolean {
  const normalize = (s: string) => JSON.stringify(macroTokens(s));
  return normalize(a.parameters) === normalize(b.parameters) && normalize(a.body) === normalize(b.body);
}
function instructionKinds(words: number[]): Set<string> {
  const kinds = new Set<string>();
  for (const word of words) {
    const op = word >>> 26;
    if (op === 0x10) kinds.add("cop0");
    if (op === 0x12 || op === 0x32 || op === 0x3a) kinds.add("cop2");
    if (op === 8) kinds.add("trapping-add");
    if (op === 0 && (word & 63) === 12) kinds.add("syscall");
    if (op === 0 && (word & 63) === 13) kinds.add("break");
  }
  // A load through the destination followed by jr is an original-word witness,
  // not an allocator guess. The final nop is the architectural delay slot.
  for (let i = 0; i + 4 < words.length; i++) {
    const [hi, load, wait, jump, delay] = words.slice(i, i + 5), reg = hi! >>> 16 & 31;
    if (hi! >>> 26 === 15 && reg !== 0 && reg !== 31 && load! >>> 26 === 35 &&
        (load! >>> 21 & 31) === reg && (load! >>> 16 & 31) === reg && wait === 0 &&
        jump === ((reg << 21 | 8) >>> 0) && delay === 0) kinds.add("loaded-transfer");
  }
  return kinds;
}
function assemblyTemplates(body: string): string {
  const tokens = macroTokens(body), templates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!["asm", "__asm", "__asm__"].includes(tokens[i]!)) continue;
    let at = i + 1;
    if (/^(?:__)?volatile(?:__)?$/.test(tokens[at] ?? "")) at++;
    if (tokens[at++] !== "(") continue;
    let template = "";
    while (tokens[at]?.startsWith('"')) template += tokens[at++]!.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, " ");
    templates.push(template);
  }
  return templates.join("\n");
}
function bodyKinds(body: string): Set<string> {
  const kinds = new Set<string>(), assembly = assemblyTemplates(body).replace(/#[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  const instructions = assembly.split(/[;\n]/).map(line => line.trim().replace(/^(?:[A-Za-z_]\w*|\d+):\s*/, ""));
  if (/\bgoto\s*\*/.test(codeTokens(body))) kinds.add("loaded-transfer");
  if (instructions.some(line => /^(?:mfc0|mtc0|cfc0|ctc0|rfe)\b/.test(line))) kinds.add("cop0");
  if (instructions.some(line => /^(?:mfc2|mtc2|cfc2|ctc2|lwc2|swc2)\b/.test(line))) kinds.add("cop2");
  if (instructions.some(line => /^addi\s/.test(line))) kinds.add("trapping-add");
  if (instructions.some(line => /^syscall\b/.test(line))) kinds.add("syscall");
  if (instructions.some(line => /^break\b/.test(line))) kinds.add("break");
  for (const match of instructions.join("\n").matchAll(/^\.word\s+(0x[\da-f]+|\d+)\b/gim))
    for (const kind of instructionKinds([Number(match[1]) >>> 0])) kinds.add(kind);
  return kinds;
}
function hasInvocation(source: string, name: string, arity: number): boolean {
  const tree = parseC(source); let found = false;
  try { walkActiveC(tree.rootNode, node => {
    if (node.type === "call_expression" && field(node, "function")?.text === name &&
        namedChildren(field(node, "arguments")!).filter(child => child.type !== "comment").length === arity) found = true;
    return true;
  }); } finally { tree.delete(); }
  return found;
}
function byteVerdict(root: string, witness: string, source?: string): "match" | "mismatch" | "inconclusive" {
  try {
    const output = execFileSync(process.execPath, installedScriptArgs("tools/agent/diffFunc.ts", [witness, ...(source ? ["--src", source] : [])], root), {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const verdict = [...output.matchAll(/^VERDICT:\s*(MATCH|MISMATCH|UNDETERMINED|STUB)\b/gm)].at(-1)?.[1];
    return verdict === "MATCH" ? "match" : verdict === "MISMATCH" ? "mismatch" : "inconclusive";
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = String(e.stdout ?? "") + String(e.stderr ?? "");
    // A failed compiler can print earlier neighboring summaries. Never turn
    // that into a positive material-use proof.
    return /(?:error:|failed|Invalid C|Traceback)/i.test(output) ? "inconclusive" :
      /^VERDICT:\s*MISMATCH\b/m.test(output) ? "mismatch" : "inconclusive";
  }
}
/** Disable only invocations in the selected function. Whole-TU comparison must
 * not mistake a live neighbor for a dead use in the requested witness. */
export function macroWitnessCounterfactual(source: string, symbol: string, name: string): { witnessSource: string; candidate: string; uses: number } {
  const tree = parseC(source), edits: Array<{ start: number; end: number; text: string }> = []; let witnessSource = "";
  try { walkActiveC(tree.rootNode, node => {
    if (node.type !== "function_definition") return true;
    let declarator = field(node, "declarator");
    while (declarator && declarator.type !== "identifier") declarator = field(declarator, "declarator");
    if (declarator?.text === symbol) {
      witnessSource = node.text;
      walkActiveC(node, call => {
        if (call.type !== "call_expression" || field(call, "function")?.text !== name) return true;
        const argumentsNode = field(call, "arguments");
        const args = argumentsNode ? namedChildren(argumentsNode).filter(child => child.type !== "comment").map(child => `(void)(${child.text})`) : [];
        edits.push({ start: call.startIndex, end: call.endIndex, text: `(${[...args, "0"].join(", ")})` });
        return false;
      });
    }
    return false;
  }); } finally { tree.delete(); }
  let candidate = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) candidate = candidate.slice(0, edit.start) + edit.text + candidate.slice(edit.end);
  return { witnessSource, candidate, uses: edits.length };
}
/** Aliases share a start coordinate even when their inferred spans differ. */
export function originalMacroWitnessIdentity(target: Pick<FunctionTarget, "owner" | "coordinate">): string {
  const at = target.coordinate;
  if (at.kind === "image" && at.vram === undefined) throw new Error("original witness has no resolved code coordinate");
  return JSON.stringify([target.owner.id, at.kind, ...(at.kind === "image" ? [at.vram] : [at.section, at.offset])]);
}
function productionHooks(root: string): MacroEvidenceHooks {
  return {
    sdkHeaders: () => configuredSdkHeaders(root),
    verify: (entry, _definition, witness) => inRuntimeContext(contextForProject(root), () => {
      const target = resolveFunctionTarget(witness, root), file = resolve(root, target.source), source = readFileSync(file, "utf8");
      const originalWords = targetWordsOf(witness).map(word => word.raw);
      const exact = byteVerdict(root, witness) === "match";
      const disabled = macroWitnessCounterfactual(source, target.symbol, entry.name);
      let withoutMacro: MacroEvidenceWitness["withoutMacro"];
      if (!entry.sdk && exact && disabled.uses) {
        const folder = resolve(root, "build/macroEvidence"); mkdirSync(folder, { recursive: true });
        const run = mkdtempSync(join(folder, "counterfactual-")), candidate = join(run, "without-macro.c");
        // Preserve local quoted-include resolution when parking the variant.
        const preserved = disabled.candidate.replace(/^(\s*#\s*include\s*)"([^"\n]+)"/gm, (line, prefix, header) => {
          const local = resolve(dirname(file), header);
          return existsSync(local) ? `${prefix}${JSON.stringify(local)}` : line;
        });
        writeFileSync(candidate, preserved);
        withoutMacro = byteVerdict(root, witness, candidate);
      }
      if (readFileSync(file, "utf8") !== source) throw new Error(`${witness}: source changed during evidence verification`);
      return { identity: originalMacroWitnessIdentity(target), source: disabled.witnessSource, originalWords, exact, withoutMacro };
    }),
  };
}

export function evaluateMacroEvidence(root: string, injected?: MacroEvidenceHooks): MacroEvidenceResult {
  const result: MacroEvidenceResult = { definitions: new Map(), failures: [] }, manifest = resolve(root, MACRO_EVIDENCE_FILE);
  if (!existsSync(manifest)) return result;
  try {
    const manifestSource = readFileSync(manifest, "utf8"), data = JSON.parse(manifestSource);
    if (data?.version !== 1 || !Array.isArray(data.macros)) throw new Error("expected version:1 and a macros array");
    const hooks = injected ?? productionHooks(root), seen = new Set<string>();
    for (const entry of data.macros as MacroEvidenceEntry[]) {
      try {
        if (!entry || typeof entry.name !== "string" || !/^[A-Za-z_]\w*$/.test(entry.name) || seen.has(entry.name)) throw new Error("macro names must be unique C identifiers");
        seen.add(entry.name);
        if (typeof entry.operation !== "string" || !entry.operation.trim() || typeof entry.rationale !== "string" || !entry.rationale.trim()) throw new Error("name the semantic operation and its positive evidence, not a failed search");
        const file = safeFile(root, entry.header, true), source = readFileSync(file, "utf8");
        const definitions = macroDefinitions(source).filter(definition => definition.name === entry.name);
        if (definitions.length !== 1) throw new Error("expected one active, fixed-arity function-like definition in the include file");
        const definition = definitions[0]!;
        if (entry.definitionSha256 !== macroDefinitionHash(definition.text)) throw new Error("definition changed: rerun its evidence checks and update its fingerprint");
        if (/\.(?:globl|global|ent|end|incbin|include|text)\b/.test(assemblyTemplates(definition.body)) || /\bINCLUDE_(?:ASM|RODATA)\b/.test(codeTokens(definition.body))) throw new Error("whole-function assembly and assembly stubs are not operation macros");
        let sdk = false;
        if (entry.sdk) {
          const sdkFile = safeFile(root, entry.sdk.header), roots = hooks.sdkHeaders().map(path => realpathSync(resolve(root, path)));
          const actual = realpathSync(sdkFile);
          if (!roots.some(path => { const rel = relative(path, actual); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); })) throw new Error("SDK witness must come from configured immutable reference headers");
          const original = macroDefinitions(readFileSync(sdkFile, "utf8")).filter(value => value.name === entry.sdk!.macro);
          sdk = original.length === 1 && sameBinding(definition, original[0]!);
          if (!sdk) throw new Error("definition does not reproduce the referenced SDK macro binding");
        }
        if (!Array.isArray(entry.witnesses) || entry.witnesses.some(witness => typeof witness !== "string" || !witness) || new Set(entry.witnesses).size !== entry.witnesses.length || entry.witnesses.length < (sdk ? 1 : 2))
          throw new Error("need an authoritative SDK binding plus a measured use, or two independent original-code uses");
        const identities = new Set<string>(), kinds = bodyKinds(definition.body);
        for (const witness of entry.witnesses) {
          const proof = hooks.verify(entry, definition, witness);
          if (!hasInvocation(proof.source, entry.name, definition.arity)) throw new Error(`${witness}: no active invocation with the declared arity`);
          if (!proof.exact) throw new Error(`${witness}: production byte oracle is not MATCH`);
          identities.add(proof.identity);
          if (!sdk) {
            const original = instructionKinds(proof.originalWords);
            if (![...kinds].some(kind => original.has(kind))) throw new Error(`${witness}: no positive original hardware/ABI-operation witness; allocation difficulty is insufficient`);
            if (proof.withoutMacro !== "mismatch") throw new Error(`${witness}: removing the operation did not produce a compiled non-match; dead or inconclusive uses are insufficient`);
          }
        }
        if (identities.size < (sdk ? 1 : 2)) throw new Error("aliases of the same original code are not independent witnesses");
        if (readFileSync(file, "utf8") !== source) throw new Error("header changed during evidence verification");
        const header = relative(root, file).replaceAll("\\", "/");
        const allowed = result.definitions.get(header) ?? new Map<string, number>();
        allowed.set(entry.name, definition.arity); result.definitions.set(header, allowed);
      } catch (error) { result.failures.push({ file: typeof entry?.header === "string" ? entry.header : MACRO_EVIDENCE_FILE, message: `${entry?.name ?? "macro"}: ${error instanceof Error ? error.message : String(error)}` }); }
    }
    if (readFileSync(manifest, "utf8") !== manifestSource) throw new Error("macro evidence manifest changed during verification");
  } catch (error) { result.failures.push({ file: MACRO_EVIDENCE_FILE, message: error instanceof Error ? error.message : String(error) }); }
  return result;
}
