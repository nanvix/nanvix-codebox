import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, accessSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { encodeBase64 } from "./encoding.js";
import { IS_WINDOWS, hostBinaryPath } from "./platform.js";

export type Runtime = "python" | "javascript";

export interface SandboxOptions {
    /** Path to the Nanvix home directory containing binaries. */
    nanvixHome: string;
    /** Runtime to use for execution. */
    runtime: Runtime;
    /** Source code to execute. */
    code: string;
    /** Optional arguments to pass to the program. */
    args?: string;
    /** Execution timeout in milliseconds (default: 120000). */
    timeoutMs?: number;
    /** Whether to print verbose output. */
    verbose?: boolean;
}

export interface SandboxResult {
    /** Stdout output from the sandbox. */
    stdout: string;
    /** Raw stderr output (Nanvix daemon logs). */
    stderr: string;
    /** Process exit code. */
    exitCode: number;
    /** nanvixd log file content (from the Nanvix logs directory, e.g. ${nanvixHome}/logs), if available. */
    nanvixdLog?: string;
}

/** Eval wrapper script baked into the ramfs during setup. Reads base64 from stdin, decodes, exec()s. */
export const PYTHON_EVAL_WRAPPER = `
import sys, base64
code = base64.b64decode(sys.stdin.buffer.read()).decode("utf-8")
exec(code)
`.trim();

export const JS_EVAL_WRAPPER = `
import * as std from "std";
var _b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function _decode64(s) {
    s = s.replace(/[\\r\\n\\s=]/g, "");
    var out = [], i = 0, n = s.length;
    while (i < n) {
        var a = _b64.indexOf(s[i++]);
        var b = i < n ? _b64.indexOf(s[i++]) : 0;
        var c = i < n ? _b64.indexOf(s[i++]) : -1;
        var d = i < n ? _b64.indexOf(s[i++]) : -1;
        var bits = (a << 18) | (b << 12) | ((c >= 0 ? c : 0) << 6) | (d >= 0 ? d : 0);
        out.push(String.fromCharCode((bits >> 16) & 0xFF));
        if (c >= 0) out.push(String.fromCharCode((bits >> 8) & 0xFF));
        if (d >= 0) out.push(String.fromCharCode(bits & 0xFF));
    }
    return out.join("");
}
var input = std.in.readAsString();
var decoded = _decode64(input);
std.evalScript(decoded);
`.trim();

interface RuntimeConfig {
    /** Path to the sysroot directory on the host. */
    sysrootDir: string;
    /** Host path to the runtime binary (loaded as initrd by nanvixd). */
    hostBinPath: string;
    /** Program name used as argv[0] in the bundled multibinary cmdline. */
    progName: string;
    /** Runtime-specific flags + eval wrapper path (the "program args" portion). */
    progArgs: string;
    /** Environment variables to inject (after the ";" separator). */
    envVars: string;
}

function getRuntimeConfig(runtime: Runtime, nanvixHome: string): RuntimeConfig {
    switch (runtime) {
        case "python":
            return {
                sysrootDir: path.join(nanvixHome, "runtimes", "python-sysroot", "ramfs"),
                // Guest binary — always ELF regardless of host OS.
                hostBinPath: path.join(nanvixHome, "runtimes", "python-sysroot", "bin", "python.elf"),
                progName: "python",
                // -B = don't write .pyc files
                progArgs: "-B /eval_stdin.py",
                envVars: "PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1",
            };
        case "javascript":
            return {
                sysrootDir: path.join(nanvixHome, "runtimes", "quickjs-sysroot"),
                // Guest binary — always ELF regardless of host OS.
                hostBinPath: path.join(nanvixHome, "runtimes", "quickjs-sysroot", "bin", "qjs.elf"),
                progName: "qjs",
                // --std = make 'std' and 'os' modules available
                progArgs: "--std /eval_stdin.js",
                envVars: "",
            };
    }
}

/**
 * Execute code inside the Nanvix sandbox (standalone mode).
 *
 * Each runtime sysroot ships with a small eval wrapper script (baked into
 * the ramfs during setup) that reads base64-encoded code from stdin,
 * decodes it, and exec()s it. This lets user scripts flow through stdin
 * without rebuilding the ramfs on every invocation.
 *
 * Flow:
 *   1. Base64-encode the user script
 *   2. Run mkramfs on the pre-built sysroot (already contains eval wrapper)
 *   3. Run mkimage to build a multibinary boot image that bundles the system
 *      daemons (procd, memd, vfsd) together with the runtime binary. The
 *      daemons are required for the guest to service filesystem syscalls
 *      (open/read/getcwd are routed to vfsd); booting the bare runtime ELF
 *      alone leaves vfsd unspawned and every file access fails.
 *   4. Invoke nanvixd with the multibinary image as the boot program
 *   5. Pipe the base64-encoded user script via stdin
 *   6. Capture stdout/stderr
 */
export async function runInSandbox(options: SandboxOptions): Promise<SandboxResult> {
    const {
        nanvixHome,
        runtime,
        code,
        args,
        timeoutMs = 120_000,
        verbose = false,
    } = options;

    const absNanvixHome = path.resolve(nanvixHome);
    const binDir = path.join(absNanvixHome, "bin");
    const nanvixd = hostBinaryPath(absNanvixHome, "nanvixd");
    const mkramfs = hostBinaryPath(absNanvixHome, "mkramfs");
    const mkimage = hostBinaryPath(absNanvixHome, "mkimage");
    const config = getRuntimeConfig(runtime, absNanvixHome);

    // Guest daemons bundled into the boot image. Order is significant: the
    // kernel assigns pids in spawn order (procd, memd, vfsd) and the guest
    // libc routes filesystem syscalls to vfsd at its fixed pid. Always ELF.
    const procd = path.join(binDir, "procd.elf");
    const memd = path.join(binDir, "memd.elf");
    const vfsd = path.join(binDir, "vfsd.elf");

    const logsDir = path.join(absNanvixHome, "logs");

    // Snapshot existing log files so we can identify new ones after execution.
    let logsBefore: Set<string>;
    try {
        logsBefore = new Set(readdirSync(logsDir));
    } catch {
        logsBefore = new Set();
    }

    // Verify sysroot exists.
    try {
        accessSync(config.sysrootDir);
    } catch {
        throw new Error(
            `Runtime sysroot not found: ${config.sysrootDir}\n` +
            `Run "nanvix-copilot --setup" to download runtime files.`
        );
    }

    // Verify the host tools and guest daemons required for the boot image.
    for (const required of [mkramfs, mkimage, config.hostBinPath, procd, memd, vfsd]) {
        try {
            accessSync(required);
        } catch {
            throw new Error(
                `Required Nanvix binary not found: ${required}\n` +
                `Run "nanvix-copilot --setup" to download sandbox binaries.`
            );
        }
    }

    // Each invocation gets its own temp directory so concurrent runs cannot
    // race on shared image paths. The directory (and both images) are removed
    // in the finally block below.
    const workDir = mkdtempSync(path.join(os.tmpdir(), `nanvix-${runtime}-`));
    const ramfsImage = path.join(workDir, "ramfs.img");
    const bootImage = path.join(workDir, "boot.img");

    try {
        if (verbose) {
            console.error(`[sandbox] Building ramfs from: ${config.sysrootDir}`);
        }

        execFileSync(mkramfs, ["-o", ramfsImage, config.sysrootDir], {
            stdio: verbose ? "inherit" : "pipe",
        });

        // Build the guest cmdline baked into the boot image. The multibinary
        // format embeds each program's cmdline, so the runtime's args and env
        // must be supplied here (nanvixd ignores trailing args for multibin
        // images). Format: "<argv0> <args>;<env>". The first ";" separates
        // application arguments from environment variables.
        const progArgs = args
            ? `${config.progArgs} ${args}`
            : config.progArgs;
        const envSuffix = config.envVars ? `;${config.envVars}` : "";
        const cmdline = `${config.progName} ${progArgs}${envSuffix}`;

        // Bundle the system daemons and the runtime into a multibinary boot
        // image. mkimage splits each entry on the first ";" only, so the
        // runtime's "<args>;<env>" cmdline survives intact.
        execFileSync(mkimage, [
            "-o", bootImage,
            `${procd};procd`,
            `${memd};memd`,
            `${vfsd};vfsd`,
            `${config.hostBinPath};${cmdline}`,
        ], {
            stdio: verbose ? "inherit" : "pipe",
        });

        const nanvixdArgs = [
            "-bin-dir", binDir,
            "-ramfs", ramfsImage,
            "--",
            bootImage,
        ];

        if (verbose) {
            console.error(`[sandbox] nanvixd: ${nanvixd}`);
            console.error(`[sandbox] args: ${nanvixdArgs.join(" ")}`);
            console.error(`[sandbox] code length: ${code.length} chars`);
        }

        // Base64-encode the user script for transport via stdin.
        const encodedCode = encodeBase64(code);

        return await new Promise<SandboxResult>((resolve, reject) => {
            const child = spawn(nanvixd, nanvixdArgs, {
                cwd: nanvixHome,
                stdio: ["pipe", "pipe", "pipe"],
            });

            let stdoutChunks: Buffer[] = [];
            let stderrChunks: Buffer[] = [];

            child.stdout.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk);
            });

            child.stderr.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk);
            });

            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            child.on("error", (err) => {
                clearTimeout(timer);
                reject(new Error(`Failed to spawn nanvixd: ${err.message}`));
            });

            child.on("close", (exitCode) => {
                clearTimeout(timer);

                const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
                const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

                // Read any new nanvixd log files produced during this run,
                // but only when verbose output is requested or the sandbox
                // exited with a non-zero code.
                let nanvixdLog = "";
                const shouldCollectLogs =
                    verbose || (exitCode !== null && exitCode !== undefined && exitCode !== 0);
                if (shouldCollectLogs) {
                    try {
                        const logsAfter = readdirSync(logsDir);
                        const newLogs = logsAfter.filter((f) => !logsBefore.has(f)).sort();
                        for (const logFile of newLogs) {
                            const logPath = path.join(logsDir, logFile);
                            if (nanvixdLog) {
                                nanvixdLog += "\n";
                            }
                            nanvixdLog += `===== ${logFile} =====\n`;
                            nanvixdLog += readFileSync(logPath, "utf-8");
                        }
                    } catch { /* logs dir may not exist */ }
                }

                if (verbose) {
                    console.error(`[sandbox] exit code: ${exitCode}`);
                    if (rawStderr) {
                        console.error(`[sandbox] stderr: ${rawStderr}`);
                    }
                    if (nanvixdLog) {
                        console.error(`[sandbox] nanvixd log:\n${nanvixdLog}`);
                    }
                }

                resolve({
                    stdout: rawStdout,
                    stderr: rawStderr,
                    exitCode: exitCode ?? 1,
                    nanvixdLog,
                });
            });

            // Pipe base64-encoded user script via stdin.
            child.stdin.write(encodedCode);
            child.stdin.end();
        });
    } finally {
        // Clean up the temp work directory (ramfs + boot image).
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
