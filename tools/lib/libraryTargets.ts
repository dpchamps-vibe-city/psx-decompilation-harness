import { projectRoot, assertProjectInput, contextForProject } from "./runtimeContext.js";
import { fileDigest } from "./contentCache.js";
import { count } from "./perfCounters.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { globSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { hash, readAr, readPsyqLib } from "./psyqMembers.js";
import { transitionalOriginals, originalMemberId, validateElfView, type OriginalMember } from "./libraryOriginals.js";
import { readLnk } from "./objectFormats/lnk.js";
import { compareObjectBytes } from "./objectFormats/byteCompare.js";
import { nativeObjectView } from "./objectFormats/view.js";
import { libraryInputFiles, loadLibraryProject, type LibraryProject } from "./project.js";
import { compareRelocatableObjects, objectFunctions, readRelocatableObject, type RelocatableObject } from "./relocatableObject.js";
import { libraryMemberSource } from "./librarySourceLayout.js";
import { libraryFunctionSource, libraryGeneratedFunction, libraryGeneratedSymbols, librarySourceFiles } from "./libraryTranslationUnit.js";
import { existsSync } from "node:fs";
export interface LibraryMember {
  id: string; input: string; member: string; ordinal: number; sourceOffset: number;
  inputHash: string; sha256: string; source: string; original: string; assembly: string;
  /** bytes/object are the ELF disassembly view for legacy consumers. Native
   * originalObject is the sole acceptance input when original-object is set. */
  originalObject?: OriginalMember;
  viewObject?: RelocatableObject;
  bytes: Buffer; object: RelocatableObject; functions: ReturnType<typeof objectFunctions>;
}
/* The inventory is a pure function of the configuration and the bytes of the
 * inputs it names. A process keeps the last one per accepted configuration and
 * root, and reuses it only while every input's content digest recomputes equal.
 * Members are shared read-only data, as within a metadata scope; the array is
 * the caller's own. A configuration built by the caller is parsed as given. */
const inventories = new WeakMap<LibraryProject, Map<string, { fingerprint: string; members: LibraryMember[] }>>();
/* The same input checks a parse makes, then each input's real location and
 * content: a symlink swapped in with identical bytes is still a different input. */
function inventoryFingerprint(project: LibraryProject, root: string): string {
  const originals = project.verification.originals, context = contextForProject(root);
  const patterns = originals ? [...originals.archives, ...originals.objects] : [];
  const views = Object.values(project.views?.elf ?? {}), originalFiles = patterns.flatMap(p => globSync(p, { cwd: root }).sort());
  for (const path of [...views, ...originalFiles]) assertProjectInput(path, context);
  const files = [...libraryInputFiles(project, root).map(i => i.path), ...originalFiles, ...views];
  return files.map(path => { const absolute = resolve(root, path); return `${path}\0${existsSync(absolute) ? realpathSync(absolute) : ""}\0${fileDigest(absolute)}`; }).join("\n");
}
export function libraryMembers(root = projectRoot(), project = loadLibraryProject(root)): LibraryMember[] {
  if (!project) throw new Error("No relocatable-library target configured in project.json");
  if (project !== loadLibraryProject(root)) return parseLibraryMembers(root, project);
  let byRoot = inventories.get(project);
  if (!byRoot) inventories.set(project, byRoot = new Map());
  const key = resolve(root), fingerprint = inventoryFingerprint(project, root), prior = byRoot.get(key);
  if (prior?.fingerprint === fingerprint) { count("inventory.reuse"); return [...prior.members]; }
  const members = parseLibraryMembers(root, project);
  byRoot.set(key, { fingerprint, members });
  return [...members];
}
function parseLibraryMembers(root: string, project: LibraryProject): LibraryMember[] {
  count("inventory.parse");
  const result: LibraryMember[] = [], originals = transitionalOriginals(project, root), idsSeen = new Set<string>();
  const archiveMembers = new Map<string, string>();
  const standaloneMembers = new Map<string, string>();
  const sourceOwners = new Map<string, string>();
  for (const input of libraryInputFiles(project, root)) {
    const bytes = readFileSync(join(root, input.path)), inputHash = hash(bytes), prefix = hash(input.path).slice(0, 16);
    const members = input.archive ? (project.target.format === "psyq-lib" ? readPsyqLib(bytes) : readAr(bytes)) : [{ name: basename(input.path), ordinal: 0, offset: 0, bytes }];
    if (!members.length) throw new Error(`No object members in ${input.path}`);
    for (const member of members) {
      const id = project.target.format === "psyq-lib" ? originalMemberId(input.path, input.archive ? member.ordinal : undefined) : `lib_${prefix}_${member.ordinal}`, sha256 = hash(member.bytes);
      if (idsSeen.has(id)) throw new Error(`Library member ID collision: ${id}`); idsSeen.add(id);
      const duplicate = (input.archive ? standaloneMembers : archiveMembers).get(sha256);
      if (duplicate) throw new Error(`Library selection contains an archive and its extracted member copy: ${duplicate}, ${input.path}; select originals or explicit converted members, not both`);
      (input.archive ? archiveMembers : standaloneMembers).set(sha256, input.path);
      const originalObject = project.target.format === "psyq-lib" ? { input: input.path, ordinal: member.ordinal, member: member.name, bytes: member.bytes, sha256, inputHash, object: readLnk(member.bytes) } : originals.get(id);
      if (project.verification.mode === "original-object" && !originalObject) throw new Error(`Missing original for ${id}`);
      const viewPath = project.target.format === "psyq-lib" ? project.views!.elf[id] : undefined;
      if (project.target.format === "psyq-lib" && !viewPath) throw new Error(`Missing ELF view for ${id}`);
      if (viewPath) assertProjectInput(viewPath, contextForProject(root));
      const viewBytes = viewPath ? readFileSync(join(root, viewPath)) : member.bytes, viewObject = readRelocatableObject(viewBytes);
      if (viewObject.native) throw new Error(`ELF view is not ELF for ${id}`);
      if (originalObject) validateElfView(originalObject.object, viewObject);
      const object = originalObject ? nativeObjectView(originalObject.object) : viewObject, functions = objectFunctions(viewObject);
      // Function partitions/private entry names belong to the validated view.
      // Enrich ONLY the diagnostic adapter, never native symbols or acceptance.
      if (originalObject) for (const fn of functions) {
        const symbol = object.symbols.find(s => s.name === fn.name && s.section === fn.section && s.value === fn.offset);
        if (symbol) { symbol.type = 2; symbol.size = fn.size; }
        else object.symbols.push({ name: fn.name, section: fn.section, value: fn.offset, size: fn.size, type: 2, binding: 0, visibility: 0 });
      }
      const source = libraryMemberSource(project, viewPath ? { path: viewPath, archive: false } : input, member, id), sourceKey = source.toLowerCase();
      const owner = sourceOwners.get(sourceKey);
      if (owner) throw new Error(`Library source path collision: ${source} (${owner}, ${input.path}[${member.ordinal}]); use distinct input paths or output.sourceLayout: member-id`);
      sourceOwners.set(sourceKey, `${input.path}[${member.ordinal}]`);
      result.push({ id, input: input.path, member: member.name, ordinal: member.ordinal, sourceOffset: member.offset,
        inputHash, sha256, source,
        original: `build/libraries/originals/${id}/${sha256}.o`, assembly: `build/libraries/disassembly/${id}/member.s`,
        bytes: viewBytes, object, functions, ...(originalObject ? { originalObject, viewObject } : {}) });
    }
  }
  const ids = new Set(result.map(m => m.id));
  for (const id of Object.keys(project.memberProfiles)) if (!ids.has(id)) throw new Error(`project.json: memberProfiles selects unknown member ${id}`);
  for (const id of [...originals.keys(), ...Object.keys(project.views?.elf ?? {})]) if (!ids.has(id)) throw new Error(`project.json: mapping selects unknown member ${id}`);
  return result;
}
/** Raw inventory/original/view witnesses for caches and publication guards.
 * Never stamp a freshly changed file against an older invocation-local model. */
export function libraryObjectInputs(member: LibraryMember, root = projectRoot(), project = loadLibraryProject(root)) {
  if (!project) throw new Error("Not a library target");
  const original = member.originalObject, view = project.target.format === "psyq-lib" ? project.views!.elf[member.id] : undefined;
  const files = [...new Set([member.input, ...(original ? [original.input] : []), ...(view ? [view] : [])])];
  for (const path of files) assertProjectInput(path, contextForProject(root));
  if (fileDigest(resolve(root, member.input)) !== member.inputHash) throw new Error(`Target input changed: ${member.id}; rerun inventory`);
  if (original && fileDigest(resolve(root, original.input)) !== original.inputHash) throw new Error(`Original input changed: ${member.id}; rerun inventory`);
  const viewHash = hash(member.bytes);
  if (view && fileDigest(resolve(root, view)) !== viewHash) throw new Error(`ELF view changed: ${member.id}; rerun inventory`);
  return { files,
    memberHash: original?.sha256 ?? member.sha256, viewHash, mode: project.verification.mode,
    ...(original ? { original: { input: original.input, ordinal: original.ordinal, sha256: original.sha256, inputHash: original.inputHash } } : {}) };
}
export function libraryTargetKey(member: LibraryMember, symbol: string): string { return `${member.id}::${symbol}`; }
/** Single acceptance model shared by CLI, finalizers and diagnostics. */
export function compareLibraryObjects(member: LibraryMember, candidate: Buffer) {
  return member.originalObject ? compareObjectBytes(member.originalObject.bytes, candidate) : compareRelocatableObjects(member.bytes, candidate);
}
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
  count("inventory.index");
  const index: LibraryIndex = { members, functions: new Map(), exports: new Map(), sources: new Map(), locals: new Map(), offsets: new Map() };
  const add = (map: Map<string, LibraryFunction[]>, key: string, value: LibraryFunction) => {
    const values = map.get(key); if (values) values.push(value); else map.set(key, [value]);
  };
  for (const member of members) {
    index.sources.set(member.source, member);
    for (const fn of member.functions) index.sources.set(libraryFunctionSource(member, fn.name), member);
    const locals = new Map<string, LibraryFunction[]>(), offsets = new Map<string, LibraryFunction[]>();
    index.locals.set(member.id, locals); index.offsets.set(member.id, offsets);
    const exported = new Set(member.object.symbols.filter(s => s.binding !== 0).map(s => `${s.section}:${s.name}`));
    // Finishing targets resolve by their qualified key only; they have no code extent.
    for (const symbol of libraryGeneratedSymbols(member)) {
      const value = { member, fn: libraryGeneratedFunction(symbol), key: libraryTargetKey(member, symbol) };
      add(index.functions, value.key, value);
    }
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
/** The inventory of the current metadata scope; a fresh one outside any scope. */
export function scopedLibraryMembers(root = projectRoot()): LibraryMember[] {
  return libraryIndex(root).members;
}
export function libraryMemberForSource(source: string, root = projectRoot()): LibraryMember | undefined {
  const index = libraryIndex(root), direct = index.sources.get(source);
  if (direct) return direct;
  return index.members.find(member => dirname(member.source) === dirname(source) && existsSync(resolve(root, member.source)) && librarySourceFiles(member, root).includes(source));
}
export function libraryMemberById(id: string, root = projectRoot()): LibraryMember {
  const member = libraryIndex(root).members.find(m => m.id === id);
  if (!member) throw new Error(`Unknown library member ${id}`);
  return member;
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
  return { schemaVersion: 1, targetKind: "relocatable-library", members: libraryMembers(root).map(({ bytes, object, originalObject, viewObject, ...member }) => ({ ...member,
    functions: member.functions.map(fn => ({ ...fn, target: libraryTargetKey(member as LibraryMember, fn.name) })),
    sections: [...object.sections].filter(([, s]) => s.flags & 2).map(([name, s]) => ({ name, size: s.size, alignment: s.alignment, flags: s.flags })),
    imports: object.symbols.filter(s => s.section === "UND" && s.binding !== 0).map(s => s.name),
    common: object.symbols.filter(s => s.section === "COMMON") })) };
}
