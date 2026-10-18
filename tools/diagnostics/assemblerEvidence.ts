/** Original-word assembler-family observations, never configuration changes.
 * Register relations nominate a family, not a compiler or assembler version. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filesUnder } from "../lib/contentCache.js";
import { readPsyqLib } from "../lib/psyqMembers.js";
import { readLnk } from "../lib/objectFormats/lnk.js";
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
  let complete = false, error: string | undefined;
  try {
    const object = readLnk(bytes);
    for (const record of object.records ?? []) if (record.opcode === 16) {
      const id = record.bytes.readUInt16LE(1), length = record.bytes[6]!;
      sections.push({ id, name: record.bytes.toString("latin1", 7, 7 + length) });
    }
    files.push(...object.files); complete = true;
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
