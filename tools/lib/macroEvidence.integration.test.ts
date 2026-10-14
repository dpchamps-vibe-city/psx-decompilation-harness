import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "../testing/runtimeTestContext.js";
import { harnessFixture } from "../testing/harnessFixture.js";
import { DEFAULT_CONFIG } from "../../.pi/extensions/shared/config.js";
import { checkSourcePolicy } from "../../.pi/extensions/shared/source-policy.js";
import { evaluateMacroEvidence, macroDefinitions, macroDefinitionHash } from "./macroEvidence.js";

/** Synthetic bytes exercise the actual compiler/process/oracle route, not SDK
 * provenance. The project's real PAD witnesses are checked separately. */
test("a new noncanonical header macro earns its exception through the real production gate", { timeout: 120_000 }, async t => {
  const f = harnessFixture(t);
  const header = '#ifndef OPERATIONS_H\n#define OPERATIONS_H\n#define LOADED_ENTRY(destination) do { register void *entry __asm__("$9") = (destination); goto *entry; } while (0)\n#endif\n';
  f.put("include/operations.h", header);
  const first = '#include "operations.h"\nvoid first(void) { LOADED_ENTRY(*(void **)0x80040000); }\n';
  const second = '#include "operations.h"\nvoid second(void) { LOADED_ENTRY(*(void **)0x80040004); }\n';
  const a = await f.compile("first", first), b = await f.compile("second", second);
  await f.install([{ name: "first", offset: 0, words: a.words }, { name: "second", offset: 0x40, words: b.words }]);
  f.put("src/first.c", first); f.put("src/second.c", second);
  const definition = macroDefinitions(header).find(d => d.name === "LOADED_ENTRY")!;
  f.put("configs/macro-evidence.json", JSON.stringify({ version: 1, macros: [{
    name: "LOADED_ENTRY", header: "include/operations.h", definitionSha256: macroDefinitionHash(definition.text),
    operation: "Transfer to a loaded entry without changing the return address", rationale: "Two synthetic original-word ABI veneers", witnesses: ["first", "second"],
  }] }));
  const evidence = evaluateMacroEvidence(f.root);
  assert.deepEqual(evidence.failures, []);
  assert.equal(evidence.definitions.get("include/operations.h")?.get("LOADED_ENTRY"), 1);
  const config = structuredClone(DEFAULT_CONFIG);
  config.sourcePolicy.allowBiosTailJumpMacro = false;
  const audit = () => checkSourcePolicy({ projectRoot: f.root, config, scanFunctions: ["first", "second"], changedFiles: ["include/operations.h", "src/first.c", "src/second.c", "configs/macro-evidence.json"] });
  assert.equal(audit().pass, true);
  // Evidence for one definition must never exempt other code in its header.
  f.put("include/operations.h", header + '__asm__("nop");\n');
  const withExtraAssembly = audit();
  assert.equal(withExtraAssembly.pass, false);
  assert(withExtraAssembly.hardFailures.some(finding => finding.kind === "embedded-asm" && finding.file === "include/operations.h"), JSON.stringify(withExtraAssembly.hardFailures));
  assert.equal(readFileSync(join(f.root, "src/first.c"), "utf8"), first);
});
