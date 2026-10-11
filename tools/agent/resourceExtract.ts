import { resourceCli } from "./resource-extraction/cli.ts";
import { recoverAbandonedResourceLocks } from "../lib/resourceLocks.ts";
import { projectRoot } from "../lib/runtimeContext.js";
recoverAbandonedResourceLocks(projectRoot());
await resourceCli("extract", process.argv.slice(2));
