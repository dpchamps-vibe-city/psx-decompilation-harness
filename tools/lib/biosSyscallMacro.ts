import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HARNESS_ROOT } from "./runtimeContext.js";
import { loadConfig } from "../../.pi/extensions/shared/config.js";

export const BIOS_SYSCALL_MACRO = "PSX_BIOS_SYSCALL";
export const BIOS_SYSCALL_HEADER = "include/library/psx_bios.h";
export const BIOS_TAILJUMP_MACRO = "PSX_BIOS_TAILJUMP";
export const BIOS_TAILJUMP_END_MACRO = "PSX_BIOS_TAILJUMP_END";
export const BIOS_TAILJUMP_HEADER = "include/library/psx_bios_tailjump.h";
export function biosSyscallHeaderText(): string {
  return readFileSync(join(HARNESS_ROOT, "include/psx_bios.h"), "utf8");
}
/** Only the reviewed platform header is exempt; a same-named macro, modified
 * template, or arbitrary header containing assembly is not. */
export function isBiosSyscallHeader(root: string, file = BIOS_SYSCALL_HEADER): boolean {
  const path = join(root, file);
  return relative(root, path).replaceAll("\\", "/") === BIOS_SYSCALL_HEADER && existsSync(path) &&
    readFileSync(path, "utf8").replaceAll("\r\n", "\n") === biosSyscallHeaderText();
}
export function biosSyscallMacroEnabled(root: string): boolean {
  return loadConfig(root).sourcePolicy.allowBiosSyscallMacro === true && isBiosSyscallHeader(root);
}
export function isBiosTailJumpHeader(root: string, file = BIOS_TAILJUMP_HEADER): boolean {
  const path = join(root, file);
  return relative(root, path).replaceAll("\\", "/") === BIOS_TAILJUMP_HEADER && existsSync(path) &&
    readFileSync(path, "utf8").replaceAll("\r\n", "\n") === readFileSync(join(HARNESS_ROOT, "include/psx_bios_tailjump.h"), "utf8");
}
export function biosTailJumpMacroEnabled(root: string): boolean {
  return loadConfig(root).sourcePolicy.allowBiosTailJumpMacro === true && isBiosTailJumpHeader(root);
}
