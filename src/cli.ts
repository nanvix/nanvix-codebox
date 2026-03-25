import path from "node:path";
import type { Runtime } from "./sandbox.js";

export const DEFAULT_MODEL = "gpt-4.1";

export interface CliArgs {
    prompt: string;
    runtime?: Runtime;
    model: string;
    nanvixHome: string;
    verbose: boolean;
    trace: boolean;
    perf: boolean;
    showHelp: boolean;
    setupMode: boolean;
}

const HELP_TEXT = `
nanvix-copilot — Run agentic workloads in Nanvix sandboxes

USAGE
  nanvix-copilot [options] <prompt>
  nanvix-copilot --setup

OPTIONS
  --model <name>                 LLM model to use (default: ${DEFAULT_MODEL})
  --runtime <python|javascript>  Runtime to use (default: auto-detect)
  --nanvix-home <path>           Path to Nanvix binaries (default: ./nanvix)
  --verbose                      Show detailed execution info
  --trace                        Show generated code before sandbox execution
  --perf                         Show performance timing for each step
  --setup                        Download Nanvix binaries
  --help                         Show this help message

EXAMPLES
  nanvix-copilot "Write a Python script that prints the first 10 Fibonacci numbers"
  nanvix-copilot --model gpt-4.1 --runtime python "Calculate the first 20 prime numbers"
  nanvix-copilot --runtime javascript "Print the factorial of 12"
  nanvix-copilot --setup
`.trim();

export function parseArgs(argv: string[]): CliArgs {
    const args = argv.slice(2);

    let runtime: Runtime | undefined;
    let model = DEFAULT_MODEL;
    let nanvixHome = path.join(process.cwd(), "nanvix");
    let verbose = false;
    let trace = false;
    let perf = false;
    let showHelp = false;
    let setupMode = false;
    const promptParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case "--help":
            case "-h":
                showHelp = true;
                break;

            case "--verbose":
            case "-v":
                verbose = true;
                break;

            case "--trace":
                trace = true;
                break;

            case "--perf":
                perf = true;
                break;

            case "--setup":
                setupMode = true;
                break;

            case "--model": {
                const value = args[++i];
                if (!value) {
                    console.error("Error: --model requires a model name argument");
                    process.exit(1);
                }
                model = value;
                break;
            }

            case "--runtime": {
                const value = args[++i];
                if (value !== "python" && value !== "javascript") {
                    console.error(`Error: --runtime must be "python" or "javascript", got "${value}"`);
                    process.exit(1);
                }
                runtime = value;
                break;
            }

            case "--nanvix-home": {
                const value = args[++i];
                if (!value) {
                    console.error("Error: --nanvix-home requires a path argument");
                    process.exit(1);
                }
                nanvixHome = path.resolve(value);
                break;
            }

            default:
                if (arg.startsWith("-")) {
                    console.error(`Unknown option: ${arg}`);
                    console.error('Run "nanvix-copilot --help" for usage info.');
                    process.exit(1);
                }
                promptParts.push(arg);
                break;
        }
    }

    return {
        prompt: promptParts.join(" "),
        runtime,
        model,
        nanvixHome,
        verbose,
        trace,
        perf,
        showHelp,
        setupMode,
    };
}

export function printHelp(): void {
    console.log(HELP_TEXT);
}
