/** Exact native program comparator. No byte masks, defined-reference folds,
 * target wildcards, or metadata substituted from the other object. Relocation
 * operands are decoded according to each format, not compared as wire syntax. */
import type { NativeObject, NativeRelocation } from "./model.js";
import { nativeRelocationOperands, hasOverlappingNativeRelocations, type RelocationOperand } from "./relocations.js";
import type { ObjectComparison } from "../relocatableObject.js";
export function compareOriginalObject(original: NativeObject, candidate: NativeObject): ObjectComparison {
  const differences: string[] = [], unresolved: string[] = [];
  const a = new Map(original.sections.map(s => [s.name, s])), b = new Map(candidate.sections.map(s => [s.name, s]));
  const wire = (o: NativeObject) => o.relocations.map(r => [r.section, r.offset, r.kind, r.target]);
  // Identical ordered LNK expressions prove equality even for arithmetic that
  // has no affine ECOFF counterpart. Preserve their raw operators/records.
  const sameLnkPatches = original.format === "psyq-lnk" && candidate.format === "psyq-lnk" &&
    JSON.stringify(wire(original)) === JSON.stringify(wire(candidate));
  const overlap = !sameLnkPatches && (hasOverlappingNativeRelocations(original) || hasOverlappingNativeRelocations(candidate));
  if (overlap) unresolved.push("Overlapping native patch operations require an ordered effect model");
  const site = (r: NativeRelocation) => JSON.stringify([r.section, r.offset, r.kind]);
  type Row = { relocation: NativeRelocation; operand: RelocationOperand };
  const groups = (o: NativeObject) => {
    const operands = nativeRelocationOperands(o), result = new Map<string, Row[]>();
    o.relocations.forEach((relocation, i) => {
      const key = site(relocation), rows = result.get(key) ?? [];
      rows.push({ relocation, operand: operands[i]! }); result.set(key, rows);
    });
    return result;
  };
  const ar = groups(original), br = groups(candidate), equalSites = new Set<string>();
  for (const key of new Set([...ar.keys(), ...br.keys()])) {
    const left = ar.get(key) ?? [], right = br.get(key) ?? [];
    if (left.length !== right.length) {
      differences.push(`${left.length > right.length ? "Missing" : "Extra"} relocation: ${key} (${left.length} original, ${right.length} candidate)`);
      continue;
    }
    if (sameLnkPatches) { equalSites.add(key); continue; }
    const missing = [...left, ...right].flatMap(row => "unresolved" in row.operand ? [row.operand.unresolved] : []);
    if (missing.length) { unresolved.push(`${key}: ${[...new Set(missing)].join("; ")}`); continue; }
    const describe = (row: Row) => {
      const operand = row.operand as { reference: string | null; addend: number };
      return JSON.stringify([row.relocation.section, row.relocation.offset, row.relocation.kind, operand.reference, operand.addend]);
    };
    const leftValues = left.map(describe), remaining = right.map(describe);
    let equal = true;
    for (const value of leftValues) {
      const at = remaining.indexOf(value);
      if (at < 0) { differences.push(`Missing relocation: ${value}`); equal = false; }
      else remaining.splice(at, 1);
    }
    for (const value of remaining) { differences.push(`Extra relocation: ${value}`); equal = false; }
    if (equal && !overlap) equalSites.add(key);
  }
  let matchedWords = 0, totalWords = 0, candidateWords = 0;
  for (const s of original.sections) if (s.kind === "code") {
    totalWords += Math.ceil(s.size / 4); const c = b.get(s.name);
    for (let i = 0; i < s.size; i += 4) {
      const sites = (o: NativeObject) => o.relocations.filter(r => r.section === s.name && r.offset >= i && r.offset < i + 4).map(site).sort();
      const left = sites(original), right = sites(candidate);
      if (c && s.data.subarray(i, i + 4).equals(c.data.subarray(i, i + 4)) &&
          JSON.stringify(left) === JSON.stringify(right) && left.every(key => equalSites.has(key))) matchedWords++;
    }
  }
  for (const s of candidate.sections) if (s.kind === "code") candidateWords += Math.ceil(s.size / 4);
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const s = a.get(name), c = b.get(name);
    if (!s || !c) { differences.push(`${name}: ${s ? "candidate" : "original"} ${(s ?? c)!.size ? "section" : "empty section declaration"} missing`); continue; }
    if (s.kind !== c.kind) differences.push(`${name}: kind ${s.kind} != ${c.kind}`);
    if (s.size !== c.size) differences.push(`${name}: size ${s.size} != ${c.size}`);
    if (s.alignment == null || c.alignment == null) {
      const missing = [s.alignment == null ? `original ${original.format}` : null, c.alignment == null ? `candidate ${candidate.format}` : null].filter(Boolean).join(" and ");
      unresolved.push(`${name}: ${missing} has no encoded section alignment; exact alignment comparison unavailable`);
    } else if (s.alignment !== c.alignment) differences.push(`${name}: alignment ${s.alignment} != ${c.alignment}`);
    // This includes EVERY relocated field, independently of operand decoding.
    if (!s.data.equals(c.data)) differences.push(`${name}: initialized bytes differ (including relocation fields)`);
  }
  const symbols = (o: NativeObject) => o.symbols.filter(s => s.binding === "external").map(s => JSON.stringify(s.section === "UND" ? [s.name, "UND"] : s.section === "COMMON" ? [s.name, "COMMON", s.size] : [s.name, s.section, s.offset])).sort();
  const as = symbols(original), bs = symbols(candidate);
  for (const row of as) { const at = bs.indexOf(row); if (at < 0) differences.push(`Missing external symbol: ${row}`); else bs.splice(at, 1); }
  for (const row of bs) differences.push(`Extra external symbol: ${row}`);
  return { verdict: differences.length ? "mismatch" : unresolved.length ? "undetermined" : "match",
    matchedWords, totalWords, candidateWords, differences, ...(unresolved.length ? { unresolved } : {}) };
}
