/** Typed definition macros contain parameter declarations, not C expressions.
 * Project only this known form into a signature-only C definition for raw-source
 * AST consumers. The production preprocessor/compiler still expands the real
 * header; this projection grants no policy approval or byte-match claim. */
import { parseC, children, namedChildren, field, declaratorName, type Node } from "../agent/residual-source-search/tree-sitter-c.js";

export const BIOS_FUNCTION_MACRO = "PSX_BIOS_FUNCTION";
export interface BiosFunctionSite {
  start: number; end: number; line: number; name: string;
  result: string; parameters: string; vector: string; selector: string;
  valid: boolean;
}
interface Token { start: number; end: number; text: string; type: string; inFunction: boolean }
export function biosFunctionProjection(source: string): { source: string; sites: BiosFunctionSite[] } {
  if (!source.includes(BIOS_FUNCTION_MACRO)) return { source, sites: [] };
  const tree = parseC(source), tokens: Token[] = [];
  const collect = (node: Node, inFunction = false): void => {
    if (node.isMissing || node.type === "comment" || ["preproc_def", "preproc_function_def", "preproc_include", "preproc_call", "preproc_arg"].includes(node.type)) return;
    const parts = children(node);
    if (!parts.length || ["string_literal", "char_literal"].includes(node.type)) {
      tokens.push({ start: node.startIndex, end: node.endIndex, text: node.text, type: node.type, inFunction }); return;
    }
    for (const child of parts) collect(child, inFunction || node.type === "function_definition");
  };
  collect(tree.rootNode); tree.delete();
  const sites: BiosFunctionSite[] = [], edits: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text !== BIOS_FUNCTION_MACRO || token.type !== "identifier" || tokens[i + 1]?.text !== "(") continue;
    let depth = 1, first = i + 2, close = -1;
    const args: Token[][] = [];
    for (let j = first; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.text === "(") depth++;
      if (t.text === ")") {
        depth--;
        if (depth === 0) { args.push(tokens.slice(first, j)); close = j; break; }
      }
      if (t.text === "," && depth === 1) { args.push(tokens.slice(first, j)); first = j + 1; }
    }
    if (close < 0 || tokens[close + 1]?.text !== ";") continue;
    const text = (n: number) => args[n]?.map(t => t.text).join(" ") ?? "";
    const site: BiosFunctionSite = { start: token.start, end: tokens[close + 1]!.end,
      line: source.slice(0, token.start).split("\n").length, name: text(1), result: text(0), parameters: text(2), vector: text(3), selector: text(4), valid: false };
    const definition = `${site.result} ${site.name}${site.parameters} {}`;
    const parsed = parseC(definition), nodes = namedChildren(parsed.rootNode).filter(n => n.type !== "comment");
    const fn = nodes[0], name = fn && declaratorName(field(fn, "declarator"));
    site.valid = !token.inFunction && args.length === 5 && args[1]?.length === 1 && /^[A-Za-z_]\w*$/.test(site.name) &&
      args[2]?.[0]?.text === "(" && args[2]?.at(-1)?.text === ")" && !parsed.rootNode.hasError && nodes.length === 1 && fn?.type === "function_definition" && name?.text === site.name;
    parsed.delete(); sites.push(site);
    const original = source.slice(site.start, site.end), newlines = (original.match(/\n/g) ?? []).length;
    const padding = original.length - newlines - definition.length;
    if (site.valid && padding >= 0) edits.push({ start: site.start, end: site.end, text: definition + " ".repeat(padding) + "\n".repeat(newlines) });
    else site.valid = false;
    i = close + 1;
  }
  let projected = source;
  for (const edit of edits.reverse()) projected = projected.slice(0, edit.start) + edit.text + projected.slice(edit.end);
  return { source: projected, sites };
}
