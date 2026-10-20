import { projectRoot } from "../../lib/runtimeContext.js";
/** Independent seed admission: SDK, or clean C verified by the relocated oracle.
 * Generated function headers are never witnesses. Cached verified bundles retain
 * exact cpp text, scoped declarations and hashed oracle outputs. */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { compileSource, sourcePathFor, configuredToolchainIdentity } from "../decompToolchain.js";
import { buildToolInputs } from "../../build/buildInputs.js";
import { compareFunction } from "../../lib/functionOracle.js";
import { requireFunctionLocation } from "../../lib/symbolIndex.js";
import { containerTargetPath, loadContainers } from "../../lib/container.js";
import { requireLibraryFunction } from "../../lib/libraryTargets.js";
import { resolveFunctionTarget } from "../../lib/targetAdapter.js";
import { sdkPrototypes, definitionPrototype, scopeFromPreprocessed, prototypesIn, type Prototype } from "../calleeTruth.js";
import { analyzeCSource } from "../cSourceGuard.js";
import { parseC } from "../residual-source-search/tree-sitter-c.js";
import { slotsWithTypedefs, parameterReads, typeScopes } from "./c-types.js";
import { cachedPreprocess, preprocessingTools } from "../preprocessedCache.js";
import { digest, fileDigest, snapshot, readCache, writeCache, type PhaseTiming } from "../../lib/contentCache.js";

export interface SeedRecord { name: string; status: "sdk" | "verified" | "withheld" | "rejected" | "absent"; prototype?: Prototype; reason?: string; evidence: string[]; cache?: "hit" | "miss" }
export interface VerifiedSeedBundle { prototype: Prototype; preprocessed: string; object: string; outputs: Record<string, string>; inputs: Record<string, string>; inputHash: string }
/** A relocatable library proves C by whole-member verification, not by relinking one function. */
export interface LibrarySeedAdmission { verified: (member: string) => boolean }
export function seedOracle(directory: string, withheld: string[] = [], permitted?: string[], library?: LibrarySeedAdmission): {
  get: (name: string) => Prototype | undefined; bundle: (name: string) => VerifiedSeedBundle | undefined; records: SeedRecord[]; timings: PhaseTiming[];
} {
  const sdk = sdkPrototypes(), records: SeedRecord[] = [], memo = new Map<string, Prototype | undefined>();
  const bundles = new Map<string, VerifiedSeedBundle>(), timings: PhaseTiming[] = [];
  let sharedInputs: string | undefined;
  const sharedIdentity = (fresh = false) => !fresh && sharedInputs ? sharedInputs : sharedInputs = digest(JSON.stringify({ tools: configuredToolchainIdentity(), preprocessing: preprocessingTools(), inputs: snapshot(projectRoot(), [
    ...buildToolInputs(projectRoot()), "toolchain.json", "build/dep_syms.txt", "build/lib_bss_syms.txt", "configs", "tools/agent", "tools/lib", "tools/vendor/tree-sitter-c", "package-lock.json",
    "build/engine_syms.txt", ...loadContainers().flatMap((c) => [containerTargetPath(c), c.paths.asmDir, c.paths.ldScript, c.paths.undefinedFuncs, c.paths.undefinedSyms]),
  ], (p) => !p.endsWith(".test.ts") && !p.endsWith(".pyc") && !p.endsWith("project-profile.md")) }));
  const get = (name: string): Prototype | undefined => {
    if (memo.has(name)) return memo.get(name);
    const record: SeedRecord = { name, status: "absent", evidence: [] }; records.push(record); memo.set(name, undefined);
    /* Isolation is checked BEFORE cache lookup. A permitted seed in another
       view supplies no evidence at all to this held-out view. */
    if (withheld.includes(name) || (permitted && !permitted.includes(name))) { record.status = "withheld"; record.reason = "isolated inference input view"; return; }
    if (library) return librarySeed(name, record, library);
    if (sdk.has(name)) {
      const prototype = structuredClone(sdk.get(name)!);
      record.evidence.push(`${prototype.where}:${prototype.line}`); record.status = "sdk"; record.prototype = prototype; memo.set(name, prototype); return prototype;
    }
    const start = performance.now();
    try {
      let source = sourcePathFor(name);
      if (!existsSync(source)) {
        const found = definitionPrototype(name);
        if (!found) return;
        source = join(projectRoot(), found.where);
      }
      const text = readFileSync(source, "utf8"), guard = analyzeCSource(text);
      if (guard.includeAsm.length) return;
      const syntax = parseC(text);
      const assembly = syntax.rootNode.descendantsOfType("gnu_asm_expression").length;
      syntax.delete();
      if (!guard.parses || assembly) throw new Error("not a clean-C seed: AST has broken syntax or embedded assembly");
      const location = requireFunctionLocation(name), container = location.container;
      const processed = cachedPreprocess(source), scope = scopeFromPreprocessed(processed.text);
      const prototype = prototypesIn(scope.source, relative(projectRoot(), source), scope.lineOf).find((p) => p.name === name && p.kind === "definition");
      if (!prototype) return;
      record.evidence.push(`${prototype.where}:${prototype.line}`);
      const inputHashShared = sharedIdentity();
      const inputHash = digest(JSON.stringify([inputHashShared, location, processed.inputs, processed.text]));
      const cache = join(projectRoot(), "build/cache/verified-seeds", container.id, name, inputHash, "receipt.json");
      const hit = readCache<VerifiedSeedBundle>(cache, inputHash);
      let bundle: VerifiedSeedBundle;
      if (hit && Object.entries(hit.outputs).every(([p, hash]) => fileDigest(p) === hash)) {
        bundle = hit; record.cache = "hit";
      } else {
        const artifact = compileSource(source, join(projectRoot(), "build/cache/verified-seeds", container.id, name, inputHash), name,
          { assemble: true, containerKind: container.kind, preprocessedText: processed.text });
        const verdict = compareFunction(name, { objectPath: artifact.object!, candidateSource: artifact.source, container });
        if (verdict.verdict !== "match") throw new Error(`defining C relocated bytes: ${verdict.verdict}`);
        prototype.slots = slotsWithTypedefs(prototype.paramTypes ?? [], scope.source);
        prototype.usedParameters = parameterReads(scope.source, name);
        const identities = typeScopes([...(prototype.paramTypes ?? []), prototype.returnType ?? ""], scope.source, scope.lineOf, prototype.where);
        prototype.typeScopes = { parameters: identities.slice(0, -1), result: identities.at(-1)! };
        bundle = { prototype, preprocessed: processed.text, object: artifact.object!, inputHash, inputs: processed.inputs,
          outputs: Object.fromEntries([artifact.object!, artifact.preprocessed, artifact.assembly].map((p) => [p, fileDigest(p)])) };
        if (Object.entries(processed.inputs).some(([p, hash]) => fileDigest(join(projectRoot(), p)) !== hash) ||
          sharedIdentity(true) !== inputHashShared) throw new Error("seed verification inputs changed during compilation");
        writeCache(cache, inputHash, bundle); record.cache = "miss";
      }
      bundles.set(name, bundle);
      const admitted = structuredClone(bundle.prototype);
      record.evidence.push(bundle.object); record.status = "verified"; record.prototype = admitted; memo.set(name, admitted); return admitted;
    } catch (error) { record.status = "rejected"; record.reason = String(error); return; }
    finally { timings.push({ phase: `seed:${name}`, durationMs: performance.now() - start, ...(record.cache ? { cache: record.cache } : {}),
      reason: record.cache === "hit" ? "independently verified bundle inputs and outputs unchanged" : record.reason ?? record.status }); }
  };
  /* Library names are member::symbol keys, or a bare import no member defines.
     The vendor header declares only what the library exports, never a private
     helper of the same name. Clean C seeds only once its member verifies. */
  const librarySeed = (name: string, record: SeedRecord, admission: LibrarySeedAdmission): Prototype | undefined => {
    let target: ReturnType<typeof requireLibraryFunction> | undefined;
    try { if (name.includes("::")) target = requireLibraryFunction(name); } catch { /* an import no member defines */ }
    const symbol = target?.fn.name ?? name;
    const exported = !target || target.member.object.symbols.some((s) => s.binding !== 0 && s.name === symbol && s.section === target!.fn.section);
    if (exported && sdk.has(symbol)) {
      const prototype = structuredClone(sdk.get(symbol)!);
      record.evidence.push(`${prototype.where}:${prototype.line}`); record.status = "sdk"; record.prototype = prototype; memo.set(name, prototype); return prototype;
    }
    if (!target) return;
    const start = performance.now();
    try {
      if (!admission.verified(target.member.id)) { record.reason = "member does not verify"; return; }
      const source = join(projectRoot(), resolveFunctionTarget(name).source);
      if (!source.endsWith(".c") || !existsSync(source)) return;
      const text = readFileSync(source, "utf8"), guard = analyzeCSource(text);
      if (guard.includeAsm.some((site) => site.symbol === symbol)) return;
      const syntax = parseC(text);
      const assembly = syntax.rootNode.descendantsOfType("gnu_asm_expression").length;
      syntax.delete();
      if (!guard.parses || assembly) throw new Error("not a clean-C seed: AST has broken syntax or embedded assembly");
      const processed = cachedPreprocess(source, projectRoot(), undefined, name), scope = scopeFromPreprocessed(processed.text);
      const prototype = prototypesIn(scope.source, relative(projectRoot(), source), scope.lineOf).find((p) => p.name === symbol && p.kind === "definition");
      if (!prototype) return;
      prototype.slots = slotsWithTypedefs(prototype.paramTypes ?? [], scope.source);
      prototype.usedParameters = parameterReads(scope.source, symbol);
      const identities = typeScopes([...(prototype.paramTypes ?? []), prototype.returnType ?? ""], scope.source, scope.lineOf, prototype.where);
      prototype.typeScopes = { parameters: identities.slice(0, -1), result: identities.at(-1)! };
      bundles.set(name, { prototype, preprocessed: processed.text, object: target.member.original, outputs: {}, inputs: processed.inputs,
        inputHash: digest(JSON.stringify([processed.inputs, processed.text])) });
      const admitted = structuredClone(prototype);
      record.evidence.push(`${prototype.where}:${prototype.line}`, target.member.original);
      record.status = "verified"; record.prototype = admitted; memo.set(name, admitted); return admitted;
    } catch (error) { record.status = "rejected"; record.reason = String(error); return; }
    finally { timings.push({ phase: `seed:${name}`, durationMs: performance.now() - start, reason: record.reason ?? record.status }); }
  };
  void directory; /* request-specific reports still link immutable verified artifacts */
  return { get, bundle: (name) => { get(name); return bundles.has(name) ? structuredClone(bundles.get(name)!) : undefined; }, records, timings };
}
