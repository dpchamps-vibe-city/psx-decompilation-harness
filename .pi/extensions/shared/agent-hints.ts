import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_SPECS } from "../psx-decomp/tools/diagnostics.js";

type Definition = Parameters<ExtensionAPI["registerTool"]>[0];
const definitions = new Map<string, Definition>();
export function rememberAgentTool(tool: Definition): void { definitions.set(tool.name, tool); }
export function agentHint(name: string, parameters: Record<string, unknown>): string {
  const definition = definitions.get(name);
  if (!definition) throw new Error(`Unregistered agent follow-up: ${name}`);
  const schema = definition.parameters as any;
  for (const key of Object.keys(parameters)) if (!schema.properties?.[key]) throw new Error(`${name}: unknown follow-up parameter ${key}`);
  for (const key of schema.required ?? []) if (!(key in parameters)) throw new Error(`${name}: missing follow-up parameter ${key}`);
  if (!Value.Check(schema, parameters)) throw new Error(`${name}: invalid follow-up parameter value`);
  return `${name}(${JSON.stringify(parameters)})`;
}
const commandTools = new Map(TOOL_SPECS.map(s => [s.script.replace(/\.ts$/, ""), s.name]));
for (const [script, tool] of Object.entries({ diffFunc: "psx_finalize_function", residualObjective: "psx_residual_objective", m2cFunc: "psx_m2c", callGraph: "psx_build_call_graph", classifyGlobals: "psx_classify_globals", deriveTuOwnedGlobals: "psx_derive_tu_globals", deriveRodataSplits: "psx_split_project", pipeline: "psx_split_project", inspectLocalAllocationVariant: "psx_inspect_local_allocation_variant", fingerprintWebPartition: "psx_compiler_trace", headerInfo: "psx_inspect_exe", identifyToolchain: "psx_identify_project", toolchain: "psx_identify_project", matchSignatures: "psx_match_sdk_signatures", overlayFlagFingerprint: "psx_inspect_container_abi", genProjectProfile: "psx_generate_project_profile", detectLibFunctions: "psx_prepare_sdk", extractArchive: "psx_extract_archive", progress: "psx_project_progress", bootstrap: "psx_split_project", solveOverlayBase: "psx_disassemble_project" })) commandTools.set(script, tool);
/** Presentation only: no command execution, aliases or interception. Human CLI
 * help stays in the implementation; provided-tool follow-ups use registrations. */
export function formatAgentHints(text: string): string {
  // CLI reports can contain next-step strings inside JSON. Preserve their shape;
  // recorded command/argv fields remain evidence, not agent recommendations.
  if (/^\s*[\[{]/.test(text)) {
    try {
      const report = JSON.parse(text);
      const format = (value: any, key = ""): any => ["command", "commands", "args", "argv", "operations"].includes(key) ? value :
        typeof value === "string" ? formatPlainHints(value) : Array.isArray(value) ? value.map(v => format(v)) :
          value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, format(v, k)])) : value;
      return JSON.stringify(format(report), null, 2);
    } catch { /* Non-JSON human output is formatted below. */ }
  }
  return formatPlainHints(text);
}
function formatPlainHints(text: string): string {
  return text.replace(/(?<![\w./])(?:npx\s+tsx\s+)?tools\/(?:agent|build|diagnostics)\/((?:[\w-]+\/)*[\w-]+)\.ts\b([^`\n]*)|\b(?:make|npm\s+run)\s+([\w-]+)([^`\n]*)/g,
    (_all, script, tail, makeTarget, makeTail) => {
      const taskTools: Record<string, string> = { "extract-assets": "psx_resource_extract", check: "psx_verify_build", "check-all": "psx_finalize_function", split: "psx_split_project", "split-all": "psx_split_project", build: "psx_verify_build", disassemble: "psx_disassemble_project", setup: "psx_prepare_tooling", identify: "psx_identify_project" };
      const name = makeTarget ? taskTools[makeTarget] : commandTools.get(script);
      if (makeTarget) tail = makeTail;
      if (!name || !definitions.has(name)) return "internal implementation operation (not an agent command)";
      const schema = definitions.get(name)!.parameters as any, props = schema.properties ?? {}, parameters: Record<string, unknown> = {};
      const tokens = (tail ?? "").trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      const positional: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        let token = tokens[i]!.replace(/^["']|["']$/g, "");
        if (token.startsWith("--")) {
          const key = token.slice(2).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          const prop = props[key];
          if (!prop) continue;
          if (prop.type === "boolean") parameters[key] = true;
          else if (tokens[i + 1] && !tokens[i + 1]!.startsWith("--")) {
            const value = tokens[++i]!.replace(/^["']|["']$/g, "");
            const parsed = prop.type === "array" ? [value] : prop.type === "number" || prop.type === "integer" ? Number(value) : value;
            if (Value.Check(prop, parsed)) parameters[key] = parsed;
          }
        } else positional.push(token);
      }
      if (props.input) { parameters.input ??= positional[0] ?? "<input>"; if (props.output && positional[1]) parameters.output = positional[1]; }
      if (makeTarget === "split-all") parameters.all = true;
      if (script === "detectLibFunctions") parameters.verifyPlacements = true;
      if (props.functionName) parameters.functionName ??= positional[0] ?? "<function>";
      if (name === "psx_inspect_local_allocation_variant") parameters.source ??= positional[1] ?? "<candidate.c>";
      if (script === "deriveRodataSplits") { parameters.repairRodata = true; }
      for (const key of schema.required ?? []) parameters[key] ??= props[key]?.type === "array" ? ["<candidate.c>"] : props[key]?.type === "integer" || props[key]?.type === "number" ? props[key]?.minimum ?? 0 : props[key]?.type === "boolean" ? false : props[key]?.enum?.[0] ?? `<${key}>`;
      return agentHint(name, parameters);
    });
}
export function validateHint(text: string): void {
  for (const match of text.matchAll(/\b(psx_\w+)\((\{[^\n]*?\})\)/g)) agentHint(match[1]!, JSON.parse(match[2]!));
}
