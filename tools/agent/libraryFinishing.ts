/** Member-finishing targets: a C TU's generated data part (`_data.c`) and its
 * symbol-order part (`_symbols.c`). These helpers prepare evidence and drafts;
 * the whole-member object hash stays the only acceptance. */
import { readLnk } from "../lib/objectFormats/lnk.js";

export interface DataObject { name: string; section: string; size: number; global: boolean }

/** Objects of a generated data listing: section, extent in listing bytes and
 * linkage. Alignment padding between objects is not counted. */
export function libraryDataObjects(listing: string): DataObject[] {
  const objects: DataObject[] = [], globals = new Set<string>();
  let section = ".data", current: DataObject | undefined;
  for (const raw of listing.split("\n")) {
    const line = raw.replace(/^\s*\/\*.*?\*\/\s*/, "").trim();
    if (!line || line.startsWith("/*") || line.startsWith("#")) continue;
    const directive = /^\.(data|rdata|rodata|bss|sdata|sbss|text)\b/.exec(line) ?? /^\.section\s+\.?(\S+?)(?:,|\s|$)/.exec(line);
    if (directive) { section = `.${directive[1]}`; current = undefined; continue; }
    const globl = /^\.globl\s+([A-Za-z_.$][\w.$]*)/.exec(line);
    if (globl) { globals.add(globl[1]!); continue; }
    const common = /^\.(l?comm)\s+([A-Za-z_.$][\w.$]*)\s*,\s*(\w+)/.exec(line);
    if (common) { objects.push({ name: common[2]!, section: common[1] === "comm" ? "COMMON" : ".bss", size: Number(common[3]), global: common[1] === "comm" }); current = undefined; continue; }
    const label = /^(?:[dg]label\s+)?([A-Za-z_.$][\w.$]*):?\s*$/.exec(line);
    if (label && (line.endsWith(":") || /^[dg]label\s/.test(line))) { current = { name: label[1]!, section, size: 0, global: false }; objects.push(current); continue; }
    if (!current) continue;
    const value = /^\.(word|short|half|byte|space|skip|asciz|ascii)\s+(.*)$/.exec(line);
    if (!value) continue;
    const [, kind, args] = value;
    if (kind === "space" || kind === "skip") current.size += Number(args!.split(",")[0]);
    else if (kind === "asciz" || kind === "ascii") current.size += stringBytes(args!) + (kind === "asciz" ? 1 : 0);
    else current.size += args!.split(",").length * (kind === "word" ? 4 : kind === "byte" ? 1 : 2);
  }
  for (const object of objects) if (globals.has(object.name)) object.global = true;
  return objects;
}
function stringBytes(quoted: string): number {
  const body = quoted.trim().replace(/^"|"$/g, "");
  return body.replace(/\\(?:x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, "_").length;
}

/** Top-level data definitions from m2c output: initialized or tentative
 * objects, without function definitions or extern prototypes. */
export function m2cGlobalDefinitions(output: string): string[] {
  const items: string[] = [];
  let item: string[] = [], depth = 0;
  for (const line of output.split("\n")) {
    if (!item.length && (!line.trim() || line.startsWith("/*") || line.startsWith("//"))) continue;
    item.push(line);
    for (const ch of line) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (depth === 0 && /[;}]\s*(\/\*.*\*\/)?\s*$/.test(line)) { items.push(item.join("\n")); item = []; }
  }
  return items.filter(text => {
    if (/\/\*\s*extern\s*\*\//.test(text)) return false;
    const head = text.split("=")[0]!;
    const definesFunction = /\)\s*\{\s*$/.test(text.split("\n")[0]!) && !text.split("\n")[0]!.includes("=");
    const prototype = !text.includes("=") && /\)\s*;\s*$/.test(text);
    return !definesFunction && !prototype && (text.includes("=") || !head.includes("("));
  });
}

export function renderDataDraft(headers: string[], objects: DataObject[], definitions: string[], listing: string): string {
  const table = objects.map(o => ` *   ${o.name}: ${o.section}, 0x${o.size.toString(16)} bytes, ${o.global ? "global" : "static"}`).join("\n");
  return `${headers.map(h => `#include "${h}"`).join("\n")}\n\n/* Member data as C. Original objects (from ${listing}):\n${table || " *   none"}\n` +
    ` * Place each definition where the original source had it; symbol order and\n * section layout follow definition order. Types are m2c inferences. */\n\n${definitions.join("\n\n")}\n`;
}

export interface LnkSymbol { id: number; kind: "defined" | "external" | "common"; name: string }
/** External symbols of a native LNK object in ID order, the order the
 * converter assigned from the assembler's symbol table. Missing IDs belong to
 * the file's own statics, which LNK does not name. */
export function lnkSymbolOrder(bytes: Buffer): LnkSymbol[] {
  return (readLnk(bytes).records ?? []).filter(r => r.opcode === 12 || r.opcode === 14 || r.opcode === 48).map(r => {
    const b = r.bytes, external = r.opcode === 14, at = external ? 3 : 9, length = b[at]!;
    return { id: b.readUInt16LE(1), kind: r.opcode === 12 ? "defined" as const : external ? "external" as const : "common" as const, name: b.subarray(at + 1, at + 1 + length).toString("latin1") };
  }).sort((a, b) => a.id - b.id);
}
export function renderSymbolOrder(original: LnkSymbol[], candidate: LnkSymbol[]): string {
  const row = (list: LnkSymbol[]) => {
    const max = Math.max(0, ...list.map(s => s.id)), byId = new Map(list.map(s => [s.id, s]));
    return Array.from({ length: max }, (_, i) => byId.get(i + 1) ?? { id: i + 1, kind: "static" as const, name: "(file static)" });
  };
  const left = row(original), right = row(candidate);
  const lines = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    const a = left[i], b = right[i], same = a && b && a.kind === b.kind && a.name === b.name;
    return `${same ? " " : "!"} ${String(i + 1).padStart(3)}  ${(a ? `${a.kind} ${a.name}` : "-").padEnd(40)} ${b ? `${b.kind} ${b.name}` : "-"}`;
  });
  const first = lines.findIndex(l => l.startsWith("!"));
  return [`Symbol IDs (1-2 are the compiler's own labels in a C object):`, `     ID  original${" ".repeat(33)}rebuilt`, ...lines,
    first < 0 ? "Orders agree." : `First divergence at ID ${first + 1}: a definition, static or first external reference appears in a different place in the source.`].join("\n");
}
