/** Run legacy ROOT-bound integration modules in an isolated project. Only
 * harness source/SDK infrastructure is shared; original bytes are synthesized
 * or compiled here. No game's extracted inputs or generated state is copied. */
import { cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeContext, inRuntimeContext } from "../lib/runtimeContext.js";
import { HARNESS_ROOT } from "../lib/toolchain.js";
import { findMatchingLow, parseRelocations, parseSymbolTable, relocatedField } from "../lib/functionOracle.js";
import { FIXTURE_BASE, FIXTURE_GP, projectFixture, type FixtureFunction } from "./projectFixture.js";

export function harnessFixture(t: { after: (cleanup: () => void) => void }) {
  const fixture = projectFixture(t, { assemblies: false });
  const { root, put } = fixture;
  put("package.json", '{"type":"module"}\n');
  cpSync(join(HARNESS_ROOT, "include"), join(root, "include"), { recursive: true, filter: path => !path.includes("/psyq") });
  const context = createRuntimeContext(root);
  // The fixture owns target files, not a second copy of the implementation.
  const bound = new WeakMap<Function, Function>();
  const load = async <T>(path: string): Promise<T> => {
    const module = await inRuntimeContext(context, () => import(pathToFileURL(join(HARNESS_ROOT, path)).href));
    return new Proxy(module, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (!bound.has(value)) bound.set(value, new Proxy(value, {
        apply(fn, self, args) { return inRuntimeContext(context, () => Reflect.apply(fn, self, args)); },
        construct(fn, args, owner) { return inRuntimeContext(context, () => Reflect.construct(fn, args, owner)); },
      }));
      return bound.get(value);
    } }) as T;
  };
  /** REL addends stay in the words; relocate from known synthetic addresses,
   * never by borrowing an original game's linker map. Single-function TUs. */
  const compile = async (name: string, text: string, base = FIXTURE_BASE, symbols: Record<string, number> = {}) => {
    const tc = await load<typeof import("../agent/decompToolchain.js")>("tools/agent/decompToolchain.ts");
    const source = join(root, "build/fixture-sources", name + ".c");
    put("build/fixture-sources/" + name + ".c", text);
    const art = tc.compileSource(source, join(root, "build/fixture-objects", name), name, { assemble: true, containerKind: "exe" });
    const binary = join(art.outputDir, "text.bin");
    tc.runTool(tc.configuredTool("objcopy"), ["-O", "binary", "-j", ".text", art.object!, binary]);
    const bytes = readFileSync(binary);
    const table = parseSymbolTable(tc.runTool(tc.configuredTool("objdump"), ["-t", "--special-syms", art.object!]));
    const rels = parseRelocations(tc.runTool(tc.configuredTool("objdump"), ["-r", "-j", ".text", art.object!]));
    const fields = Buffer.from(bytes);
    for (const [i, r] of rels.entries()) {
      const symbol = table.find(s => s.name === r.symbol && s.section === ".text");
      const address = r.symbol === ".text" ? base : symbol ? base + symbol.offset : symbols[r.symbol];
      if (address === undefined) throw new Error(`Fixture relocation has no declared address: ${r.symbol}`);
      const low = r.type === "R_MIPS_HI16" ? findMatchingLow(rels, i) : null;
      bytes.writeUInt32LE(relocatedField(r.type, fields.readUInt32LE(r.offset), address, {
        gp: FIXTURE_GP, place: base + r.offset, ...(low ? { lowField: fields.readUInt32LE(low.offset) } : {}),
      }), r.offset);
    }
    const functionSymbol = table.find(s => s.name === name && s.section === ".text");
    if (!functionSymbol || functionSymbol.offset !== 0 || functionSymbol.size <= 0)
      throw new Error(`Fixture requires a bounded single-function text section: ${name}`);
    const functionBytes = bytes.subarray(0, functionSymbol.size);
    return { source, art, bytes: functionBytes, words: Array.from({ length: functionBytes.length / 4 }, (_, i) => functionBytes.readUInt32LE(i * 4)) };
  };
  const install = async (exe: readonly FixtureFunction[], overlays: Readonly<Record<string, readonly FixtureFunction[]>> = {}) => {
    projectFixture({ after: () => {} }, { root, exe, overlays, assemblies: false });
    const containers = await load<typeof import("../lib/container.js")>("tools/lib/container.ts");
    containers.resetContainerCache();
    return containers.loadContainers();
  };
  return { ...fixture, load, compile, install };
}
