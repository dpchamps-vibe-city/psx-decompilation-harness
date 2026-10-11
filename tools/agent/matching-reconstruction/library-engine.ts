import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../../lib/runtimeContext.js";
import { requireLibraryFunction } from "../../lib/libraryTargets.js";
import { libraryContext } from "../../lib/project.js";
import { configuredFlags } from "../../lib/toolchain.js";
import { compareFunction } from "../../lib/functionOracle.js";
import { relocatableFunctionWords } from "../../lib/relocatableFunctionOracle.js";
import { compileSource, detectImplicitDeclarations, loadFlagOverrides, rejectionFromDiagnostics } from "../decompToolchain.js";
import { computeProvenance, stableJson, stamped, writeStableJson } from "../provenance.js";
import { decodeFunctionWords } from "./decode.js";
import { executeFunction, UnsupportedTarget } from "./exec.js";
import { constructEffectCandidates, constructGuardedCandidates, fitStraightLineEffects } from "./effect-construct.js";
import { constructControlFlowCandidates } from "./control-structure.js";
import { recognizeBiosVeneer, describeBiosVeneer } from "./bios-veneer.js";
import { targetFeatures, type FailureCategory } from "./failure-category.js";
import { ArtifactRecorder } from "./result-contract.js";
import { contextMode, warmContextAllowed } from "./context-mode.js";
import type { ConstructionContext } from "./construction-context.js";
import { MATCHING_RECONSTRUCTION_SCHEMA_VERSION, type CandidateOutcome, type ResultBundle } from "./types.js";
import type { ReconstructOptions } from "./engine.js";

/** Initial ET_REL reconstruction domain: call-free integer relations over
 * arguments/pointer storage and resolved in-function control transfers.
 * Symbolic storage/calls are capability refusals, never fake linked addresses.
 * Exact means the SAME whole-member oracle used by library finalization. */
export function reconstructLibraryFunction(options: ReconstructOptions): ResultBundle {
  const started = Date.now();
  const { member, fn, key } = requireLibraryFunction(options.functionName);
  const flags = libraryContext(member.id);
  const overrides = options.ignoreFlagOverrides ? undefined : loadFlagOverrides().get(member.id);
  const directory = options.outputDirectory ?? join(projectRoot(), "build/matchingReconstruction", key);
  mkdirSync(directory, { recursive: true });
  const artifacts = new ArtifactRecorder(directory);
  const notify = options.notify ?? ((line: string) => console.error(line));
  const bundle: ResultBundle = {
    schemaVersion: MATCHING_RECONSTRUCTION_SCHEMA_VERSION, functionName: key, containerId: member.id,
    coordinate: { kind: "section", section: fn.section, offset: fn.offset, size: fn.size, inferredSize: fn.inferredSize },
    verification: { scope: "translation-unit", mode: "relocatable-object" }, sizeBytes: fn.size,
    state: "tool-failure", candidates: [], artifacts: { files: {} }, compiles: 0, wallMs: 0,
    contextMode: contextMode(), inputsRead: [member.input, "project.json", "toolchain.json"],
    build: { containerKind: "library", cc1Flags: [...configuredFlags("cc1", flags), ...(overrides ?? [])],
      ...(overrides ? { overrideFlags: overrides } : {}) },
  };
  const refuse = (state: NonNullable<ResultBundle["unresolved"]>["state"], category: FailureCategory, detail: string, offsets: number[] = []) => {
    bundle.state = state;
    bundle.unresolved = { state, category, detail,
      ...(offsets.length ? { coordinates: offsets.map(offset => ({ section: fn.section, offset })) } : {}) };
  };
  const finish = () => {
    bundle.wallMs = Date.now() - started;
    bundle.artifacts = artifacts.manifest();
    const provenance = computeProvenance(key, {
      files: [member.input, "project.json", "toolchain.json", "configs/flag_overrides.mk"],
      values: { memberHash: member.sha256, coordinate: bundle.coordinate, build: bundle.build,
        contextMode: contextMode(), maxCandidates: options.maxCandidates, exhaustive: options.exhaustive },
      implementation: ["tools/agent/matching-reconstruction"],
    });
    writeStableJson(join(directory, "result.json"), stamped(bundle, provenance));
    return bundle;
  };
  try {
    const insns = decodeFunctionWords(relocatableFunctionWords(member.object, fn.name));
    bundle.features = targetFeatures(insns);
    bundle.partialFacts = { features: bundle.features, notes: [
      "Instruction locations are section offsets, not VRAM. No linked-image context was loaded.",
      "Function-local matches are diagnostic only; whole-member bytes, symbols and relocations decide exactness.",
    ] };
    artifacts.write("target.json", stableJson({ functionName: key, coordinate: bundle.coordinate, insns, features: bundle.features }));
    const bios = recognizeBiosVeneer(insns);
    if (bios) { refuse("unsupported-target", "bios-veneer", describeBiosVeneer(bios), [bios.transferOffset]); return finish(); }

    const unsupportedRelocations = insns.filter(insn => insn.relocations?.some(relocation =>
      !["R_MIPS_26", "R_MIPS_PC16"].includes(relocation.type) || relocation.targetOffset === undefined || insn.op === "jal"));
    if (unsupportedRelocations.length) {
      refuse("context-unresolved", "symbolic-relocation",
        "ET_REL symbolic storage/callee relocation execution is not implemented in this reconstruction domain: " +
        unsupportedRelocations.flatMap(insn => insn.relocations!.map(r => `${r.type} ${r.reference}`)).slice(0, 8).join(", ") +
        ". Relocation fields have not been interpreted as linked addresses.", unsupportedRelocations.map(insn => insn.vram));
      return finish();
    }
    if (bundle.features.hasCalls) {
      refuse("context-unresolved", "callee-signature-unknown", "ET_REL call reconstruction requires symbolic callee/signature evidence; linked-address inference is unavailable.");
      return finish();
    }
    let executed;
    try { executed = executeFunction(insns); }
    catch (error) {
      if (!(error instanceof UnsupportedTarget)) throw error;
      refuse("unsupported-target", error.category, error.reason, error.vram);
      return finish();
    }
    const context: ConstructionContext = { kind: "library", id: member.id, symbolIndex: { byAddress: new Map(), addresses: [] } };
    const root = executed.arena.node(executed.root);
    let constructed;
    if (root.kind === "leaf") {
      const relation = fitStraightLineEffects(root.value, root.effects);
      if ("unfit" in relation) { refuse("unsupported-target", "relation-unfit", relation.unfit); return finish(); }
      bundle.effectRelation = relation;
      constructed = constructEffectCandidates(fn.name, relation, executed.loads, context);
    } else {
      constructed = constructGuardedCandidates(fn.name, executed.arena, executed.root, executed.loads, context, executed.maskWitnesses);
      if ("invalid" in constructed) constructed = constructControlFlowCandidates(fn.name, executed.arena, executed.root, executed.loads, context);
    }
    if ("unresolved" in constructed) { refuse("context-unresolved", "no-origin-evidence", constructed.unresolved); return finish(); }
    if ("invalid" in constructed) { refuse("unsupported-target", "structure-unsupported", constructed.invalid); return finish(); }
    const sources = warmContextAllowed() ? constructed : constructed.filter(candidate => !candidate.label.endsWith("-umbrella"));
    let best: { outcome: CandidateOutcome; source: string; integrationPlan: string[]; residual: number } | undefined;
    for (const [index, candidate] of sources.entries()) {
      if (bundle.candidates.length >= (options.maxCandidates ?? sources.length)) break;
      if (bundle.winner && !options.exhaustive) break;
      const id = `${String(index).padStart(3, "0")}-${candidate.label}`;
      const sourcePath = artifacts.write(join("candidates", `${id}.c`), candidate.source);
      const outcome: CandidateOutcome = { id, choice: {} as CandidateOutcome["choice"], sourcePath, verdict: "error" };
      try {
        const compiled = compileSource(sourcePath, join(directory, "candidates", id), key, {
          assemble: true, useOverrides: !options.ignoreFlagOverrides, containerKind: "library", containerId: member.id,
        });
        bundle.compiles++;
        const implicit = detectImplicitDeclarations(readFileSync(compiled.preprocessed, "utf8"), fn.name);
        const rejection = rejectionFromDiagnostics(compiled.diagnostics);
        if (implicit.length || rejection) throw new Error(implicit.length ? `implicit declarations: ${implicit.join(", ")}` : `invalid C: ${rejection}`);
        const oracle = compareFunction(key, { objectPath: compiled.object! });
        if (!oracle.verification || oracle.verification.scope !== "translation-unit") throw new Error("ET_REL whole-member verification unavailable");
        outcome.memberVerification = { verdict: oracle.verification.verdict, differences: oracle.verification.differences };
        outcome.verdict = oracle.verdict === "stub" || oracle.verification.verdict === "stub" ? "error"
          : oracle.verdict === "undetermined" || oracle.verification.verdict === "undetermined" ? "undetermined"
          : oracle.verdict === "match" && oracle.verification.verdict === "match" ? "match" : "mismatch";
        outcome.matchedWords = oracle.same;
        outcome.totalWords = Math.max(oracle.targetWords.length, oracle.candidateWords.length);
        outcome.differingCount = oracle.differing.length;
        outcome.differingCoordinates = oracle.differing.slice(0, 16).map(offset => ({ section: fn.section, offset }));
        if (outcome.verdict === "match") {
          bundle.winner = { ...outcome, source: candidate.source, integrationPlan: candidate.integrationPlan };
          artifacts.write("winner.c", candidate.source);
        } else if (outcome.verdict === "mismatch") {
          const residual = oracle.differing.length + oracle.verification.differences.length;
          if (!best || residual < best.residual) best = { outcome, source: candidate.source, integrationPlan: candidate.integrationPlan, residual };
        }
        notify(`  ${id}: ${outcome.verdict} (function ${oracle.same}/${outcome.totalWords}, whole-member ${oracle.verification.verdict})`);
      } catch (error) {
        outcome.compileError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        notify(`  ${id}: error (${outcome.compileError})`);
      }
      bundle.candidates.push(outcome);
    }
    if (bundle.winner) bundle.state = "exact-candidate";
    else if (bundle.candidates.length < sources.length) refuse("budget-exhausted", "budget-exhausted", `${sources.length - bundle.candidates.length} candidates remain unevaluated`);
    else if (bundle.candidates.length && bundle.candidates.every(c => c.verdict === "error")) refuse("tool-failure", "tool-failure", "No candidate reached the ET_REL oracle; inspect preserved compile errors.");
    else if (bundle.candidates.some(c => c.verdict === "undetermined") && !bundle.candidates.some(c => c.verdict === "mismatch")) refuse("oracle-undetermined", "oracle-undetermined", "Whole-member relocation comparison was undetermined; no exact candidate is established.");
    else refuse("domain-exhausted", "domain-exhausted", `All ${bundle.candidates.length} candidates in the bounded call-free ET_REL domain were evaluated without a whole-member match.`);
    if (best) {
      bundle.bestEffort = { ...best.outcome, source: best.source, integrationPlan: best.integrationPlan,
        diffSummary: `function ${best.outcome.matchedWords}/${best.outcome.totalWords} words; whole-member ${best.outcome.memberVerification?.verdict}` };
      artifacts.write("best-effort.c", best.source);
    }
    return finish();
  } catch (error) {
    refuse("tool-failure", "tool-failure", error instanceof Error ? error.message : String(error));
    return finish();
  }
}
