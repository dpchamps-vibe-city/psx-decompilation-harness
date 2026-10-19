import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, fixtureContext } from "../../../../tools/testing/runtimeTestContext.js";
import { libraryProjectFixture } from "../../../../tools/testing/libraryProjectFixture.js";
import { checkLibrary } from "../../../../tools/agent/libraryTarget.js";
import { libraryFunctionTarget } from "../../../../tools/lib/targetAdapter.js";
import { libraryMembers, requireLibraryFunction } from "../../../../tools/lib/libraryTargets.js";
import { clearLibraryReceipts, publishLibraryReceipt, validLibraryReceipt } from "./library-receipt.ts";
import type { GateResult } from "../../shared/types.ts";

/* The plan's negative controls (plans/optimization/01-finalization-window.md):
   every input a library verification rests on must invalidate its receipt, and
   a rewrite with identical bytes must not. */
test("a library receipt holds only while every verified input is unchanged", async t => {
  const f = libraryProjectFixture(t, 2);
  const quiet = t.mock.method(console, "log", () => {});
  try {
    await fixtureContext(f.root, async () => {
      clearLibraryReceipts();
      checkLibrary([], f.root);
      const members = libraryMembers(f.root), target = requireLibraryFunction(`${members[0]!.id}::${members[0]!.functions[0]!.name}`, f.root);
      const context = libraryFunctionTarget(target.member, target.fn, f.root).context;
      for (const path of [context.types, context.functions]) { mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), "/* published */\n"); }
      const gate = { pass: true, mode: "match", functionName: target.key, failures: [], checkedAt: new Date().toISOString(),
        diff: { functionName: target.key, matchedInstructions: 2, totalInstructions: 2, matchPercent: 100, verdict: "match", exact: true, instructionCountDelta: 0, output: "" },
        build: { command: "check", code: 0, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0 },
        contextPublication: { status: "published", skipped: false, signatureMatches: true, signatures: [], localPrototypes: [],
          command: { command: "export", code: 0, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0 } } } as unknown as GateResult;
      await publishLibraryReceipt(f.root, target.key, target, members, gate);
      const hit = async () => (await validLibraryReceipt(f.root, target.key, target, members)).gate !== undefined;
      assert.equal(await hit(), true, "unchanged inputs reuse the verification");

      const mutate = async (label: string, path: string, change: (text: string) => string) => {
        const absolute = join(f.root, path), original = readFileSync(absolute);
        writeFileSync(absolute, change(original.toString("utf8")));
        assert.equal(await hit(), false, `${label} must invalidate the receipt`);
        writeFileSync(absolute, original);
        assert.equal(await hit(), true, `${label}: the same bytes again are the same inputs`);
      };
      await mutate("a source edit", join(dirname(target.member.source), `${target.fn.name}.s`), text => text + "# edited\n");
      await mutate("an owned header edit", "include/owned.h", text => text + "/* edited */\n");
      await mutate("a toolchain edit", "toolchain.json", text => text.replace(/}\s*$/, ', "schemaVersion": 1 }'));
      await mutate("an input object change", members[1]!.input, text => text + "\0");
      await mutate("an accepted record edit", `build/libraries/verified/${members[1]!.id}.json`, text => text.replace("{", '{"edited":true,'));
      await mutate("a publication edit", context.functions, text => text + "/* stale */\n");
      rmSync(join(f.root, context.types));
      assert.equal(await hit(), false, "a deleted publication invalidates the receipt");
      writeFileSync(join(f.root, context.types), "/* published */\n");
      mkdirSync(join(f.root, ".pi"), { recursive: true });
      writeFileSync(join(f.root, ".pi/autoloop.json"), JSON.stringify({ sourcePolicy: { allowEmptyMemoryBarrier: false } }));
      assert.equal(await hit(), false, "a source-policy change invalidates the receipt");
      rmSync(join(f.root, ".pi/autoloop.json"));
      assert.equal(await hit(), true);
      assert.equal((await validLibraryReceipt(f.root, target.key, target, members.slice(0, 1))).gate, undefined, "another checked set is another verification");
      assert.equal((await validLibraryReceipt(join(f.root, "."), `${members[1]!.id}::${members[1]!.functions[0]!.name}`, target, members)).gate, undefined, "another function has no receipt");
      clearLibraryReceipts();
      assert.equal(await hit(), false, "receipts never cross functions");
    });
  } finally { quiet.mock.restore(); }
});
