#!/usr/bin/env node

// Suppress Node.js experimental warnings (e.g. SQLite) in this process and any
// child processes spawned by dependencies like @github/copilot-sdk.
process.env.NODE_NO_WARNINGS = "1";

// @github/copilot-sdk requires node:sqlite which is only available in Node 22.5+.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
    console.error(
        `Error: Node.js 22.5 or later is required (current: ${process.versions.node}).\n` +
        `The @github/copilot-sdk depends on the node:sqlite built-in module.\n` +
        `Upgrade with: nvm install 22 && nvm use 22`
    );
    process.exit(1);
}

import { parseArgs, printHelp } from "./cli.js";
import { runAgenticWorkload, type PerfTimings } from "./copilot.js";
import { setup } from "./setup.js";

function printPerfTimings(perf: PerfTimings): void {
    const fmt = (ms: number) => (ms / 1000).toFixed(2) + "s";
    console.error("\n--- Performance ---");
    console.error(`  Copilot client start : ${fmt(perf.clientStartMs)}`);
    console.error(`  Code generation      : ${fmt(perf.codeGenerationMs)}`);
    console.error(`  Sandbox execution    : ${fmt(perf.sandboxExecutionMs)}`);
    console.error(`  Total                : ${fmt(perf.totalMs)}`);
    console.error("-------------------");
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

    if (args.showHelp) {
        printHelp();
        process.exit(0);
    }

    if (args.setupMode) {
        await setup({ nanvixHome: args.nanvixHome, verbose: args.verbose });
        process.exit(0);
    }

    if (!args.prompt) {
        console.error("Error: No prompt provided.");
        console.error('Run "nanvix-codex --help" for usage info.');
        process.exit(1);
    }

    try {
        const { code, runtime, result, perf } = await runAgenticWorkload(args.prompt, {
            nanvixHome: args.nanvixHome,
            model: args.model,
            runtime: args.runtime,
            verbose: args.verbose,
            perf: args.perf,
        });

        if (args.trace || args.verbose) {
            console.error(`\n--- Generated ${runtime} code ---`);
            console.error(code);
            console.error("--- End of code ---\n");
        }

        // Print the sandbox output.
        if (result.stdout) {
            process.stdout.write(result.stdout);
            if (!result.stdout.endsWith("\n")) {
                process.stdout.write("\n");
            }
        }

        if (result.exitCode !== 0) {
            console.error(`\nSandbox exited with code ${result.exitCode}`);
            if (result.stderr) {
                // Filter out noisy Nanvix VFS debug logs; keep only meaningful errors.
                const meaningful = result.stderr
                    .split("\n")
                    .filter((line) => !line.startsWith("[ERROR]"))
                    .join("\n")
                    .trim();
                if (meaningful) {
                    console.error(meaningful);
                }
            }
            if (perf) {
                printPerfTimings(perf);
            }
            process.exit(result.exitCode);
        }

        if (perf) {
            printPerfTimings(perf);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
    }
}

main();
