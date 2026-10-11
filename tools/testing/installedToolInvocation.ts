/** No-model, complete provided-tool dispatch through the supported Pi 0.85 SDK. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [project, host, toolName, parameters, expectedExtension, operationRoot] = process.argv.slice(2);
if (!project || !host || !toolName || !parameters || !expectedExtension) throw new Error("Expected project, Pi host module, tool, JSON parameters and extension provenance");
const { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager } = await import(pathToFileURL(resolve(host)).href);
const cwd = resolve(project);
const settingsManager = SettingsManager.create(cwd, resolve(cwd, "build/timing-agent"));
settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd, agentDir: resolve(cwd, "build/timing-agent"), settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
await loader.reload({ resolveProjectTrust: async () => true });
const loaded = loader.getExtensions();
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const seen = new Set<string>();
for (const extension of loaded.extensions) for (const name of extension.tools.keys()) {
  if (seen.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
  seen.add(name);
}
const { session } = await createAgentSession({ cwd, agentDir: resolve(cwd, "build/timing-agent"), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
try {
  const info = session.getAllTools().find((tool: { name: string }) => tool.name === toolName);
  if (!info?.sourceInfo?.path || resolve(info.sourceInfo.path) !== resolve(expectedExtension)) throw new Error(`Unexpected tool provenance: ${JSON.stringify(info)}`);
  const definition = session.extensionRunner.getToolDefinition(toolName);
  if (!definition) throw new Error(`Missing tool ${toolName}`);
  console.log(JSON.stringify({ tool: toolName, provenance: info.sourceInfo, parameters: JSON.parse(parameters) }));
  const context = { ...session.extensionRunner.createContext(), ...(operationRoot ? { cwd: resolve(operationRoot) } : {}), model: undefined };
  const result = await definition.execute("runtime-timing", JSON.parse(parameters), new AbortController().signal, undefined, context);
  console.log(JSON.stringify(result));
  if (result.isError || result.details?.pass === false || result.details?.code > 0) process.exitCode = 1;
} finally { session.dispose(); }
