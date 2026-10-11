import { test } from "../../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixture } from "./test-fixtures.js";
import { projectParsers } from "./project-parsers.js";
import { executeResource } from "./pipeline.js";
import { prepareParserProject } from "./parser-builder.js";
const registryFile = fileURLToPath(new URL("./parser-plugins.ts", import.meta.url));
test("installed built-ins stay immutable while project plugins are prepared, discovered, updated and replayed", async () => {
  const f = fixture(), before = readFileSync(registryFile);
  try {
    prepareParserProject(f.root);
    f.put("tools/resource-parsers/parser-plugins.ts", 'import { FIXTURE } from "./fixture.ts";\nexport const EXTRA_PARSERS = [FIXTURE];\n');
    const code = `export const FIXTURE = { id: "fixture-v1", format: "Fixture", version: 1,
      probe: (b: Buffer, o: number) => b[o] === 250,
      parse: (b: Buffer, o: number) => { if (b[o] !== 250 || b[o+1] !== 2) throw Error("invalid"); return { length: 2, metadata: {} }; },
      variants: () => [{}], decode: (b: Buffer) => [{ kind: "raw", extension: "bin", stage: "export", bytes: b, metadata: {} }]
    };\n`;
    f.put("tools/resource-parsers/fixture.ts", code);
    f.put("extracted/test.bin", Buffer.from([250, 2]));
    const a = await projectParsers(f.root);
    assert.ok(a.registry.parsers.some(p => p.id === "fixture-v1"));
    assert.equal((await executeResource("extract", f.root)).resourceNodes, 1);
    assert.equal((await executeResource("verify", f.root)).outcome, "validated");
    prepareParserProject(f.root);
    assert.match(readFileSync(f.root + "/tools/resource-parsers/parser-plugins.ts", "utf8"), /FIXTURE/);
    f.put("tools/resource-parsers/fixture.ts", code.replace("version: 1", "version: 2"));
    const b = await projectParsers(f.root);
    assert.equal(b.registry.get("fixture-v1").version, 2);
    assert.notDeepEqual(a.fingerprints, b.fingerprints);
    await assert.rejects(executeResource("verify", f.root), /implementation drift/);
    assert.deepEqual(readFileSync(registryFile), before);
  } finally { f.cleanup(); }
});
