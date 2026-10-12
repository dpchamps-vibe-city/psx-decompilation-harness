/** Target register numbering belongs to the configured compiler source, not
 * the release assumed by the diagnostic implementation. Resolve inside the
 * active runtime context: one installed harness can serve several projects. */
import { readFileSync, statSync } from "node:fs";
import { configuredTool, executablePath } from "../../lib/toolchain.js";
import { join } from "node:path";
import { sourceDir, loadPin, verifyTree, verifyCompilerBinding } from "../compiler-source/index.js";
import { configuredGccVersion } from "../decompToolchain.js";
import { parseC, walk, field } from "../residual-source-search/tree-sitter-c.js";

const observed = new Map<string, number>();

export function firstPseudoRegister(): number {
  const directory = sourceDir();
  const header = join(directory, "gcc/config/mips/mips.h");
  const binary = executablePath(configuredTool("cc1", undefined, { prepare: false }));
  const stamp = (path: string) => {
    const stat = statSync(path);
    return [path, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  };
  /* Check identity on each use, but do not reread/parse a large header for
   * every register reference in every stage of a trace. */
  const key = JSON.stringify([configuredGccVersion(), stamp(header), stamp(join(directory, "../pin.json")),
    binary ? stamp(binary) : null]);
  const cached = observed.get(key);
  if (cached !== undefined) return cached;
  loadPin();
  const text = readFileSync(header, "utf8");
  const verified = verifyTree();
  if (!verified.ok) throw new Error("Register model unavailable: configured compiler source drifted from its pin.");
  verifyCompilerBinding();
  const values: number[] = [];
  walk(parseC(text).rootNode, node => {
    if (node.type === "preproc_def" && field(node, "name")?.text === "FIRST_PSEUDO_REGISTER") {
      const value = field(node, "value")?.text.trim();
      if (value && /^\d+$/.test(value)) values.push(Number(value));
    }
    return true;
  });
  if (values.length !== 1 || values[0]! < 32)
    throw new Error(`Register model unavailable: ${header} does not define one literal FIRST_PSEUDO_REGISTER.`);
  observed.set(key, values[0]!);
  return values[0]!;
}
