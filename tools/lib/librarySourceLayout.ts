import { posix } from "node:path";
import type { LibraryProject } from "./project.js";

/** Derive from manifest spellings, never from the set of files a glob happens
 * to match. An explicit root keeps source paths stable as selection expands. */
export function librarySourceInputRoot(project: LibraryProject): string {
  if (project.output.inputRoot !== undefined) return posix.normalize(project.output.inputRoot.replaceAll("\\", "/"));
  const prefixes = [...project.target.archives, ...project.target.standaloneObjects].map(pattern => {
    const pieces = posix.normalize(pattern.replaceAll("\\", "/")).split("/");
    const wildcard = pieces.findIndex(piece => /[*?\[{]/.test(piece));
    return pieces.slice(0, wildcard < 0 ? -1 : wildcard).filter(piece => piece !== ".");
  });
  const common = [...(prefixes[0] ?? [])];
  for (const prefix of prefixes.slice(1)) {
    let length = 0;
    while (length < common.length && common[length] === prefix[length]) length++;
    common.length = length;
  }
  return common.join("/") || ".";
}

export function legacyLibrarySource(project: LibraryProject, id: string, member: string): string {
  return `${project.output.sourceDir}/${id}/${posix.basename(member).replace(/\.[^.]*$/, "")}.c`;
}

export function libraryMemberSource(project: LibraryProject, input: { path: string; archive: boolean },
  member: { name: string; ordinal: number }, id: string): string {
  if (project.output.sourceLayout === "member-id") return legacyLibrarySource(project, id, member.name);
  const path = posix.relative(librarySourceInputRoot(project), posix.normalize(input.path));
  if (!path || path === ".." || path.startsWith("../") || posix.isAbsolute(path))
    throw new Error(`Library input is outside output.inputRoot: ${input.path}`);
  const stem = path.replace(/\.[^./]*$/, "");
  // Archive ordinals distinguish duplicate names without consulting any other
  // member. Explicit standalone inputs already carry their full relative path.
  const suffix = input.archive ? `${stem}/${member.ordinal}-${posix.basename(member.name).replace(/\.[^.]*$/, "")}.c` : `${stem}.c`;
  return `${project.output.sourceDir}/${project.output.sourceLayout === "tu-directory" ? suffix.replace(/\.c$/, "/tu.json") : suffix}`;
}
