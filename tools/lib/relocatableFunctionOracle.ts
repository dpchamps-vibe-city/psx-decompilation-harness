/** Function-local diagnostic oracle for ET_REL. Encoded words AND symbolic
 * relocation identities are retained. No linking to invented RAM addresses.
 * Whole-member acceptance remains a separate, stricter scope. */
import { readFileSync } from "node:fs";
import { requireLibraryFunction } from "./libraryTargets.js";
import { isDirectoryTu } from "./libraryTranslationUnit.js";
import { objectFunctions, readRelocatableObject, compareRelocatableObjects, type RelocatableObject, type ObjectRelocation } from "./relocatableObject.js";
import { compareWords, disassembleBytes, symboliseWord, type OracleResult, type RenderedWord } from "./functionOracle.js";
const NAMES: Record<number, string> = { 0: "R_MIPS_NONE", 1: "R_MIPS_16", 2: "R_MIPS_32", 4: "R_MIPS_26", 5: "R_MIPS_HI16", 6: "R_MIPS_LO16", 7: "R_MIPS_GPREL16", 10: "R_MIPS_PC16" };
const signed = (n: number) => (n & 0x8000) ? (n & 0xffff) - 0x10000 : n & 0xffff;
function referenceText(r: ObjectRelocation): string { return r.reference.replace(/^(named|import):/, ""); }
/** Encoded REL addend, including paired HI16/LO16. Shared by original-word
 * diagnostics so a low half is never mistaken for a complete address. */
export function relocatableAddend(o: RelocatableObject, r: ObjectRelocation): number {
  const word = o.sections.get(r.section)!.data.readUInt32LE(r.offset);
  if (r.type === 4) return (word & 0x3ffffff) * 4;
  if (r.type === 2) return word;
  if (r.type === 10) return signed(word) * 4;
  if (r.type === 6) {
    const before = o.relocations.slice(0, o.relocations.indexOf(r));
    const lastLow = before.findLastIndex(l => l.type === 6 && l.section === r.section && l.reference === r.reference);
    const baseRegister = (word >>> 21) & 31;
    const hi = before.slice(lastLow + 1).findLast(h => h.type === 5 && h.section === r.section && h.reference === r.reference &&
      ((o.sections.get(h.section)!.data.readUInt32LE(h.offset) >>> 16) & 31) === baseRegister);
    if (hi) return (o.sections.get(hi.section)!.data.readUInt32LE(hi.offset) & 0xffff) * 0x10000 + signed(word);
  }
  if (r.type === 5) {
    const at = o.relocations.indexOf(r), low = o.relocations.slice(at + 1).find(l => l.section === r.section && l.reference === r.reference && l.type === 6);
    return (word & 0xffff) * 0x10000 + (low ? signed(o.sections.get(low.section)!.data.readUInt32LE(low.offset)) : 0);
  }
  return signed(word);
}
export function relocatableFunctionWords(object: RelocatableObject, symbol: string, base?: number, extent?: number): RenderedWord[] {
  const fn = objectFunctions(object).find(f => f.name === symbol);
  if (!fn) throw new Error(`Object does not define ${symbol}`);
  const size = extent ?? fn.size, section = object.sections.get(fn.section)!;
  if (size < 0 || fn.offset + size > section.size) throw new Error(`Invalid code extent for ${symbol}`);
  const bytes = section.data.subarray(fn.offset, fn.offset + size);
  if (bytes.length % 4) throw new Error(`Unaligned code extent for ${symbol}`);
  const start = base ?? fn.offset, context = { functionName: symbol, functionStart: start, functionExtent: size,
    index: { byAddress: new Map<number, string>(), addresses: [] }, gp: 0 };
  const lines = disassembleBytes(bytes, start);
  return lines.map((line, i) => {
    const raw = bytes.readUInt32LE(i * 4), offset = fn.offset + i * 4;
    const [mnemonic, operands = ""] = line.split(/\s+(.*)/);
    const rendered = symboliseWord(context, start + i * 4, mnemonic!, operands);
    const rs = object.relocations.filter(r => r.section === fn.section && r.offset === offset && r.type !== 0);
    const word: RenderedWord = { vram: start + i * 4, raw, text: rendered.text, key: rendered.key,
      coordinate: { kind: "section", section: fn.section, offset } };
    if (rs.length) {
      word.relocations = rs.map(r => {
        const bias = relocatableAddend(object, r), local = r.reference.match(/^(.*)@(\d+)$/);
        const named = object.symbols.find(s => `named:${s.name}` === r.reference);
        const section = local?.[1] ?? named?.section, value = local ? Number(local[2]) : named?.value;
        // R_MIPS_PC16 encodes (S + A - P) / 4; the machine's branch
        // adds P + 4, so its destination is S + A + 4 (GAS uses A=-4).
        const targetOffset = value === undefined ? undefined : value + bias + (r.type === 10 ? 4 : 0);
        return { type: NAMES[r.type]!, reference: r.reference, addend: bias,
          ...([4, 10].includes(r.type) && section === fn.section && targetOffset !== undefined && targetOffset >= fn.offset && targetOffset < fn.offset + size
            ? { targetOffset: start + targetOffset - fn.offset } : {}) };
      });
      const r = rs[0]!, ref = referenceText(r), bias = relocatableAddend(object, r), expr = `${ref}${bias ? `${bias < 0 ? "" : "+"}${bias}` : ""}`;
      let symbolic = operands;
      if (r.type === 4) symbolic = expr;
      else if (r.type === 5) symbolic = operands.replace(/[^,]+$/, `%hi(${expr})`);
      else if (r.type === 6 || r.type === 7) symbolic = operands.replace(/(-?(?:0x)?[0-9a-f]+)(\([^)]*\))?$/i, `${r.type === 7 ? "%gp_rel" : "%lo"}(${expr})$2`);
      else if (r.type === 10) symbolic = operands.replace(/[^,]+$/, `%pc_rel(${expr})`);
      word.text = word.key = `${mnemonic} ${symbolic}`;
    }
    return word;
  });
}
export function targetRelocatableWords(name: string): RenderedWord[] {
  const { member, fn } = requireLibraryFunction(name);
  return relocatableFunctionWords(member.object, fn.name);
}
export function compareRelocatableFunction(name: string, objectPath: string): OracleResult {
  const { member, fn, key } = requireLibraryFunction(name), candidateBytes = readFileSync(objectPath), object = readRelocatableObject(candidateBytes);
  const memberComparison = compareRelocatableObjects(member.bytes, candidateBytes);
  // A size-zero original symbol's inferred span may include alignment padding
  // outside the compiler's FUNC-size annotation. Exact whole-member bytes and
  // symbol positions license comparing that same span; metadata must not turn
  // already-identical assembly into a function-local mismatch.
  const extent = fn.inferredSize && memberComparison.verdict === "match" ? fn.size : undefined;
  const targetWords = relocatableFunctionWords(member.object, fn.name), candidateWords = relocatableFunctionWords(object, fn.name, fn.offset, extent);
  const comparison = compareWords(targetWords, candidateWords);
  if (object.symbols.some(s => s.name === `${fn.name}.NON_MATCHING`)) comparison.verdict = "stub";
  const memberStub = !isDirectoryTu(member) && object.symbols.some(s => s.name.endsWith(".NON_MATCHING"));
  return { ...comparison, functionName: key, vram: fn.offset, objectPath, targetWords, candidateWords,
    verification: { scope: "translation-unit", verdict: memberStub ? "stub" : memberComparison.verdict, differences: memberComparison.differences },
    notes: [`Diagnostic coordinates are ${fn.section} offsets, not RAM; ${fn.inferredSize ? "original symbol extent is inferred" : "original function extent is recorded"}.`,
      `Function-local diagnostics do not certify the owning TU; whole-member verdict: ${memberStub ? "STUB" : memberComparison.verdict.toUpperCase()}.`] };
}
