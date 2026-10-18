/** Period cccp treats CRLF continuations differently. Reference inputs remain
 * immutable; production reads an LF-only, content-addressed header tree. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { digest, filesUnder, snapshot, writeIfChanged } from "./contentCache.js";
export function referenceHeaderCopy(directory: string, root: string): string {
  const files = filesUnder(directory);
  const key = digest(JSON.stringify(snapshot(root, files)));
  const output = join(root, "build/headers/reference", key);
  if (!existsSync(join(output, ".complete"))) {
    for (const file of files) {
      const path = join(output, relative(directory, file)); mkdirSync(dirname(path), { recursive: true });
      writeIfChanged(path, readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    }
    mkdirSync(output, { recursive: true }); writeFileSync(join(output, ".complete"), key);
  }
  return output;
}
