import os from "node:os";
import path from "node:path";

/** True when the host operating system is Windows. */
export const IS_WINDOWS = os.platform() === "win32";

/**
 * Return the platform-specific file name for a Nanvix **host** binary.
 *
 * Host binaries are programs that run directly on the host OS (nanvixd,
 * mkramfs).  On Linux they use the `.elf` extension; on Windows they use
 * `.exe`.
 *
 * Guest binaries (e.g. python.elf, qjs.elf) always use ELF format because
 * they execute inside the Nanvix microvm, regardless of the host OS.
 */
export function hostBinaryName(baseName: string): string {
    return IS_WINDOWS ? `${baseName}.exe` : `${baseName}.elf`;
}

/**
 * Return the full path to a host binary inside the Nanvix home directory.
 */
export function hostBinaryPath(nanvixHome: string, baseName: string): string {
    return path.join(nanvixHome, "bin", hostBinaryName(baseName));
}
