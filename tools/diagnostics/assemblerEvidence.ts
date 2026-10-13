/** Original-word assembler-family observations, never configuration changes.
 * Register relations nominate a family, not a compiler or assembler version. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filesUnder } from "../lib/contentCache.js";
import { readPsyqLib } from "../lib/psyqMembers.js";
import { readRelocatableObject, type RelocatableObject } from "../lib/relocatableObject.js";
import { configuredSdk } from "../lib/toolchain.js";
import { projectRoot } from "../lib/runtimeContext.js";
import { libraryMembers } from "../lib/libraryTargets.js";
import { loadLibraryProject } from "../lib/project.js";

export function indexedLoadCensus(object: RelocatableObject) {
  const counts = { "gas-rule": 0, "aspsx-rule": 0, ambiguous: 0, other: 0 };
  const examples: Array<{ section: string; offset: number; temp: number; destination: number; base: number; classification: keyof typeof counts }> = [];
  for (const [section, text] of object.sections) {
    if (!(text.flags & 4)) continue;
    const relocations = new Map(object.relocations.filter(r => r.section === section).map(r => [r.offset, r]));
    for (let offset = 0; offset + 12 <= text.data.length; offset += 4) {
      const a = text.data.readUInt32LE(offset), b = text.data.readUInt32LE(offset + 4), c = text.data.readUInt32LE(offset + 8);
      const high = relocations.get(offset), low = relocations.get(offset + 8), temp = (a >>> 16) & 31;
      if (a >>> 26 !== 15 || !temp || high?.type !== 5 || low?.type !== 6 || high.reference !== low.reference ||
          b >>> 26 !== 0 || (b & 63) !== 33 || ((b >>> 11) & 31) !== temp ||
          ![32, 33, 34, 35, 36, 37, 38].includes(c >>> 26) || ((c >>> 21) & 31) !== temp) continue;
      const rs = (b >>> 21) & 31, rt = (b >>> 16) & 31;
      const base = rs === temp ? rt : rt === temp ? rs : temp, destination = (c >>> 16) & 31;
      if (base === temp || !base) continue;
      const classification = temp === 1 ? destination === base ? "ambiguous" : "aspsx-rule" :
        temp === destination && destination !== base ? "gas-rule" : "other";
      counts[classification]++;
      if (examples.length < 6) examples.push({ section, offset, temp, destination, base, classification });
    }
  }
  const classification = counts["gas-rule"] && counts["aspsx-rule"] ? "mixed" : counts["gas-rule"] ? "gas-rule" : counts["aspsx-rule"] ? "aspsx-rule" : "ambiguous";
  return { classification, counts, examples };
}
/** Bounded native LNK v2 record reader. Payload bytes are skipped, not searched
 * for opcodes; unknown/truncated records make absence evidence incomplete.
 * Layout follows the supported LIB/LNK converter record grammar. */
export function lnkPackaging(bytes: Buffer) {
  const sections: Array<{ id: number; name: string }> = [], files: string[] = [];
  let pos = 4, complete = false, error: string | undefined;
  const need = (size: number) => { if (pos + size > bytes.length) throw new Error(`Truncated LNK at ${pos}`); };
  const skip = (size: number) => { need(size); pos += size; };
  const byte = () => { need(1); return bytes[pos++]!; };
  const u16 = () => { need(2); const value = bytes.readUInt16LE(pos); pos += 2; return value; };
  const text = () => { const size = byte(); need(size); const value = bytes.toString("latin1", pos, pos + size); pos += size; return value; };
  const expression = (depth = 0): void => {
    if (depth > 64) throw new Error("LNK expression nesting exceeds 64");
    const op = byte();
    if (op === 0) skip(4);
    else if ([2, 4, 12, 22].includes(op)) skip(2);
    else if ([44, 46, 50].includes(op)) { expression(depth + 1); expression(depth + 1); }
    else throw new Error(`Unknown LNK expression ${op}`);
  };
  try {
    if (bytes.toString("hex", 0, 4) !== "4c4e4b02") throw new Error("Unsupported LNK magic/version");
    while (pos < bytes.length) {
      const op = byte();
      if (op === 0) { complete = true; break; }
      switch (op) {
        case 2: skip(u16()); break;
        case 6: case 50: case 60: skip(2); break;
        case 8: skip(4); break;
        case 10: skip(3); expression(); break;
        case 12: case 48: skip(8); text(); break;
        case 14: skip(2); text(); break;
        case 16: { const id = u16(); skip(3); sections.push({ id, name: text() }); break; }
        case 18: skip(6); text(); break;
        case 28: skip(2); files.push(text()); break;
        case 46: skip(1); break;
        case 52: skip(3); break;
        case 54: skip(4); break;
        case 56: skip(6); break;
        case 58: skip(8); break;
        case 74: skip(28); text(); break;
        case 76: case 78: case 80: skip(10); break;
        case 82: skip(14); text(); break;
        case 84: skip(14); skip(u16() * 2); text(); text(); break;
        case 86: skip(36); text(); break;
        default: throw new Error(`Unknown LNK record ${op} at ${pos - 1}`);
      }
    }
  } catch (cause) { error = String(cause); }
  const firstSectionId = sections[0]?.id ?? null;
  const constructors = sections.some(s => [".ctors", ".dtors"].includes(s.name));
  const classification = !complete ? "undetermined" : firstSectionId !== null && sections.every(s => s.id >= 0xf000 && s.id <= 0xf00f) && !files.length && !constructors ? "gnu-converter-style" :
    firstSectionId === 1 && (files.length > 0 || constructors) ? "aspsx-native-style" : "ambiguous";
  return { classification, complete, firstSectionId, sections, constructors, fileRecords: files.length, files, ...(error ? { error } : {}) };
}
export function assemblerFamilyEvidence(root = projectRoot()) {
  const sdk = configuredSdk(root), members = loadLibraryProject(root) ? libraryMembers(root).map(m => ({ id: m.id, input: m.input, object: m.object })) :
    (existsSync(sdk.convertedDir) ? filesUnder(sdk.convertedDir).filter(p => p.endsWith(".o")).map(input => ({ input, object: readRelocatableObject(readFileSync(input)) })) : []);
  const indexedLoads = members.map(({ object, ...member }) => ({ ...member, ...indexedLoadCensus(object) }));
  const totals = { "gas-rule": 0, "aspsx-rule": 0, ambiguous: 0, other: 0 };
  for (const member of indexedLoads) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += member.counts[key];
  const packaging: Array<any> = [], unreadable: Array<{ input: string; error: string }> = [];
  if (existsSync(sdk.originalDir)) for (const input of filesUnder(sdk.originalDir).filter(p => /\.(lib|obj|lnk)$/i.test(p))) {
    try {
      const bytes = readFileSync(input);
      const native = bytes.toString("ascii", 0, 3) === "LIB" ? readPsyqLib(bytes) : [{ name: input.split("/").pop()!, ordinal: 0, bytes }];
      for (const member of native) packaging.push({ archive: input, member: member.name, ordinal: member.ordinal, ...lnkPackaging(member.bytes) });
    } catch (error) { unreadable.push({ input, error: String(error) }); }
  }
  return { basis: "Original relocated indexed integer-load register relations plus native LNK packaging; nominations only, never an automatic backend switch or version identification.",
    membersScanned: members.length, indexedLoadTotals: totals, indexedLoads, packaging, unreadable };
}
