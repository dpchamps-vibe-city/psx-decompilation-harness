import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installedScriptArgs } from "../../../../tools/lib/installedScripts.js";
import { runProjectCommand, validateFunctionName } from "./shared.js";

export function registerProjectBuildTools(pi: ExtensionAPI): void {
  pi.registerTool({ name: "psx_prepare_tooling", label: "Prepare Public Tooling",
    description: "Prepare and verify pinned public tooling and patched m2c in this project's dependency cache. No SDK download or compiler build.",
    parameters: Type.Object({}),
    execute: (_id, _params, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/pipeline.ts", ["setup"], ctx.cwd), signal, 300_000),
  });
  pi.registerTool({ name: "psx_inspect_exe", label: "Inspect Original EXE Header",
    description: "Read one supplied PS-X EXE header into a project evidence report; no layout or compiler facts are invented.",
    parameters: Type.Object({ input: Type.String(), output: Type.Optional(Type.String()) }),
    execute: (_id, p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/diagnostics/headerInfo.ts", [p.input, p.output ?? "build/identification/header.md"], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_identify_project", label: "Identify Project Evidence",
    description: "Compare target/compiler/SDK evidence with configured choices, without starting a matching campaign.",
    parameters: Type.Object({ deep: Type.Optional(Type.Boolean()), json: Type.Optional(Type.Boolean()) }),
    execute: (_id, p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/diagnostics/identifyToolchain.ts", [...(p.deep ? ["--deep"] : []), ...(p.json ? ["--json"] : [])], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_disassemble_project", label: "Disassemble Project Inputs",
    description: "Produce configured original disassembly and layout evidence. Optional paired-archive discovery is not a universal archive decoder.",
    parameters: Type.Object({ container: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()), archives: Type.Optional(Type.Boolean()) }),
    execute: (_id, p, signal, _update, ctx) => {
      if (p.container && p.all) throw new Error("Choose container or all");
      return runProjectCommand(pi, ctx.cwd, process.execPath, installedScriptArgs("tools/build/pipeline.ts", ["disassemble", ...(p.container ? ["--container", p.container] : p.all ? ["--all"] : []), ...(p.archives ? ["--archives"] : [])], ctx.cwd), signal, 300_000);
    },
  });
  pi.registerTool({ name: "psx_match_sdk_signatures", label: "Measure SDK Signatures",
    description: "Measure original-word signatures against the explicitly configured public signature database. Counts are candidates, not compiler identification.",
    parameters: Type.Object({ version: Type.Optional(Type.String()) }),
    execute: (_id, p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/diagnostics/matchSignatures.ts", p.version ? ["--version", p.version] : [], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_prepare_sdk", label: "Prepare Supplied SDK Members",
    description: "Convert supplied supported SDK members into project lib with hashes/provenance. Optional placement verification requires original target/layout evidence.",
    parameters: Type.Object({ verifyPlacements: Type.Optional(Type.Boolean()) }),
    execute: async (_id, p, signal, _update, ctx) => {
      const split = await runProjectCommand(pi, ctx.cwd, process.execPath, installedScriptArgs("tools/build/pipeline.ts", ["split-sdk-libs"], ctx.cwd), signal, 120_000);
      return p.verifyPlacements ? runProjectCommand(pi, ctx.cwd, process.execPath, installedScriptArgs("tools/build/detectLibFunctions.ts", [], ctx.cwd), signal, 120_000) : split;
    },
  });
  pi.registerTool({ name: "psx_inspect_container_abi", label: "Inspect Container ABI",
    description: "Report original overlay small-data/layout fingerprints independently of candidate configuration.",
    parameters: Type.Object({}),
    execute: (_id, _p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath, installedScriptArgs("tools/diagnostics/overlayFlagFingerprint.ts", [], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_extract_archive", label: "Inspect Paired Archive",
    description: "Inspect an explicitly selected supported paired-index archive; extraction is opt-in and writes only project outputs.",
    parameters: Type.Object({ index: Type.String(), data: Type.String(), write: Type.Optional(Type.Boolean()), extract: Type.Optional(Type.Boolean()) }),
    execute: (_id, p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/extractArchive.ts", ["--index", p.index, "--data", p.data, ...(p.write ? ["--write"] : []), ...(p.extract ? ["--extract"] : [])], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_generate_project_profile", label: "Generate Project Profile",
    description: "Regenerate the configured project's prompt-facing evidence profile. Configuration alone is not a detected target fact.",
    parameters: Type.Object({ write: Type.Optional(Type.Boolean()) }),
    execute: (_id, p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/genProjectProfile.ts", p.write === false ? [] : ["--write"], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_verify_project", label: "Verify All Configured Targets",
    description: "Check complete byte identity of every configured container/member, at 300 seconds. This is not the function scope/source-policy finalization gate.",
    parameters: Type.Object({ container: Type.Optional(Type.String()) }),
    execute: (_id, p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/pipeline.ts", p.container ? ["check", "--container", p.container] : ["check-all"], ctx.cwd), signal, 300_000),
  });
  pi.registerTool({ name: "psx_project_progress", label: "Project Progress",
    description: "Report configured target/member reconstruction progress without claiming missing outputs verified.",
    parameters: Type.Object({}),
    execute: (_id, _p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/diagnostics/progress.ts", [], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_check_configuration", label: "Check Configuration Convergence",
    description: "Regenerate all configured project splits and fail on tracked config/header differences. Requires Git; new outputs still need review.",
    parameters: Type.Object({}),
    execute: (_id, _p, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/pipeline.ts", ["config-check"], ctx.cwd), signal, 300_000),
  });
  pi.registerTool({ name: "psx_classify_globals", label: "Classify Project Globals",
    description: "Classify project global ownership and regenerate its declaration/context headers. Preserves project override declarations.",
    parameters: Type.Object({ write: Type.Optional(Type.Boolean({ description: "Write generated outputs (default true)" })) }),
    execute: (_id, params, signal, _update, ctx) => runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/classifyGlobals.ts", params.write === false ? [] : ["--write"], ctx.cwd), signal, 120_000),
  });
  pi.registerTool({ name: "psx_derive_tu_globals", label: "Derive TU Global Ownership",
    description: "Report global definitions owned by one translation unit from independently derived section/symbol evidence. Diagnostic only.",
    parameters: Type.Object({ functionName: Type.String(), json: Type.Optional(Type.Boolean()) }),
    execute: (_id, params, signal, _update, ctx) => { validateFunctionName(params.functionName); return runProjectCommand(pi, ctx.cwd, process.execPath,
      installedScriptArgs("tools/build/deriveTuOwnedGlobals.ts", [params.functionName, ...(params.json ? ["--json"] : [])], ctx.cwd), signal, 120_000); },
  });
  pi.registerTool({ name: "psx_split_project", label: "Prepare Project Splits",
    description: "Generate configured project splitting/preparation outputs using installed tooling. Library mode follows project.json. Optional rodata repair rederives attribution before splitting.",
    parameters: Type.Object({ container: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()), repairRodata: Type.Optional(Type.Boolean()) }),
    execute: async (_id, params, signal, _update, ctx) => {
      if (params.container && !/^(exe|ovl_\d+)$/.test(params.container)) throw new Error("Invalid container id");
      if (params.container && params.all) throw new Error("Choose container or all, not both");
      const selection = params.container ? ["--container", params.container] : params.all ? ["--all"] : [];
      if (params.repairRodata) await runProjectCommand(pi, ctx.cwd, process.execPath,
        installedScriptArgs("tools/build/deriveRodataSplits.ts", [...selection, "--write"], ctx.cwd), signal, 120_000);
      return runProjectCommand(pi, ctx.cwd, process.execPath, installedScriptArgs("tools/build/pipeline.ts", [params.all ? "split-all" : "split", ...selection.filter(flag => flag !== "--all")], ctx.cwd), signal, 300_000);
    },
  });
}
