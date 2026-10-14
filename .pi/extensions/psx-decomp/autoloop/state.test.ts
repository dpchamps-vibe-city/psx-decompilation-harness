import assert from "node:assert/strict";
import { test } from "../../../../tools/testing/runtimeTestContext.js";
import { DEFAULT_CONFIG } from "../../shared/config.ts";
import { emptyState, withLoopExemptions } from "./state.ts";
import { KEEP_GOING, escalationMessage, nudgeMessage, openingMessage, rejectionReport, reviewMessage } from "./prompts.ts";

test("a parked function is exempted from the include-asm rule, and nothing else is", () => {
  const state = emptyState();
  state.parked.func_80012345 = {
    functionName: "func_80012345",
    reason: "escalation-exhausted",
    parkedAt: "2026-08-09T00:00:00.000Z",
    reachedTier: "gpt-5.6-sol",
    lastReport: "",
    findings: [],
  };
  const config = withLoopExemptions(DEFAULT_CONFIG, state);
  assert.deepEqual(config.sourcePolicy.allowlist.func_80012345, ["include-asm"]);
  assert.equal(config.sourcePolicy.allowlist.func_80099999, undefined);
});

test("an agent-approved exemption is honoured by the loop and merged with existing entries", () => {
  const state = emptyState();
  state.approvals.func_80012345 = {
    functionName: "func_80012345",
    kinds: ["embedded-asm"],
    approvedAt: "2026-08-09T00:00:00.000Z",
    approvedBy: "gpt-5.6-sol",
    rationale: "documented exception class",
  };
  const base = {
    ...DEFAULT_CONFIG,
    sourcePolicy: { ...DEFAULT_CONFIG.sourcePolicy, allowlist: { func_80012345: ["register-asm"] } },
  };
  const config = withLoopExemptions(base, state);
  assert.deepEqual(config.sourcePolicy.allowlist.func_80012345.sort(), ["embedded-asm", "register-asm"]);
});

test("loop exemptions never mutate the config they were derived from", () => {
  const state = emptyState();
  state.parked.func_80012345 = {
    functionName: "func_80012345",
    reason: "escalation-exhausted",
    parkedAt: "2026-08-09T00:00:00.000Z",
    reachedTier: "kimi-k3",
    lastReport: "",
    findings: [],
  };
  withLoopExemptions(DEFAULT_CONFIG, state);
  assert.deepEqual(DEFAULT_CONFIG.sourcePolicy.allowlist, {});
});

test("the first tier opens a fresh decompilation and every later tier resumes the attempt", () => {
  assert.match(openingMessage("func_80012345"), /Mode: fresh decompilation/);
  assert.match(escalationMessage("func_80012345", "kimi-k3", "report"), /Mode: resume\/fix/);
  assert.match(escalationMessage("func_80012345", "kimi-k3", "report"), /you are now kimi-k3/);
});

test("every non-matching return carries the same nudge", () => {
  assert.ok(nudgeMessage("report").startsWith(KEEP_GOING));
  assert.ok(escalationMessage("func_80012345", "kimi-k3", "report").includes(KEEP_GOING));
  /* The nudge states the four-step protocol, not just encouragement: a turn told
   * only to keep going spends its context reasoning forward from the last
   * report instead of producing a measurement. */
  assert.doesNotMatch(KEEP_GOING, /there is clean C that matches this function 100%/);
  assert.match(KEEP_GOING, /Do not assume every original target has a clean-C expression/);
  assert.match(KEEP_GOING, /no per-macro human approval/);
  assert.match(KEEP_GOING, /One experiment is one edit and one measurement/);
  /* "Turn" is the harness's word for one assistant response. Using it for a
   * loop iteration told an agent it owed exactly one measurement per response,
   * and it stopped after one. The pacing words must never say "turn". */
  assert.doesNotMatch(KEEP_GOING, /\bturn\b/i);
  for (const step of ["OBSERVE", "HYPOTHESISE", "ACT", "MEASURE"]) {
    assert.match(KEEP_GOING, new RegExp(step), `the nudge must name the ${step} step`);
  }
});

test("the opening message carries the protocol, because the nudge may never fire", () => {
  /* `nudgeMessage` is sent from the second return onward. With returnsPerTier
   * at 1 it never fires, so the opening message is the only thing an agent
   * reads — and a protocol that lives only in the nudge is read by nothing. */
  const opening = openingMessage("func_80012345");
  assert.match(opening, /Work toward byte identity/);
  assert.match(opening, /configs\/macro-evidence\.json/);
  assert.match(opening, /no per-macro human approval/);
  assert.match(opening, /back to back/);
  assert.match(opening, /psx_residual_objective/);
  assert.doesNotMatch(opening, /This turn runs/);
});

test("policy review cannot substitute an approval or a clean-C promise for macro evidence", () => {
  const findings = [{ kind: "platform-macro", file: "include/operations.h", message: "missing proof" }];
  const review = reviewMessage("target", findings), rejection = rejectionReport("target", findings, "missing original witnesses");
  assert.match(review, /not per-macro approval/);
  assert.match(review, /not waived here/);
  assert.doesNotMatch(rejection, /The remaining divergence has a clean-C expression/);
  assert.match(rejection, /without per-macro approval/);
  assert.match(rejection, /does not prove/);
});
