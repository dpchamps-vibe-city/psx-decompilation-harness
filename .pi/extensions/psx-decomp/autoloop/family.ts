import { join } from "node:path";
import { contextForProject, inRuntimeContext } from "../../../../tools/lib/runtimeContext.js";
import { siblingsOf } from "../../../../tools/agent/fileGroupings.js";
import { readLedger } from "../../../../tools/agent/experimentLedger.ts";
import { buildIndex } from "../../../../tools/agent/residualSignatures.ts";

/**
 * The functions a park has implicated.
 *
 * Two relations, both cheap and both derived rather than guessed:
 *
 *  - **residual signature.** The parked function's measurements recorded the
 *    shapes of its open blocks. Any other function whose measurements carried
 *    one of those shapes is the same problem written twice — that is what a
 *    signature means — so whatever stopped this one will stop that one.
 *  - **suspected translation unit.** `notes/file-groupings.md` records
 *    same-file membership with evidence. Members of a group share the author's
 *    idioms and the build's per-TU facts, which is exactly the layer a park
 *    most often turns out to be about.
 *
 * Deferred, never skipped. The relation says "the answer to this one is
 * probably the answer to those", which is a reason to work them *after* the
 * cause is understood, not a reason to abandon them. Working them before is
 * what turned four functions of one family into three hours and four parks.
 */
export function implicatedByPark(projectRoot: string, parked: string): string[] {
  const implicated = new Set<string>();

  for (const name of inRuntimeContext(contextForProject(projectRoot), () => bySignature(parked))) implicated.add(name);
  for (const name of siblingsOf(parked, join(projectRoot, "notes/file-groupings.md"))) implicated.add(name);
  implicated.delete(parked);
  return [...implicated];
}

function bySignature(parked: string): string[] {
  const signatures = new Set(readLedger(parked).flatMap((entry) => entry.signatures ?? []));
  if (signatures.size === 0) return [];
  const out = new Set<string>();
  for (const record of buildIndex().records) {
    if (!signatures.has(record.signature)) continue;
    for (const carrier of record.carriers) out.add(carrier.function);
  }
  return [...out];
}
