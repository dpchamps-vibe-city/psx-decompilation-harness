import { test } from "./runtimeTestContext.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";
import { assertInstructionBytes, descriptionSpans, inspectInstructionReferences, readInstructionLedger } from "./instructionContracts.js";
import ts from "typescript";
import { filesUnder } from "../lib/contentCache.js";
import matching from "../../.pi/extensions/psx-decomp/index.js";
import resources from "../../.pi/extensions/psx-resources/index.js";
import bootstrap from "../../.pi/extensions/psx-bootstrap/index.js";
import { planScaffold, applyScaffold } from "../build/scaffoldProject.js";
import { agentHint, formatAgentHints, validateHint } from "../../.pi/extensions/shared/agent-hints.js";

function registrations() {
  const tools = new Map<string, any>();
  const api: any = { registerTool: (tool: any) => { assert.ok(!tools.has(tool.name), `duplicate ${tool.name}`); tools.set(tool.name, tool); },
    registerCommand() {}, on() {}, registerMessageRenderer() {}, registerFlag() {} };
  matching(api); resources(api); bootstrap(api);
  return tools;
}
const baseline = JSON.parse(readFileSync(join(HARNESS_ROOT, "test-fixtures/installed-runtime/instruction-baseline.json"), "utf8"));
test("active instruction bytes differ only by the exact recorded I1/I2 patch", () => {
  const edits = readInstructionLedger(HARNESS_ROOT);
  for (const row of baseline.rows) assertInstructionBytes(row.file, row.text, readFileSync(join(HARNESS_ROOT, row.file), "utf8"), edits, row.descriptionsOnly);
  assert.equal(createHash("sha256").update(readFileSync(join(HARNESS_ROOT, "AGENTS.md"))).digest("hex"), baseline.agentsUnchangedHash);
  assert.equal(existsSync(join(HARNESS_ROOT, "prompts/legacy")), false);
  assert.throws(() => assertInstructionBytes("fixture.md", "unchanged prose\n", "unchanged  prose\n", []), /unrecorded/);
});
test("installed instruction links and provided parameters resolve in a prepared consumer without copied tools", async t => {
  const root = mkdtempSync(join(tmpdir(), "installed-instructions-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  await applyScaffold(planScaffold(root, "exe"), false);
  writeFileSync(join(root, "tools/resource-parsers/fixture.ts"), "/* prepared authored plugin */\n");
  // This fixture contains project mutation paths, never the implementation tree.
  assert.equal(existsSync(join(root, "tools/agent")), false);
  assert.equal(existsSync(join(root, ".pi/skills")), false);
  const tools = registrations();
  for (const row of baseline.rows) {
    const current = readFileSync(join(HARNESS_ROOT, row.file), "utf8");
    const text = row.descriptionsOnly ? descriptionSpans(current).join("\n") : current;
    inspectInstructionReferences(text, join(HARNESS_ROOT, row.file), root, tools);
  }
  for (const tool of tools.values()) inspectInstructionReferences(tool.description, join(HARNESS_ROOT, "package.json"), root, tools);
  for (const hint of ["npx tsx tools/agent/residualObjective.ts fixture --src candidate.c", "npx tsx tools/agent/fuzzVariants.ts fixture --manifest variants.json", "npx tsx tools/build/deriveRodataSplits.ts --container ovl_1", "make check", "make check-all fixture", "npm run extract-assets", "Usage: npx tsx tools/agent/loopTrace.ts fixture --json"]) {
    const output = formatAgentHints(hint); validateHint(output); inspectInstructionReferences(output, join(HARNESS_ROOT, "package.json"), root, tools);
  }
});
test("runtime literal hint inventory formats registered follow-ups and preserves JSON evidence", () => {
  const tools = registrations(), rows: Array<{ file: string; line: number; original: string; formatted: string }> = [];
  for (const directory of ["tools/agent", "tools/build", "tools/diagnostics", ".pi/extensions"]) {
    for (const path of filesUnder(join(HARNESS_ROOT, directory)).filter(p => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ts.isTemplateExpression(node) ?
          node.head.text + node.templateSpans.map(s => "<value>" + s.literal.text).join("") : undefined;
        if (text && /\bnpx\s+tsx\s+tools\/|\b(?:npm\s+run|make)\s+[\w-]+/.test(text)) {
          const formatted = formatAgentHints(text);
          assert.doesNotMatch(formatted, /\bnpx\s+tsx\s+tools\/|\b(?:npm\s+run|make)\s+[\w-]+|(?<![\w./])tools\/(?:agent|build|diagnostics)\/[^\s]+\.ts/, path);
          validateHint(formatted);
          rows.push({ file: path.slice(HARNESS_ROOT.length + 1), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, original: text, formatted });
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  assert.ok(rows.length >= 77, `inventory must cover runtime strings, not only seven examples: ${rows.length}`);
  const report = { next: "Run npm run setup", usage: "npx tsx tools/agent/residualObjective.ts fixture --json", command: "npx tsx tools/agent/diffFunc.ts fixture", argv: ["tools/agent/diffFunc.ts", "fixture"] };
  const formatted = JSON.parse(formatAgentHints(JSON.stringify(report)));
  assert.equal(formatted.next, 'Run psx_prepare_tooling({})');
  assert.equal(formatted.command, report.command); assert.deepEqual(formatted.argv, report.argv);
  validateHint(formatted.usage); assert.ok(tools.has("psx_prepare_tooling"));
  // CLI-only maintenance/census operations stay excluded, never become a runner.
  assert.equal(formatAgentHints("npm run clean"), "internal implementation operation (not an agent command)");
});
test("negative references reject every removed consumer reference class", t => {
  const root = mkdtempSync(join(tmpdir(), "bad-installed-instructions-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "SKILL.md"), tools = registrations();
  assert.throws(() => agentHint("psx_residual_objective", { functionName: 123 }), /invalid.*value/);
  for (const [text, error] of [["make check-all", /Make/], ["npx tsx tools/agent/diffFunc.ts fixture", /invocation/], ["tools/build/pipeline.ts", /missing project/], [".pi/skills/psx-decompile-function/SKILL.md", /missing project/], ["[resource](../missing.md)", /resource link/], ["psx_nonexistent({})", /unregistered/], ['psx_residual_objective({functionName: "fixture", nonexistent: true})', /invalid/], ["psx_residual_objective({})", /missing.*parameter/], ['psx_residual_objective({functionName: 123})', /invalid.*value/], ['psx_residual_objective({functionName: "fixture", block: "wrong"})', /invalid.*value/]] as const) assert.throws(() => inspectInstructionReferences(text, file, root, tools), error);
});
