import { definedRegister, type DecodedInsn } from "./decode.js";

export interface BiosVeneer {
  vector: number;
  selector: number;
  transferOffset: number;
}

/** A narrow original-word fingerprint, not a symbol-name heuristic. A PS-X
 * BIOS dispatch veneer preserves a0..a3 and ra, sets t1, and tail-jumps via t2.
 * Only constant setup and alignment nops are admitted. */
export function recognizeBiosVeneer(insns: DecodedInsn[]): BiosVeneer | undefined {
  const jump = insns.findIndex(insn => insn.op === "jr" && insn.rs === 10);
  if (jump < 1 || jump + 1 >= insns.length) return undefined;
  const constants = new Map<number, number>();
  let vector: number | undefined;
  for (const [index, insn] of insns.entries()) {
    if (insn.relocations?.length) return undefined;
    if (index === jump) { vector = constants.get(10); continue; }
    if (insn.op === "nop") continue;
    if (index > jump + 1) return undefined;
    const destination = definedRegister(insn);
    if (destination !== 9 && destination !== 10) return undefined;
    if (index > jump && destination === 10) return undefined;
    if (insn.rs !== 0 || (insn.op !== "addiu" && insn.op !== "ori")) return undefined;
    constants.set(destination, (insn.op === "ori" ? insn.uimm : insn.simm) >>> 0);
  }
  const selector = constants.get(9);
  if (vector === undefined || ![0xa0, 0xb0, 0xc0].includes(vector) || selector === undefined || selector > 0xff) return undefined;
  return { vector, selector, transferOffset: insns[jump]!.vram };
}

export function describeBiosVeneer(veneer: BiosVeneer): string {
  return `BIOS dispatch veneer: tail-jump to 0x${veneer.vector.toString(16)} with $t1=0x${veneer.selector.toString(16)}, preserving incoming arguments and $ra. ` +
    "The production clean-C compiler has no supported operation for this fixed-register BIOS calling convention. " +
    "This is an unsupported clean-C target, not a request to retain INCLUDE_ASM or grant an assembly exception; it remains unreconstructed.";
}
