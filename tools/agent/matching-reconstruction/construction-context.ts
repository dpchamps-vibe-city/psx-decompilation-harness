import type { Container } from "../../lib/container.js";
import { loadSymbolIndex, type SymbolIndex } from "../../lib/symbolIndex.js";

/** Construction needs storage labels, not necessarily a linked image.
 * The initial ET_REL domain has no absolute storage labels: symbolic address
 * relocations are refused before execution rather than assigned fake RAM. */
export type ConstructionContext = Container | {
  kind: "library";
  id: string;
  symbolIndex: SymbolIndex;
};

export function constructionSymbolIndex(context: ConstructionContext): SymbolIndex {
  return context.kind === "library" ? context.symbolIndex : loadSymbolIndex(context);
}
