import { projectRoot } from "./runtimeContext.js";
/** Format adapters present one function/TU contract to the matching tools.
 * Coordinates and acceptance scope stay explicit: a section offset is not VRAM.
 * Original assembly remains INCLUDE_ASM-backed until replaced with recovered C. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { type FlagContext } from "./toolchain.js";
import { EXE_CONTAINER_ID, containerOfSymbol, loadContainers, symbolPrefix, type Container } from "./container.js";
import { loadFunctionSpans } from "./symbolIndex.js";
import { libraryContext, loadLibraryProject } from "./project.js";
import { libraryMemberForSource, libraryTargetKey, requireLibraryFunction, type LibraryMember } from "./libraryTargets.js";
import { isDirectoryTu, libraryAssemblyTu, libraryFunctionSource } from "./libraryTranslationUnit.js";

/** Diagnostic keys may be owner-qualified; C/RTL still names the actual symbol. */
export function functionSymbol(key: string): string {
  const separator = key.lastIndexOf("::");
  return separator < 0 ? key : key.slice(separator + 2);
}

export interface FunctionTarget {
  key: string;
  symbol: string;
  owner: { id: string; kind: FlagContext["kind"] };
  source: string;
  assembly: { function: string; translationUnit: string };
  includeAsm: { folder: string; symbol: string };
  flags: FlagContext;
  coordinate: { kind: "image"; vram?: number } | { kind: "section"; section: string; offset: number; size: number; inferredSize: boolean };
  translationUnit: { source: string; functions: string[] };
  verification: { scope: "function" | "translation-unit"; mode: "linked-bytes" | "relocatable-object" | "original-object" };
  context: { types: string; functions: string; compilerHeaders: string[] };
  capabilities: { linkedImageAnalysis: boolean; functionInstructionView: boolean; automaticSingleStubStaging: boolean };
}

/** Image compatibility lookup. Unconfigured fixtures retain the old src/ layout. */
export function imageContainerFor(name: string, root = projectRoot()): Container | null {
  try {
    const containers = loadContainers(root);
    return containerOfSymbol(name, containers) ?? containers.find(c => c.id === EXE_CONTAINER_ID) ?? null;
  } catch { return null; }
}

export function libraryFunctionTarget(member: LibraryMember, fn: LibraryMember["functions"][number], root = projectRoot()): FunctionTarget {
  const project = loadLibraryProject(root)!;
  const folder = `build/libraries/nonmatchings/${member.id}`;
  const assemblyTu = libraryAssemblyTu(member, root);
  return { key: libraryTargetKey(member, fn.name), symbol: fn.name, owner: { id: member.id, kind: "library" },
    source: assemblyTu ? relative(root, assemblyTu.source).replaceAll("\\", "/") : libraryFunctionSource(member, fn.name),
    assembly: { function: `${folder}/${fn.name}.s`, translationUnit: member.assembly }, includeAsm: { folder, symbol: fn.name },
    flags: libraryContext(member.id, root), coordinate: { kind: "section", section: fn.section, offset: fn.offset, size: fn.size, inferredSize: fn.inferredSize },
    translationUnit: { source: member.source, functions: member.functions.map(f => libraryTargetKey(member, f.name)) },
    verification: { scope: "translation-unit", mode: project.verification.mode },
    context: { types: `build/libraries/context/${member.id}/types.h`, functions: `build/libraries/context/${member.id}/functions.h`, compilerHeaders: project.headers.context },
    capabilities: { linkedImageAnalysis: false, functionInstructionView: !fn.generated, automaticSingleStubStaging: isDirectoryTu(member) || member.functions.length === 1 } };
}

function imageFunctionTarget(name: string, root: string): FunctionTarget {
  const container = imageContainerFor(name, root);
  // A generated graph also supplies paths for alternate roots and older layouts.
  let entry: { container?: string; source?: string; includeAsmPath?: string; vram?: string } | undefined;
  try { entry = JSON.parse(readFileSync(join(root, "build/callGraph.json"), "utf8")).functions.find((e: { name: string }) => e.name === name); }
  catch { /* No graph yet. */ }
  const owner = { id: entry?.container ?? container?.id ?? EXE_CONTAINER_ID, kind: container?.kind ?? (entry?.container && entry.container !== EXE_CONTAINER_ID ? "overlay" : "exe") as "exe" | "overlay" };
  const folder = entry?.includeAsmPath ?? `${container?.paths.asmDir ?? "build/asm"}/nonmatchings/${name}`;
  let assembly = `${folder}/${name}.s`;
  if (!existsSync(join(root, assembly)) && existsSync(join(root, folder))) {
    const files = readdirSync(join(root, folder)).filter(f => f.endsWith(".s"));
    if (files.length === 1) assembly = `${folder}/${files[0]}`;
  }
  if (!existsSync(join(root, assembly))) {
    const prefix = container ? symbolPrefix(container) : "";
    for (const stem of prefix && name.startsWith(prefix) ? [name, name.slice(prefix.length)] : [name]) {
      const archived = `${container?.paths.disasmDir ?? "build"}/functions/${stem}.s`;
      if (existsSync(join(root, archived))) { assembly = archived; break; }
    }
  }
  const source = entry?.source ?? `${container?.paths.srcDir ?? "src"}/${name}.c`;
  let vram = entry?.vram ? Number(entry.vram) : undefined;
  if (vram === undefined && container) { try { vram = loadFunctionSpans(container).find(f => f.name === name)?.vram; } catch { /* not split */ } }
  return { key: name, symbol: name, owner, source, assembly: { function: assembly, translationUnit: assembly }, includeAsm: { folder, symbol: name },
    flags: owner, coordinate: { kind: "image", ...(vram !== undefined ? { vram } : {}) }, translationUnit: { source, functions: [name] },
    verification: { scope: "function", mode: "linked-bytes" },
    context: { types: "include/sdk_types.h", functions: owner.kind === "overlay" ? `include/overlays/${owner.id}.h` : "include/functions.h", compilerHeaders: [] },
    capabilities: { linkedImageAnalysis: true, functionInstructionView: true, automaticSingleStubStaging: true } };
}

export function resolveFunctionTarget(value: string, root = projectRoot()): FunctionTarget {
  if (loadLibraryProject(root)) {
    const { member, fn } = requireLibraryFunction(value, root);
    return libraryFunctionTarget(member, fn, root);
  }
  const name = basename(value).replace(/\.c$/, "");
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Invalid function name: ${value}`);
  return imageFunctionTarget(name, root);
}

/** Context/flag ownership for preprocessing an arbitrary live source path. */
export function sourceFlagContext(source: string, root = projectRoot()): FlagContext | undefined {
  const path = relative(root, resolve(root, source)).replaceAll("\\", "/");
  if (loadLibraryProject(root)) {
    const member = libraryMemberForSource(path, root);
    return member ? libraryContext(member.id, root) : undefined;
  }
  return imageContainerFor(basename(source).replace(/\.c$/, ""), root) ?? undefined;
}

export function requireTargetCapability(name: string, capability: keyof FunctionTarget["capabilities"], root = projectRoot()): FunctionTarget {
  const target = resolveFunctionTarget(name, root);
  if (!target.capabilities[capability]) throw new Error(`${capability} is unavailable for ${target.key}; use the preparation handoff and ${target.verification.mode} report`);
  return target;
}
