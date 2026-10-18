/** Explicit, review-only snapshot regeneration. Never invoked by the tests. */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { captureInstructionSnapshot } from "./instructionContracts.js";
import { writeIfChanged } from "../lib/contentCache.js";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--write") throw new Error("Usage: updateInstructionSnapshot.ts --write (review instruction changes first)");
  const path = join(HARNESS_ROOT, "test-fixtures/installed-runtime/instruction-current.json");
  writeIfChanged(path, JSON.stringify(captureInstructionSnapshot(HARNESS_ROOT), null, 2) + "\n");
  console.log(`Updated ${path}; review the snapshot diff before accepting it.`);
}
