/** Original-word MIPS I provenance heuristics. Scores are an explainable
 * ranking, NOT probabilities or a proof of historical source language. No
 * failed C experiment, function name, disassembly comment or source spelling
 * contributes to the score. This module never compiles or modifies source. */
import { decodeMacroFunction, REGISTER_NAMES, type MacroInstruction } from "../diagnostics/macroInstructions.js";
import type { MacroFunction } from "../diagnostics/macroTiler.js";
import { digest } from "./contentCache.js";

export interface StorageReference { reference: string; addend: number }
export interface HandwrittenFunction extends MacroFunction {
  /** Full symbolic addends, including paired HI16/LO16, indexed by word. */
  storageReferences?: ReadonlyMap<number, StorageReference>;
}
export interface AssemblyEvidence {
  /** Function-relative byte offset. The row supplies its image/section origin. */
  offset: number; word: string; instruction: string; storage?: string;
  role?: "copied-payload";
}
export interface EmbeddedCopy {
  source: { offset: number; size: number };
  loop: { load: number; store: number; latch: number; iterations: number };
  interpretation: "kernel-context-fragment" | "unclassified-bytes";
  evidence: AssemblyEvidence[];
}
export interface HookCopySite { function: string; load: number; store: number; latch: number; bytes: number }
export interface CodeHookLifecycle {
  role: "installer" | "restorer";
  destination: string;
  buffer: { function: string; offset: number; size: number };
  trampoline: { function: string; offset: number; size: number; target: string };
  save: HookCopySite; install: HookCopySite; restore: HookCopySite;
  witnesses: Array<{ function: string; originalSha256: string; relocationSha256: string }>;
}
export interface CopiedTransfer {
  install: HookCopySite;
  template: { function: string; offset: number; templateBytes: 16; copiedBytes: number; delaySlotCopied: boolean; evidence: AssemblyEvidence[] };
  target: { kind: "local-entry"; function: string; offset: number; reachableWords: number; returns: number[]; exceptionReturns: number[] } |
    { kind: "deployed-entry"; function: string; offset: number; address: number; physicalAddress: number;
      deployment: { copy: HookCopySite; destination: number; sourceOffset: number; entryOffset: number } };
  witnesses: CodeHookLifecycle["witnesses"];
}
export interface AssemblySignal {
  id: string; family: "calling-convention" | "context" | "arithmetic" | "hardware" | "scheduling" | "code-patching";
  weight: number; structural: boolean; description: string; evidence: AssemblyEvidence[];
}
export interface HandwrittenReading {
  function: string; container: string;
  coordinate: { kind: "section"; section: string; offset: number; inferredSize: boolean } | { kind: "image"; vram: number };
  originalSha256: string; relocationSha256: string; size: number;
  confidence: { score: number; level: "high" | "medium" | "low" | "undetermined"; scale: "heuristic-not-probability" };
  classification: "likely-handwritten" | "possible-handwritten" | "no-strong-evidence" | "undetermined";
  assemblyCandidate: boolean; threshold: number; signals: AssemblySignal[];
  embeddedCopies: EmbeddedCopy[];
  codeHooks: CodeHookLifecycle[];
  copiedTransfers: CopiedTransfer[];
  analysis: { complete: boolean; totalWords: number; reachableWords: number; unreachableWords: number; limitations: string[] };
  facts: { calls: number[]; returns: number[]; stackWrites: number[]; unknownWords: number[] };
}

const CALLER_SAVED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 25];
const SAVED_CONTEXT = new Set([16, 17, 18, 19, 20, 21, 22, 23, 29, 31]);
const BRANCHES = new Set(["beq", "bne", "blez", "bgtz", "bltz", "bgez", "bltzal", "bgezal", "bc2"]);
const BIOS = new Set([0xa0, 0xb0, 0xc0]);
const U = "?";
/** Exact-value-or-unknown lattice. Roots distinguish stack aliases, incoming
 * context pointers, fixed addresses, loaded values and call link addresses. */
type Value = string;
type State = Value[];
interface Address { root: string; offset: number; key: string; stack: boolean }
const constant = (n: number): Value => `constant:${n >>> 0}`;
const numberOf = (v: Value): number | undefined => v.startsWith("constant:") ? Number(v.slice(9)) : undefined;
const affine = (root: string, offset: number): Value => `${root}|${offset}`;
function affineOf(value: Value): { root: string; offset: number } | undefined {
  const at = value.lastIndexOf("|");
  return at < 0 ? undefined : { root: value.slice(0, at), offset: Number(value.slice(at + 1)) };
}
const same = (a: State, b: State) => a.every((v, r) => v === b[r]);
const isCall = (i: MacroInstruction) => i.op === "jal" || i.op === "bltzal" || i.op === "bgezal" || (i.op === "jalr" && i.writes.some(r => r !== 0));
const isTransfer = (i: MacroInstruction) => i.control && i.op !== "break";
const stripReloc = (op: string) => op.replace(/^reloc-/, "");

/** The common macro decoder intentionally leaves privileged operations opaque.
 * Decode their GPR effects here without treating COP registers as GPRs. */
function instructions(fn: HandwrittenFunction): MacroInstruction[] {
  return decodeMacroFunction(fn).map(i => {
    i.op = stripReloc(i.op);
    const w = i.word, op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;
    if (op === 0x10 && [0, 4].includes(rs) && !(w & 0x7ff)) return { ...i, op: rs === 0 ? "mfc0" : "mtc0",
      args: [{ kind: "gpr" as const, value: rt }, { kind: "cop" as const, value: rd }], reads: rs === 4 ? [rt] : [], writes: rs === 0 ? [rt] : [] };
    if (w === 0x42000010) return { ...i, op: "rfe", args: [], reads: [], writes: [], control: false };
    if (op === 0 && (w & 63) === 0x0c) return { ...i, op: "syscall", args: [], reads: [], writes: [], control: false };
    if (op === 0 && [0x11, 0x13].includes(w & 63)) return { ...i, op: (w & 63) === 0x11 ? "mthi" : "mtlo",
      args: [{ kind: "gpr" as const, value: rs }], reads: [rs], writes: [], control: false };
    if (op === 1 && [16, 17].includes(rt)) return { ...i, op: rt === 16 ? "bltzal" : "bgezal", control: true,
      target: fn.relocations?.has((i.vram - fn.vram) / 4) ? i.target : (i.vram + 4 + ((w << 16) >> 16) * 4) >>> 0,
      args: [{ kind: "gpr" as const, value: rs }], reads: [rs], writes: [31] };
    return i;
  });
}
function addressAt(fn: HandwrittenFunction, n: number, i: MacroInstruction, state: State): Address | undefined {
  if (!i.memory || i.args[2]?.kind !== "gpr") return;
  const base = state[i.args[2].value]!, reference = fn.storageReferences?.get(n), relocation = fn.relocations?.get(n);
  if (reference) {
    // A low relocation is an address only in conjunction with the proper HI
    // register (or GP). Never interpret an unresolved field as an absolute 0.
    const hi = affineOf(base);
    const upperMatches = hi?.root === `hi:${reference.reference}` &&
      Math.floor((hi.offset + 0x8000) / 0x10000) === Math.floor((reference.addend + 0x8000) / 0x10000);
    if (!upperMatches && !(relocation?.type === 7 && base === affine("entry:28", 0))) return;
    const root = `symbol:${reference.reference}`, offset = reference.addend;
    return { root, offset, key: affine(root, offset), stack: false };
  }
  if (relocation && relocation.type !== 0) return;
  const immediate = i.args[1]!.value, value = numberOf(base);
  if (value !== undefined) {
    const address = (value + immediate) >>> 0, root = `absolute:${Math.floor(address / 0x10000) * 0x10000}`;
    return { root, offset: address & 0xffff, key: `absolute:${address}`, stack: false };
  }
  const a = affineOf(base);
  if (!a || !(a.root === "stack" || /^entry:(?:[4-7]|2[678])$/.test(a.root) || a.root.startsWith("symbol:"))) return;
  const offset = a.offset + immediate;
  return { root: a.root, offset, key: affine(a.root, offset), stack: a.root === "stack" };
}
function apply(fn: HandwrittenFunction, n: number, i: MacroInstruction, input: State): State {
  const state = [...input], d = i.writes.find(r => r !== 0);
  if (i.op === "unknown") { state.fill(U); state[0] = constant(0); return state; }
  if (d === undefined) return state;
  state[d] = U;
  const ref = fn.storageReferences?.get(n), relocated = fn.relocations?.get(n)?.type;
  if (isCall(i)) state[d] = `link:${n}`;
  else if (i.op === "lui") state[d] = ref ? affine(`hi:${ref.reference}`, ref.addend) : relocated ? U : constant(i.args[1]!.value << 16);
  else if (i.op === "lw") {
    const address = addressAt(fn, n, i, input);
    if (address) state[d] = affine(`loaded:${JSON.stringify(address.key)}`, 0);
  } else if (["addiu", "addi"].includes(i.op)) {
    const base = input[i.args[1]!.value]!, a = affineOf(base), v = numberOf(base), imm = i.args[2]!.value;
    if (ref && a?.root === `hi:${ref.reference}` && Math.floor((a.offset + 0x8000) / 0x10000) === Math.floor((ref.addend + 0x8000) / 0x10000))
      state[d] = affine(`symbol:${ref.reference}`, ref.addend);
    else if (!relocated) state[d] = v !== undefined ? constant(v + imm) : a ? affine(a.root, a.offset + imm) : U;
  } else if (["addu", "add", "or"].includes(i.op)) {
    const a = input[i.args[1]!.value]!, b = input[i.args[2]!.value]!, x = numberOf(a), y = numberOf(b);
    if (x === 0) state[d] = b;
    else if (y === 0) state[d] = a;
    else if (x !== undefined && y !== undefined) state[d] = constant(i.op === "or" ? x | y : x + y);
  } else if (i.op === "ori" && !relocated) {
    const base = numberOf(input[i.args[1]!.value]!);
    if (base !== undefined) state[d] = constant(base | i.args[2]!.value);
  }
  state[0] = constant(0);
  return state;
}
function exceptionReturn(insns: MacroInstruction[], n: number): boolean {
  const jump = insns[n];
  if (jump?.op !== "jr" || insns[n + 1]?.op !== "rfe") return false;
  const reg = jump.reads[0]!;
  if ([26, 27].includes(reg)) return true;
  for (let k = n - 1; k >= 0 && k >= n - 8; k--) {
    const i = insns[k]!;
    if (i.op === "mfc0" && i.writes.includes(reg) && i.args[1]?.value === 14) return true;
    if (i.control || i.op === "unknown" || i.writes.includes(reg)) break;
  }
  return false;
}

/** Delay slots belong to their transfer edges. Calls install the link before
 * the slot and clobber volatile GPRs after it. Unreachable padding/data never
 * contributes evidence. Unknown control and words cap confidence. */
function flow(fn: HandwrittenFunction, insns: MacroInstruction[], entryWord = 0) {
  const states: Array<State | undefined> = insns.map(() => undefined), reachable = new Set<number>(), limitations = new Set<string>();
  const entry = Array.from({ length: 32 }, (_, r) => r === 0 ? constant(0) : r === 29 ? affine("stack", 0) : affine(`entry:${r}`, 0));
  const queue: number[] = [], queued = new Set<number>(), slots = new Set<number>(), nodes = new Set<number>();
  const edges = new Map<number, Set<number>>(), transferStates = new Map<number, State>();
  const merge = (n: number, state: State, slot = false, from?: number) => {
    if (n < 0 || n >= insns.length) { limitations.add("Control falls outside the recorded function extent"); return; }
    if (!slot && from !== undefined) {
      const destinations = edges.get(from) ?? new Set<number>(); destinations.add(n); edges.set(from, destinations);
    }
    reachable.add(n);
    if (slot) slots.add(n); else nodes.add(n);
    const old = states[n], next = old ? old.map((v, r) => v === state[r] ? v : U) : [...state];
    if (!old || !same(old, next)) { states[n] = next; if (!slot && !queued.has(n)) { queue.push(n); queued.add(n); } }
  };
  merge(entryWord, entry);
  const target = (i: MacroInstruction): number | undefined => i.target === null ? undefined : (i.target - fn.vram) / 4;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const n = queue[cursor]!; queued.delete(n);
    const i = insns[n]!, before = states[n]!, after = apply(fn, n, i, before);
    if (i.op === "unknown") limitations.add("Reachable undecoded instruction(s); register/control effects are incomplete");
    if (!i.control) { merge(n + 1, after, false, n); continue; }
    if (i.op === "break") continue; // synchronous exception, NOT a delay-slot owner
    const slot = insns[n + 1];
    if (!slot) { limitations.add("Missing transfer delay slot"); continue; }
    merge(n + 1, after, true);
    if (slot.control) { limitations.add("Control transfer in a delay slot"); continue; }
    if (slot.op === "unknown") limitations.add("Reachable undecoded instruction(s); register/control effects are incomplete");
    const out = apply(fn, n + 1, slot, after);
    transferStates.set(n, [...out]); // argument values seen by the callee
    if (isCall(i)) {
      for (const r of CALLER_SAVED) out[r] = U;
      merge(n + 2, out, false, n); // a potentially returning call, not a jump to raw REL addends
    } else if (BRANCHES.has(i.op)) {
      const a = i.args[0]?.value, b = i.args[1]?.value;
      const always = i.op === "beq" && a === b, never = i.op === "bne" && a === b;
      if (!never) {
        const destination = target(i);
        if (destination !== undefined && Number.isInteger(destination)) merge(destination, out, false, n);
        else limitations.add("Unresolved conditional branch target");
      }
      if (!always) merge(n + 2, out, false, n);
    } else if (i.op === "j") {
      const destination = target(i);
      if (destination !== undefined && destination >= 0 && destination < insns.length && Number.isInteger(destination)) merge(destination, out, false, n);
      else if (i.target === null && !i.callee) limitations.add("Unresolved direct jump target");
    } else if (i.op === "jr" || i.op === "jalr") {
      const reg = i.reads[0]!, value = before[reg]!;
      if (reg !== 31 && !exceptionReturn(insns, n) && !BIOS.has(numberOf(value) ?? -1))
        limitations.add("Unresolved indirect jump; possible jump-table paths were not traversed");
    } else limitations.add("Unsupported control-flow instruction");
  }
  if ([...slots].some(n => nodes.has(n))) limitations.add("A branch enters another transfer's delay slot");
  return { states, reachable: [...reachable].sort((a, b) => a - b), limitations, edges, transferStates };
}

/** Only map exact in-function addresses. Raw REL fields and equal low halves
 * cannot establish a self-reference; ET_REL needs normalized section addends. */
function localOffset(fn: HandwrittenFunction, value: Value): number | undefined {
  if (!fn.coordinate) {
    const absolute = numberOf(value);
    return absolute === undefined ? undefined : absolute - fn.vram;
  }
  const a = affineOf(value);
  return a?.root === `symbol:section:${fn.coordinate.section}` ? a.offset - fn.coordinate.offset : undefined;
}

interface WordCopy { source: Value; destination: Value; size: number; load: number; store: number; latch: number; sites: number[] }
function plus(value: Value, offset: number): Value {
  const n = numberOf(value), a = affineOf(value);
  return n !== undefined ? constant(n + offset) : a ? affine(a.root, a.offset + offset) : U;
}
function difference(end: Value, start: Value): number | undefined {
  const x = numberOf(end), y = numberOf(start), a = affineOf(end), b = affineOf(start);
  return x !== undefined && y !== undefined ? x - y : a && b && a.root === b.root ? a.offset - b.offset : undefined;
}

/** Single-entry, 1..64-word copies, bounded by either pointer. Register
 * forwarding, +4 inductions and MIPS-I load spacing are checked independently
 * of what the bytes mean. A copy alone is never assembly-origin evidence. */
function wordCopies(fn: HandwrittenFunction, insns: MacroInstruction[], traced: ReturnType<typeof flow>): WordCopy[] {
  const found: WordCopy[] = [], reachable = new Set(traced.reachable);
  const increments = (n: number, reg: number) => insns[n]!.op === "addiu" && insns[n]!.args[0]?.value === reg &&
    insns[n]!.args[1]?.value === reg && insns[n]!.args[2]?.value === 4;
  for (const latch of traced.reachable) {
    const branch = insns[latch]!, head = branch.target === null ? -1 : (branch.target - fn.vram) / 4;
    if (branch.op !== "bne" || !Number.isInteger(head) || head < 1 || head >= latch || latch + 1 >= insns.length) continue;
    const body = Array.from({ length: latch + 2 - head }, (_, n) => n + head);
    if (body.some(n => !reachable.has(n) || (n !== latch && insns[n]!.control))) continue;
    if (insns[head - 1]!.control || !traced.edges.get(head - 1)?.has(head)) continue;
    if ([...traced.edges].some(([from, destinations]) => (from < head || from > latch + 1) &&
      [...destinations].some(to => to >= head && to <= latch + 1 && !(from === head - 1 && to === head)))) continue;
    const before = traced.states[head - 1]; if (!before) continue;
    const entry = apply(fn, head - 1, insns[head - 1]!, before);
    const loads = body.filter(n => insns[n]!.op === "lw"), stores = body.filter(n => insns[n]!.op === "sw");
    if (loads.length !== 1 || stores.length !== 1) continue;
    const load = loads[0]!, store = stores[0]!, li = insns[load]!, si = insns[store]!;
    const data = li.args[0]!.value, src = li.args[2]!.value, dst = si.args[2]!.value;
    if (src === dst || [0, src, dst].includes(data) || !src || !dst || dst === 29 || store <= load + 1 || si.args[0]!.value !== data ||
      affineOf(entry[dst]!)?.root === "stack" || insns.slice(load + 1, store).some(i => i.writes.includes(data))) continue;
    const sourceSteps = body.filter(n => insns[n]!.writes.includes(src)), destinationSteps = body.filter(n => insns[n]!.writes.includes(dst));
    if (sourceSteps.length !== 1 || destinationSteps.length !== 1 || !increments(sourceSteps[0]!, src) || !increments(destinationSteps[0]!, dst)) continue;
    for (const [bounded, limit] of [[branch.args[0]!.value, branch.args[1]!.value], [branch.args[1]!.value, branch.args[0]!.value]] as const) {
      if (![src, dst].includes(bounded) || [src, dst, data].includes(limit) || body.some(n => insns[n]!.writes.includes(limit))) continue;
      if ((bounded === src ? sourceSteps[0]! : destinationSteps[0]!) >= latch) continue;
      const size = difference(entry[limit]!, entry[bounded]!);
      if (size === undefined || size <= 0 || size % 4 || size > 64 * 4) continue;
      const allowed = new Set([load, store, sourceSteps[0]!, destinationSteps[0]!, latch]);
      if (body.some(n => !allowed.has(n) && insns[n]!.word !== 0)) continue;
      const source = plus(entry[src]!, li.args[1]!.value + (sourceSteps[0]! < load ? 4 : 0));
      const destination = plus(entry[dst]!, si.args[1]!.value + (destinationSteps[0]! < store ? 4 : 0));
      const setup: number[] = [];
      for (let n = head - 1; n >= 0 && !insns[n]!.control; n--)
        if (insns[n]!.writes.some(r => [src, dst, limit].includes(r))) setup.push(n);
      found.push({ source, destination, size, load, store, latch, sites: [...setup, load, store, latch] });
    }
  }
  return found;
}

/** Interpret only exactly addressed, non-executed local payloads here.
 * External buffers require the separate, same-module lifecycle evidence. */
function embeddedCopies(fn: HandwrittenFunction, insns: MacroInstruction[], traced: ReturnType<typeof flow>) {
  return wordCopies(fn, insns, traced).flatMap(copy => {
    const source = localOffset(fn, copy.source);
    if (source === undefined || source % 4 || source < 0 || source + copy.size > fn.bytes.length) return [];
    const payload = Array.from({ length: copy.size / 4 }, (_, n) => source / 4 + n);
    if (payload.some(n => traced.reachable.includes(n))) return [];
    const relocated = payload.some(n => (fn.relocations?.get(n)?.type ?? 0) !== 0);
    const saves = payload.filter(n => insns[n]!.op === "sw"), regs = new Set(saves.map(n => insns[n]!.args[0]!.value));
    const slots = new Set(saves.map(n => insns[n]!.args[1]!.value)), base = insns[saves[0] ?? -1]?.args[2]?.value;
    const kernel = !relocated && (base === 26 || base === 27) && regs.has(31) && regs.size >= 3 &&
      regs.size === saves.length && slots.size === saves.length && payload.every(n => !insns[n]!.writes.includes(base)) &&
      saves.every(n => insns[n]!.args[2]!.value === base && insns[n]!.args[1]!.value >= 0 &&
        insns[n]!.args[1]!.value <= 0x100 && insns[n]!.args[1]!.value % 4 === 0 &&
        !payload.some(p => p < n && insns[p]!.writes.includes(insns[n]!.args[0]!.value))) &&
      payload.some(n => insns[n]!.op === "mfc0" && insns[n]!.args[1]?.value === 14) &&
      payload.every(n => insns[n]!.word === 0 || insns[n]!.op === "sw" ||
        (insns[n]!.op === "mfc0" && [13, 14].includes(insns[n]!.args[1]!.value)));
    return [{ ...copy, source, iterations: copy.size / 4, payload, kernel }];
  });
}

function instructionEvidence(insns: MacroInstruction[], n: number, storage?: string): AssemblyEvidence {
  const i = insns[n]!;
  return { offset: n * 4, word: `0x${i.word.toString(16).padStart(8, "0")}`,
    instruction: `${i.op}${i.args.length ? " " : ""}${i.args.map(a => a.kind === "gpr" ? `$${REGISTER_NAMES[a.value]}` : a.kind === "cop" ? `$c${a.value}` : a.kind === "address" ? `0x${a.value.toString(16)}` : a.value).join(", ")}${i.callee ? ` <${i.callee}>` : ""}`,
    ...(storage && i.memory ? { storage } : {}) };
}

export function analyzeHandwrittenFunction(fn: HandwrittenFunction, options: { threshold?: number } = {}): HandwrittenReading {
  const threshold = options.threshold ?? 80;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new Error("Assembly threshold must be an integer in 1..100");
  const row: HandwrittenReading = {
    function: fn.name, container: fn.container,
    coordinate: fn.coordinate ? { kind: "section", ...fn.coordinate } : { kind: "image", vram: fn.vram },
    originalSha256: digest(fn.bytes), relocationSha256: digest(JSON.stringify({ relocations: [...fn.relocations ?? []], storage: [...fn.storageReferences ?? []] })), size: fn.bytes.length,
    confidence: { score: 0, level: "undetermined", scale: "heuristic-not-probability" }, classification: "undetermined", assemblyCandidate: false,
    threshold, signals: [], embeddedCopies: [], codeHooks: [], copiedTransfers: [], analysis: { complete: false, totalWords: fn.bytes.length / 4, reachableWords: 0, unreachableWords: 0, limitations: [] },
    facts: { calls: [], returns: [], stackWrites: [], unknownWords: [] },
  };
  if (!fn.bytes.length || fn.bytes.length % 4 || fn.vram % 4 || !Number.isSafeInteger(fn.vram) || fn.vram < 0 || fn.vram + fn.bytes.length > 0x1_0000_0000) {
    row.analysis.limitations.push("Empty, unaligned or invalid original function extent"); return row;
  }
  const insns = instructions(fn), traced = flow(fn, insns), live = traced.reachable;
  const evidence = (n: number, storage?: string) => instructionEvidence(insns, n, storage);
  const add = (id: string, family: AssemblySignal["family"], weight: number, structural: boolean, description: string, sites: number[], storage?: string) => {
    row.signals.push({ id, family, weight, structural, description, evidence: [...new Set(sites)].sort((a, b) => a - b).map(n => evidence(n, storage)) });
  };
  const calls = live.filter(n => isCall(insns[n]!)), returns = live.filter(n => insns[n]!.op === "jr" && insns[n]!.reads[0] === 31);
  const stackWrites = live.filter(n => insns[n]!.writes.includes(29)), unknown = live.filter(n => insns[n]!.op === "unknown");
  row.facts = { calls: calls.map(n => n * 4), returns: returns.map(n => n * 4), stackWrites: stackWrites.map(n => n * 4), unknownWords: unknown.map(n => n * 4) };
  const memory = live.flatMap(n => {
    const i = insns[n]!, address = addressAt(fn, n, i, traced.states[n]!);
    return address ? [{ n, i, address, state: traced.states[n]! }] : [];
  });
  const entryReturnSaves = memory.filter(m => m.i.op === "sw" && m.i.args[0]?.value === 31 && m.state[31] === affine("entry:31", 0) && !m.address.stack);
  const pairs = entryReturnSaves.flatMap(save => {
    // A straight entry prefix dominates every subsequent path. Do not join
    // unrelated store/restore arms into invented return preservation.
    if (insns.slice(0, save.n).some(i => i.control)) return [];
    return returns.filter(n => calls.some(c => c > save.n && c < n) && traced.states[n]![31] === affine(`loaded:${JSON.stringify(save.address.key)}`, 0))
      .map(ret => ({ save, ret }));
  });
  if (pairs.length && !stackWrites.length) {
    const p = pairs[0]!, reload = memory.filter(m => m.i.op === "lw" && m.i.args[0]?.value === 31 && m.address.key === p.save.address.key);
    add("external-return-state", "calling-convention", 65, true,
      "Entry $ra is saved outside the stack, reloaded from the same storage and used to return after linking calls, with no reachable $sp write", [p.save.n, ...calls, ...reload.map(m => m.n), p.ret], p.save.address.key);
  } else if (entryReturnSaves.length) add("entry-ra-capture", "calling-convention", 5, false,
    "Entry $ra is stored outside the stack; alone this can be an inline diagnostic macro", entryReturnSaves.map(m => m.n));

  // setjmp/longjmp and context-switch shapes: six or more s-registers PLUS
  // both sp and ra, distinct nearby slots, through one non-stack context base.
  const groups = new Map<string, typeof memory>();
  for (const m of memory.filter(m => !m.address.stack)) {
    const g = groups.get(m.address.root) ?? []; g.push(m); groups.set(m.address.root, g);
  }
  for (const group of groups.values()) {
    for (const direction of ["save", "restore"] as const) {
      const entries = group.filter(m => {
        const r = m.i.args[0]?.value;
        return r !== undefined && SAVED_CONTEXT.has(r) && (direction === "save" ? m.i.op === "sw" &&
          m.state[r] === (r === 29 ? affine("stack", 0) : affine(`entry:${r}`, 0)) : m.i.op === "lw");
      });
      const regs = new Set(entries.map(m => m.i.args[0]!.value)), offsets = entries.map(m => m.address.offset);
      if (regs.size >= 8 && regs.has(29) && regs.has(31) && new Set(offsets).size >= regs.size && Math.max(...offsets) - Math.min(...offsets) <= 0x100) {
        add(`register-context-${direction}`, "context", 85, true,
          `Explicit ${direction} of at least six callee-saved registers, $sp and $ra through one non-stack context base`, entries.map(m => m.n));
        break;
      }
    }
    if (row.signals.some(s => s.id.startsWith("register-context-"))) break;
  }
  const exceptions = live.filter(n => exceptionReturn(insns, n));
  if (exceptions.length) add("exception-return", "context", 75, true,
    "R3000 exception return: jump through a kernel/EPC register with rfe in its delay slot", exceptions.flatMap(n => [n, n + 1]));
  const kernel = live.filter(n => [...insns[n]!.reads, ...insns[n]!.writes].some(r => r === 26 || r === 27));
  if (kernel.length) add("kernel-gpr-use", "hardware", 25, false, "Explicit $k0/$k1 use (COP register numbers are not counted as GPRs)", kernel);
  const trapping = live.filter(n => { const w = insns[n]!.word; return w >>> 26 === 8 || (w >>> 26 === 0 && [0x20, 0x22].includes(w & 63)); });
  if (trapping.length) add("trapping-arithmetic", "arithmetic", 20, false,
    "Trapping addi/add/sub encodings; unusual in normal MIPS C output, but expressible by inline assembly/macros", trapping);
  const bios = live.filter(n => {
    const i = insns[n]!, argumentsAtTransfer = traced.transferStates.get(n);
    // The jump target is read BEFORE the slot; its selector argument is seen
    // AFTER it. Setting t2 in the slot cannot retroactively change the target.
    return ["jr", "jalr"].includes(i.op) && i.reads[0] === 10 && BIOS.has(numberOf(traced.states[n]![10]!) ?? -1) &&
      argumentsAtTransfer !== undefined && numberOf(argumentsAtTransfer[9]!) !== undefined;
  });
  if (bios.length) add("bios-register-transfer", "hardware", 10, false,
    "BIOS A0/B0/C0 transfer through $t2 with a constant selector in $t1 (including delay-slot setup); also compatible with a C operation macro",
    bios.flatMap(n => insns[n + 1]!.writes.includes(9) ? [n, n + 1] : [n]));
  const copies = embeddedCopies(fn, insns, traced);
  row.embeddedCopies = copies.map(copy => ({ source: { offset: copy.source, size: copy.size },
    loop: { load: copy.load * 4, store: copy.store * 4, latch: copy.latch * 4, iterations: copy.iterations },
    interpretation: copy.kernel ? "kernel-context-fragment" : "unclassified-bytes",
    evidence: copy.payload.map(n => ({ ...evidence(n), role: "copied-payload" })) }));
  const kernelCopies = copies.filter(copy => copy.kernel);
  if (kernelCopies.length) {
    add("embedded-kernel-context-copy", "code-patching", 20, false,
      "A bounded word-copy loop forwards an exactly referenced embedded fragment containing kernel-based context saves and a COP0 EPC read; payload words are copied, not directly executed",
      kernelCopies.flatMap(copy => [...copy.sites, ...copy.payload]));
    for (const e of row.signals[row.signals.length - 1]!.evidence)
      if (!live.includes(e.offset / 4)) e.role = "copied-payload";
  }
  const privileged = live.filter(n => ["mfc0", "mtc0", "rfe", "syscall"].includes(insns[n]!.op));
  if (privileged.length) add("privileged-operations", "hardware", 10, false,
    "COP0/exception operations; hardware instructions alone do not establish handwritten origin", privileged);
  const transfers = live.filter(n => isTransfer(insns[n]!) && insns[n + 1]);
  if (transfers.length >= 3 && transfers.every(n => insns[n + 1]!.word === 0)) add("empty-delay-slots", "scheduling", 3, false,
    "At least three transfer delay slots are all nop; weak supporting evidence only", transfers.map(n => n + 1));
  const allocatesStack = live.some(n => insns[n]!.op === "addiu" && insns[n]!.args[0]?.value === 29 && insns[n]!.args[1]?.value === 29 && insns[n]!.args[2]!.value < 0);
  const stackRaSaves = memory.filter(m => m.i.op === "sw" && m.i.args[0]?.value === 31 && m.address.stack);
  if (allocatesStack && stackRaSaves.length) add("conventional-call-frame", "calling-convention", -15, false,
    "Stack allocation and a stack-based $ra save are compatible with ordinary compiled C (not proof of C origin)", stackRaSaves.map(m => m.n));
  row.analysis = { complete: traced.limitations.size === 0, totalWords: insns.length, reachableWords: live.length,
    unreachableWords: insns.length - live.length, limitations: [...traced.limitations] };
  if (fn.coordinate?.inferredSize) row.analysis.limitations.push("Original symbol size is inferred; reachable code was scanned within that bound, not a proven historical function extent");
  scoreReading(row);
  return row;
}

function scoreReading(row: HandwrittenReading): void {
  // These are alternative code-patching witnesses, not independent origin
  // evidence. Preserve every observation, but cap their combined contribution.
  const patching = row.signals.filter(s => s.family === "code-patching").reduce((n, s) => n + s.weight, 0);
  const structural = row.signals.some(s => s.structural), raw = Math.min(20, patching) +
    row.signals.filter(s => s.family !== "code-patching").reduce((n, s) => n + s.weight, 0);
  const score = Math.max(0, Math.min(row.analysis.complete && structural ? 100 : 79, raw));
  const level = score >= 80 ? "high" : score >= 40 ? "medium" : score > 0 || row.analysis.complete ? "low" : "undetermined";
  row.confidence = { score, level, scale: "heuristic-not-probability" };
  row.classification = level === "high" ? "likely-handwritten" : level === "medium" ? "possible-handwritten" : level === "undetermined" ? "undetermined" : "no-strong-evidence";
  row.assemblyCandidate = structural && row.analysis.complete && score >= row.threshold;
}

/** A module supplies cross-function ADDRESS witnesses, not inherited origin
 * scores. Only the actual installer/restorer receive this supporting signal. */
export function analyzeHandwrittenModule(functions: readonly HandwrittenFunction[], options: { threshold?: number } = {}): HandwrittenReading[] {
  if (new Set(functions.map(fn => fn.container)).size > 1) throw new Error("Code-hook witnesses must belong to the same original module/container");
  const rows = functions.map(fn => analyzeHandwrittenFunction(fn, options));
  const valid = functions.filter(fn => fn.bytes.length > 0 && fn.bytes.length % 4 === 0 && Number.isSafeInteger(fn.vram) &&
    fn.vram >= 0 && fn.vram % 4 === 0 && fn.vram + fn.bytes.length <= 0x1_0000_0000);
  const decoded = new Map(valid.map(fn => [fn, instructions(fn)]));
  const traces = new Map(valid.map(fn => [fn, flow(fn, decoded.get(fn)!)]));
  const copies = valid.flatMap(fn => wordCopies(fn, decoded.get(fn)!, traces.get(fn)!).map(copy => ({ fn, copy })));
  const region = (value: Value, size: number) => {
    const hits = valid.flatMap(fn => {
      const offset = localOffset(fn, value);
      return offset !== undefined && offset >= 0 && offset % 4 === 0 && offset + size <= fn.bytes.length ? [{ fn, offset }] : [];
    });
    return hits.length === 1 ? hits[0] : undefined;
  };
  const dominates = (fn: HandwrittenFunction, a: number, b: number) => {
    const seen = new Set<number>(), queue = [0], edges = traces.get(fn)!.edges;
    for (let at = 0; at < queue.length; at++) {
      const n = queue[at]!; if (n === a || seen.has(n)) continue;
      if (n === b) return false;
      seen.add(n); queue.push(...edges.get(n) ?? []);
    }
    return true;
  };
  const site = ({ fn, copy }: typeof copies[number]): HookCopySite => ({ function: fn.name, load: copy.load * 4,
    store: copy.store * 4, latch: copy.latch * 4, bytes: copy.size });
  for (const save of copies) {
    // Only shared symbolic/absolute storage establishes a cross-function
    // identity. Equal stack/argument offsets in two functions do not alias.
    const pointer = affineOf(save.copy.source);
    if (!pointer?.root.startsWith("loaded:") || ![12, 16].includes(save.copy.size)) continue;
    const storage: unknown = JSON.parse(pointer.root.slice(7));
    if (typeof storage !== "string" || !/^(?:symbol:|absolute:)/.test(storage)) continue;
    const buffer = region(save.copy.destination, save.copy.size);
    if (!buffer || !buffer.fn.bytes.subarray(buffer.offset, buffer.offset + save.copy.size).every(b => b === 0)) continue;
    for (const install of copies) {
      if (install.fn !== save.fn || install.copy.destination !== save.copy.source || install.copy.size !== 16 ||
        install.copy.load <= save.copy.latch + 1 || !dominates(save.fn, save.copy.load, install.copy.load)) continue;
      const trampoline = region(install.copy.source, 16); if (!trampoline) continue;
      const at = trampoline.offset / 4, code = decoded.get(trampoline.fn)!, words = code.slice(at, at + 4), reg = words[0]!.writes[0];
      if (words[0]!.op !== "lui" || reg === undefined || reg === 0 || reg === 31 || words[1]!.op !== "addiu" ||
        words[1]!.args[0]?.value !== reg || words[1]!.args[1]?.value !== reg || words[2]!.op !== "jalr" ||
        words[2]!.reads[0] !== reg || words[2]!.writes[0] !== 31 || words[3]!.word !== 0) continue;
      const state = Array.from({ length: 32 }, (_, r) => r === 0 ? constant(0) : U);
      const targetValue = apply(trampoline.fn, at + 1, words[1]!, apply(trampoline.fn, at, words[0]!, state))[reg]!;
      const target = region(targetValue, 4);
      if (!target || target.offset !== 0 || target.fn === trampoline.fn) continue;
      // Restoring three words removes the whole call; the installed fourth
      // word is its nop slot. Do not pretend 12 restored bytes means 16.
      for (const restore of copies) {
        if (restore.fn === save.fn || restore.copy.source !== save.copy.destination || restore.copy.destination !== save.copy.source ||
          restore.copy.size !== save.copy.size) continue;
        const involved = [...new Set([save.fn, restore.fn, buffer.fn, trampoline.fn, target.fn])];
        const witnesses = involved.map(fn => { const row = rows[functions.indexOf(fn)]!;
          return { function: fn.name, originalSha256: row.originalSha256, relocationSha256: row.relocationSha256 }; });
        for (const [owner, role] of [[save.fn, "installer"], [restore.fn, "restorer"]] as const) {
          const row = rows[functions.indexOf(owner)]!, own = [save, install, restore].filter(c => c.fn === owner);
          row.codeHooks.push({ role, destination: save.copy.source, buffer: { function: buffer.fn.name, offset: buffer.offset, size: save.copy.size },
            trampoline: { function: trampoline.fn.name, offset: trampoline.offset, size: 16, target: target.fn.name },
            save: site(save), install: site(install), restore: site(restore), witnesses });
          if (!row.signals.some(s => s.id === "code-hook-lifecycle")) row.signals.push({ id: "code-hook-lifecycle", family: "code-patching", weight: 20, structural: false,
            description: "Same-module bounded copies save an external pointer's words into executable storage, install a resolved local-call trampoline, and restore the saved prefix through that same pointer",
            evidence: [...new Set(own.flatMap(c => c.copy.sites))].sort((a, b) => a - b).map(n => instructionEvidence(decoded.get(owner)!, n)) });
        }
      }
    }
  }
  // A copy can also install a transfer prefix without saving old words.
  // Follow only its explicitly resolved target, never every instruction-shaped
  // island in the module. A source nop after a 12-byte prefix does NOT prove
  // anything about the destination's uncopied delay slot.
  const ramOffset = (value: number): number | undefined => {
    for (const base of [0, 0x80000000, 0xa0000000])
      if (value >= base && value < base + 0x200000) return value - base;
    return undefined;
  };
  for (const install of copies) {
    if (install.copy.size < 12) continue;
    const template = region(install.copy.source, Math.max(16, install.copy.size)); if (!template) continue;
    const at = template.offset / 4, code = decoded.get(template.fn)!, words = code.slice(at, at + Math.max(16, install.copy.size) / 4);
    const reg = words[0]!.writes[0];
    if (words[0]!.op !== "lui" || reg === undefined || reg === 0 || reg === 31 || words[1]!.op !== "addiu" ||
      words[1]!.args[0]?.value !== reg || words[1]!.args[1]?.value !== reg || !["jr", "jalr"].includes(words[2]!.op) ||
      words[2]!.reads[0] !== reg || (words[2]!.op === "jalr" && words[2]!.writes[0] !== 31) || words.slice(3).some(i => i.word !== 0)) continue;
    const state = Array.from({ length: 32 }, (_, r) => r === 0 ? constant(0) : U);
    const targetValue = apply(template.fn, at + 1, words[1]!, apply(template.fn, at, words[0]!, state))[reg]!;
    let target: CopiedTransfer["target"] | undefined, involved: HandwrittenFunction[] = [install.fn, template.fn];
    const local = region(targetValue, 4);
    if (local) {
      const localCode = decoded.get(local.fn)!, trace = flow(local.fn, localCode, local.offset / 4);
      const returns = trace.reachable.filter(n => localCode[n]!.op === "jr" && localCode[n]!.reads[0] === 31);
      const exceptions = trace.reachable.filter(n => exceptionReturn(localCode, n));
      const escapes = trace.reachable.some(n => localCode[n]!.op === "j" &&
        (localCode[n]!.target === null || localCode[n]!.target! < local.fn.vram || localCode[n]!.target! >= local.fn.vram + local.fn.bytes.length));
      if (!trace.limitations.size && !escapes && (returns.length || exceptions.length)) {
        target = { kind: "local-entry", function: local.fn.name, offset: local.offset, reachableWords: trace.reachable.length,
          returns: returns.map(n => n * 4), exceptionReturns: exceptions.map(n => n * 4) };
        involved.push(local.fn);
      }
    } else {
      const address = numberOf(targetValue), physical = address === undefined ? undefined : ramOffset(address);
      if (physical !== undefined) {
        const deployments = copies.flatMap(deploy => {
          const destination = numberOf(deploy.copy.destination), base = destination === undefined ? undefined : ramOffset(destination);
          if (base === undefined || base + deploy.copy.size > 0x200000 || physical < base || physical >= base + deploy.copy.size || (physical - base) % 4) return [];
          const source = region(deploy.copy.source, deploy.copy.size); if (!source) return [];
          const payload = decoded.get(source.fn)!.slice(source.offset / 4, (source.offset + deploy.copy.size) / 4);
          if (payload.some(i => i.op === "unknown") || !payload.some(i => i.control)) return [];
          return [{ deploy, source, destination: destination!, entryOffset: physical - base }];
        });
        // Ambiguous deployments do not establish which bytes are entered.
        if (deployments.length === 1) {
          const d = deployments[0]!;
          target = { kind: "deployed-entry", function: d.source.fn.name, offset: d.source.offset + d.entryOffset,
            address: address!, physicalAddress: physical,
            deployment: { copy: site(d.deploy), destination: d.destination, sourceOffset: d.source.offset, entryOffset: d.entryOffset } };
          involved.push(d.deploy.fn, d.source.fn);
        }
      }
    }
    if (!target) continue;
    const row = rows[functions.indexOf(install.fn)]!;
    row.copiedTransfers.push({ install: site(install), template: { function: template.fn.name, offset: template.offset, templateBytes: 16,
      copiedBytes: install.copy.size, delaySlotCopied: install.copy.size >= 16,
      evidence: words.map((_, n) => ({ ...instructionEvidence(code, at + n), ...(n * 4 < install.copy.size ? { role: "copied-payload" as const } : {}) })) }, target,
      witnesses: [...new Set(involved)].map(fn => { const r = rows[functions.indexOf(fn)]!;
        return { function: fn.name, originalSha256: r.originalSha256, relocationSha256: r.relocationSha256 }; }) });
    if (!row.signals.some(s => s.id === "copied-control-transfer")) row.signals.push({ id: "copied-control-transfer", family: "code-patching", weight: 20, structural: false,
      description: "A bounded copy installs a resolved transfer template targeting a traced local entry or an independently witnessed RAM deployment; an uncopied delay slot is not assumed",
      evidence: [...new Set(install.copy.sites)].sort((a, b) => a - b).map(n => instructionEvidence(decoded.get(install.fn)!, n)) });
  }
  rows.forEach(scoreReading);
  return rows;
}
