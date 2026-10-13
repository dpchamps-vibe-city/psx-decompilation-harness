import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { BASELINE_LABEL, CURRENT_SOURCE_LABEL, concludeMatrix, probeSourceStatus, renderProbe, type FlagMatrixRow, type ProbeResult } from "./flagProbe.js";
import { symbolicSelfClobberPairs } from "./triage.js";

const stub = '#include "include_asm.h"\nINCLUDE_ASM("original/member", StopRCnt);\n';
const candidate = "long StopRCnt(unsigned long counter) { return 1; }\n";

test("flag probe does not treat an INCLUDE_ASM baseline as candidate C", () => {
    assert.equal(probeSourceStatus(stub, "StopRCnt"), "assembly-stub");
    assert.equal(probeSourceStatus(undefined, "StopRCnt"), "missing");
    assert.equal(probeSourceStatus(candidate, "StopRCnt"), "c-candidate");
});

test("flag probe uses the selected symbol, not a neighbor's backlog", () => {
    assert.equal(probeSourceStatus(candidate + 'INCLUDE_ASM("original/member", ResetRCnt);\n', "StopRCnt"), "c-candidate");
});

test("flag probe AST ignores assembly mentions in comments, strings and disabled blocks", () => {
    for (const suffix of [
        '// INCLUDE_ASM("original/member", StopRCnt);\n',
        'const char *note = "INCLUDE_ASM(original, StopRCnt)";\n',
        '#if 0\nINCLUDE_ASM("original/member", StopRCnt);\n#endif\n',
    ]) assert.equal(probeSourceStatus(candidate + suffix, "StopRCnt"), "c-candidate");
});

test("triage sees ET_REL symbolic fixups in original-word views, regardless of register spelling", () => {
    for (const register of ["a1", "$5"]) {
        const words = [`lui ${register},%hi(.data@0)`, `lw ${register},%lo(.data@0)(${register})`];
        assert.deepEqual(symbolicSelfClobberPairs(words), [words.join("  /  ")]);
    }
});

test("triage does not manufacture symbolic self-clobbers from numeric fields or different webs", () => {
    for (const words of [
        ["lui a1,0", "lw a1,0(a1)"],
        ["lui a1,%hi(.data@0)", "lw a1,%lo(.data@0+4)(a1)"],
        ["lui a1,%hi(.data@0)", "lw v0,%lo(.data@0)(a1)"],
        ["lui a1,%hi(.data@0)", "lw a1,%lo(.data@0)(v0)"],
        ["lui a1,%hi(.data@0)", "nop", "lw a1,%lo(.data@0)(a1)"],
    ]) assert.deepEqual(symbolicSelfClobberPairs(words), []);
});

const fingerprint = { kind: "self-clobber-shape" as const, detail: "original symbolic lui/lw", candidates: ["-fno-schedule-insns2"] };
function row(source: string, label: string, masked: number): FlagMatrixRow {
    return { source, label, flags: label, masked, instructions: 13, targetInstructions: 13 };
}

test("selected scratch C, not a perfect assembly-backed live source, owns the conclusion", () => {
    const sourceLabel = "build/candidate.c";
    const result = concludeMatrix({ sourceLabel, fingerprints: [fingerprint], rows: [
        row(CURRENT_SOURCE_LABEL, BASELINE_LABEL, 13),
        row(CURRENT_SOURCE_LABEL, "-fno-schedule-insns2", 13),
        row(sourceLabel, BASELINE_LABEL, 10),
        row(sourceLabel, "-fno-schedule-insns2", 13),
    ] });
    assert.equal(result.conclusion, "supported");
    assert.deepEqual(result.dominantRows, ["-fno-schedule-insns2"]);
});

test("advisory candidate rows cannot manufacture a baseline for an unmeasured stub", () => {
    const result = concludeMatrix({ sourceLabel: CURRENT_SOURCE_LABEL, fingerprints: [fingerprint], rows: [
        row("build/candidate.c", BASELINE_LABEL, 10),
        row("build/candidate.c", "-fno-schedule-insns2", 13),
    ] });
    assert.equal(result.conclusion, "inconclusive");
    assert.deepEqual(result.dominantRows, []);
});

test("candidate-only render identifies selected source and does not claim a live-stub matrix", () => {
    const sourceLabel = "build/candidate.c";
    const result: ProbeResult = { info: { vram: 0x104, size: 52 }, nearby: [], report: {
        schemaVersion: 1, function: "StopRCnt", sourceHash: "candidate-hash", sourcePath: sourceLabel, sourceLabel, sourceStatus: "c-candidate",
        targetHash: "target", toolchainHash: "compiler", fingerprints: [fingerprint],
        matrix: [row(sourceLabel, BASELINE_LABEL, 10)], conclusion: "inconclusive", dominantRows: [], reasons: [], candidates: [],
    } };
    const text = renderProbe(result);
    assert.match(text, /Selected source: build\/candidate\.c \(c-candidate\)/);
    assert.match(text, /10\/13 masked/);
    assert.doesNotMatch(text, /13\/13 masked|Flag matrix on current src/);
});

test("advisory-only render does not call its candidate the selected source", () => {
    const result: ProbeResult = { info: { vram: 0x104, size: 52 }, nearby: [], report: {
        schemaVersion: 1, function: "StopRCnt", sourceHash: null, sourceLabel: CURRENT_SOURCE_LABEL, sourceStatus: "assembly-stub",
        targetHash: "target", toolchainHash: "compiler", fingerprints: [fingerprint],
        matrix: [row("build/advisory.c", BASELINE_LABEL, 10)], conclusion: "inconclusive", dominantRows: [], reasons: [], candidates: [],
    } };
    const text = renderProbe(result);
    assert.match(text, /Only advisory sources were scored/);
    assert.match(text, /Pass --src <candidate\.c>/);
    assert.doesNotMatch(text, /Only the selected source was scored|Flag matrix on current src/);
});
