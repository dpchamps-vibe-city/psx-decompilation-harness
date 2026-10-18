/** Original-object correspondence is an input validation, not acceptance.
 * ELF remains only a view. Relocated fields may differ in the converter's
 * documented addend convention; sites, kinds and all other bytes must agree. */
import { readFileSync } from "node:fs";
import { assertProjectInput, contextForProject } from "./runtimeContext.js";
import { basename, join } from "node:path";
import { globSync } from "node:fs";
import { readPsyqLib, hash } from "./psyqMembers.js";
import { readLnk } from "./objectFormats/lnk.js";
import type { NativeObject } from "./objectFormats/model.js";
import type { RelocatableObject } from "./relocatableObject.js";
import type { LibraryProject } from "./project.js";
export interface OriginalMember { input: string; ordinal: number; member: string; bytes: Buffer; sha256: string; inputHash: string; object: NativeObject }
export function originalMemberId(input: string, ordinal?: number): string {
  const stem = basename(input).replace(/\.[^.]+$/, "").toLowerCase();
  if (!/^[a-z0-9_]+$/.test(stem) || (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0))) throw new Error(`Unsafe original member identity: ${input}[${ordinal}]`);
  return ordinal === undefined ? stem : `${stem}_${ordinal}`;
}
export function readOriginalMembers(inputs: Array<{ path: string; archive: boolean }>, root: string): OriginalMember[] {
  const ids = new Set<string>(), result: OriginalMember[] = [];
  for (const input of inputs) {
    assertProjectInput(input.path, contextForProject(root));
    const bytes = readFileSync(join(root, input.path)), inputHash = hash(bytes);
    for (const member of input.archive ? readPsyqLib(bytes) : [{ name: basename(input.path), ordinal: 0, bytes }]) {
      const id = originalMemberId(input.path, input.archive ? member.ordinal : undefined);
      if (ids.has(id)) throw new Error(`Original member ID collision: ${id}`); ids.add(id);
      result.push({ input: input.path, ordinal: member.ordinal, member: member.name, bytes: member.bytes, sha256: hash(member.bytes), inputHash, object: readLnk(member.bytes) });
    }
  }
  return result;
}
export function transitionalOriginals(project: LibraryProject, root: string): Map<string, OriginalMember> {
  const config = project.verification.originals;
  if (!config) return new Map();
  const inputs = [ ...config.archives.map(pattern => ({ pattern, archive: true })), ...config.objects.map(pattern => ({ pattern, archive: false })) ].flatMap(({ pattern, archive }) => {
    const files = globSync(pattern, { cwd: root }).sort(); if (!files.length) throw new Error(`Original input matched nothing: ${pattern}`);
    return files.map(path => ({ path, archive }));
  });
  const originals = readOriginalMembers(inputs, root), result = new Map<string, OriginalMember>(), used = new Set<string>();
  for (const [id, selection] of Object.entries(config.map)) {
    const path = "archive" in selection ? selection.archive : selection.object, ordinal = "archive" in selection ? selection.ordinal : 0;
    const found = originals.filter(m => m.input === path && m.ordinal === ordinal);
    if (found.length !== 1) throw new Error(`Unmapped original for ${id}: ${path}[${ordinal}]`);
    const key = `${path}:${ordinal}`; if (used.has(key)) throw new Error(`Original selected twice: ${key}`); used.add(key); result.set(id, found[0]!);
  }
  return result;
}
export function validateElfView(original: NativeObject, view: RelocatableObject): void {
  const types = { REFHALF: 1, REFWORD: 2, JMPADDR: 4, REFHI: 5, REFLO: 6, GPREL: 7, LITERAL: 8 };
  const originalSites = original.relocations.map(r => `${r.section}:${r.offset}:${types[r.kind]}`).sort(), viewSites = view.relocations.map(r => `${r.section}:${r.offset}:${r.type}`).sort();
  if (JSON.stringify(originalSites) !== JSON.stringify(viewSites)) throw new Error("ELF correspondence: relocation sites/kinds differ");
  for (const s of original.sections) {
    const v = view.sections.get(s.name);
    if (!v && !s.size) continue; // Empty format declarations contain no view storage.
    if (!v || s.size !== v.size || (s.kind === "bss") !== (v.type === 8)) throw new Error(`ELF correspondence: ${s.name} storage differs`);
    for (let i = 0; i < s.data.length; i++) {
      const reloc = original.relocations.find(r => r.section === s.name && i >= r.offset && i < r.offset + (r.kind === "REFHALF" || ["REFHI", "REFLO", "GPREL", "LITERAL"].includes(r.kind) ? 2 : 4));
      if (!reloc && s.data[i] !== v.data[i]) throw new Error(`ELF correspondence: ${s.name}+${i} unrelocated byte differs`);
      if (reloc?.kind === "JMPADDR" && i === reloc.offset + 3 && (s.data[i]! & 0xfc) !== (v.data[i]! & 0xfc)) throw new Error(`ELF correspondence: ${s.name}+${i} opcode differs`);
    }
  }
  for (const [name, s] of view.sections) if ((s.flags & 2) && s.size && ![0x70000006, 0x7000002a].includes(s.type) && !original.sections.some(o => o.name === name)) throw new Error(`ELF correspondence: extra ${name}`);
  const visible = (list: Array<{ name: string; section: string; value: number; size: number }>) => list.map(s =>
    `${s.name}:${s.section}:${s.section === "COMMON" ? s.size : s.section === "UND" ? "" : s.value}`).sort();
  if (JSON.stringify(visible(original.symbols.filter(s => s.binding === "external").map(s => ({ ...s, value: s.offset })))) !== JSON.stringify(visible(view.symbols.filter(s => s.binding !== 0 && s.type !== 4)))) throw new Error("ELF correspondence: external symbol identity differs");
  const target = (reference: string) => reference.replace(/^(?:import|named):/, "symbol:");
  // The view converter moves LNK expression constants into ELF REL fields.
  // This is only a view-correspondence check: native acceptance retains the
  // complete expression and every original byte unchanged.
  const leaf = (expression: import("./objectFormats/model.js").Expression): string => {
    if (expression.op === "add" && expression.left.op === "value") return leaf(expression.right);
    if ((expression.op === "add" || expression.op === "sub") && expression.right.op === "value") return leaf(expression.left);
    if (expression.op === "base") {
      const record = original.records?.find(r => r.opcode === 16 && r.bytes.readUInt16LE(1) === expression.id);
      if (record) return `${record.bytes.toString("latin1", 7, 7 + record.bytes[6]!)}@0`;
    }
    if (expression.op === "symbol") {
      const record = original.records?.find(r => [12, 14, 48].includes(r.opcode) && r.bytes.readUInt16LE(1) === expression.id);
      if (record) { const at = record.opcode === 14 ? 3 : 9; return `symbol:${record.bytes.toString("latin1", at + 1, at + 1 + record.bytes[at]!)}`; }
    }
    throw new Error("ELF correspondence: expression has no supported symbolic view");
  };
  const originalTargets = original.relocations.map(r => `${r.section}:${r.offset}:${target(r.target.startsWith("expression:") && r.expression ? leaf(r.expression) : r.target)}`).sort();
  const viewTargets = view.relocations.map(r => `${r.section}:${r.offset}:${target(r.reference)}`).sort();
  if (JSON.stringify(originalTargets) !== JSON.stringify(viewTargets)) throw new Error("ELF correspondence: relocation targets differ");
}
