/** Compiler-owned read-only data in a C member. GCC writes .rdata in TU stream
 * order: string literals while a function is expanded, its switch tables while
 * the function's code is output. A table therefore sits between the strings of
 * the functions around it, and a generated data part placed after every
 * function can never let the compiler emit it there. The table travels with
 * its owner's extraction instead, and the .rdata before each table becomes its
 * own generated part placed before the owner. Derived from the original object
 * only: a pure function of the member. */
import type { LibraryMember } from "./libraryTargets.js";
import { nativeRelocationOperands } from "./objectFormats/relocations.js";

export const RODATA_SECTION = ".rdata";
/** A run of code addresses one function loads as its switch table (adjacent
 * tables of the same function, with their alignment padding, are one run). */
export interface LibraryJumpTable { owner: string; start: number; end: number }
/** .rdata in front of `owner`'s table; its part precedes the owner's part. */
export interface LibraryRodataSegment { symbol: string; start: number; end: number; owner: string; after?: string }
export interface LibraryRodataLayout {
  tables: LibraryJumpTable[];
  segments: LibraryRodataSegment[];
  /** Start of the .rdata that stays in `__library_member_data`. */
  tail: number;
  size: number;
  /** Why the tables cannot be moved to their owners. The member then keeps all
   * .rdata in its data part, as before, and its table owners stay unmatchable. */
  unsupported?: string;
}
const RODATA_SYMBOL = /^__library_member_rodata_(\d+)$/;
export const isLibraryRodataSymbol = (symbol: string | undefined): symbol is string => symbol !== undefined && RODATA_SYMBOL.test(symbol);
export const libraryRodataPartPath = (symbol: string) => `_rodata-${RODATA_SYMBOL.exec(symbol)![1]}.c`;
const EMPTY: LibraryRodataLayout = Object.freeze({ tables: [], segments: [], tail: 0, size: 0 });
const layouts = new WeakMap<LibraryMember, LibraryRodataLayout>();

export function libraryRodataLayout(member: LibraryMember): LibraryRodataLayout {
  let layout = layouts.get(member);
  if (!layout) layouts.set(member, layout = computeLayout(member));
  return layout;
}
/** Region boundaries [0, b1, ..., size]: every segment, table and the tail. */
export function libraryRodataRegions(layout: LibraryRodataLayout): number[] {
  return [...new Set([0, ...layout.tables.flatMap(t => [t.start, t.end]), layout.size])].sort((a, b) => a - b);
}

function computeLayout(member: LibraryMember): LibraryRodataLayout {
  const native = member.originalObject?.object;
  const rdata = native?.sections.find(s => s.name === RODATA_SECTION);
  if (!native || !rdata?.size) return EMPTY;
  const operands = nativeRelocationOperands(native);
  const code = member.functions.filter(f => f.section === ".text");
  const containing = (offset: number) => code.find(f => offset >= f.offset && offset < f.offset + f.size);
  // A case label lies inside its function, never at its entry.
  const inside = (offset: number) => code.find(f => offset > f.offset && offset < f.offset + f.size);
  const codeAddress = (i: number): number | undefined => {
    const operand = operands[i];
    if (!operand || "unresolved" in operand || !operand.reference) return undefined;
    if (operand.reference === ".text@0") return operand.addend;
    const named = /^named:(.+)$/.exec(operand.reference);
    const symbol = named ? native.symbols.find(s => s.name === named[1] && s.section === ".text") : undefined;
    return symbol ? symbol.offset + operand.addend : undefined;
  };
  const words = new Map<number, string>(), loads = new Set<string>();
  let pending: number[] = [];
  native.relocations.forEach((r, i) => {
    const operand = operands[i];
    if (r.kind === "REFHI") pending.push(i);
    if (r.section === RODATA_SECTION && r.kind === "REFWORD") {
      const address = codeAddress(i), owner = address === undefined ? undefined : inside(address);
      if (owner) words.set(r.offset, owner.name);
    }
    if (r.section === ".text" && (r.kind === "REFHI" || r.kind === "REFLO") && operand && !("unresolved" in operand) && operand.reference === `${RODATA_SECTION}@0`) {
      // A LO16 operand is its low half; the paired HI16 carries the full addend.
      const hi = r.kind === "REFLO" ? pending.at(-1) : undefined, full = hi === undefined ? operand : operands[hi]!;
      const loader = containing(r.offset);
      if (loader && !("unresolved" in full)) loads.add(`${loader.name}@${full.addend}`);
    }
    if (r.kind === "REFLO") pending = [];
  });
  const offsets = [...words.keys()].sort((a, b) => a - b), tables: LibraryJumpTable[] = [];
  for (let k = 0; k < offsets.length;) {
    const start = offsets[k]!, owner = words.get(start)!;
    k++;
    if (!loads.has(`${owner}@${start}`)) continue;
    let end = start + 4;
    while (k < offsets.length && offsets[k] === end && words.get(end) === owner) { end += 4; k++; }
    const previous = tables.at(-1);
    // GCC aligns every table to 8: a same-function neighbour across zero padding is one run.
    if (previous?.owner === owner && start - previous.end < 8 && rdata.data.subarray(previous.end, start).every(b => b === 0)) previous.end = end;
    else tables.push({ owner, start, end });
  }
  if (!tables.length) return EMPTY;
  const order = (name: string) => code.findIndex(f => f.name === name);
  const segments: LibraryRodataSegment[] = [];
  let cursor = 0, unsupported: string | undefined;
  tables.forEach((table, i) => {
    const previous = tables[i - 1];
    if (previous && order(table.owner) < order(previous.owner))
      unsupported ??= `switch table at ${RODATA_SECTION}+0x${table.start.toString(16)} (${table.owner}) precedes the table of ${previous.owner}, which comes after it in .text`;
    if (table.start > cursor) {
      if (previous?.owner === table.owner) unsupported ??= `read-only data between two switch tables of ${table.owner} at ${RODATA_SECTION}+0x${cursor.toString(16)}`;
      segments.push({ symbol: `__library_member_rodata_${segments.length}`, start: cursor, end: table.start, owner: table.owner, ...(previous ? { after: previous.owner } : {}) });
    }
    cursor = table.end;
  });
  return unsupported ? { ...EMPTY, unsupported } : { tables, segments, tail: cursor, size: rdata.size };
}

/** Listing words carry `/* FILEOFFSET VRAM [BYTES] *\/`; hex-dump comments carry one field. */
const DATA_LINE = /^\s*\/\*\s*([\da-f]+)\s+([\da-f]+)(?:\s+[\da-f]+)?\s*\*\/\s*\S/i;
const LABEL_LINE = /^\s*(?:(?:glabel|dlabel|jlabel|alabel|ehlabel)\s+([\w.$]+)|([\w.$]+):\s*$)/;
const LEADING_LINE = /^\s*(?:$|(?:glabel|dlabel|jlabel|alabel|ehlabel|nonmatching)\s|[\w.$]+:\s*$|\/\*(?!\s*[\da-f]+\s*\*\/).*\*\/\s*$)/i;
/** Cut one section of a listing at the given section offsets into
 * `boundaries.length + 1` regions. A cut falls before the labels and comments
 * that introduce the first word at or after it, and must land exactly on a word:
 * a directive spanning a boundary fails closed. A region that does not start
 * with a label gets one (`RO_<vram>`), so references into it can be written
 * against storage the region itself defines. */
export function cutListingSection(text: string, sectionOffset: number, boundaries: number[]): string[] {
  const lines = text.split("\n"), names = new Set(lines.flatMap(line => { const m = LABEL_LINE.exec(line); return m ? [m[1] ?? m[2]!] : []; }));
  const word = (line: string) => { const m = DATA_LINE.exec(line); return m ? { offset: parseInt(m[1]!, 16) - sectionOffset, vram: m[2]! } : undefined; };
  const cuts: number[] = [];
  for (const boundary of boundaries) {
    const j = lines.findIndex(line => (word(line)?.offset ?? -1) >= boundary);
    if (j < 0) { cuts.push(lines.length); continue; }
    if (word(lines[j]!)!.offset !== boundary) throw new Error(`listing has no word at ${RODATA_SECTION}+0x${boundary.toString(16)}; a directive spans the cut`);
    let start = j;
    while (start > 0 && LEADING_LINE.test(lines[start - 1]!) && !word(lines[start - 1]!)) start--;
    if (!lines.slice(start, j).some(line => LABEL_LINE.test(line))) {
      let name = `RO_${word(lines[j]!)!.vram.toUpperCase().padStart(8, "0")}`;
      while (names.has(name)) name += "_";
      names.add(name); lines.splice(j, 0, `dlabel ${name}`);
    }
    cuts.push(start);
  }
  if (cuts.some((cut, i) => i && cut < cuts[i - 1]!)) throw new Error("listing words are out of section order");
  return [0, ...cuts].map((cut, i) => lines.slice(cut, cuts[i] ?? lines.length).join("\n"));
}
