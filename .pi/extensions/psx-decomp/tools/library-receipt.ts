import { join, resolve } from "node:path";
import { digest, fileDigest, withFreshContentMemo } from "../../../../tools/lib/contentCache.js";
import { count } from "../../../../tools/lib/perfCounters.js";
import { libraryFunctionTarget } from "../../../../tools/lib/targetAdapter.js";
import type { LibraryMember } from "../../../../tools/lib/libraryTargets.js";
import { loadConfig } from "../../shared/config.ts";
import type { GateResult } from "../../shared/types.ts";

/**
 * Receipts for passing library finalizations, held in this process only: the
 * agent can write to disk, so nothing on disk can claim a pass. A receipt is the
 * machine verification (function diff and member check) of one function, plus
 * every identity it rested on:
 *
 * - the end-of-window workspace identity over the checked members (sources,
 *   headers, toolchain, flag files, inventory inputs, compiler identities);
 * - the verification key (harness implementation and on-disk source policy);
 * - each checked member's accepted record, byte for byte;
 * - the published context files.
 *
 * It is reused only while all of them recompute equal. Scope and policy are
 * never reused: the consumer runs them again under its own configuration and
 * baseline, then re-validates the receipt. Receipts never cross functions: the
 * loop clears them when a function starts.
 */
interface LibraryReceipt { members: string[]; evidence: string; gate: GateResult }
const receipts = new Map<string, LibraryReceipt>();
const keyOf = (root: string, name: string) => `${resolve(root)}\0${name}`;

function evidence(root: string, target: { member: LibraryMember; fn: LibraryMember["functions"][number] }, checked: LibraryMember[]): Promise<string> {
  return withFreshContentMemo(async () => {
    const { acceptedPath, libraryVerificationKey, libraryWorkspaceIdentity } = await import("../../../../tools/agent/libraryTarget.js");
    const context = libraryFunctionTarget(target.member, target.fn, root).context;
    return digest(JSON.stringify({
      workspace: libraryWorkspaceIdentity(checked, root),
      verificationKey: libraryVerificationKey(root, loadConfig(root).sourcePolicy),
      records: checked.map(m => [m.id, fileDigest(acceptedPath(root, m))]),
      publication: [context.types, context.functions].map(path => [path, fileDigest(join(root, path))]),
    }));
  });
}

export async function publishLibraryReceipt(root: string, name: string, target: { member: LibraryMember; fn: LibraryMember["functions"][number] },
  checked: LibraryMember[], gate: GateResult): Promise<void> {
  if (!gate.pass || !gate.diff?.exact || gate.build?.code !== 0 || !gate.contextPublication) throw new Error("Cannot receipt an incomplete library verification");
  receipts.set(keyOf(root, name), { members: checked.map(m => m.id).sort(), evidence: await evidence(root, target, checked), gate: structuredClone(gate) });
}

/** The receipt's verification, when every identity it rests on is unchanged.
 * `checked` is the caller's own member set; it must equal the receipt's. */
export async function validLibraryReceipt(root: string, name: string, target: { member: LibraryMember; fn: LibraryMember["functions"][number] },
  checked: LibraryMember[]): Promise<{ gate?: GateResult; reason: string }> {
  const stored = receipts.get(keyOf(root, name));
  if (!stored) { count("libraryReceipt.miss:none"); return { reason: "no successful finalization of this function in this process" }; }
  if (JSON.stringify(checked.map(m => m.id).sort()) !== JSON.stringify(stored.members)) { count("libraryReceipt.miss:members"); return { reason: "checked members changed" }; }
  let current: string;
  /* An identity that cannot be computed (an input changed under the inventory) is a miss; the full path reports it. */
  try { current = await evidence(root, target, checked); }
  catch (error) { count("libraryReceipt.miss:error"); return { reason: `verified inputs could not be re-identified: ${error instanceof Error ? error.message : String(error)}` }; }
  if (current !== stored.evidence) { count("libraryReceipt.miss:evidence"); return { reason: "verified inputs, records, harness or publication changed" }; }
  count("libraryReceipt.hit");
  return { gate: structuredClone(stored.gate), reason: "inputs, records, harness and publication unchanged since this process verified them" };
}

/** The member set a receipt was taken over, for a consumer without changed files. */
export function libraryReceiptMembers(root: string, name: string): string[] | undefined {
  return receipts.get(keyOf(root, name))?.members;
}

export function clearLibraryReceipts(): void { receipts.clear(); }
