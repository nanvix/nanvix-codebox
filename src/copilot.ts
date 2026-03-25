import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { runInSandbox, type Runtime, type SandboxResult } from "./sandbox.js";

export interface CopilotOptions {
    /** Path to the Nanvix home directory. */
    nanvixHome: string;
    /** LLM model to use for code generation. */
    model: string;
    /** Preferred runtime (if not specified, the agent decides). */
    runtime?: Runtime;
    /** Whether to print verbose output. */
    verbose?: boolean;
}

/**
 * Detect the runtime language from the generated code or the agent's metadata.
 */
function detectRuntime(code: string): Runtime {
    // Simple heuristics based on code patterns.
    const pythonSignals = [
        /^import\s/m,
        /^from\s+\S+\s+import/m,
        /^def\s+\w+/m,
        /^class\s+\w+/m,
        /print\s*\(/,
        /:\s*$/m,
    ];

    const jsSignals = [
        /\bfunction\s+\w+/,
        /\bconst\s+\w+/,
        /\blet\s+\w+/,
        /\bvar\s+\w+/,
        /console\.log/,
        /=>\s*[{(]/,
    ];

    const pythonScore = pythonSignals.filter((r) => r.test(code)).length;
    const jsScore = jsSignals.filter((r) => r.test(code)).length;

    return pythonScore >= jsScore ? "python" : "javascript";
}

/**
 * Run an agentic workload using the Copilot SDK and execute the
 * generated code in a Nanvix sandbox.
 */
export async function runAgenticWorkload(
    prompt: string,
    options: CopilotOptions
): Promise<{ code: string; runtime: Runtime; result: SandboxResult }> {
    const { nanvixHome, model, runtime: preferredRuntime, verbose = false } = options;

    if (verbose) {
        console.error("[copilot] Starting Copilot client...");
    }

    const client = new CopilotClient();
    await client.start();

    try {
        const session = await client.createSession({
            model,
            onPermissionRequest: approveAll,
        });

        // Build the system prompt to instruct Copilot to generate executable code.
        const runtimeHint = preferredRuntime
            ? `Generate ${preferredRuntime === "python" ? "Python" : "JavaScript"} code.`
            : "Generate either Python or JavaScript code (pick whichever is best for the task).";

        const agentPrompt = [
            "You are a code generation agent. Your task is to generate a complete, self-contained, executable program.",
            runtimeHint,
            "IMPORTANT CONSTRAINTS:",
            "- The code runs in an isolated sandbox with NO network access and NO filesystem write access.",
            "- Only the standard library is available. Do NOT use any third-party packages (no pip packages like requests, numpy, pandas, etc.).",
            "- For Python: only use modules from the Python 3.12 standard library.",
            "- For JavaScript: only use built-in QuickJS features (console, std, os modules).",
            "- If the task requires external data (e.g. news, web content), generate realistic sample/mock data instead.",
            "- The program should print its output to stdout.",
            "Output ONLY the source code, no explanations, no markdown fences, no comments about the code.",
            "",
            `Task: ${prompt}`,
        ].join("\n");

        if (verbose) {
            console.error("[copilot] Sending prompt to Copilot SDK...");
        }

        const response = await session.sendAndWait({
            prompt: agentPrompt,
        });

        const generatedCode = response?.data?.content?.trim();
        if (!generatedCode) {
            throw new Error("Copilot SDK returned empty response");
        }

        // Strip markdown code fences if present.
        const cleanedCode = generatedCode
            .replace(/^```(?:python|javascript|js|py)?\s*\n?/i, "")
            .replace(/\n?```\s*$/i, "")
            .trim();

        const runtime = preferredRuntime ?? detectRuntime(cleanedCode);

        if (verbose) {
            console.error(`[copilot] Detected runtime: ${runtime}`);
            console.error(`[copilot] Generated code (${cleanedCode.length} chars):`);
            console.error(cleanedCode);
        }

        // Execute in the Nanvix sandbox.
        if (verbose) {
            console.error("[copilot] Executing in Nanvix sandbox...");
        }

        const result = await runInSandbox({
            nanvixHome,
            runtime,
            code: cleanedCode,
            verbose,
        });

        return { code: cleanedCode, runtime, result };
    } finally {
        await client.stop();
    }
}
