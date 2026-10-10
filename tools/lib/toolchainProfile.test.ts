import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_TOOLCHAIN, detectToolchain, profileMatches } from "./toolchainProfile.ts";
import { projectFixture, SDK_BANNER } from "../testing/projectFixture.js";

test("a strategy declared for any toolchain matches every profile", () => {
  assert.equal(profileMatches(UNKNOWN_TOOLCHAIN, ["*"]), true);
  assert.equal(profileMatches({ ...UNKNOWN_TOOLCHAIN, id: "sn64" }, ["*"]), true);
});

test("a strategy declared for one toolchain matches only that one", () => {
  const psyq = { ...UNKNOWN_TOOLCHAIN, id: "psyq", verdict: "detected" as const };
  assert.equal(profileMatches(psyq, ["psyq"]), true);
  assert.equal(profileMatches({ ...psyq, id: "sn64" }, ["psyq"]), false);
  assert.equal(profileMatches(UNKNOWN_TOOLCHAIN, ["psyq"]), false);
});

test("an undetected profile matches no toolchain-specific strategy", () => {
  assert.equal(UNKNOWN_TOOLCHAIN.verdict, "undetermined");
  assert.equal(profileMatches(UNKNOWN_TOOLCHAIN, ["psyq", "sn64"]), false);
});

test("a fixture image detects its toolchain, and every observation names its source", (t) => {
  const { root } = projectFixture(t, { vendorString: SDK_BANNER + "\n$Id: sys.c,v 1.2 1997/08/01 $" });
  const profile = detectToolchain({ root, refresh: true });
  assert.equal(profile.verdict, "detected");
  assert.ok(profile.evidence.length > 0);
  for (const item of profile.evidence) {
    assert.ok(
      ["vendor-string", "project-config", "library-signatures"].includes(item.source),
      `unknown evidence source ${item.source}`
    );
    assert.ok(item.detail.length > 0, "every observation states what it saw");
  }
});

test("vendor evidence comes from image bytes, not the configured compiler", (t) => {
  const { root, put } = projectFixture(t, { vendorString: SDK_BANNER });
  const profile = detectToolchain({ root, refresh: true });
  assert.ok(
    profile.evidence.some((e) => e.source === "vendor-string" && e.toolchain !== undefined),
    "the binary must supply its own evidence, not only the project config"
  );
  // Same configured compiler, different bytes: config alone cannot identify it.
  const unknown = projectFixture(t);
  assert.equal(detectToolchain({ root: unknown.root, refresh: true }).verdict, "undetermined");
  // Cached detection must notice authoritative image changes too.
  put("extracted/FIXTURE.EXE", Buffer.alloc(0x800));
  assert.equal(detectToolchain({ root }).verdict, "undetermined");
});
