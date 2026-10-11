import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntimeContext, inRuntimeContext } from "../../../tools/lib/runtimeContext.js";
import { withContentMemo } from "../../../tools/lib/contentCache.js";
import { rememberAgentTool, formatAgentHints } from "./agent-hints.js";

/** Supported tool/command registration, with per-invocation Pi cwd resolution.
 * Loading package resources requires no target configuration. */
export function projectAPI(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      rememberAgentTool(definition);
      return target.registerTool({ ...definition,
        execute: (id, params, signal, update, ctx) => inRuntimeContext(createRuntimeContext(ctx.cwd), () => withContentMemo(async () => {
          try {
            const result = await definition.execute(id, params, signal, update && (result => update({ ...result, content: result.content.map(block => block.type === "text" ? { ...block, text: formatAgentHints(block.text) } : block) })), ctx);
            return { ...result, content: result.content.map(block => block.type === "text" ? { ...block, text: formatAgentHints(block.text) } : block) };
          } catch (error) {
            if (error instanceof Error) error.message = formatAgentHints(error.message);
            throw error;
          }
        })),
      });
    };
    if (key === "registerCommand") return (name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => target.registerCommand(name, { ...definition,
      handler: (args, ctx) => inRuntimeContext(createRuntimeContext(ctx.cwd), () => definition.handler(args, ctx)),
    });
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
export function projectEvent<T>(ctx: Pick<ExtensionContext, "cwd">, operation: () => T): T { return inRuntimeContext(createRuntimeContext(ctx.cwd), operation); }
