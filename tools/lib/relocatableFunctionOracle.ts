/** Function-local diagnostic oracle for ET_REL. Encoded words AND symbolic
 * relocation identities are retained. No linking to invented RAM addresses.
 * Whole-member acceptance remains a separate, stricter scope. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareLibraryObjects, requireLibraryFunction } from "./libraryTargets.js";
import { isDirectoryTu, libraryTuStatus } from "./libraryTranslationUnit.js";
import { projectRoot } from "./runtimeContext.js";
import { analyzeCSource } from "../agent/cSourceAnalysis.js";
import { objectFunctions, readRelocatableObject, compareRelocatableObjects, canonicalizeDefinedReferences, type RelocatableObject, type ObjectRelocation } from "./relocatableObject.js";
import { compareWords, disassembleBytes, symboliseWord, type OracleResult, type RenderedWord } from "./functionOracle.js";
const NAMES: Record<number, string> = { 0: "R_MIPS_NONE", 1: "R_MIPS_16", 2: "R_MIPS_32", 4: "R_MIPS_26", 5: "R_MIPS_HI16", 6: "R_MIPS_LO16", 7: "R_MIPS_GPREL16", 8: "R_MIPS_LITERAL", 10: "R_MIPS_PC16" };
import { relocatableAddend } from "./relocatableAddend.js";
export { relocatableAddend } from "./relocatableAddend.js";
function referenceText(r: ObjectRelocation): string { return r.reference.replace(/^(named|import):/, ""); }
/** `definedAs` is the name `object` defines the function under when it differs
 * from the target's: words still render under the target's name. */
export function relocatableFunctionWords(object: RelocatableObject, symbol: string, base?: number, extent?: number, definedAs = symbol): RenderedWord[] {
  const fn = objectFunctions(object).find(f => f.name === definedAs);
  if (!fn) throw new Error(`Object does not define ${definedAs}`);
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
    if (rs.some(r => r.addend === null)) {
      word.undetermined = `Native relocation operand unavailable: ${rs.filter(r => r.addend === null).map(r => r.reference).join(", ")}`;
      word.text = word.key = `${mnemonic} <undetermined>`;
      return word;
    }
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
export function compareRelocatableFunction(name: string, objectPath: string, candidateSource?: string): OracleResult {
  const { member, fn, key } = requireLibraryFunction(name), candidateBytes = readFileSync(objectPath), object = readRelocatableObject(candidateBytes);
  const memberComparison = compareLibraryObjects(member, candidateBytes);
  // Candidate ECOFF retains static function names which LNK does not serialize.
  // Bounds come from the candidate even when its member is not yet identical.
  if (object.native && existsSync(`${objectPath}.ecoff`)) {
    const ecoff = readRelocatableObject(readFileSync(`${objectPath}.ecoff`));
    for (const symbol of ecoff.symbols.filter(s => s.type === 2 && !object.symbols.some(o => o.name === s.name))) object.symbols.push(symbol);
  }
  // A size-zero original symbol's inferred span may include alignment padding
  // outside the compiler's FUNC-size annotation. Exact whole-member bytes and
  // symbol positions license comparing that same span; metadata must not turn
  // already-identical assembly into a function-local mismatch.
  const extent = fn.inferredSize && memberComparison.verdict === "match" ? fn.size : undefined;
  const { targetWords, candidateWords, rawTargetWords, rawCandidateWords, ...comparison } =
    compareRelocatableFunctionObjects(member.object, object, fn.name, extent, fn.discovery !== undefined);
  const status = libraryTuStatus(member, projectRoot(), candidateSource && resolve(projectRoot(), candidateSource) !== resolve(projectRoot(), member.source) ? { symbol: fn.name, source: candidateSource } : undefined);
  const memberStub = !status && analyzeCSource(readFileSync(resolve(projectRoot(), candidateSource ?? member.source), "utf8")).includeAsm.length > 0;
  if (status?.some(s => s.symbol === fn.name && s.stub) || !status && memberStub) comparison.verdict = "stub";
  return { ...comparison, functionName: key, vram: fn.offset, objectPath, targetWords, candidateWords, rawTargetWords, rawCandidateWords,
    verification: { ...memberComparison, scope: "translation-unit", verdict: memberStub ? "stub" : memberComparison.verdict },
    notes: [`Diagnostic coordinates are ${fn.section} offsets, not RAM; ${fn.inferredSize ? "original symbol extent is inferred" : "original function extent is recorded"}.`,
      member.originalObject ? "Function diagnostics retain native bytes and relocation targets without defined-reference folding." : "Legacy ELF function comparison uses defined-reference canonicalization; raw words/references are retained separately.",
      `Function-local diagnostics do not certify the owning TU; whole-member verdict: ${memberStub ? "STUB" : memberComparison.verdict.toUpperCase()}.`] };
}
/** The exact same proven relocation equivalence as whole-member acceptance.
 * Original-word readers above stay raw; only this comparison view is folded.
 * `unnamed`: the original never named this private helper (its name is a code
 * coordinate), so a folded module may rename it; the candidate's function at
 * the same coordinate is then that helper. */
export function compareRelocatableFunctionObjects(original: RelocatableObject, candidate: RelocatableObject, symbol: string, extent?: number, unnamed = false) {
  const fn = objectFunctions(original).find(f => f.name === symbol);
  if (!fn) throw new Error(`Object does not define ${symbol}`);
  const functions = objectFunctions(candidate), definedAs = unnamed && !functions.some(f => f.name === symbol)
    ? functions.find(f => f.section === fn.section && f.offset === fn.offset)?.name ?? symbol : symbol;
  const rawTargetWords = relocatableFunctionWords(original, symbol);
  const rawCandidateWords = relocatableFunctionWords(candidate, symbol, fn.offset, extent, definedAs);
  const native = !!(original.native || candidate.native);
  const targetWords = relocatableFunctionWords(native ? original : canonicalizeDefinedReferences(original), symbol);
  const candidateWords = relocatableFunctionWords(native ? candidate : canonicalizeDefinedReferences(candidate), symbol, fn.offset, extent, definedAs);
  return { ...compareWords(targetWords, candidateWords), targetWords, candidateWords, rawTargetWords, rawCandidateWords };
}
