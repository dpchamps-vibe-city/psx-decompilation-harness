import { projectRoot } from "../lib/runtimeContext.js";
/** Library preparation's type inference: the original-code evidence graph and
 * propagation of image preparation, linked by relocations, handed to m2c as
 * partial ABI constraints with the reference and verified-C declarations they
 * name. Nothing here completes a prototype that no declaration states. */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadLibraryProject } from "../lib/project.js";
import { referenceHeaderCopy } from "../lib/referenceHeaders.js";
import { withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { functionSymbol } from "../lib/targetAdapter.js";
import { digest, withContentMemo } from "../lib/contentCache.js";
import { buildEvidenceGraph } from "./type-propagation/graph.js";
import { inferenceInput, propagate } from "./type-propagation/solve.js";
import { seedOracle, type SeedRecord, type VerifiedSeedBundle } from "./type-propagation/seeds.js";
import type { EvidenceGraph, InferenceInput, Propagation } from "./type-propagation/model.js";
import { scopeFromPreprocessed, sdkPrototypes, type Prototype } from "./calleeTruth.js";
import { indexDeclarations, projectDeclarations, type DeclarationIndex } from "./declarationContext.js";
import { declaratorName, namedChildren, parseC } from "./residual-source-search/tree-sitter-c.js";
import { renameTypeTokens } from "./scopedTypes.js";

/** Native object imports need not have symbol-table entries. These names are
 * projection roots only: an absent declaration remains unknown, never invented. */
export function libraryImportedNames(member: Pick<LibraryMember, "object">): string[] {
  return [...new Set(member.object.relocations.flatMap(r => /^import:(.+)$/.exec(r.reference)?.slice(1) ?? []))].sort();
}

export interface LibraryTypeAnalysis {
  graph: EvidenceGraph; propagation: Propagation; seeds: SeedRecord[];
  /** Reference headers by include spelling, in include order: those declaring the
   * target, its contracts and the member's imports, after what each requires. */
  headers: string[];
  /** Partial word-slot constraints keyed by the names m2c's listing uses. */
  constraints: InferenceInput;
  carriers: Array<{ name: string; type: string; scope: string }>;
  /** Verified clean-C contracts defined in other members; this member's own are in its TU. */
  foreign: Array<{ key: string; bundle: VerifiedSeedBundle }>;
  /** The reference declaration of the target itself, when the target is exported. */
  declaration?: Prototype;
  /** Callees the target calls with fewer arguments than they read. */
  unprototyped: string[];
}

export function analyzeLibraryTypes(member: LibraryMember, key: string, verified: (member: string) => boolean, signal?: AbortSignal): LibraryTypeAnalysis {
  return withLibraryMetadata(() => withContentMemo(() => {
    const seeds = seedOracle("", [key], undefined, { verified });
    const graph = buildEvidenceGraph(key, { seed: seeds.get, ...(signal ? { signal } : {}) });
    const propagation = propagate(graph, seeds.get);
    const { input, carriers } = inferenceInput(graph, propagation);
    /* m2c names functions as the member's listing does: its own functions by
       symbol, another member's only through an import of that name. A
       foreign static helper has no name m2c could see. */
    const own = new Set(member.functions.map((fn) => fn.name));
    const imported = new Set(member.object.relocations.flatMap((r) => r.reference.startsWith("import:") ? [r.reference.slice("import:".length)] : []));
    const owners = new Map(graph.nodes.map((n) => [n.name, n.container]));
    const constraints: InferenceInput = { version: 1, functions: {}, ...(input.openTables ? { openTables: input.openTables } : {}) };
    for (const [name, fn] of Object.entries(input.functions)) {
      const symbol = functionSymbol(name), owner = owners.get(name);
      if (owner === member.id ? own.has(symbol) : !own.has(symbol) && imported.has(symbol)) constraints.functions[symbol] = fn;
    }
    const sdk = sdkPrototypes(), symbol = functionSymbol(key), declaration = sdk.get(symbol);
    const exported = member.object.symbols.some((s) => s.binding !== 0 && s.name === symbol);
    /* A declared target passes on none of its own argument registers beyond
       its parameters: a call that leaves one untouched was written with fewer
       arguments than its callee reads, with no prototype in scope (an
       old-style call). The callee's wider slots are true of the callee, but
       would make m2c pass them here: its partial constraint is withheld and
       its declaration in the draft is unprototyped. */
    const node = graph.nodes.find((n) => n.id === graph.root), parameters = declaration && exported ? declaration.slots : undefined;
    const unprototyped = new Set<string>();
    if (node && parameters) for (const call of node.calls) {
      const untouched = call.args.some((value, slot) => {
        const op = value === null ? undefined : node.report.ir.values[value]?.op;
        return slot < 4 && op?.kind === "entry" && op.register === `a${slot}` && !parameters.includes(slot);
      });
      if (untouched) for (const target of call.targets) unprototyped.add(functionSymbol(target.slice(target.indexOf(":") + 1)));
    }
    for (const name of unprototyped) delete constraints.functions[name];
    const foreign = seeds.records.filter((r) => r.status === "verified" && owners.get(r.name) !== member.id && imported.has(functionSymbol(r.name)) && !own.has(functionSymbol(r.name)))
      .flatMap((r) => { const bundle = seeds.bundle(r.name); return bundle ? [{ key: r.name, bundle }] : []; });
    /* A verified contract of this member's own TU is in scope there already. */
    const local = new Set(seeds.records.filter((r) => r.status === "verified" && owners.get(r.name) === member.id).map((r) => r.prototype!.where));
    const used = new Set(Object.values(constraints.functions).flatMap((fn) => [...Object.values(fn.slots), ...(fn.result ? [fn.result] : [])].flatMap((c) => c.type ? [c.type] : [])));
    const declared = new Set<string>();
    /* The member's own names, as its TU sees them, and the types its constraints carry. */
    for (const name of [symbol, ...member.object.symbols.filter((s) => s.binding !== 0).map((s) => s.name)]) {
      const prototype = sdk.get(name);
      if (prototype) declared.add(prototype.where);
    }
    const kept = carriers.filter((c) => used.has(c.name)).map((c) => local.has(c.scope) ? { ...c, scope: member.id } : c);
    for (const carrier of kept) declared.add(carrier.scope);
    return { graph, propagation, seeds: seeds.records, headers: includeOrder([...declared]), constraints, foreign, carriers: kept,
      unprototyped: [...unprototyped].sort(), ...(declaration && exported ? { declaration: structuredClone(declaration) } : {}) };
  }));
}

/** Reference headers as include spellings, each after the headers it requires. */
function includeOrder(paths: string[], root = projectRoot()): string[] {
  const project = loadLibraryProject(root)!, requires = project.headers.requires ?? {};
  const directories = project.headers.reference.flatMap((d) => [resolve(root, d), referenceHeaderCopy(resolve(root, d), root)]);
  const spellings = paths.flatMap((path) => {
    const absolute = resolve(root, path);
    for (const directory of directories) {
      const spelling = relative(directory, absolute);
      if (!spelling.startsWith("..") && !isAbsolute(spelling)) return [spelling.split(sep).join("/")];
    }
    return [];
  });
  const order: string[] = [];
  const visit = (header: string) => {
    if (order.includes(header)) return;
    for (const prior of requires[header] ?? []) visit(prior);
    order.push(header);
  };
  for (const header of [...new Set(spellings)].sort()) visit(header);
  return order.filter((header) => directories.some((d) => existsSync(join(d, header))));
}

/** A declarator of `type` named `name`, in C's inside-out spelling. */
function declare(type: string, name: string): string {
  if (type.includes("(*)")) return type.replace("(*)", `(*${name})`);
  const dimensions = /(\[[^\]]*\])+$/.exec(type);
  if (dimensions) return `${declare(type.slice(0, dimensions.index).trimEnd(), name)}${dimensions[0]}`;
  return type.endsWith("*") ? `${type}${name}` : `${type} ${name}`;
}

/** m2c prints `long` as s32 (int): the same machine word, but a type cc1 rejects
 * as conflicting with the reference declaration in scope. The definition spells
 * the declared return and parameter types, keeping m2c's parameter names. */
export function alignDefinition(source: string, prototype: Prototype): string {
  const { returnType, paramTypes } = prototype;
  if (prototype.parameters === null || !returnType || !paramTypes || returnType.includes("(")) return source;
  const tree = parseC(source);
  try {
    const definition = tree.rootNode.descendantsOfType("function_definition")
      .find((d) => declaratorName(d.childForFieldName("declarator") ?? undefined)?.text === prototype.name);
    const parameters = definition?.descendantsOfType("function_declarator")[0]?.childForFieldName("parameters");
    const body = definition?.childForFieldName("body");
    if (!definition || !parameters || !body) return source;
    const declared = namedChildren(parameters).filter((p) => p.type === "parameter_declaration");
    const variadic = namedChildren(parameters).some((p) => p.type === "variadic_parameter");
    const names = declared.map((p, i) => declaratorName(p.childForFieldName("declarator") ?? undefined)?.text ?? `arg${i}`);
    const count = declared.length === 1 && declared[0]!.text === "void" ? 0 : declared.length;
    if (count !== paramTypes.length || variadic !== prototype.variadic) return source;
    const list = paramTypes.length ? paramTypes.map((type, i) => declare(type, names[i]!)).join(", ") + (variadic ? ", ..." : "") : "void";
    return source.slice(0, definition.startIndex) + declare(returnType, `${prototype.name}(${list})`) + " " + source.slice(body.startIndex);
  } finally { tree.delete(); }
}

/** m2c prototypes every callee it declares. A callee the target calls with fewer
 * arguments than it reads was called with no prototype in scope, so its
 * declaration keeps the return type and drops the parameter list. */
export function unprototypeDeclarations(source: string, names: string[]): string {
  if (!names.length) return source;
  const tree = parseC(source), edits: Array<{ start: number; end: number }> = [];
  try {
    for (const declaration of namedChildren(tree.rootNode).filter((n) => n.type === "declaration")) {
      const declarator = declaration.childForFieldName("declarator");
      const parameters = declarator?.type === "function_declarator" ? declarator.childForFieldName("parameters") : undefined;
      if (parameters && names.includes(declaratorName(declarator ?? undefined)?.text ?? "")) edits.push({ start: parameters.startIndex, end: parameters.endIndex });
    }
  } finally { tree.delete(); }
  return edits.reverse().reduce((text, edit) => text.slice(0, edit.start) + "()" + text.slice(edit.end), source);
}

/** Header declarations are public; a TU's own are visible only in its scope. */
export function indexPreprocessed(index: DeclarationIndex, text: string, scope: string): void {
  const preprocessed = scopeFromPreprocessed(text);
  const tree = parseC(preprocessed.source);
  try {
    for (const node of namedChildren(tree.rootNode)) {
      const origin = preprocessed.lineOf(node.startPosition.row).file, header = origin.endsWith(".h");
      indexDeclarations(index, node.text, origin, header ? "public" : scope, header ? "public-header" : "source-local");
    }
  } finally { tree.delete(); }
}

/** Declarations for the m2c context and the draft. Foreign private types are
 * renamed per defining TU; carriers are m2c-only type holders. */
export function inferenceDeclarations(analysis: LibraryTypeAnalysis, index: DeclarationIndex, origin: string): {
  callees: string[]; wrapperTypes: string[]; carriers: string[]; unknown: string[];
} {
  const renames = new Map<string, Map<string, string>>(), callees: string[] = [], wrapperTypes: string[] = [], carriers: string[] = [], unknown: string[] = [];
  for (const { key, bundle } of analysis.foreign) {
    const where = bundle.prototype.where;
    indexPreprocessed(index, bundle.preprocessed, where);
    const projected = projectDeclarations(index, [functionSymbol(key)], where);
    const privateTypes = projected.selected.filter((d) => d.visibility === "source-local" && d.kind === "type");
    const scopeId = digest(where).slice(0, 12), tag = (name: string) => name.replace(/^(struct|union) /, "");
    const scoped = new Map(privateTypes.map((d) => [tag(d.name), `M2C_${scopeId}_${tag(d.name)}`]));
    renames.set(where, scoped);
    callees.push(renameTypeTokens(projected.text, scoped)); unknown.push(...projected.unknown);
    if (privateTypes.length) wrapperTypes.push(renameTypeTokens(projectDeclarations(index, privateTypes.map((d) => d.name), where, { omitPublicTypes: true }).text, scoped));
  }
  for (const carrier of analysis.carriers) {
    indexDeclarations(index, `void ${carrier.name}(${carrier.type});`, origin, carrier.scope, "source-local");
    const projected = projectDeclarations(index, [carrier.name], carrier.scope);
    carriers.push(renameTypeTokens(projected.text, renames.get(carrier.scope) ?? new Map())); unknown.push(...projected.unknown);
  }
  return { callees, wrapperTypes, carriers, unknown };
}
