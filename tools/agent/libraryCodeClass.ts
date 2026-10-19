/** Original-word fingerprints of hand-written code. A function that carries one
 * is hand-written assembly (a `.s` member, or an `asm()` body inside a C member):
 * it stays its retained extraction and is never a C translation target. These
 * are operation fingerprints, not SDK-name guesses or proof of historical source
 * spelling. COP2 (GTE) is never a fingerprint: Sony wrote GTE code in C with
 * INLINE_C macros that DMPSX rewrites. No rendered-assembly comments: split
 * listings can inherit a neighbour's "Handwritten function" annotation. */
import type { RelocatableObject } from "../lib/relocatableObject.js";
import { decodeWord, definedRegister } from "./matching-reconstruction/decode.js";
import { recognizeBiosVeneer } from "./matching-reconstruction/bios-veneer.js";

export interface LibraryAssemblyClass {
  kind: "bios-dispatch" | "syscall-helper" | "cop0-helper" | "abi-register-helper" | "bios-inline-dispatch" | "gcc-impossible";
  detail: string;
  section: string;
  offset: number;
  selector?: number;
}

const JR_RA = 0x03e00008;
const same = (words: number[], expected: number[]) => words.length === expected.length && words.every((word, i) => word === expected[i]);
/** `break 7` / `break 6`: the divide-by-zero and overflow traps the assembler expands `div` into. */
const DIVISION_TRAPS = new Set([0x0007000d, 0x0006000d]);
const KERNEL_REGISTERS = new Set([26, 27]);

/** Why GCC cannot have emitted `word` outside an asm statement, or undefined.
 * Raw fields, not `decodeWord`: the decoder folds trapping add/sub into addu/subu. */
export function gccImpossibleWord(word: number): string | undefined {
  const op = word >>> 26, rs = (word >>> 21) & 31, rt = (word >>> 16) & 31, rd = (word >>> 11) & 31, funct = word & 63;
  const kernel = (...registers: number[]) => registers.some(r => KERNEL_REGISTERS.has(r)) ? "k0/k1 register" : undefined;
  if (op === 0) {
    if (funct === 0x0c) return "syscall";
    if (funct === 0x0d) return DIVISION_TRAPS.has(word) ? undefined : "break outside the division traps";
    if (funct === 0x20) return "trapping add";
    if (funct === 0x22) return "trapping sub";
    return kernel(rs, rt, rd);
  }
  if (op === 0x01) return kernel(rs);
  if (op === 0x02 || op === 0x03) return undefined;
  if (op === 0x08) return "trapping addi";
  if (op === 0x10 || op === 0x30 || op === 0x38) return "COP0 or rfe";
  // COP1-3 transfers name a general register in rt; commands (bit 25) name none.
  if (op >= 0x11 && op <= 0x13) return word & 0x02000000 ? undefined : kernel(rt);
  // lwcz/swcz: rt is a coprocessor register, only the base is general.
  if ((op >= 0x31 && op <= 0x33) || (op >= 0x39 && op <= 0x3b)) return kernel(rs);
  return kernel(rs, rt);
}

const CONTROL = new Set(["beq", "bne", "blez", "bgtz", "bltz", "bgez", "j", "jal", "jr", "jalr"]);
/** The literal a register holds just before `end`, from the straight-line code
 * that sets it, or undefined when a branch, call or unknown write intervenes.
 * `skip` is the transfer whose delay slot is being read: it writes no operand. */
function constantBefore(words: number[], end: number, register: number, base: number, skip = -1): number | undefined {
  for (let i = end - 1; i >= 0 && i >= end - 8; i--) {
    if (i === skip) continue;
    const insn = decodeWord(words[i]!, base + i * 4), defined = definedRegister(insn);
    if (CONTROL.has(insn.op) || defined === "unknown") return undefined;
    if (defined !== register) continue;
    if (insn.op === "and" && insn.rs === register && insn.rt === 0) return 0;
    if ((insn.op === "addiu" || insn.op === "ori") && insn.rs === 0) return insn.op === "ori" ? insn.uimm : insn.simm >>> 0;
    if ((insn.op === "addiu" || insn.op === "ori") && insn.rs === register) {
      const previous = constantBefore(words, i, register, base, skip);
      return previous === undefined ? undefined : ((insn.op === "ori" ? previous | insn.uimm : previous + insn.simm) >>> 0);
    }
    return undefined;
  }
  return undefined;
}

/** A call or jump into the BIOS tables (A0h/B0h/C0h) with the function number in
 * $t1: the fixed-register calling convention no C construct produces. */
function inlineBiosDispatch(words: number[], base: number): string | undefined {
  for (let i = 0; i + 1 < words.length; i++) {
    const word = words[i]!;
    if (word >>> 26 !== 0 || ((word & 63) !== 0x08 && (word & 63) !== 0x09)) continue;
    const target = (word >>> 21) & 31;
    if (target === 31) continue;
    const vector = constantBefore(words, i, target, base);
    if (vector === undefined || ![0xa0, 0xb0, 0xc0].includes(vector)) continue;
    const selector = constantBefore(words, i + 2, 9, base, i);
    if (selector === undefined || selector > 0xff) continue;
    return `BIOS ${(word & 63) === 0x09 ? "call" : "tail-jump"} to 0x${vector.toString(16)} with $t1=0x${selector.toString(16)} at +0x${(base + i * 4).toString(16)}`;
  }
  return undefined;
}

export function classifyLibraryCode(object: RelocatableObject, fn: { section: string; offset: number; size: number }): LibraryAssemblyClass | undefined {
  const section = object.sections.get(fn.section);
  if (!section || fn.offset < 0 || fn.offset % 4 || fn.size % 4 || fn.size < 8 || fn.offset + fn.size > section.data.length) return undefined;
  const words: number[] = [];
  for (let offset = fn.offset; offset < fn.offset + fn.size; offset += 4) words.push(section.data.readUInt32LE(offset));
  const result = (kind: LibraryAssemblyClass["kind"], detail: string): LibraryAssemblyClass => ({ kind, detail, section: fn.section, offset: fn.offset });
  if (!object.relocations.some(r => r.type !== 0 && r.section === fn.section && r.offset >= fn.offset && r.offset < fn.offset + fn.size)) {
    const exact = exactHelper(words, fn.offset, result);
    if (exact) return exact;
  }
  const dispatch = inlineBiosDispatch(words, fn.offset);
  if (dispatch) return result("bios-inline-dispatch", `${dispatch}; hand-written assembly, never translated to C.`);
  for (const [i, word] of words.entries()) {
    const reason = gccImpossibleWord(word);
    if (reason) return result("gcc-impossible", `${reason} at +0x${(fn.offset + i * 4).toString(16)} (word 0x${word.toString(16).padStart(8, "0")}); hand-written assembly, never translated to C.`);
  }
  return undefined;
}

/** Complete short helpers, including their real return delay slot and zero
 * alignment padding, recognized from unrelocated words only. */
function exactHelper(words: number[], offset: number, result: (kind: LibraryAssemblyClass["kind"], detail: string) => LibraryAssemblyClass): LibraryAssemblyClass | undefined {
  const bios = recognizeBiosVeneer(words.map((word, i) => decodeWord(word, offset + i * 4)));
  if (bios) return result("bios-dispatch", `Fixed-register BIOS tail-jump to 0x${bios.vector.toString(16)} with $t1=0x${bios.selector.toString(16)}; not an ordinary C call.`);
  const ret = words.indexOf(JR_RA);
  if (ret < 0 || ret + 1 >= words.length || words.slice(ret + 2).some(word => word !== 0)) return undefined;
  const operations = words.filter(word => word !== 0);
  if (words[ret + 1] === 0) {
    if (operations.length === 3 && (operations[0]! >>> 16) === 0x2404 && operations[1] === 0x0000000c && operations[2] === JR_RA) {
      return { ...result("syscall-helper", "Direct syscall helper; hand-written assembly, never translated to C."), selector: operations[0]! & 0xffff };
    }
    if (same(operations, [0x40026000, JR_RA]) || same(operations, [0x40026800, JR_RA]) ||
        same(operations, [0x40046000, 0x2401fbfe, 0x00812024, 0x40846000, JR_RA]) ||
        same(operations, [0x40046000, 0x34840401, 0x40846000, JR_RA])) {
      return result("cop0-helper", "Direct COP0 status/cause register helper; requires privileged register operations, not ordinary C.");
    }
  }
  if (same(operations, [JR_RA, 0x03801021]) || same(operations, [JR_RA, 0x03a01021]) ||
      (words[ret + 1] === 0 && (same(operations, [0x03801021, JR_RA]) || same(operations, [0x03a01021, JR_RA]))) ||
      same(operations, [0x03a01021, JR_RA, 0x0080e821])) {
    return result("abi-register-helper", "Entry $gp/$sp getter or stack-pointer exchange helper; requires explicit ABI-register operations, not ordinary C.");
  }
  return undefined;
}
