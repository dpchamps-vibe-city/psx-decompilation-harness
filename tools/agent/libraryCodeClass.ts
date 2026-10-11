/** Narrow original-word exclusions for the clean-C library queue. These are
 * operation fingerprints, not SDK-name guesses or proof of historical source
 * spelling. Keep all other targets eligible, including COP2 macro candidates.
 * No rendered-assembly comments: split listings can inherit a neighbour's
 * "Handwritten function" annotation. */
import type { RelocatableObject } from "../lib/relocatableObject.js";
import { decodeWord } from "./matching-reconstruction/decode.js";
import { recognizeBiosVeneer } from "./matching-reconstruction/bios-veneer.js";

export interface LibraryAssemblyClass {
  kind: "bios-dispatch" | "syscall-helper" | "cop0-helper" | "abi-register-helper";
  detail: string;
  section: string;
  offset: number;
  selector?: number;
}

const JR_RA = 0x03e00008;
const same = (words: number[], expected: number[]) => words.length === expected.length && words.every((word, i) => word === expected[i]);

export function classifyLibraryCode(object: RelocatableObject, fn: { section: string; offset: number; size: number }): LibraryAssemblyClass | undefined {
  const section = object.sections.get(fn.section);
  if (!section || fn.offset < 0 || fn.offset % 4 || fn.size % 4 || fn.size < 8 || fn.offset + fn.size > section.data.length) return undefined;
  if (object.relocations.some(r => r.type !== 0 && r.section === fn.section && r.offset >= fn.offset && r.offset < fn.offset + fn.size)) return undefined;
  const words: number[] = [];
  for (let offset = fn.offset; offset < fn.offset + fn.size; offset += 4) words.push(section.data.readUInt32LE(offset));
  const result = (kind: LibraryAssemblyClass["kind"], detail: string): LibraryAssemblyClass => ({ kind, detail, section: fn.section, offset: fn.offset });
  const bios = recognizeBiosVeneer(words.map((word, i) => decodeWord(word, fn.offset + i * 4)));
  if (bios) return result("bios-dispatch", `Fixed-register BIOS tail-jump to 0x${bios.vector.toString(16)} with $t1=0x${bios.selector.toString(16)}; not an ordinary C call.`);

  // Only complete short helpers, including their real return delay slot and
  // zero alignment padding. An instruction buried in a larger body is NOT a
  // match; it may be data, or need macro/CFG evidence this classifier lacks.
  const ret = words.indexOf(JR_RA);
  if (ret < 0 || ret + 1 >= words.length || words.slice(ret + 2).some(word => word !== 0)) return undefined;
  const operations = words.filter(word => word !== 0);
  if (words[ret + 1] === 0) {
    if (operations.length === 3 && (operations[0]! >>> 16) === 0x2404 && operations[1] === 0x0000000c && operations[2] === JR_RA) {
      return { ...result("syscall-helper", "Direct syscall helper; use the explicitly enabled PSX_BIOS_SYSCALL platform operation, not an invented C call."), selector: operations[0]! & 0xffff };
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
