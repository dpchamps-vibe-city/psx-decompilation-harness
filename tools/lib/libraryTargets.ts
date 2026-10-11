import { projectRoot } from "./runtimeContext.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
    const bytes = readFileSync(join(root, input.path)), inputHash = hash(bytes), prefix = hash(input.path).slice(0, 16);
    const members = input.archive ? readAr(bytes) : [{ name: basename(input.path), ordinal: 0, offset: 0, bytes }];
    if (!members.length) throw new Error(`No object members in ${input.path}`);
    for (const member of members) {
      const id = `lib_${prefix}_${member.ordinal}`, sha256 = hash(member.bytes);
      const duplicate = (input.archive ? standaloneMembers : archiveMembers).get(sha256);
      if (duplicate) throw new Error(`Library selection contains an archive and its extracted member copy: ${duplicate}, ${input.path}; select originals or explicit converted members, not both`);
      (input.archive ? archiveMembers : standaloneMembers).set(sha256, input.path);
      const object = readRelocatableObject(member.bytes), functions = objectFunctions(object);
      const source = libraryMemberSource(project, input, member, id), sourceKey = source.toLowerCase();
      const owner = sourceOwners.get(sourceKey);
      if (owner) throw new Error(`Library source path collision: ${source} (${owner}, ${input.path}[${member.ordinal}]); use distinct input paths or output.sourceLayout: member-id`);
      sourceOwners.set(sourceKey, `${input.path}[${member.ordinal}]`);
      result.push({ id, input: input.path, member: member.name, ordinal: member.ordinal, sourceOffset: member.offset,
        inputHash, sha256, source,
        original: `build/libraries/originals/${id}/${sha256}.o`, assembly: `build/libraries/disassembly/${id}/member.s`,
        bytes: member.bytes, object, functions });
    }
  }
  const ids = new Set(result.map(m => m.id));
  for (const id of Object.keys(project.memberProfiles)) if (!ids.has(id)) throw new Error(`project.json: memberProfiles selects unknown member ${id}`);
  return result;
}
export function libraryTargetKey(member: LibraryMember, symbol: string): string { return `${member.id}::${symbol}`; }
type LibraryFunction = { member: LibraryMember; fn: LibraryMember["functions"][number]; key: string };
interface LibraryIndex {
  members: LibraryMember[];
  functions: Map<string, LibraryFunction[]>;
  exports: Map<string, LibraryFunction[]>;
  sources: Map<string, LibraryMember>;
  locals: Map<string, Map<string, LibraryFunction[]>>;
  offsets: Map<string, Map<string, LibraryFunction[]>>;
}
const indexes = new WeakMap<LibraryMember[], LibraryIndex>();
const metadata = new AsyncLocalStorage<Map<string, LibraryIndex>>();
function indexMembers(members: LibraryMember[]): LibraryIndex {
  const prior = indexes.get(members);
  if (prior) return prior;
  const index: LibraryIndex = { members, functions: new Map(), exports: new Map(), sources: new Map(), locals: new Map(), offsets: new Map() };
  const add = (map: Map<string, LibraryFunction[]>, key: string, value: LibraryFunction) => {
    const values = map.get(key); if (values) values.push(value); else map.set(key, [value]);
  };
  for (const member of members) {
    index.sources.set(member.source, member);
    const locals = new Map<string, LibraryFunction[]>(), offsets = new Map<string, LibraryFunction[]>();
    index.locals.set(member.id, locals); index.offsets.set(member.id, offsets);
    const exported = new Set(member.object.symbols.filter(s => s.binding !== 0).map(s => `${s.section}:${s.name}`));
    for (const fn of member.functions) {
      const value = { member, fn, key: libraryTargetKey(member, fn.name) };
      add(index.functions, value.key, value); add(index.functions, fn.name, value);
      add(locals, fn.name, value); add(offsets, `${fn.section}@${fn.offset}`, value);
      if (exported.has(`${fn.section}:${fn.name}`)) add(index.exports, fn.name, value);
    }
  }
  indexes.set(members, index); return index;
}
/** Invocation-local lookup metadata. Inventory and byte/hash validation remain
 * fresh reads; this scope never turns a cached lookup into verification. */
export function withLibraryMetadata<T>(task: () => T, members?: LibraryMember[], root = projectRoot()): T {
  if (!members && metadata.getStore()) return task();
  return metadata.run(new Map(members ? [[resolve(root), indexMembers(members)]] : []), task);
}
function libraryIndex(root: string): LibraryIndex {
  const store = metadata.getStore(), key = resolve(root), prior = store?.get(key);
  if (prior) return prior;
  const index = indexMembers(libraryMembers(root)); store?.set(key, index); return index;
}
export function libraryMemberForSource(source: string, root = projectRoot()): LibraryMember | undefined {
  return libraryIndex(root).sources.get(source);
}
export function requireLibraryFunction(name: string, root = projectRoot()): LibraryFunction {
  const matches = libraryIndex(root).functions.get(name) ?? [];
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous library symbol ${name}; use ${matches.map(m => m.key).join(", ")}` : `Unknown library function: ${name}; run npm run library -- inventory`);
  return matches[0]!;
}
/** Exact call relocation resolution. Ambiguous exports still stay unresolved. */
export function resolveLibraryCall(member: LibraryMember, reference: string, addend: number, members?: LibraryMember[]): string | undefined {
  const index = members ? indexMembers(members) : libraryIndex(projectRoot());
  const named = /^(named|import):(.+)$/.exec(reference);
  let matches: LibraryFunction[];
  if (named) {
    if (addend !== 0) return undefined;
    matches = (named[1] === "named" ? (index.locals.get(member.id) ?? indexMembers([member]).locals.get(member.id))?.get(named[2]!) : index.exports.get(named[2]!)) ?? [];
  } else {
    const local = /^(.*)@(\d+)$/.exec(reference);
    if (!local) return undefined;
    matches = index.offsets.get(member.id)?.get(`${local[1]}@${Number(local[2]) + addend}`) ?? [];
  }
  return matches.length === 1 ? matches[0]!.key : undefined;
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
