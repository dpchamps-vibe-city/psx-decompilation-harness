/** Split symbolic disassembly into reference stubs. The assembler, not a copied
 * relocation table, must reconstruct the object. Unrepresentable listings fail
 * closed; the whole-member oracle is the only round-trip certificate. */
import type { LibraryMember } from "./libraryTargets.js";
import { libraryAssemblyParts as legacyLibraryAssemblyParts } from "./libraryAssemblyLegacy.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileDigest, snapshot } from "./contentCache.js";
import { executedToolIdentity } from "./toolProvenance.js";
import { dependencyPaths, scanDependencies } from "./dependencyScanner.js";
import { analyzeCSource, walkActiveC } from "../agent/cSourceAnalysis.js";
import { parseC } from "../agent/residual-source-search/tree-sitter-c.js";
import { configuredAssembler, configuredAssemblyCppFlags, configuredTool } from "./toolchain.js";
import { libraryContext, loadLibraryProject } from "./project.js";
import { projectRoot } from "./runtimeContext.js";
import { nativeRelocationOperands } from "./objectFormats/relocations.js";
import { dmpsxSource, DMPSX_OPERATIONS } from "./stages/psyqDmpsx.js";
/** ID 1/2 exports precede GCC's file/option entries in assembly-origin members. */
export function libraryMemberOrigin(member: LibraryMember): "c" | "assembly" {
  return member.originalObject?.object.records?.some(r => r.opcode === 12 && r.bytes.readUInt16LE(1) <= 2) ? "assembly" : "c";
}
export interface LibraryAssemblyPart { symbol: string; text: string; functions: string[]; preprocess?: boolean; translationUnit?: string }
export function librarySourceScaffold(member: LibraryMember, headers: string[], parts: LibraryAssemblyPart[], folder = `build/libraries/nonmatchings/${member.id}`): string {
  return `/* Original TU: ${member.originalObject?.input ?? member.input}[${member.ordinal}] ${member.member}\n * sha256: ${member.originalObject?.sha256 ?? member.sha256}\n * One original member, one TU. Replace INCLUDE_ASM stubs with C; keep neighboring code/data.\n * Functions: ${member.functions.map(f => f.name).join(", ") || "none identified (data-only or unresolved code)"}\n */\n` +
    [...new Set([...headers, "include_asm.h"])].map(h => `#include "${h}"\n`).join("") + "\n" +
    parts.map(part => `INCLUDE_ASM("${folder}", ${part.symbol});\n`).join("");
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const registers = ["zero", "at", "v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra"];
/** Reserve the assembler's external IDs before any part can mention a name.
 * Hidden slots are nil symbols, not serialized definitions. */
export function librarySymbolPart(member: LibraryMember): string {
  const symbols = new Map(member.originalObject?.object.symbols.filter(s => s.id !== undefined).map(s => [s.id!, s]) ?? []);
  const lines = [".set noat", ".set noreorder", ".text"];
  const manifest = resolve(projectRoot(), member.source);
  const assembly = existsSync(manifest) && manifest.endsWith("/tu.json") && JSON.parse(readFileSync(manifest, "utf8")).parts.some((p: { path: string }) => /\.(?:s|ASM)$/.test(p.path));
  for (let id = assembly || libraryMemberOrigin(member) === "assembly" ? 1 : 3; id <= Math.max(0, ...symbols.keys()); id++)
    lines.push(symbols.has(id) ? `.globl ${symbols.get(id)!.name}` : `__lnk_hidden_${id}:`);
  return lines.join("\n") + "\n";
}
function sourceReferences(member: LibraryMember): Set<string> {
  const file = resolve(projectRoot(), member.source);
  if (!existsSync(file) || !file.endsWith("/tu.json")) return new Set();
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const names = new Set<string>();
  for (const part of manifest.parts) {
    if (part.backlog) continue;
    const text = readFileSync(join(dirname(file), part.path), "utf8");
    if (/\.(?:s|ASM)$/.test(part.path)) { for (const name of text.match(/[\w.$]+/g) ?? []) names.add(name); continue; }
    if (analyzeCSource(text).includeAsm.length) continue;
    const tree = parseC(text);
    try { walkActiveC(tree.rootNode, node => {
      if (node.type === "identifier") names.add(node.text);
      if (node.type === "preproc_arg") for (const name of node.text.match(/[\w.$]+/g) ?? []) names.add(name);
      return true;
    }); } finally { tree.delete(); }
  }
  return names;
}
/** Reconstruct source order only where original patch order witnesses that GAS
 * filled the slot. A referenced slot label forbids moving its instruction. */
function reorderDelaySlots(member: LibraryMember, text: string, context: string): string {
  const native = member.originalObject?.object;
  if (!native) return text;
  const moved = new Set<string>(), patches = native.relocations;
  const delay = (word: number) => {
    const op = word >>> 26, fn = word & 63, rt = word >>> 16 & 31;
    return op === 2 || op === 3 || op >= 4 && op <= 7 || op === 0 && [8, 9].includes(fn) || op === 1 && [0, 1, 16, 17].includes(rt) || op >= 16 && op <= 19 && (word >>> 21 & 31) === 8;
  };
  patches.forEach((p, i) => {
    if (p.kind === "JMPADDR" && patches.slice(0, i).some(q => q.section === p.section && q.offset === p.offset + 4)) moved.add(`${p.section}:${p.offset}`);
    const hi = patches[i - 1], bytes = native.sections.find(s => s.name === p.section)?.data;
    if (p.kind === "REFLO" && hi?.kind === "REFHI" && hi.section === p.section && hi.offset < p.offset - 4 && p.offset >= 4 && bytes && delay(bytes.readUInt32LE(p.offset - 4))) moved.add(`${p.section}:${p.offset - 4}`);
  });
  const lines = text.split("\n"), at: Array<{ line: number; section: string; offset: number }> = [];
  let section = "";
  lines.forEach((line, i) => {
    const sec = /^\.(text|data|rdata|sdata|bss)\b/.exec(line.trim()); if (sec) section = `.${sec[1]}`;
    const word = /\/\*\s*([\da-f]+)\s+[\da-f]+\s+[\da-f]{8}\s*\*\//i.exec(line);
    if (word) at.push({ line: i, section, offset: parseInt(word[1]!, 16) - (member.viewObject ?? member.object).sections.get(section)!.offset });
  });
  const regions: Array<{ start: number; end: number; swaps: Array<[number, number]> }> = [], drop = new Set<number>();
  at.forEach((jump, i) => {
    if (!moved.has(`${jump.section}:${jump.offset}`)) return;
    const slot = at[i + 1]; if (!slot || slot.section !== jump.section || slot.offset !== jump.offset + 4) return;
    const labels = lines.slice(jump.line + 1, slot.line).flatMap((line, k) => {
      const m = /^\s*([\w.$]+):\s*$/.exec(line); return m ? [{ name: m[1]!, line: jump.line + 1 + k }] : [];
    });
    if (labels.some(l => new RegExp(`(?<![\\w.$])${escape(l.name)}(?![\\w.$])`).test(text.replace(lines[l.line]!, "")))) return;
    labels.forEach(l => drop.add(l.line));
    const start = i > 0 && at[i - 1]!.section === jump.section ? at[i - 1]!.line : jump.line;
    const last = regions.at(-1);
    if (last && start <= last.end + 1) { last.end = slot.line; last.swaps.push([jump.line, slot.line]); }
    else regions.push({ start, end: slot.line, swaps: [[jump.line, slot.line]] });
  });
  const output: string[] = []; let cursor = 0;
  for (const region of regions) {
    output.push(...lines.slice(cursor, region.start));
    const order = Array.from({ length: region.end - region.start + 1 }, (_, i) => region.start + i);
    for (const [jump, slot] of region.swaps) { const a = order.indexOf(jump), b = order.indexOf(slot); [order[a], order[b]] = [order[b]!, order[a]!]; }
    output.push(".set reorder", ...order.filter(i => !drop.has(i)).map(i => lines[i]!), ".set noreorder"); cursor = region.end + 1;
  }
  return [...output, ...lines.slice(cursor)].join("\n");
}
/** Render the listing, never repair it from target bytes. Visibility follows
 * witnessed labels; a missing original export is a generator gap, not a .set
 * manufactured from the target symbol table. */
function symbolicListing(member: LibraryMember, assembly: string, period: boolean, contextAssembly = assembly): string {
  const exports = new Map(member.object.symbols.filter(s => s.binding !== 0 && member.object.sections.has(s.section)).map(s => [s.name, s]));
  const defined = new Set<string>();
  let section = "";
  const native = member.originalObject?.object, operands = native ? nativeRelocationOperands(native) : [];
  const fullAddends = new Map<number, number>();
  const pending: number[] = [];
  native?.relocations.forEach((r, i) => {
    const operand = operands[i]!;
    if ("unresolved" in operand) throw new Error(`${member.id}: ${operand.unresolved}`);
    fullAddends.set(i, operand.addend);
    if (r.kind === "REFHI") pending.push(i);
    if (r.kind === "REFLO") {
      if (pending.length) fullAddends.set(i, fullAddends.get(pending[pending.length - 1]!)!);
      pending.length = 0;
    }
  });
  const labels = new Map<string, Array<{ name: string; offset: number }>>();
  let scanSection = "", waiting: string[] = [];
  for (const line of contextAssembly.split("\n")) {
    const header = /^\.section\s+([^\s,]+)/.exec(line);
    if (header) { scanSection = header[1]!; waiting = []; }
    const label = /^\s*(?:(?:glabel|dlabel|jlabel|alabel|ehlabel)\s+([\w.$]+)(?:,\s*\w+)?|([\w.$]+):)\s*(?:#.*)?$/.exec(line);
    if (label) waiting.push(label[1] ?? label[2]!);
    const word = /\/\*\s*([\da-f]+)\s+/i.exec(line);
    if (word && waiting.length) {
      const offset = parseInt(word[1]!, 16) - (member.viewObject ?? member.object).sections.get(scanSection)!.offset;
      const rows = labels.get(scanSection) ?? []; rows.push(...waiting.map(name => ({ name, offset }))); labels.set(scanSection, rows); waiting = [];
    }
  }
  const result = assembly.split("\n").map(line => {
    if (period && /^\s*\.include\s+"macro.inc"/.test(line)) return "";
    const directive = /^\.section\s+([^\s,]+)/.exec(line);
    if (directive) {
      section = directive[1]!;
      // Use source operations, not ELF flags copied into a directive. Unknown
      // sections require an explicit source representation from the caller.
      if (period) {
        if (section === ".sbss") throw new Error(`${member.id}: .sbss data has no witnessed generator rule`);
        if (![".text", ".data", ".rdata", ".sdata", ".bss"].includes(section)) throw new Error(`${member.id}: no period section operation for ${section}`);
        return section;
      }
    }
    const label = /^\s*(glabel|dlabel|jlabel|alabel|ehlabel)\s+([\w.$]+)(?:,\s*\w+)?\s*(?:#.*)?$/.exec(line);
    if (label) {
      const name = label[2]!, symbol = exports.get(name); defined.add(name);
      if (symbol && symbol.binding !== 1) throw new Error(`${member.id}: unsupported export binding for ${name}`);
      // Never export disassembler-invented labels. Keep modern function type
      // operations only where the selected object format supports them.
      return `${symbol ? `.globl ${name}\n` : ""}${!period && symbol ? `.type ${name}, @${label[1] === "glabel" || label[1] === "alabel" ? "function" : "object"}\n` : ""}${name}:`;
    }
    const marker = /^\s*nonmatching\s+([\w.$]+)(?:,\s*[^\s]+)?\s*$/.exec(line);
    if (marker) return "";
    const end = /^\s*(?:endlabel|enddlabel)\s+([\w.$]+)\s*$/.exec(line);
    if (end) return !period && exports.has(end[1]!) ? `.size ${end[1]}, . - ${end[1]}` : "";
    if (period) {
      const word = /\/\*\s*([\da-f]+)\s+[\da-f]+\s+([\da-f]{8})\s*\*\/\s*(.*)$/i.exec(line);
      if (word) {
        const offset = parseInt(word[1]!, 16) - (member.viewObject ?? member.object).sections.get(section)!.offset;
        const index = native?.relocations.findIndex(r => r.section === section && r.offset === offset) ?? -1;
        if (index >= 0) {
          const r = native!.relocations[index]!, operand = operands[index]!;
          if ("unresolved" in operand) throw new Error(operand.unresolved);
          const addend = fullAddends.get(index)!;
          let expression: string;
          const local = /^(.+)@0$/.exec(operand.reference ?? "");
          if (local) {
            const anchors = labels.get(local[1]!) ?? [];
            const anchor = anchors.find(a => a.offset === 0) ?? anchors[0];
            if (!anchor) throw new Error(`${member.id}: no storage anchor for ${local[1]}`);
            const delta = addend - anchor.offset;
            expression = anchor.name + (delta ? `${delta < 0 ? "-" : "+"}${Math.abs(delta)}` : "");
          } else expression = (operand.reference ?? "").replace(/^(?:named:|import:)/, "") + (addend ? `${addend < 0 ? "-" : "+"}${Math.abs(addend)}` : "");
          if (r.kind === "REFHI" || r.kind === "REFLO") line = line.replace(/%(hi|lo)\([^)]*\)/, `%${r.kind === "REFHI" ? "hi" : "lo"}(${expression})`);
          else if (r.kind === "JMPADDR") line = line.replace(/\b(jal|j)\s+\S+\s*$/, `$1 ${expression}`);
          else if (r.kind === "REFWORD") line = line.replace(/\.word\s+.*$/, `.word ${expression}`);
        }
        const raw = Buffer.from(word[2]!, "hex").readUInt32LE();
        if (index < 0 && !(member.object.sections.get(section)?.flags! & 4) && /^\.word\b/.test(word[3]!)) {
          const literal = /^\.word\s+([-+]?(?:0x[\da-f]+|\d+))\s*$/i.exec(word[3]!);
          if (literal && ((Number(literal[1]!.replace(/^[-+]/, "")) * (literal[1]!.startsWith("-") ? -1 : 1)) >>> 0) !== raw)
            throw new Error(`${member.id}: data literal disagrees with its disassembly bytes at ${section}+${offset}`);
          line = line.replace(/\.word\s+.*$/, `.word 0x${raw.toString(16).padStart(8, "0")}`);
        }
        if (raw >>> 26 === 0 && (raw & 63) === 0x25)
          line = line.replace(/\bmove\s+(\S+),\s*(\S+)\s*$/, "or $1, $2, zero");
      }
    }
    if (period) line = line.replace(/\$([a-z][a-z0-9]*)\b/g, (all, name) => {
      const n = name === "s8" ? 30 : registers.indexOf(name); return n < 0 ? all : n === 1 ? "AT" : registers[n]!;
    });
    if (period && (member.object.sections.get(section)?.flags! & 4)) {
      const command = /(?:\.word|cop2)\s+(0x[\da-f]+)\s*$/i.exec(line);
      if (command) {
        const word = (Number(command[1]) | (command[0].startsWith("cop2") ? 0x4a000000 : 0)) >>> 0;
        const operation = dmpsxSource(word);
        if (operation) line = line.slice(0, command.index) + operation;
      }
      line = line.replace(/^(\s*(?:\/\*.*?\*\/\s*)?)([a-z][a-z0-9]*)\b/i, (all, prefix, opcode) => {
        const operation = opcode.toLowerCase() === "dpcl" ? "DCPL" : opcode.toUpperCase();
        return (DMPSX_OPERATIONS as readonly string[]).includes(operation) ? prefix + operation : all;
      });
      line = line.replace(/\b(MVMVA|SQR|OP|GPF|GPL)\s+([^#\n]+?)\s*$/, "$1($2)");
    }
    return line;
  }).join("\n");
  const compilerLabels = period;
  const globalNames = new Set((native?.symbols.filter(s => s.binding === "external") ?? [...exports.values()]).map(s => s.name));
  const localNames = [...contextAssembly.matchAll(/^\s*(?:(?:glabel|dlabel|jlabel|alabel|ehlabel)\s+([\w.$]+)|([\w.$]+):)/gm)].map(m => m[1] ?? m[2]!).filter(name => !globalNames.has(name));
  let rendered = result;
  const references = sourceReferences(member);
  if (compilerLabels) for (const name of new Set(localNames.filter(name => !references.has(name)))) rendered = rendered.replace(new RegExp(`(?<![\\w.$])${escape(name)}(?![\\w.$])`, "g"), () => `$L${name.replace(/[^\w]/g, "_")}`);
  for (const name of exports.keys()) if (!defined.has(name)) throw new Error(`${member.id}: generator gap: missing storage label ${name}`);
  return period ? reorderDelaySlots(member, rendered, contextAssembly) : rendered;
}
/** Materialize source BEFORE assembly. The expanded fragment is tied to its
 * source, headers, flags and actual cpp, so a tool switch cannot reuse it. */
export function writeLibraryAssemblyParts(member: LibraryMember, parts: LibraryAssemblyPart[], root = projectRoot(), folder = join(root, "build/libraries/nonmatchings", member.id)): void {
  mkdirSync(folder, { recursive: true });
  for (const part of parts) {
    const output = join(folder, `${part.symbol}.s`);
    if (!part.preprocess) { writeFileSync(output, part.text); continue; }
    const source = join(folder, `${part.symbol}.ASM`), context = libraryContext(member.id, root);
    writeFileSync(source, part.text);
    const flags = configuredAssemblyCppFlags(context, root);
    const dependencies = dependencyPaths(scanDependencies(source, flags, root), root);
    execFileSync(configuredTool("cpp", root), [...flags, source, "-o", output], { cwd: root });
    writeFileSync(`${output}.cpp.json`, JSON.stringify({ cpp: executedToolIdentity("cpp", root), flags,
      inputs: snapshot(root, [source, ...dependencies]), outputSha256: fileDigest(output) }, null, 2) + "\n");
  }
}
export function libraryAssemblyInputs(member: LibraryMember, symbol: string, root = projectRoot()): string[] {
  const output = join(root, "build/libraries/nonmatchings", member.id, `${symbol}.s`);
  if (configuredAssembler(libraryContext(member.id, root), root).objectFormat !== "ecoff") return [relative(root, output)];
  try {
    const receipt = JSON.parse(readFileSync(`${output}.cpp.json`, "utf8"));
    if (JSON.stringify(receipt.cpp) !== JSON.stringify(executedToolIdentity("cpp", root)) ||
        JSON.stringify(receipt.flags) !== JSON.stringify(configuredAssemblyCppFlags(libraryContext(member.id, root), root)) ||
        receipt.outputSha256 !== fileDigest(output) ||
        JSON.stringify(receipt.inputs) !== JSON.stringify(snapshot(root, Object.keys(receipt.inputs)))) throw new Error("producer/input changed");
    return [relative(root, output), relative(root, `${output}.cpp.json`), ...Object.keys(receipt.inputs)];
  } catch (error) { throw new Error(`${member.id}/${symbol}: stale or missing period source preprocessing receipt; regenerate library splits (${error})`); }
}
export function libraryAssemblyParts(member: LibraryMember, assembly: string): LibraryAssemblyPart[] {
  if (member.functions.some(fn => fn.name === "__library_member_data")) throw new Error("Reserved scaffold symbol __library_member_data conflicts with an original function");
  const root = projectRoot(), project = loadLibraryProject(root);
  const context = project ? libraryContext(member.id, root, project) : { kind: "library" as const, id: member.id };
  const period = configuredAssembler(context, root).objectFormat === "ecoff";
  if (!period) return legacyLibraryAssemblyParts(member, assembly);
  // Split before rendering markers into ordinary local labels.
  const parts: LibraryAssemblyPart[] = [], data: string[] = [];
  const sections = [...assembly.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
  const directives = '.set noat\n.set noreorder\n';
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i]!.index!, end = sections[i + 1]?.index ?? assembly.length;
    const section = sections[i]![1]!, original = member.object.sections.get(section), text = assembly.slice(start, end);
    if (!(original?.flags! & 4)) { data.push(text); continue; }
    const anchors = member.functions.filter(f => f.section === section).flatMap(fn => {
      const match = new RegExp(`^nonmatching\\s+${escape(fn.name)}(?:,|\\s|$)`, "m").exec(text);
      return match ? [{ fn, at: match.index }] : [];
    }).sort((a, b) => a.at - b.at);
    if (!anchors.length) { data.push(text); continue; }
    const prefix = text.slice(0, anchors[0]!.at);
    const leadingCode = /^\s*(?:nonmatching|glabel)\s+/m.exec(prefix);
    const sectionHeader = leadingCode ? prefix.slice(0, leadingCode.index) : prefix;
    for (let j = 0; j < anchors.length; j++) {
      const a = anchors[j]!, end = anchors[j + 1]?.at ?? text.length;
      const header = j === 0 ? prefix : sectionHeader.replace(/^\s*\.(?:align|balign|p2align)\b[^\n]*\n/gm, "");
      parts.push({ symbol: a.fn.name, functions: [a.fn.name], text: directives + header + text.slice(a.at, end) });
    }
  }
  const commons: string[] = [];
  for (const s of member.object.symbols.filter(s => s.section === "COMMON")) {
    if (!/^[A-Za-z_]\w*$/.test(s.name)) throw new Error(`Cannot scaffold COMMON symbol ${s.name}`);
    commons.push(`.comm ${s.name}, ${s.size}\n`);
  }
  data.push(...commons);
  if (data.length) parts.push({ symbol: "__library_member_data", functions: [], text: directives + data.join("\n") });
  if (!parts.length) {
    const allocated = [...member.object.sections.values()].some(s => (s.flags & 2) && s.size > 0);
    const publicSymbols = member.object.symbols.some(s => s.binding !== 0 && s.type !== 4);
    if (allocated || publicSymbols || member.object.relocations.length || member.functions.length) throw new Error(`No assembly sections found for ${member.id}`);
    parts.push({ symbol: "__library_member_data", functions: [], text: directives + "/* Metadata-only member. */\n" });
  }
  for (const fn of member.functions) if (!parts.some(p => p.functions.includes(fn.name)))
    throw new Error(`No independent assembly boundary for ${member.id}::${fn.name}; aliases/unsupported listings need review`);
  // Validate all exports across the complete listing, then render each split
  // with only the exports it actually owns. No tail-byte or relocation fixups.
  // COMMON declarations have no listing section: both extraction forms must
  // carry the same original-derived data, including assembly-origin backlogs.
  const whole = symbolicListing(member, assembly, period) + "\n" + commons.join("");
  const manifest = resolve(root, member.source);
  const assemblyTu = period && (libraryMemberOrigin(member) === "assembly" || existsSync(manifest) && manifest.endsWith("/tu.json") && JSON.parse(readFileSync(manifest, "utf8")).parts.some((p: { path: string }) => /\.(?:s|ASM)$/.test(p.path)));
  for (const part of parts) {
    const owned = member.object.symbols.filter(s => !member.object.sections.has(s.section) ||
      new RegExp(`^\\s*(?:glabel|dlabel|jlabel|alabel|ehlabel)\\s+${escape(s.name)}(?:,|\\s|$)`, "m").test(part.text));
    part.text = symbolicListing({ ...member, object: { ...member.object, symbols: owned } }, part.text, period, assembly);
    if (period) { part.preprocess = true; part.text = '#include <asm.h>\n#include <inline_s.h>\n' + part.text; }
  }
  if (assemblyTu) parts.push({ symbol: "__library_member_assembly", functions: [], preprocess: true, text: '#include <asm.h>\n#include <inline_s.h>\n' + whole });
  if (period) parts.unshift({ symbol: "__library_member_symbols", functions: [], preprocess: true, text: librarySymbolPart(member), ...(assemblyTu ? { translationUnit: `.include "build/libraries/nonmatchings/${member.id}/__library_member_symbols.s"\n.include "build/libraries/nonmatchings/${member.id}/__library_member_assembly.s"\n` } : {}) });
  return parts;
}
