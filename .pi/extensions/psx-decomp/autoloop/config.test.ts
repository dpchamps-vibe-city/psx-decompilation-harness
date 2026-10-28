import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "../../../../tools/testing/runtimeTestContext.js";
import { DEFAULT_CHECKPOINT_AT_TOKENS, DEFAULT_LADDER, loadLoopConfig, parseLadder, parseSubagents } from "./config.ts";
import { parseArgs } from "./commands.ts";
import { loadConfig } from "../../shared/config.ts";

test("the default ladder escalates local -> openrouter -> codex with the configured thinking levels", () => {
  assert.deepEqual(
    DEFAULT_LADDER.map((tier) => `${tier.provider}/${tier.model}:${tier.thinking}`),
    [
      "qwen36-llama/qwen3.6-27b:medium",
      "openrouter/deepseek/deepseek-v4-flash-0731:xhigh",
      // "openrouter/moonshotai/kimi-k3:high",
      "openai-codex/gpt-5.6-sol:xhigh",
    ],
  );
});

test("a ladder entry must name a provider, a model, and a known thinking level", () => {
  assert.throws(() => parseLadder([]), /non-empty/);
  assert.throws(() => parseLadder([{ model: "m" }]), /provider/);
  assert.throws(() => parseLadder([{ provider: "p" }]), /model/);
  assert.throws(() => parseLadder([{ provider: "p", model: "m", thinking: "turbo" }]), /thinking/);
  assert.throws(() => parseLadder([{ provider: "p", model: "m", speed: 1 }]), /unknown field/);
});

test("a ladder entry defaults its label to the model id and its thinking to high", () => {
  assert.deepEqual(parseLadder([{ provider: "p", model: "m" }]), [
    { provider: "p", model: "m", thinking: "high", label: "m", checkpointAtTokens: 350_000 },
  ]);
});

test("prep is opt-in and must hand off to a matching tier", () => {
  const ladder = [{ provider: "p", model: "m", role: "prep" }, { provider: "p", model: "m" }];
  assert.equal(parseLadder(ladder)[0].role, "prep");
  assert.equal(parseLadder(ladder)[1].role, undefined);
  for (const role of ["solver", "", null, 1]) {
    assert.throws(() => parseLadder([{ provider: "p", model: "m", role }]), /role/);
  }
  const invalid = projectWith({ ladder: ladder.slice(0, 1), singleTier: true });
  try { assert.throws(() => loadLoopConfig(invalid.dir), /later matching tier/); }
  finally { invalid.cleanup(); }
});

function projectWith(config: Record<string, unknown>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-config-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "autoloop.json"), JSON.stringify(config));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("checkpoint thresholds default to 350k and are independent for each ladder agent", () => {
  assert.equal(DEFAULT_CHECKPOINT_AT_TOKENS, 350_000);
  assert.ok(DEFAULT_LADDER.every((tier) => tier.checkpointAtTokens === 350_000));
  const { dir, cleanup } = projectWith({ ladder: [
    { provider: "p", model: "small", checkpointAtTokens: 120_000 },
    { provider: "p", model: "large", checkpointAtTokens: 350_000 },
    { provider: "p", model: "off", checkpointAtTokens: 0 },
    { provider: "p", model: "default" },
  ] });
  try {
    const config = loadLoopConfig(dir);
    assert.deepEqual(config.ladder.map((tier) => tier.checkpointAtTokens), [120_000, 350_000, 0, 350_000]);
    assert.equal("compactAtTokens" in config, false);
  } finally { cleanup(); }
});

test("bad checkpoint thresholds and unsafe 10% grace limits are refused", () => {
  for (const bad of [-1, 1.5, "350k", null, NaN, Infinity]) {
    assert.throws(() => parseLadder([{ provider: "p", model: "m", checkpointAtTokens: bad }]),
      /ladder\[0\].checkpointAtTokens must be a non-negative integer/);
  }
  assert.throws(() => parseLadder([{ provider: "p", model: "m", checkpointAtTokens: Number.MAX_SAFE_INTEGER }]),
    /safe integer including its 10% grace/);
});

test("the removed top-level ceiling reports how to migrate", () => {
  const { dir, cleanup } = projectWith({ compactAtTokens: 350_000 });
  try { assert.throws(() => loadLoopConfig(dir), /compactAtTokens has moved.*checkpointAtTokens.*ladder entry/); }
  finally { cleanup(); }
});

test("an unknown autoloop config field is refused rather than ignored", () => {
  const { dir, cleanup } = projectWith({ compactAt: 350_000 });
  try {
    assert.throws(() => loadLoopConfig(dir), /unknown field/);
  } finally {
    cleanup();
  }
});

test("command arguments select a target, a limit, or a subcommand", () => {
  assert.deepEqual(parseArgs(""), { action: "run" });
  assert.deepEqual(parseArgs("  "), { action: "run" });
  assert.deepEqual(parseArgs("status"), { action: "status" });
  assert.deepEqual(parseArgs("stop"), { action: "stop" });
  assert.deepEqual(parseArgs("func_80012345"), { action: "run", target: "func_80012345" });
  assert.deepEqual(parseArgs("archive_33::entry"), { action: "run", target: "archive_33::entry" });
  assert.deepEqual(parseArgs("func_80012345 --max=3"), { action: "run", target: "func_80012345", maxFunctions: 3 });
  assert.deepEqual(parseArgs("--max-functions=7"), { action: "run", maxFunctions: 7 });
  assert.equal(parseArgs("func_1 func_2").action, "usage");
  assert.equal(parseArgs("--max=0").action, "usage");
  assert.equal(parseArgs("--nonsense").action, "usage");
});

test("optional subagents reuse ladder model parsing; both strict config readers accept controller mode", () => {
  const model = { provider: "p", model: "worker", thinking: "low", checkpointAtTokens: 120_000, label: "worker-label" };
  assert.equal(parseSubagents(undefined), undefined);
  assert.deepEqual(parseSubagents({ quantity: 3, model })?.model, parseLadder([model])[0]);
  for (const key of ["subagents", "subgents"]) {
    const project = projectWith({ [key]: { quantity: 3, model } });
    try {
      assert.equal(loadLoopConfig(project.dir).subagents?.quantity, 3);
      assert.doesNotThrow(() => loadConfig(project.dir));
    } finally { project.cleanup(); }
  }
});

test("controller configuration rejects malformed, ambiguous and unsupported requests", () => {
  const model = { provider: "p", model: "m" };
  for (const bad of [null, false, [], "yes", {}, { quantity: 1 }, { quantity: 0, model }, { quantity: 1.5, model },
    { quantity: Number.MAX_SAFE_INTEGER + 1, model }, { quantity: 1, model: { ...model, speed: 1 } }, { quantity: 1, model, extra: true }]) {
    assert.throws(() => parseSubagents(bad), /subagents/);
  }
  for (const config of [{ subagents: null }, { subagents: { quantity: 1, model }, subgents: { quantity: 1, model } }]) {
    const project = projectWith(config);
    try { assert.throws(() => loadLoopConfig(project.dir), /subagents|subgents|autoFold/); }
    finally { project.cleanup(); }
  }
});

test("subagent fan-out preserves auto-fold and accepts the same model roles as the ladder", () => {
  for (const key of ["subagents", "subgents"]) {
    const project = projectWith({ [key]: { quantity: 3, model: { provider: "p", model: "m", role: "prep" } }, autoFold: true });
    try {
      const config = loadLoopConfig(project.dir);
      assert.equal(config.autoFold, true);
      assert.equal(config.subagents?.quantity, 3);
      assert.equal(config.subagents?.model.role, "prep");
    } finally { project.cleanup(); }
  }
});

test("auto-fold is off unless a project turns it on", () => {
  const off = projectWith({ ladder: [{ provider: "p", model: "m" }], singleTier: true }), on = projectWith({ ladder: [{ provider: "p", model: "m" }], singleTier: true, autoFold: true });
  try {
    assert.equal(loadLoopConfig(off.dir).autoFold, false);
    assert.equal(loadLoopConfig(on.dir).autoFold, true);
  } finally { off.cleanup(); on.cleanup(); }
});
