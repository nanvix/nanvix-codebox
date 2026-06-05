# Architecture

This document describes the end-to-end architecture of nanvix-copilot, from user prompt to
sandbox execution result.

## High-Level Flow

```text
 ┌─────────────────┐
 │   User Prompt    │
 └────────┬────────┘
          │
          ▼
 ┌─────────────────┐     ┌─────────────────────────────────────────────┐
 │   CLI (cli.ts)   │────▶│  Parse flags: --model, --runtime, --verbose │
 └────────┬────────┘     └─────────────────────────────────────────────┘
          │
          ▼
 ┌─────────────────┐     ┌─────────────────────────────────────────────┐
 │ Copilot SDK      │────▶│  System prompt constrains output to         │
 │ (copilot.ts)     │     │  self-contained, stdlib-only code           │
 └────────┬────────┘     └─────────────────────────────────────────────┘
          │
          │  Generated source code (Python or JavaScript)
          ▼
 ┌─────────────────┐     ┌─────────────────────────────────────────────┐
 │ Runtime Detection│────▶│  Heuristic regex matching or --runtime flag │
 └────────┬────────┘     └─────────────────────────────────────────────┘
          │
          ▼
 ┌─────────────────┐     ┌─────────────────────────────────────────────┐
 │ Base64 Encode    │────▶│  Code encoded for stdin transport            │
 │ (encoding.ts)    │     └─────────────────────────────────────────────┘
 └────────┬────────┘
          │
          ▼
 ┌─────────────────┐     ┌─────────────────────────────────────────────┐
 │ Sandbox          │────▶│  mkramfs builds FAT32 image from sysroot,   │
 │ (sandbox.ts)     │     │  mkimage bundles daemons + runtime,         │
 │                 │     │  nanvixd boots microvm                      │
 └────────┬────────┘     └─────────────────────────────────────────────┘
          │
          │  stdin: base64-encoded code
          ▼
 ┌─────────────────┐     ┌─────────────────────────────────────────────┐
 │ Nanvix microvm   │────▶│  eval_stdin wrapper decodes + exec()s code  │
 │ (nanvixd)        │     │  Hardware-isolated via KVM (Linux) / WHP    │
 └────────┬────────┘     │  (Windows)                                  │
          │
          │  stdout / stderr / exit code
          ▼
 ┌─────────────────┐
 │  Terminal Output  │
 └─────────────────┘
```

## Module Overview

### Entry Point — `src/index.ts`

The main orchestrator:

1. Suppresses Node.js experimental warnings (for `node:sqlite`)
2. Validates Node.js version (22.5+ required)
3. Parses CLI arguments via `parseArgs()`
4. Dispatches to setup mode, help, or the main execution path
5. Calls `runAgenticWorkload()` with the user prompt
6. Writes sandbox stdout to the terminal and exits with the sandbox exit code

### CLI Parser — `src/cli.ts`

Parses `process.argv` into a typed `CliArgs` object. Supports:

- `--model <name>` — LLM model (default: `gpt-4.1`)
- `--runtime <python|javascript>` — force a specific runtime
- `--nanvix-home <path>` — path to Nanvix binaries (default: `./nanvix`)
- `--verbose` / `--trace` — diagnostic output
- `--perf` — performance timing
- `--setup` — download binaries and exit
- `--help` — print usage

Positional arguments are joined into a single prompt string.

### Copilot Integration — `src/copilot.ts`

Bridges the GitHub Copilot SDK with the sandbox:

1. Creates a `CopilotClient` and opens a session with the chosen model
2. Builds a **system prompt** that constrains the agent to generate self-contained, executable
   code using only standard library modules
3. Strips markdown code fences from the response
4. Detects the runtime language via regex heuristics (or uses the `--runtime` flag)
5. Passes the code to `runInSandbox()`

### Sandbox Runner — `src/sandbox.ts`

Executes code in the Nanvix microvm:

1. Verifies the runtime sysroot exists
2. Resolves the platform-specific host binary names via `src/platform.ts` (`.elf` on Linux, `.exe` on Windows)
3. Runs `mkramfs` to build a FAT32 image from the sysroot directory
4. Runs `mkimage` to build a multibinary boot image bundling the system daemons
   (`procd`, `memd`, `vfsd`) and the runtime binary, with the runtime's cmdline embedded
5. Base64-encodes the user code
6. Spawns `nanvixd` with the multibinary boot image as initrd
7. Pipes the encoded code through stdin
8. Captures stdout, stderr, and the exit code
9. Enforces a 120-second timeout
10. Cleans up the temporary work directory (ramfs + boot image)

> The system daemons must be bundled into the boot image: guest filesystem syscalls are routed
> to `vfsd`, so booting the bare runtime ELF (which leaves `vfsd` unspawned) breaks all file access.

### Encoding — `src/encoding.ts`

Provides `encodeBase64()` and `decodeBase64()` for transporting code and data through stdin
to the sandbox. Wraps Node.js `Buffer` operations.

### Setup — `src/setup.ts`

Downloads and prepares all sandbox components from GitHub Releases:

1. **Nanvix microvm** — `nanvixd`, `mkramfs`, `mkimage`, and the guest daemons
   `procd`/`memd`/`vfsd` (host tools are `.elf` on Linux, `.exe` on Windows)
2. **CPython sysroot** — Python 3.12 binary + trimmed standard library
3. **QuickJS sysroot** — `qjs.elf` binary

For each runtime, the setup process bakes an **eval wrapper** (`eval_stdin.py` /
`eval_stdin.js`) into the sysroot. These wrappers read base64-encoded code from stdin,
decode it, and execute it.

## Eval Wrappers

Each runtime sysroot contains a small wrapper script that acts as the bridge between stdin
input and code execution:

**Python** (`eval_stdin.py`):

```python
import sys, base64
code = base64.b64decode(sys.stdin.buffer.read()).decode("utf-8")
exec(code)
```

**JavaScript** (`eval_stdin.js`):

```javascript
import * as std from "std";
// Custom base64 decoder (QuickJS has no built-in atob)
var input = std.in.readAsString();
var decoded = _decode64(input);
std.evalScript(decoded);
```

The wrappers are baked into the ramfs during `setup`, so user code never touches the guest
filesystem — it flows entirely through stdin.

## Data Flow

```text
User code (string)
    → encodeBase64()       → base64 string
    → stdin pipe           → nanvixd
    → eval wrapper stdin   → base64.b64decode() / _decode64()
    → exec() / evalScript()
    → stdout               → captured by Node.js child process
    → process.stdout.write → terminal
```

## Build & Compilation

The project is written in TypeScript and compiled to JavaScript:

```text
src/*.ts  →  tsc  →  dist/src/*.js     (runtime code)
test/*.ts →  tsc  →  dist/test/*.js    (test code)
bin/nanvix-copilot                     (shebang wrapper, imports dist/src/index.js)
```

### Platform Abstraction — `src/platform.ts`

Provides cross-platform helpers used by the sandbox runner and setup modules:

- `IS_WINDOWS` — `true` when running on Windows
- `hostBinaryName(name)` — appends `.elf` or `.exe` to a binary name based on the host OS
- `hostBinaryPath(nanvixHome, name)` — resolves the full path to a host binary

Guest binaries (Python, QuickJS) always use ELF format regardless of the host platform.

The `bin/nanvix-copilot` entry point is a Node.js script that imports the compiled output:

```bash
#!/usr/bin/env -S node --no-warnings
import("../dist/src/index.js");
```
