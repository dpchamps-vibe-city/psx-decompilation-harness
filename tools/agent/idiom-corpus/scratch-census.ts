import type { RenderedWord } from "../../lib/functionOracle.js";

const LOADS = new Map([[32, "lb"], [33, "lh"], [35, "lw"], [36, "lbu"], [37, "lhu"]]);

export interface ScratchPattern {
  signature: string;
  wordIndex: number;
  coordinate?: RenderedWord["coordinate"];
  load: string;
  scratch: "load-destination" | "at" | "other";
  destinationIsIndex: boolean;
}

/** A relation in three ORIGINAL words, not an inverse-assembler interpretation. */
export function indexedLoadScratchPatterns(words: readonly RenderedWord[]): ScratchPattern[] {
  const result: ScratchPattern[] = [];
  for (let i = 0; i + 2 < words.length; i++) {
    if (words[i + 1]!.vram !== words[i]!.vram + 4 || words[i + 2]!.vram !== words[i]!.vram + 8) continue;
    const a = words[i]!.raw >>> 0, b = words[i + 1]!.raw >>> 0, c = words[i + 2]!.raw >>> 0;
    const scratch = (a >>> 16) & 31, rs = (b >>> 21) & 31, rt = (b >>> 16) & 31;
    const destination = (c >>> 16) & 31, load = LOADS.get(c >>> 26);
    if (a >>> 26 !== 15 || !scratch || b >>> 26 !== 0 || (b & 63) !== 33 ||
      ((b >>> 11) & 31) !== scratch || (rs !== scratch && rt !== scratch) ||
      !load || ((c >>> 21) & 31) !== scratch) continue;
    const index = rs === scratch ? rt : rs;
    if (!index || index === scratch) continue;
    const role = destination === scratch ? "load-destination" : scratch === 1 ? "at" : "other";
    const destinationIsIndex = destination === index;
    result.push({ signature: `${load}:${role}:${destinationIsIndex ? "dest=index" : "dest!=index"}`,
      wordIndex: i, coordinate: words[i]!.coordinate, load, scratch: role, destinationIsIndex });
  }
  return result;
}

/** Exhaustive within the named eligible functions; capped detail, never capped counts. */
export function scratchRegisterCensus(query: readonly RenderedWord[], functions: readonly string[],
  readWords: (name: string) => RenderedWord[]) {
  const queryPatterns = indexedLoadScratchPatterns(query);
  const signatures = [...new Set(queryPatterns.map(pattern => pattern.signature))];
  const counts = new Map(signatures.map(signature => [signature, { occurrences: 0, functions: new Set<string>(),
    examples: [] as Array<{ function: string; wordIndex: number; coordinate?: RenderedWord["coordinate"] }> }]));
  const unreadable: Array<{ function: string; detail: string }> = [];
  let scanned = 0;
  if (signatures.length) for (const name of functions) {
    let words: RenderedWord[];
    try { words = readWords(name); } catch (error) { unreadable.push({ function: name, detail: String(error) }); continue; }
    if (!words.length) { unreadable.push({ function: name, detail: "No original words" }); continue; }
    scanned++;
    for (const pattern of indexedLoadScratchPatterns(words)) {
      const count = counts.get(pattern.signature);
      if (!count) continue;
      count.occurrences++; count.functions.add(name);
      if (count.examples.length < 8) count.examples.push({ function: name, wordIndex: pattern.wordIndex, coordinate: pattern.coordinate });
    }
  }
  return {
    basis: "Adjacent original LUI/ADDU/integer-load register relations; symbols, immediates and origin are not inferred. Load-destination scratch with dest!=index is the GAS rule; $at with dest!=index is the ASPSX rule, while $at with dest=index fits either. This is not proof of original compiler input or assembler behavior; the relation only nominates a family, not a version.",
    status: signatures.length === 0 ? "not-applicable" : unreadable.length ? "incomplete" : "complete",
    eligibleFunctions: functions.length, scannedFunctions: scanned, unreadable,
    queryPatterns,
    patterns: [...counts].map(([signature, count]) => ({ signature, occurrences: count.occurrences,
      functions: count.functions.size, examples: count.examples, examplesTruncated: count.occurrences > count.examples.length })),
  };
}
