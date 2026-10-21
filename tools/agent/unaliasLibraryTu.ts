/** Retire asm-label aliases from library C TUs.
 *
 * Split spells a C TU's local labels by their listing names (`B_000015B8:`), so
 * C declares extracted storage and helpers directly — `extern DsCq B_000015B8;`,
 * never `extern DsCq q __asm__("$LB_000015B8");`. This migration re-spells every
 * `$L` reference against the plain label, then drops each alias whose label can
 * take one plain declaration, renaming its C name throughout the TU. A function
 * bound to a local label is file-local, so its declarations become `static`.
 * An alias that cannot go — an offset into its label, or a C name whose type the
 * label's other declarations do not share — stays, spelled against the plain
 * label, and is reported. Each member is re-split and must rebuild its original
 * object with the result, or its sources are restored. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { libraryMembers, withLibraryMetadata, type LibraryMember } from "../lib/libraryTargets.js";
import { libraryAssemblyParts } from "../lib/libraryAssembly.js";
import { isDirectoryTu, libraryAssemblyTu, librarySourceFiles } from "../lib/libraryTranslationUnit.js";
import { walkActiveC } from "./cSourceAnalysis.js";
import { declaratorName, field, namedChildren, parseC, type Node } from "./residual-source-search/tree-sitter-c.js";
import { checkLibrary, disassembleLibraryMember, libraryMemberResults } from "./libraryTarget.js";

export interface UnaliasLabel {
  label: string;
  /** C names declared against the label itself. */
  names: string[];
  /** Aliases into the label at an offset (`B_00001B98+4`); never retired here. */
  offsets: string[];
  /** The names this run declared plainly; absent on a dry run. */
  retired?: string[];
}
export interface UnaliasRow { id: string; files: string[]; labels: UnaliasLabel[]; written?: boolean; error?: string }
export interface UnaliasReport { written: boolean; members: UnaliasRow[] }

/** A C name bound to a local label: through an asm label (`asm` is its range),
 * or by spelling the label's retired `$L` form as the identifier itself
 * (`declarator` is where that declaration's asm label would go). */
interface Alias { part: number; label: string; offset: string; name: string; asm?: { start: number; end: number }; declarator?: number }
const LABEL = /^\s*([A-Za-z_]\w*)\s*(?:([+-])\s*(\d+))?\s*$/;
const LABEL_STRING = /(\b(?:__asm__|__asm|asm)\s*\(\s*"\s*)\$L([A-Za-z_]\w*)/g;
const DOLLAR_NAME = /^\$L([A-Za-z_]\w*)$/;

/** Asm labels naming the `$L` form of a local label, re-spelled plainly; in
 * disabled arms too, since the extraction no longer defines that form. A C
 * identifier spelled `$L…` is a different C name, so it keeps its spelling. */
export function respellLocalLabels(text: string, locals: ReadonlySet<string>): string {
  return text.replace(LABEL_STRING, (all, head: string, name: string) => locals.has(name) ? head + name : all);
}

function aliasesOf(texts: readonly string[], locals: ReadonlySet<string>): Alias[] {
  const aliases: Alias[] = [];
  texts.forEach((text, part) => {
    const tree = parseC(text);
    try {
      walkActiveC(tree.rootNode, node => {
        if (node.type === "gnu_asm_expression") {
          const owner = node.parent;
          const name = owner?.type === "function_declarator" ? declaratorName(owner)
            : owner?.type === "declaration" ? declaratorName(node.previousNamedSibling ?? undefined) : undefined;
          const operands = namedChildren(node);
          const label = operands.length === 1 && operands[0]!.type === "string_literal" ? LABEL.exec(operands[0]!.text.slice(1, -1)) : null;
          if (name && label && locals.has(label[1]!))
            aliases.push({ part, label: label[1]!, offset: label[2] ? `${label[2]}${label[3]}` : "", name: name.text, asm: { start: node.startIndex, end: node.endIndex } });
        }
        if (node.type === "declaration" && !namedChildren(node).some(c => c.type === "gnu_asm_expression")) {
          for (const declarator of node.childrenForFieldName("declarator")) {
            const bare = declarator?.type === "init_declarator" ? field(declarator, "declarator") : declarator ?? undefined;
            const name = declaratorName(bare), local = name && DOLLAR_NAME.exec(name.text);
            const labelled = bare && [bare, ...bare.descendantsOfType("function_declarator")].some(d => namedChildren(d).some(c => c.type === "gnu_asm_expression"));
            if (local && locals.has(local[1]!) && !labelled) aliases.push({ part, label: local[1]!, offset: "", name: name.text, declarator: bare!.endIndex });
          }
        }
        return true;
      });
    } finally { tree.delete(); }
  });
  return aliases;
}

/** One retirement: a C name declared against a label, written `label\0name`. */
export const aliasKey = (label: string, name: string) => `${label}\u0000${name}`;

/** The labels a TU aliases, after re-spelling, and the retirements it allows:
 * a name bound to one label alone, which no offset alias already declares as
 * its own name. The label's own name goes first; it only drops a redundant label. */
export function aliasLabels(sources: readonly string[], locals: ReadonlySet<string>): { labels: UnaliasLabel[]; retirable: string[] } {
  const aliases = aliasesOf(sources.map(text => respellLocalLabels(text, locals)), locals);
  const boundTo = new Map<string, Set<string>>();
  for (const alias of aliases) boundTo.set(alias.name, (boundTo.get(alias.name) ?? new Set()).add(`${alias.label}${alias.offset}`));
  const labels = new Map<string, UnaliasLabel>(), retirable: string[] = [];
  for (const alias of aliases) {
    const row = labels.get(alias.label) ?? { label: alias.label, names: [], offsets: [] };
    labels.set(alias.label, row);
    if (alias.offset) { if (!row.offsets.includes(`${alias.label}${alias.offset}`)) row.offsets.push(`${alias.label}${alias.offset}`); continue; }
    if (row.names.includes(alias.name)) continue;
    row.names.push(alias.name);
    if (boundTo.get(alias.name)!.size === 1 && !aliases.some(a => a.offset && a.name === alias.label)) retirable.push(aliasKey(alias.label, alias.name));
  }
  const own = (key: string) => { const [label, name] = key.split("\u0000"); return label === name ? 0 : 1; };
  return { labels: [...labels.values()], retirable: retirable.sort((a, b) => own(a) - own(b)) };
}

/** Top-level (an active preprocessor arm counts as top level). */
function fileScope(node: Node): boolean {
  let parent = node.parent;
  while (parent && parent.type.startsWith("preproc_")) parent = parent.parent;
  return parent?.type === "translation_unit";
}
/** The function a declarator declares; a function pointer is an object. */
function functionName(declarator: Node | undefined): Node | undefined {
  let current = declarator;
  while (current?.type === "pointer_declarator") current = field(current, "declarator");
  if (current?.type !== "function_declarator") return undefined;
  const inner = field(current, "declarator");
  return inner?.type === "identifier" ? inner : undefined;
}

/** Re-spell `$L` asm labels, then retire the aliases `retire` names (see
 * `aliasKey`): drop the asm label and rename the C name to the label through
 * the TU. A `$L`-spelled name that stays is given an asm label against the
 * plain label, so it still links. Each local-label function becomes `static`. */
export function retireAliases(sources: readonly string[], locals: ReadonlySet<string>, retire: ReadonlySet<string>): string[] {
  const texts = sources.map(text => respellLocalLabels(text, locals));
  const aliases = aliasesOf(texts, locals);
  const touched = new Set(aliases.filter(a => !a.offset).map(a => a.label));
  const renames = new Map<string, string>();
  const retired = (alias: Alias) => !alias.offset && retire.has(aliasKey(alias.label, alias.name));
  for (const alias of aliases) if (retired(alias) && alias.name !== alias.label) renames.set(alias.name, alias.label);
  return texts.map((text, part) => {
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const alias of aliases) {
      if (alias.part !== part) continue;
      if (retired(alias) && alias.asm) {
        let start = alias.asm.start;
        while (start > 0 && /[ \t]/.test(text[start - 1]!)) start--;
        edits.push({ start, end: alias.asm.end, text: "" });
      }
      if (!retired(alias) && alias.declarator !== undefined) edits.push({ start: alias.declarator, end: alias.declarator, text: ` __asm__("${alias.label}")` });
    }
    const tree = parseC(text);
    try {
      walkActiveC(tree.rootNode, node => {
        if (node.type === "identifier" && renames.has(node.text)) edits.push({ start: node.startIndex, end: node.endIndex, text: renames.get(node.text)! });
        if ((node.type === "declaration" || node.type === "function_definition") && fileScope(node)) {
          const declarators = node.childrenForFieldName("declarator").filter((d): d is Node => d !== null);
          const name = declarators.length === 1 ? functionName(declarators[0]) : undefined;
          const local = name && (renames.get(name.text) ?? name.text);
          if (local && touched.has(local) && locals.has(local)) {
            const storage = namedChildren(node).filter(c => c.type === "storage_class_specifier");
            const extern = storage.find(c => c.text === "extern");
            if (extern) edits.push({ start: extern.startIndex, end: extern.endIndex, text: "static" });
            else if (!storage.some(c => c.text === "static")) edits.push({ start: node.startIndex, end: node.startIndex, text: "static " });
          }
        }
        return true;
      });
    } finally { tree.delete(); }
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = text, floor = Infinity;
    for (const edit of edits) {
      if (edit.end > floor) throw new Error(`overlapping alias edits at ${edit.start}`);
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
      floor = edit.start;
    }
    return out;
  });
}

/** Local labels a C TU may name: every non-exported label the split defines. */
function localLabels(member: LibraryMember, root: string): Set<string> {
  const parts = libraryAssemblyParts(member, readFileSync(disassembleLibraryMember(member, root), "utf8"));
  const exported = new Set(member.object.symbols.filter(s => s.binding !== 0).map(s => s.name));
  return new Set(parts.flatMap(p => [...p.text.matchAll(/^\s*([A-Za-z_]\w*):/gm)].map(m => m[1]!))
    .filter(name => !exported.has(name) && !name.startsWith("__lnk_hidden_")));
}
/** Every C file of the TU's directory: its parts, and any private header they
 * include, which may declare (or define) the same labels. */
function cSources(member: LibraryMember, root: string): string[] {
  const directory = join(root, dirname(member.source)), parts = librarySourceFiles(member, root).map(file => join(root, file));
  return [...new Set([...parts, ...readdirSync(directory).map(name => join(directory, name))])].filter(file => /\.(?:c|h)$/.test(file)).sort();
}
function aliased(member: LibraryMember, root: string): boolean {
  return isDirectoryTu(member) && !libraryAssemblyTu(member, root) &&
    cSources(member, root).some(file => /\$L[A-Za-z_]|__asm__\s*\(\s*"/.test(readFileSync(file, "utf8")));
}

/** Check (default) or write the migration. A write re-splits and compiles the
 * member for every attempt, and keeps only a whole-object match; when retiring
 * every alias fails, aliases are retired one at a time on top of the
 * re-spelled baseline. The written members are then verified together, after
 * every member is settled: a member that failed (and is restored) cannot
 * unsettle the others. */
export function unaliasLibraryTus(write = false, ids: string[] = [], root = projectRoot(),
  verify: (members: LibraryMember[]) => void = members => checkLibrary(members.flatMap(m => ["--member", m.id]), root)): UnaliasReport {
  const all = libraryMembers(root);
  return withLibraryMetadata(() => {
    const selected = ids.length ? ids.map(id => all.find(m => m.id === id) ?? fail(`Unknown library member ${id}`)) : all.filter(m => aliased(m, root));
    const report: UnaliasReport = { written: write, members: [] };
    for (const member of selected) {
      if (!isDirectoryTu(member) || libraryAssemblyTu(member, root)) { report.members.push({ id: member.id, files: [], labels: [], error: "not a C TU" }); continue; }
      const files = cSources(member, root), before = files.map(file => readFileSync(file, "utf8"));
      const locals = localLabels(member, root), { labels, retirable } = aliasLabels(before, locals);
      const row: UnaliasRow = { id: member.id, files: files.map(file => relative(root, file)), labels };
      report.members.push(row);
      if (!write) continue;
      let failure = "";
      const matches = (retire: ReadonlySet<string>) => {
        retireAliases(before, locals, retire).forEach((text, i) => writeFileSync(files[i]!, text));
        try { failure = `verdict ${libraryMemberResults([member], root).get(member.id)}`; } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        return failure === "verdict match";
      };
      try {
        let retired = new Set(retirable);
        if (!matches(retired)) {
          retired = new Set();
          if (!matches(retired)) throw new Error(`the re-spelled sources do not rebuild the original object (${failure})`);
          for (const key of retirable) if (matches(new Set([...retired, key]))) retired.add(key);
          if (!matches(retired)) throw new Error(`the kept retirements no longer rebuild the original object together (${failure})`);
        }
        for (const label of row.labels) label.retired = label.names.filter(name => retired.has(aliasKey(label.label, name)));
        row.written = true;
      } catch (error) {
        before.forEach((text, i) => writeFileSync(files[i]!, text));
        row.error = `${error instanceof Error ? error.message : error}; sources restored, which split's plain listing names no longer link until this member's aliases are written by hand`;
      }
    }
    const written = selected.filter(m => report.members.find(r => r.id === m.id)?.written);
    if (written.length) verify(written);
    return report;
  }, all, root);
}
function fail(message: string): never { throw new Error(message); }
