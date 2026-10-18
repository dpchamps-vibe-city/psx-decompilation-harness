import { test } from "./runtimeTestContext.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HARNESS_ROOT } from "../lib/runtimeContext.js";
import { snapshot } from "../lib/contentCache.js";
import { assertInstructionSnapshot, descriptionSpans, inspectInstructionReferences, readInstructionSnapshot } from "./instructionContracts.js";

const host = process.env.PSX_PI_085_HOST, pkg = process.env.PSX_PRODUCTION_PACKAGE;
const options = { skip: !host || !pkg ? "Run with the production-only package and Pi 0.85.1 host" : false };
async function consumer(t: any) {
  assert.equal(JSON.parse(readFileSync(resolve(dirname(host!), "../package.json"), "utf8")).version, "0.85.1");
  const root = mkdtempSync(join(tmpdir(), "installed-consumer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [resolve(dirname(host!), "cli.js"), "install", "--local", pkg!], { cwd: root, stdio: "pipe" });
  const sdk = await import(pathToFileURL(host!).href);
  const agentDir = join(root, "build/isolated-agent"), settingsManager = sdk.SettingsManager.create(root, agentDir);
  settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true, noThemes: true, noPromptTemplates: true });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  const tools = new Map<string, any>();
  for (const extension of loader.getExtensions().extensions) for (const [name, tool] of extension.tools) {
    assert.ok(!tools.has(name), `duplicate provided tool ${name}`); tools.set(name, tool.definition);
  }
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory() });
  t.after(() => session.dispose());
  async function invoke(name: string, parameters: any, cwd = root) {
    const info = session.getAllTools().find((tool: any) => tool.name === name);
    assert.ok(info?.sourceInfo?.path?.startsWith(resolve(pkg!) + "/"), `not an installed-package tool: ${name}`);
    const definition = session.extensionRunner.getToolDefinition(name);
    const result = await definition.execute("consumer-acceptance", parameters, new AbortController().signal, undefined, { ...session.extensionRunner.createContext(), cwd, model: undefined });
    assert.notEqual(result.isError, true); return result;
  }
  return { root, loader, tools, invoke };
}
function assertNoCopies(root: string) {
  for (const path of ["AGENTS.md", "tools/agent", "tools/build", "tools/lib", "tools/vendor", ".pi/extensions", ".pi/skills", "prompts/reference"]) assert.equal(existsSync(join(root, path)), false, path);
  if (existsSync(join(root, "package.json"))) {
    const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) assert.equal(p.dependencies?.[name], undefined);
  }
}
for (const mode of ["exe", "library"] as const) test(`Pi 0.85.1 production-only ${mode} consumer bootstraps and runs installed tooling`, options, async t => {
  const f = await consumer(t), before = snapshot(pkg!, [pkg!]);
  await assert.rejects(f.invoke("psx_reference", {}), /psx-bootstrap-project/);
  await f.invoke("psx_bootstrap_project", { mode });
  await f.invoke("psx_prepare_tooling", {});
  assertNoCopies(f.root);
  mkdirSync(join(f.root, "src"), { recursive: true }); writeFileSync(join(f.root, "src/check.c"), "void check(void) {}\n");
  const guard = await f.invoke("psx_c_source_guard", { paths: ["src/check.c"] });
  assert.equal(JSON.parse(guard.content[0].text).parses, true);
  assert.deepEqual(snapshot(pkg!, [pkg!]), before, "installed package is immutable");
});
test("actual installed skills/descriptions resolve in the prepared consumer and accept a project parser without package mutation", options, async t => {
  const f = await consumer(t), before = snapshot(pkg!, [pkg!]);
  await f.invoke("psx_bootstrap_project", {});
  const base = join(f.root, "tools/resource-parsers");
  writeFileSync(join(base, "fixture.ts"), `import type { AssetParser } from "psx-decompilation-harness/resource-parsers";
export const FIXTURE: AssetParser = { id: "fixture-v1", format: "Fixture", version: 1,
 probe: (b,o) => o+5<=b.length && b.toString("ascii",o,o+4)==="FTR1",
 parse: (b,o) => { if(o+5>b.length||b.toString("ascii",o,o+4)!=="FTR1"||o+5+b[o+4]!>b.length)throw new Error("invalid");return {length:5+b[o+4]!,metadata:{}}; },
 variants: () => [{}],decode: (b,_v,m) => {if(b.length>m)throw new Error("budget");return [{kind:"raw",extension:"bin",stage:"export",bytes:b,metadata:{}}];} };
`);
  // Validate resources against their actual installed locations, not the checkout.
  const baseline = readInstructionSnapshot(HARNESS_ROOT);
  assertInstructionSnapshot(pkg!, baseline, { projectGuide: false });
  for (const row of baseline.rows) {
    if (row.file === "AGENTS.md") continue; /* Not copied into consumers. */
    const file = join(pkg!, row.file), text = readFileSync(file, "utf8");
    inspectInstructionReferences(row.descriptionsOnly ? descriptionSpans(text).join("\n") : text, file, f.root, f.tools);
  }
  for (const skill of f.loader.getSkills().skills) assert.ok(skill.filePath.startsWith(resolve(pkg!) + "/"));
  for (const tool of f.tools.values()) inspectInstructionReferences(tool.description, join(pkg!, "package.json"), f.root, f.tools);
  const prepared = JSON.parse((await f.invoke("psx_resource_parser", { action: "prepare" })).content[0].text);
  writeFileSync(join(base, "parser-plugins.ts"), 'import { FIXTURE } from "./fixture.ts";\nexport const EXTRA_PARSERS = [FIXTURE];\n');
  // A changed implementation and corresponding tests are required by admission.
  writeFileSync(join(base, "fixture.ts"), readFileSync(join(base, "fixture.ts"), "utf8") + "/* tested capability */\n");
  writeFileSync(join(base, "fixture.test.ts"), `import {test} from "node:test";import assert from "node:assert/strict";import {FIXTURE} from "./fixture.ts";
test("layout",()=>assert.equal(FIXTURE.parse(Buffer.from([70,84,82,49,2,0,0]),0).length,7));
test("truncated",()=>assert.throws(()=>FIXTURE.parse(Buffer.from([70,84,82,49,2]),0)));
test("budget",()=>assert.throws(()=>FIXTURE.decode(Buffer.alloc(7),{},1)));
`);
  const tested = JSON.parse((await f.invoke("psx_resource_parser", { action: "test", baseline: prepared.baseline })).content[0].text);
  assert.equal(tested.outcome, "tested", JSON.stringify(tested));
  const accepted = JSON.parse((await f.invoke("psx_resource_parser", { action: "accept", baseline: prepared.baseline })).content[0].text);
  assert.equal(accepted.outcome, "parser-tested");
  mkdirSync(join(f.root, "extracted"), { recursive: true }); writeFileSync(join(f.root, "extracted/resource"), Buffer.from([70,84,82,49,2,0,0]));
  const extracted = JSON.parse((await f.invoke("psx_resource_extract", {})).content[0].text); assert.equal(extracted.assets, 1);
  assertNoCopies(f.root); assert.deepEqual(snapshot(pkg!, [pkg!]), before);
});
