/** Bounded switch recovery over original section coordinates and relocations.
 * No synthetic linking: each table word must relocate into this code extent.
 * Unrecognised/unguarded forms stay unresolved, never acquire guessed edges. */
import type { RelocatableObject } from "../../lib/relocatableObject.js";
import { relocatableAddend } from "../../lib/relocatableAddend.js";
import { definedRegister, isBranch, type DecodedInsn } from "../matching-reconstruction/decode.js";

export interface RelocatableDispatch {
  instructionIndex: number;
  table: { section: string; offset: number };
  /** In table order, including repeated default entries. */
  targets: number[];
}

export function recoverRelocatableDispatches(object: RelocatableObject, section: string, insns: DecodedInsn[]): RelocatableDispatch[] {
  const result: RelocatableDispatch[] = [], start = insns[0]?.vram ?? 0, end = start + insns.length * 4;
  const rows = object.relocations.filter(r => r.section === section);
  const relocation = (offset: number, type: number) => {
    const at = rows.filter(r => r.offset === offset && r.type !== 0);
    return at.length === 1 && at[0]!.type === type ? at[0] : undefined;
  };
  const address = (reference: string, addend: number): { section: string; offset: number } | undefined => {
    const local = /^(.*)@(\d+)$/.exec(reference);
    if (local && object.sections.has(local[1]!)) return { section: local[1]!, offset: Number(local[2]) + addend };
    const named = /^named:(.+)$/.exec(reference);
    const symbols = named ? object.symbols.filter(s => s.name === named[1] && object.sections.has(s.section)) : [];
    return symbols.length === 1 ? { section: symbols[0]!.section, offset: symbols[0]!.value + addend } : undefined;
  };
  for (let jump = 0; jump < insns.length; jump++) {
    const jr = insns[jump]!;
    if (jr.op !== "jr" || jr.rs === 31) continue;
    const floor = Math.max(0, jump - 16);
    const definition = (register: number, before: number): number | undefined => {
      for (let at = before - 1; at >= floor; at--) {
        const insn = insns[at]!;
        if (["jal", "jalr", "j", "jr", "unknown", "break"].includes(insn.op) || isBranch(insn.op)) return undefined;
        if (definedRegister(insn) === register) return at;
      }
      return undefined;
    };
    const loadAt = definition(jr.rs, jump), load = loadAt === undefined ? undefined : insns[loadAt];
    if (!load || load.op !== "lw") continue;
    const low = relocation(load.vram, 6), addAt = definition(load.rs, loadAt!), add = addAt === undefined ? undefined : insns[addAt];
    if (!low || !add || add.op !== "addu") continue;
    for (const [base, index] of [[add.rs, add.rt], [add.rt, add.rs]]) {
      const highAt = definition(base!, addAt!), shiftAt = definition(index!, addAt!);
      const high = highAt === undefined ? undefined : insns[highAt], shift = shiftAt === undefined ? undefined : insns[shiftAt];
      if (!high || high.op !== "lui" || !shift || shift.op !== "sll" || shift.shamt !== 2) continue;
      const hi = relocation(high.vram, 5);
      if (!hi || hi.reference !== low.reference || hi.addend === null || low.addend === null) continue;
      // sltiu/beqz witnesses the length. The scaling can occupy the guard's
      // delay slot or follow it; a different slot operation must not redefine
      // the tested index. Never scan contiguous words into a neighbouring table.
      let guard: DecodedInsn | undefined;
      for (let branchAt = shiftAt! - 1; branchAt >= Math.max(floor, shiftAt! - 4); branchAt--) {
        const branch = insns[branchAt]!;
        if (branch.op !== "beq" || branch.target === undefined ||
            (branch.target >= branch.vram + 8 && branch.target <= jr.vram)) continue;
        const condition = branch.rs === 0 ? branch.rt : branch.rt === 0 ? branch.rs : 0;
        const guardAt = definition(condition, branchAt), test = guardAt === undefined ? undefined : insns[guardAt];
        if (!condition || !test || test.op !== "sltiu" || test.rs !== shift.rt || test.rt === shift.rt || test.uimm < 2 || test.uimm > 4096) continue;
        if (insns.slice(guardAt! + 1, shiftAt).some(i => definedRegister(i) === shift.rt || i.op === "unknown")) continue;
        if (insns.slice(branchAt + 1, jump).some(i => isBranch(i.op) || ["j", "jal", "jr", "jalr", "unknown"].includes(i.op))) continue;
        guard = test; break;
      }
      if (!guard) continue;
      let table: ReturnType<typeof address>;
      try {
        const addend = relocatableAddend(object, low);
        if (relocatableAddend(object, hi) !== addend) continue;
        table = address(low.reference, addend);
      } catch { continue; }
      if (!table || table.offset < 0 || table.offset % 4) continue;
      const storage = object.sections.get(table.section)!;
      if (storage.type === 8 || !(storage.flags & 2) || storage.flags & 5 || table.offset + guard.uimm * 4 > storage.data.length) continue;
      const targets: number[] = [];
      for (let i = 0; i < guard.uimm; i++) {
        const offset = table.offset + i * 4;
        const entries = object.relocations.filter(r => r.section === table!.section && r.offset === offset && r.type !== 0);
        if (entries.length !== 1 || entries[0]!.type !== 2 || entries[0]!.addend === null) break;
        let target: ReturnType<typeof address>;
        try { target = address(entries[0]!.reference, relocatableAddend(object, entries[0]!)); } catch { break; }
        if (!target || target.section !== section || target.offset < start || target.offset >= end || target.offset % 4) break;
        targets.push(target.offset);
      }
      if (targets.length === guard.uimm) { result.push({ instructionIndex: jump, table, targets }); break; }
    }
  }
  return result;
}
