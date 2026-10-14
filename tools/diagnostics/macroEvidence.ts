/** Fingerprint project operation definitions or run their automatic proof gate.
 * No source edits, approval state, compiler changes or cache-based grants. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "../lib/runtimeContext.js";
import { evaluateMacroEvidence, macroDefinitions, macroDefinitionHash } from "../lib/macroEvidence.js";

const args = process.argv.slice(2), root = projectRoot();
try {
  if (args[0] === "--fingerprint" && args.length === 2) {
    console.log(JSON.stringify(macroDefinitions(readFileSync(resolve(root, args[1]!), "utf8")).map(definition => ({
      name: definition.name, header: args[1], definitionSha256: macroDefinitionHash(definition.text), arity: definition.arity,
    })), null, 2));
  } else if (!args.length || args.length === 1 && args[0] === "--json") {
    const result = evaluateMacroEvidence(root);
    const report = { pass: result.failures.length === 0, definitions: [...result.definitions].map(([header, macros]) => ({ header, macros: Object.fromEntries(macros) })), failures: result.failures };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  } else throw new Error("Usage: macroEvidence.ts [--json | --fingerprint include/operations.h]");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
