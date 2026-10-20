import { projectRoot } from "../../lib/runtimeContext.js";
import { resolve } from "node:path";
/** The relocatable library's original index. Members have no addresses: a call
 * or an address names its target through a relocation, which links the
 * library's functions to each other exactly as the linker would. */
import { digest } from "../../lib/contentCache.js";
import { libraryMembers, libraryTargetKey, resolveLibraryCall, type LibraryMember } from "../../lib/libraryTargets.js";
import { relocatableAddend } from "../../lib/relocatableFunctionOracle.js";
import type { IndexedFunction, OriginalIndex } from "./graph.js";

/* ELF relocation types of the member view. */
const WORD = 2, JUMP = 4, LOW = 6, GP_RELATIVE = 7;
let cached: OriginalIndex | undefined;

export function libraryOriginalIndex(limit: number): OriginalIndex {
  const members = libraryMembers(projectRoot());
  const identity = digest(JSON.stringify([limit, members.map((m) => [m.id, m.sha256])]));
  if (cached?.identity === identity) return cached;
  const byMember = new Map(members.map((m) => [m.id, m]));
  const nodes = new Map<string, IndexedFunction>(), ids = new Map<string, string>();
  for (const member of members) for (const fn of member.functions) {
    const key = libraryTargetKey(member, fn.name), id = `${member.id}:${key}`;
    nodes.set(id, { id, name: key, container: member.id, span: { vram: fn.offset, size: fn.size }, address: id, calls: [], references: [] });
    ids.set(key, id);
  }
  /* A global defined by one member is the same storage in every member that imports it. */
  const exported = new Map<string, string[]>();
  for (const member of members) for (const symbol of member.object.symbols) {
    if (symbol.binding === 0 || !symbol.name || symbol.section === "UND") continue;
    const storage = symbol.section === "COMMON" ? `common:${symbol.name}@0` : `${member.id}:${symbol.section}@${symbol.value}`;
    exported.set(symbol.name, [...(exported.get(symbol.name) ?? []), storage]);
  }
  const resolveSymbol = (container: string, reference: string, addend: number, call: boolean) => {
    const member = byMember.get(container);
    const key = member && resolveLibraryCall(member, reference, addend, members);
    if (key) return ids.get(key);
    const name = /^import:(.+)$/.exec(reference)?.[1];
    /* An unresolved call is still a contract by name; an address is not. */
    return call && name && addend === 0 ? `extern:${name}` : undefined;
  };
  const offset = (storage: string, addend: number) => {
    const at = storage.lastIndexOf("@");
    return `${storage.slice(0, at)}@${Number(storage.slice(at + 1)) + addend}`;
  };
  const storage = (container: string, reference: string, addend: number): string => {
    const member = byMember.get(container), named = /^(named|import):(.+)$/.exec(reference);
    if (named?.[1] === "import") {
      const defined = exported.get(named[2]!);
      return defined?.length === 1 ? offset(defined[0]!, addend) : `extern:${named[2]}@${addend}`;
    }
    if (named) {
      const symbol = member?.object.symbols.find((s) => s.name === named[2] && s.section !== "UND");
      return symbol ? `${container}:${symbol.section}@${symbol.value + addend}` : `${container}:${named[2]}@${addend}`;
    }
    const local = /^(.*)@(\d+)$/.exec(reference);
    return local ? `${container}:${local[1]}@${Number(local[2]) + addend}` : `${container}:${reference}@${addend}`;
  };
  const incoming = new Map<string, string[]>();
  let instructions = 0, complete = true;
  for (const member of members) {
    const owners = member.functions.map((fn) => ({ fn, node: nodes.get(ids.get(libraryTargetKey(member, fn.name))!)! }));
    for (const { fn, node } of owners) {
      if (instructions + fn.size / 4 > limit) { complete = false; continue; }
      instructions += fn.size / 4;
      /* References are selection hints only, as in the image index. A high
         half names the same reference as its paired low half. */
      for (const r of member.object.relocations) {
        if (r.section !== fn.section || r.offset < fn.offset || r.offset >= fn.offset + fn.size || r.addend === null) continue;
        if (r.type === JUMP) {
          const target = resolveSymbol(member.id, r.reference, relocatableAddend(member.object, r), true);
          if (target && target !== node.id) node.calls.push(target);
        } else if (r.type === LOW || r.type === GP_RELATIVE || r.type === WORD) {
          const addend = relocatableAddend(member.object, r);
          node.references.push(resolveSymbol(member.id, r.reference, addend, false) ?? storage(member.id, r.reference, addend));
        }
      }
      node.calls = [...new Set(node.calls)].sort();
      node.references = [...new Set(node.references)].sort();
      for (const target of node.calls) incoming.set(target, [...(incoming.get(target) ?? []), node.id]);
    }
  }
  const rootId = (functionName: string) => {
    const id = ids.get(functionName);
    if (!id) throw new Error(`${functionName} is not a library function`);
    return id;
  };
  cached = { identity, nodes, incoming, instructions, complete, inputs: [...new Set(members.map((m: LibraryMember) => resolve(projectRoot(), m.input)))],
    resolve: () => undefined, resolveSymbol, storage, rootId,
    /* Linked members share all global storage. */
    sharesStorage: () => true };
  return cached;
}
