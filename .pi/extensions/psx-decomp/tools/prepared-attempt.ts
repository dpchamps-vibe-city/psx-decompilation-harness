import { compilationIdentity, COMPONENT_CONTRACTS, stableHash } from "../../../../tools/lib/cacheIdentity.js";
import { installedScriptArgs } from "../../../../tools/lib/installedScripts.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { recordedCommand, commandText } from "../../../../tools/lib/recordedCommand.ts";
import { fileDigest as hashFile, digest as hashText } from "../../../../tools/lib/contentCache.js";
import { loadContainers } from "../../../../tools/lib/container.ts";
import { libraryInputFiles, loadLibraryProject } from "../../../../tools/lib/project.js";
import { buildToolInputs } from "../../../../tools/build/buildInputs.js";
import { snapshot } from "../../../../tools/lib/contentCache.js";
import { packetOpening, packetEvidence, type PreparationPacket } from "../../../../tools/agent/campaign/packet.ts";

export interface PreparedAttempt { packet: PreparationPacket; path: string }
export async function prepareAttempt(root: string, name: string, signal?: AbortSignal): Promise<PreparedAttempt> {
  const result = await recordedCommand(process.execPath, installedScriptArgs("tools/agent/m2cFunc.ts", [name, "--json"], root), root,
    join(root, "build/preparation/commands", name, `${Date.now()}-${process.pid}`), "prepare", signal, 600_000);
  if (result.status !== 0) throw new Error(`Preparation failed; full diagnostics: ${result.stderr}\n${commandText(result)}`);
  const { path } = JSON.parse(readFileSync(result.stdout, "utf8")) as { path: string };
  return { path, packet: JSON.parse(readFileSync(join(root, path), "utf8")) as PreparationPacket };
}
export function persistAttempt(root: string, attempt: PreparedAttempt): void {
  writeFileSync(join(root, attempt.path), JSON.stringify(attempt.packet, null, 2) + "\n");
  writeFileSync(join(root, dirname(attempt.path), "handoff.md"), packetOpening(attempt.packet, attempt.path) + "\n");
  writeFileSync(join(root, dirname(attempt.path), "evidence.md"), packetEvidence(attempt.packet) + "\n");
  writeFileSync(join(root, dirname(attempt.path), "diagnostics.txt"), attempt.packet.compilation.diagnostics + "\n");
}

export function buildInputs(root: string): Record<string, string> {
  const inputs: Record<string, string> = {};
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, e.name);
      if (e.isDirectory()) visit(file); else inputs[relative(root, file)] = hashFile(file);
    }
  };
  for (const dir of ["src", "include", "configs"]) visit(join(root, dir));
  const library = loadLibraryProject(root);
  if (library) {
    for (const dir of [...library.headers.reference, ...library.headers.owned]) visit(resolve(root, dir));
  }
  const targets = library ? libraryInputFiles(library, root).map(i => i.path) : loadContainers(root).map(c => c.targetPath);
  Object.assign(inputs, snapshot(root, buildToolInputs(root), path => !path.endsWith(".pyc") && !path.includes("/.git/")));
  for (const file of targets)
    inputs[relative(root, resolve(root, file))] = hashFile(resolve(root, file));
  for (const file of ["project.json", ".pi/autoloop.json"]) inputs[file] = hashFile(join(root, file));
  inputs["$compilation"] = stableHash(compilationIdentity(root));
  inputs["$verification-contract"] = COMPONENT_CONTRACTS.compilation;
  return inputs;
}
export const inputIdentity = (inputs: Record<string, string>) => hashText(JSON.stringify(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))));
export const sameInputs = (a: Record<string, string>, b: Record<string, string>) => inputIdentity(a) === inputIdentity(b);
export interface Completion {
  origin: "static" | "agent";
  /** Matching rung that produced the source; absent for static/legacy records. */
  tier?: string;
  /** Actual model that completed the notes-only turn, not the source author. */
  documentationModel?: string;
  verifiedIdentity: string;
  inputs: Record<string, string>;
  changedFiles: string[];
  /** Static matches retain evidence without dispatching a model for notes. */
  documentation: "pending" | "passed" | "skipped";
  verification?: "passed" | "invalidated";
  packetPath?: string;
  error?: string;
}

/** Exactness alone is never acceptance. Runs before any solver model lookup.
 * Failed staging is CAS-restored only when it is still exactly our own write. */
export async function attemptStaticFinalization(options: {
  root: string; attempt: PreparedAttempt; aborted: () => boolean;
  finalize: () => Promise<{ passed: boolean; changedFiles: string[]; detail: string }>;
}): Promise<{ completed?: Completion; handoff: string }> {
  const { packetIsFresh, stagePrepared } = await import("../../../../tools/agent/prepareFunction.ts");
  const { root, attempt } = options;
  const p = attempt.packet;
  const handoff = () => packetOpening(p, attempt.path);
  if (options.aborted() || p.comparison.status !== "exact" || p.integration.blockers.length || !packetIsFresh(p, root))
    return { handoff: handoff() };
  const destination = join(root, p.identity.destination);
  const original = readFileSync(destination, "utf8");
  let staged = false;
  if (p.integration.state !== "live") {
    const result = await withFileMutationQueue(destination, async () => stagePrepared(p, root));
    staged = result.staged;
    if (!staged) { p.integration.blockers.push(result.reason ?? "staging refused"); persistAttempt(root, attempt); return { handoff: handoff() }; }
  }
  let result: Awaited<ReturnType<typeof options.finalize>>;
  try {
    if (options.aborted()) throw new Error("cancelled before finalization");
    result = await options.finalize();
  } catch (error) { result = { passed: false, changedFiles: [], detail: String(error) }; }
  if (result.passed && !options.aborted()) {
    const inputs = buildInputs(root);
    const completion: Completion = { origin: "static", inputs, verifiedIdentity: inputIdentity(inputs), verification: "passed",
      changedFiles: result.changedFiles, documentation: "skipped", packetPath: attempt.path };
    p.finalization = { status: "passed", verifiedIdentity: completion.verifiedIdentity, changedFiles: result.changedFiles };
    p.integration.state = "live";
    persistAttempt(root, attempt);
    return { completed: completion, handoff: handoff() };
  }
  p.finalization = { status: "failed", gate: result.detail };
  if (staged) await withFileMutationQueue(destination, async () => {
    if (hashFile(destination) === p.integration.stagedHash) {
      writeFileSync(destination, original); p.integration.state = "staged";
    } else p.integration.blockers.push("concurrent source modification after staging; not restored");
  });
  persistAttempt(root, attempt);
  return { handoff: handoff() };
}

/** Documentation failure is independent of matching success and resumable.
 * Nothing here commits or resets files, including unauthorized documentation edits.
 * `document` resolves true on success, or with the reason it did not succeed. */
export async function documentCompletion(root: string, completion: Completion,
  document: () => Promise<true | false | string>): Promise<Completion> {
  if (!sameInputs(completion.inputs, buildInputs(root))) return { ...completion, verification: "invalidated", documentation: "pending", error: "verified build inputs changed; finalization must be rerun" };
  if (completion.documentation === "passed" || completion.documentation === "skipped") return completion;
  let outcome: true | false | string = false;
  try { outcome = await document(); } catch (failure) { outcome = String(failure); }
  /* Even an aborted/failed role may have edited a header before it stopped. */
  if (!sameInputs(completion.inputs, buildInputs(root))) return { ...completion, verification: "invalidated", documentation: "pending", error: "documentation changed build inputs; finalization must be rerun" };
  return outcome === true ? { ...completion, verification: "passed", documentation: "passed", error: undefined } :
    { ...completion, documentation: "pending", error: typeof outcome === "string" ? outcome : "the documentation turn did not complete" };
}
