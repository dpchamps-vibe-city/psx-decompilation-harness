import { projectRoot } from "./runtimeContext.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { hash, readAr } from "./psyqMembers.js";
import { libraryInputFiles, loadLibraryProject, type LibraryProject } from "./project.js";
import { objectFunctions, readRelocatableObject, type RelocatableObject } from "./relocatableObject.js";
import { libraryMemberSource } from "./librarySourceLayout.js";
export interface LibraryMember {
  id: string; input: string; member: string; ordinal: number; sourceOffset: number;
  inputHash: string; sha256: string; source: string; original: string; assembly: string;
  bytes: Buffer; object: RelocatableObject; functions: ReturnType<typeof objectFunctions>;
}
export function libraryMembers(root = projectRoot(), project = loadLibraryProject(root)): LibraryMember[] {
  if (!project) throw new Error("No relocatable-library target configured in project.json");
  const result: LibraryMember[] = [];
  const archiveMembers = new Map<string, string>();
  const standaloneMembers = new Map<string, string>();
  const sourceOwners = new Map<string, string>();
  for (const input of libraryInputFiles(project, root)) {
    const bytes = readFileSync(join(root, input.path));
    const members = input.archive ? readAr(bytes) : [{ name: basename(input.path), ordinal: 0, offset: 0, bytes }];
    if (!members.length) throw new Error(`No object members in ${input.path}`);
    for (const member of members) {
      const id = `lib_${hash(input.path).slice(0, 16)}_${member.ordinal}`, sha256 = hash(member.bytes);
      const duplicate = (input.archive ? standaloneMembers : archiveMembers).get(sha256);
      if (duplicate) throw new Error(`Library selection contains an archive and its extracted member copy: ${duplicate}, ${input.path}; select originals or explicit converted members, not both`);
      (input.archive ? archiveMembers : standaloneMembers).set(sha256, input.path);
      const object = readRelocatableObject(member.bytes), functions = objectFunctions(object);
      const source = libraryMemberSource(project, input, member, id), sourceKey = source.toLowerCase();
      const owner = sourceOwners.get(sourceKey);
      if (owner) throw new Error(`Library source path collision: ${source} (${owner}, ${input.path}[${member.ordinal}]); use distinct input paths or output.sourceLayout: member-id`);
      sourceOwners.set(sourceKey, `${input.path}[${member.ordinal}]`);
      result.push({ id, input: input.path, member: member.name, ordinal: member.ordinal, sourceOffset: member.offset,
        inputHash: hash(bytes), sha256, source,
        original: `build/libraries/originals/${id}/${sha256}.o`, assembly: `build/libraries/disassembly/${id}/member.s`,
        bytes: member.bytes, object, functions });
    }
  }
  for (const id of Object.keys(project.memberProfiles)) if (!result.some(m => m.id === id)) throw new Error(`project.json: memberProfiles selects unknown member ${id}`);
  return result;
}
export function libraryTargetKey(member: LibraryMember, symbol: string): string { return `${member.id}::${symbol}`; }
export function requireLibraryFunction(name: string, root = projectRoot()): { member: LibraryMember; fn: LibraryMember["functions"][number]; key: string } {
  const matches = libraryMembers(root).flatMap(member => member.functions.filter(fn => name === fn.name || name === libraryTargetKey(member, fn.name)).map(fn => ({ member, fn, key: libraryTargetKey(member, fn.name) })));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous library symbol ${name}; use ${matches.map(m => m.key).join(", ")}` : `Unknown library function: ${name}; run npm run library -- inventory`);
  return matches[0]!;
}
/** Exact call relocation resolution. No nearest symbol or invented link address. */
export function resolveLibraryCall(member: LibraryMember, reference: string, addend: number, members = libraryMembers()): string | undefined {
  const named = /^(named|import):(.+)$/.exec(reference);
  let matches: Array<{ member: LibraryMember; fn: LibraryMember["functions"][number] }>;
  if (named) {
    if (addend !== 0) return undefined; // a call into a symbol is not its entry
    const owners = named[1] === "named" ? [member] : members;
    matches = owners.flatMap(m => m.functions.filter(f => f.name === named[2] && (named[1] === "named" || m.object.symbols.some(s => s.name === f.name && s.section === f.section && s.binding !== 0))).map(fn => ({ member: m, fn })));
  } else {
    const local = /^(.*)@(\d+)$/.exec(reference);
    if (!local) return undefined;
    matches = member.functions.filter(f => f.section === local[1] && f.offset === Number(local[2]) + addend).map(fn => ({ member, fn }));
  }
  return matches.length === 1 ? libraryTargetKey(matches[0]!.member, matches[0]!.fn.name) : undefined;
}

export function materializeOriginal(member: LibraryMember, root = projectRoot()): string {
  const path = join(root, member.original); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, member.bytes); return path;
}
export function libraryInventory(root = projectRoot()) {
  return { schemaVersion: 1, targetKind: "relocatable-library", members: libraryMembers(root).map(({ bytes, object, ...member }) => ({ ...member,
    functions: member.functions.map(fn => ({ ...fn, target: libraryTargetKey(member as LibraryMember, fn.name) })),
    sections: [...object.sections].filter(([, s]) => s.flags & 2).map(([name, s]) => ({ name, size: s.size, alignment: s.alignment, flags: s.flags })),
    imports: object.symbols.filter(s => s.section === "UND" && s.binding !== 0).map(s => s.name),
    common: object.symbols.filter(s => s.section === "COMMON") })) };
}
