# CLI Reference

## Synopsis

```text
nanvix-copilot [options] <prompt>
nanvix-copilot --setup [--nanvix-home <path>] [--verbose]
nanvix-copilot --help
```

## Options

| Option | Argument | Default | Description |
| --- | --- | --- | --- |
| `--model` | `<name>` | `gpt-4.1` | LLM model to use for code generation |
| `--runtime` | `python` \| `javascript` | auto-detect | Force a specific runtime language |
| `--nanvix-home` | `<path>` | `./nanvix` | Path to Nanvix binaries and sysroots |
| `--verbose`, `-v` | — | off | Show detailed execution info (sandbox logs, generated code) |
| `--trace` | — | off | Show generated code before sandbox execution |
| `--perf` | — | off | Show performance timing for each step |
| `--setup` | — | — | Download Nanvix binaries and runtime sysroots, then exit |
| `--help`, `-h` | — | — | Show help message and exit |

## Arguments

All positional arguments are concatenated into a single prompt string and sent to the Copilot
SDK for code generation.

## Runtime Auto-Detection

When `--runtime` is not specified, nanvix-copilot uses regex heuristics to detect whether the
generated code is Python or JavaScript:

**Python signals:** `import`, `from ... import`, `def`, `class`, `print()`, trailing `:`

**JavaScript signals:** `function`, `const`, `let`, `var`, `console.log`, arrow functions (`=>`)

The language with more matching patterns wins. If tied, Python is preferred.

## Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Sandbox executed successfully |
| 1 | Error (no prompt, Copilot failure, sandbox error, or Node.js version too old) |
| Other | Forwarded from the sandbox process exit code |

## Environment Variables

| Variable | Description |
| --- | --- |
| `GITHUB_TOKEN` | Optional. Used for authenticating GitHub API requests during setup |
| `NODE_NO_WARNINGS` | Set automatically to `1` to suppress Node.js experimental warnings |

## Examples

**Bash (Linux / macOS):**

```bash
# Basic usage
nanvix-copilot "Print the first 10 Fibonacci numbers"

# Use a specific model
nanvix-copilot --model gpt-4.1 "Solve the Tower of Hanoi for 4 disks"

# Force Python runtime
nanvix-copilot --runtime python "Print all environment variables"

# Force JavaScript runtime
nanvix-copilot --runtime javascript "List files on /"

# Show the generated code
nanvix-copilot --trace "Calculate the factorial of 20"

# Verbose mode (all diagnostic output)
nanvix-copilot --verbose "What OS are you running on?"

# Show performance timing
nanvix-copilot --perf "What OS are you running on?"

# Download binaries only
nanvix-copilot --setup

# Custom Nanvix home directory
nanvix-copilot --nanvix-home /opt/nanvix "Hello world"

# Setup with custom home
nanvix-copilot --setup --nanvix-home /opt/nanvix
```

**PowerShell (Windows):**

```powershell
# Basic usage
npx nanvix-copilot "Print the first 10 Fibonacci numbers"

# Use a specific model
npx nanvix-copilot --model gpt-4.1 "Solve the Tower of Hanoi for 4 disks"

# Force Python runtime
npx nanvix-copilot --runtime python "Print all environment variables"

# Show the generated code
npx nanvix-copilot --trace "Calculate the factorial of 20"

# Download binaries only
npx nanvix-copilot --setup

# Custom Nanvix home directory
npx nanvix-copilot --nanvix-home C:\nanvix "Hello world"
```
