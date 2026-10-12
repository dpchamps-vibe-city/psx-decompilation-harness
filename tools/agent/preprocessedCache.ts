import { COMPONENT_CONTRACTS, stableHash } from "../lib/cacheIdentity.js";
import { projectRoot } from "../lib/runtimeContext.js";
/** The real target cpp, reused by content + transitive include/search identity.
 * Cached text is immutable; inference views receive their own declaration models. */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { digest, fileDigest, filesUnder, readCache, snapshot, writeCache } from "../lib/contentCache.js";

import { resolveFunctionTarget, sourceFlagContext } from "../lib/targetAdapter.js";
import { libraryMemberForSource, requireLibraryFunction } from "../lib/libraryTargets.js";
import { isDirectoryTu, libraryCompileInput, librarySourceFiles } from "../lib/libraryTranslationUnit.js";
import { configuredCppFrontend, configuredFlags, configuredTool, executablePath, loadToolchain } from "../lib/toolchain.js";

export function dependencyPaths(text: string, root: string): string[] {
  const first = text.replace(/\\\r?\n/g, " ").split("\n")[0] ?? "";
  const colon = first.indexOf(":");
  if (colon < 0) throw new Error("cpp did not emit a dependency rule");
  return (first.slice(colon + 1).match(/(?:\\.|[^\s])+/g) ?? []).map((p) => resolve(root, p.replace(/\\(.)/g, "$1")));
}
const searchMemo = new Map<string, string[]>();
interface RequestMetadata { tools?: { cpp: string; frontend: string; hashes: string[]; config: string }; members: Map<string, string[]>; names: Set<string> }
const includeCandidate = (path: string, names: Set<string>) => /\.(?:h|inc)$/.test(path) || !basename(path).includes(".") || names.has(basename(path));
const metadata = new AsyncLocalStorage<RequestMetadata>();
/** Sharing is bounded to one operation. The closing check refuses a view whose
 * include search membership or cpp implementation drifted during the request. */
export function withPreprocessorMetadata<T>(task: () => T): T {
  if (metadata.getStore()) return task();
  const state: RequestMetadata = { members: new Map(), names: new Set() };
  const validate = () => {
    for (const [dir, members] of state.members) if (JSON.stringify(members.filter((p) => includeCandidate(p, state.names))) !==
      JSON.stringify(filesUnder(dir).filter((p) => includeCandidate(p, state.names))))
      throw new Error("include search membership changed during request");
    if (state.tools && (state.tools.config !== cppConfiguration() || JSON.stringify(state.tools.hashes) !== JSON.stringify([fileDigest(state.tools.cpp), fileDigest(state.tools.frontend)])))
      throw new Error("cpp implementation changed during request");
  };
  return metadata.run(state, () => {
    const result = task();
    if (result instanceof Promise) return result.then((value) => { validate(); return value; }) as T;
    validate(); return result;
  });
}
function cppConfiguration(): string { return stableHash({ cpp: configuredTool("cpp"), family: loadToolchain().compiler.family }); }
function toolConfiguration(): { cpp: string; frontend: string; hashes: string[]; config: string } {
  const state = metadata.getStore();
  if (state?.tools) return state.tools;
  const command = configuredTool("cpp");
  const cpp = executablePath(command);
  if (!cpp) throw new Error(`Configured preprocessor not found: ${command}`);
  const frontend = configuredCppFrontend();
  if (!frontend) throw new Error(`Configured preprocessor frontend not found: ${command}`);
  const tools = { cpp, frontend, hashes: [fileDigest(cpp), fileDigest(frontend)], config: cppConfiguration() };
  if (state) state.tools = tools;
  return tools;
}
function searchMembers(dir: string): string[] {
  const state = metadata.getStore();
  if (!state) return filesUnder(dir);
  if (!state.members.has(dir)) state.members.set(dir, filesUnder(dir));
  return state.members.get(dir)!;
}
export function preprocessingTools(): { tools: ReturnType<typeof toolConfiguration>; environment: Record<string, string | null> } {
  return { tools: toolConfiguration(), environment: Object.fromEntries(["CPATH", "C_INCLUDE_PATH", "GCC_EXEC_PREFIX", "COMPILER_PATH", "SOURCE_DATE_EPOCH"]
    .map((p) => [p, process.env[p] ?? null])) };
}
export interface ProcessedBundle { text: string; dependencies: string[]; inputs: Record<string, string>; cache: "hit" | "miss" }
export function cachedPreprocess(source: string, root = projectRoot(), flags?: string[], name?: string): ProcessedBundle {
  source = resolve(root, source);
  const context = name ? resolveFunctionTarget(name, root).flags : sourceFlagContext(source, root);
  flags ??= configuredFlags("cpp", context, root);
  const member = context?.kind === "library" && !source.endsWith(".h") ? (name ? requireLibraryFunction(name, root).member : libraryMemberForSource(source.slice(root.length + 1), root)) : undefined;
  const composition = member && isDirectoryTu(member) ? snapshot(root, librarySourceFiles(member, root)) : undefined;
  const input = member && isDirectoryTu(member) ? libraryCompileInput(member, source, join(root, "build/cache/preprocessed/inputs", digest(source)), root, name ? resolveFunctionTarget(name, root).symbol : undefined) : source;
  const { tools, environment } = preprocessingTools();
  const { cpp } = tools;
  const searchKey = digest(JSON.stringify([root, flags, tools, environment]));
  let search = searchMemo.get(searchKey);
  if (!search) {
    /* Ask cpp itself: preserves -I/-iquote/-isystem order, environment paths,
       and default system directories, including extensionless headers. */
    const probe = spawnSync(cpp, [...flags, "-E", "-v", "-"], { cwd: root, input: "", encoding: "utf8" });
    if (probe.status !== 0) throw new Error(`cpp search discovery failed: ${probe.stderr}`);
    const listing = probe.stderr.match(/#include "\.\.\." search starts here:\n([\s\S]*?)End of search list\./)?.[1];
    if (listing === undefined) throw new Error("cpp search discovery did not report include directories");
    search = [...new Set(listing.split("\n").filter((p) => /^\s+\S/.test(p)).map((p) => resolve(root, p.trim())))];
    searchMemo.set(searchKey, search);
  }
  const requested: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (["-I", "-iquote", "-isystem", "-idirafter"].includes(f)) { if (flags[i + 1]) requested.push(resolve(root, flags[++i]!)); }
    else if (f.startsWith("-I") && f !== "-I-") requested.push(resolve(root, f.slice(2)));
  }
  for (const variable of ["CPATH", "C_INCLUDE_PATH"]) if (process.env[variable])
    requested.push(...process.env[variable]!.split(":").map((p) => resolve(root, p || ".")));
  search = [...new Set([dirname(source), ...search, ...requested])];
  const membershipOf = (names: string[]) => {
    const set = new Set(names); for (const name of set) metadata.getStore()?.names.add(name);
    return search.map((dir): [string, string[]] => [dir, searchMembers(dir).filter((p) => includeCandidate(p, set))]);
  };
  const identity = { source, sourceHash: fileDigest(source), composition, flags, cpp: searchKey,
    compatibility: COMPONENT_CONTRACTS.preprocess };
  const key = digest(JSON.stringify(identity));
  const path = join(root, "build/cache/preprocessed", `${digest(source)}.json`);
  type Cached = Omit<ProcessedBundle, "cache"> & { searchNames: string[]; membership: Array<[string, string[]]> };
  const prior = readCache<Cached>(path, key);
  if (prior && JSON.stringify(prior.membership) === JSON.stringify(membershipOf(prior.searchNames)) &&
    JSON.stringify(prior.inputs) === JSON.stringify(snapshot(root, prior.dependencies))) return { ...prior, cache: "hit" };
  const temp = mkdtempSync(join(tmpdir(), "psx-cpp-cache-"));
  try {
    const deps = join(temp, "source.d"), output = join(temp, "source.i");
    const run = () => execFileSync(cpp, [...flags, "-MD", "-MF", deps, "-MT", "source", input, "-o", output], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    run();
    const dependenciesOf = () => [...new Set([...dependencyPaths(readFileSync(deps, "utf8"), root), ...(member && isDirectoryTu(member) ? librarySourceFiles(member, root).map(p => resolve(root, p)) : [])])];
    let dependencies = dependenciesOf();
    /* Discover actual includes, then repeat under their complete before/after
       snapshot. Hashing every *possible* include on each cold file is quadratic
       in the header population; a second cpp pass is cheaper and exact. */
    const before = snapshot(root, dependencies);
    /* Literal/macro include names also witness *absent* headers (notably
       __has_include). Keep nonstandard extensions without treating generated
       compiler/command artifacts in a staged source directory as headers. */
    const searchNames = [...new Set(dependencies.flatMap((p) => [basename(p),
      ...[...readFileSync(p, "utf8").matchAll(/["<]([^"<>\\\r\n]+)[">]/g)].map((m) => basename(m[1]!))]))].sort();
    const membership = membershipOf(searchNames);
    run(); dependencies = dependenciesOf();
    const after = snapshot(root, dependencies);
    if (JSON.stringify(before) !== JSON.stringify(after) || identity.sourceHash !== fileDigest(source) ||
      JSON.stringify(membership) !== JSON.stringify(membershipOf(searchNames)))
      throw new Error("preprocessor inputs changed during preprocessing");
    const value = { text: readFileSync(output, "utf8"), dependencies, inputs: snapshot(root, dependencies), searchNames, membership };
    writeCache(path, key, value);
    return { ...value, cache: "miss" };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
