# API Reference

This document describes the public TypeScript API exported by nanvix-codebox. These modules can
be imported for programmatic use.

## Module: `sandbox`

**File:** `src/sandbox.ts`

### Types

#### `Runtime`

```typescript
type Runtime = "python" | "javascript";
```

Supported runtime languages for sandbox execution.

#### `SandboxOptions`

```typescript
interface SandboxOptions {
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
```

#### `SandboxResult`

```typescript
interface SandboxResult {
    /** Stdout output from the sandbox. */
    stdout: string;
    /** Raw stderr output (Nanvix daemon logs). */
    stderr: string;
    /** Process exit code. */
    exitCode: number;
}
```

### Functions

#### `runInSandbox(options: SandboxOptions): Promise<SandboxResult>`

Execute code inside the Nanvix sandbox. Builds a FAT32 ramfs image from the runtime sysroot,
spawns the Nanvix microvm, pipes base64-encoded code through stdin, and captures the output.

**Parameters:**

- `options` — Configuration for the sandbox execution (see `SandboxOptions`)

**Returns:** A promise resolving to stdout, stderr, and the exit code.

**Throws:**

- If the runtime sysroot directory does not exist
- If the `nanvixd` host binary fails to spawn (binary name is platform-specific: `.elf` on Linux, `.exe` on Windows)
- If execution exceeds the timeout (default: 120 seconds)

**Example:**

```typescript
import { runInSandbox } from "./sandbox.js";

const result = await runInSandbox({
    nanvixHome: "./nanvix",
    runtime: "python",
    code: 'print("Hello from the sandbox!")',
});

console.log(result.stdout);    // "Hello from the sandbox!\n"
console.log(result.exitCode);  // 0
```

### Constants

#### `PYTHON_EVAL_WRAPPER`

The Python eval wrapper script baked into the sysroot. Reads base64-encoded code from stdin,
decodes, and `exec()`s it.

#### `JS_EVAL_WRAPPER`

The JavaScript eval wrapper script for QuickJS. Includes a custom base64 decoder since QuickJS
has no built-in `atob()`.

---

## Module: `copilot`

**File:** `src/copilot.ts`

### Copilot Types

#### `CopilotOptions`

```typescript
interface CopilotOptions {
    /** Path to the Nanvix home directory. */
    nanvixHome: string;
    /** LLM model to use for code generation. */
    model: string;
    /** Preferred runtime (if not specified, the agent decides). */
    runtime?: Runtime;
    /** Whether to print verbose output. */
    verbose?: boolean;
}
```

### Copilot Functions

#### `runAgenticWorkload(prompt: string, options: CopilotOptions): Promise<{ code: string; runtime: Runtime; result: SandboxResult }>`

Send a natural-language prompt to the Copilot SDK, receive generated code, and execute it in
the Nanvix sandbox.

**Parameters:**

- `prompt` — Natural-language description of the task
- `options` — Configuration (model, runtime preference, etc.)

**Returns:** An object containing:

- `code` — The generated source code (cleaned of markdown fences)
- `runtime` — The detected or specified runtime (`"python"` or `"javascript"`)
- `result` — The sandbox execution result (stdout, stderr, exitCode)

**Throws:**

- If the Copilot SDK returns an empty response
- If sandbox execution fails

**Example:**

```typescript
import { runAgenticWorkload } from "./copilot.js";

const { code, runtime, result } = await runAgenticWorkload(
    "Print the first 20 prime numbers",
    {
        nanvixHome: "./nanvix",
        model: "gpt-4.1",
        runtime: "python",
    }
);

console.log(`Generated ${runtime} code (${code.length} chars)`);
console.log(result.stdout);
```

---

## Module: `encoding`

**File:** `src/encoding.ts`

### Encoding Functions

#### `encodeBase64(input: string): string`

Encode a UTF-8 string to base64.

**Parameters:**

- `input` — The string to encode

**Returns:** Base64-encoded string.

#### `decodeBase64(input: string): string`

Decode a base64 string back to UTF-8.

**Parameters:**

- `input` — The base64-encoded string

**Returns:** Decoded UTF-8 string.

---

## Module: `cli`

**File:** `src/cli.ts`

### CLI Types

#### `CliArgs`

```typescript
interface CliArgs {
    prompt: string;
    runtime?: Runtime;
    model: string;
    nanvixHome: string;
    verbose: boolean;
    trace: boolean;
    showHelp: boolean;
    setupMode: boolean;
}
```

### CLI Constants

#### `DEFAULT_MODEL`

```typescript
const DEFAULT_MODEL = "gpt-4.1";
```

### CLI Functions

#### `parseArgs(argv: string[]): CliArgs`

Parse command-line arguments into a typed `CliArgs` object.

**Parameters:**

- `argv` — The raw argument array (typically `process.argv`)

**Returns:** Parsed CLI arguments. Positional arguments are joined into `prompt`.

#### `printHelp(): void`

Print the formatted help message to stdout.

---

## Module: `setup`

**File:** `src/setup.ts`

### Setup Types

#### `SetupOptions`

```typescript
interface SetupOptions {
    nanvixHome: string;
    verbose?: boolean;
}
```

### Setup Functions

#### `setup(options: SetupOptions): Promise<void>`

Download and prepare Nanvix sandbox binaries and runtime sysroots from GitHub Releases.

Downloads three components:

1. **Nanvix microvm** (`nanvix/nanvix`) — `nanvixd` and `mkramfs` (`.elf` on Linux, `.exe` on Windows)
2. **CPython runtime** (`nanvix/cpython`) — Python 3.12 sysroot (trimmed for 128 MB VM)
3. **QuickJS runtime** (`nanvix/quickjs`) — QuickJS binary

After downloading, the function:

- Trims the Python sysroot to ~26 MB
- Bakes eval wrapper scripts into each sysroot
- Verifies all required binaries exist

**Parameters:**

- `options.nanvixHome` — Directory to install binaries into
- `options.verbose` — Print download progress and sizes

**Throws:**

- If GitHub API requests fail
- If expected release assets are not found
- If `mkramfs` is missing after extraction (binary name is platform-specific)

---

## Module: `platform`

**File:** `src/platform.ts`

Provides cross-platform helpers for resolving host binary names and paths.

### Constants

#### `IS_WINDOWS`

```typescript
const IS_WINDOWS: boolean;
```

`true` when the host operating system is Windows, `false` otherwise. Determined at module load
time via `process.platform`.

### Functions

#### `hostBinaryName(name: string): string`

Return the platform-specific host binary filename.

**Parameters:**

- `name` — Base binary name without extension (e.g., `"nanvixd"`, `"mkramfs"`)

**Returns:** `"<name>.exe"` on Windows, `"<name>.elf"` on Linux.

**Example:**

```typescript
import { hostBinaryName } from "./platform.js";

hostBinaryName("nanvixd");  // "nanvixd.exe" on Windows, "nanvixd.elf" on Linux
```

#### `hostBinaryPath(nanvixHome: string, name: string): string`

Resolve the full path to a host binary under the Nanvix home directory.

**Parameters:**

- `nanvixHome` — Path to the Nanvix home directory
- `name` — Base binary name without extension (e.g., `"nanvixd"`)

**Returns:** Full path to the binary (e.g., `"./nanvix/bin/nanvixd.elf"` on Linux).

**Example:**

```typescript
import { hostBinaryPath } from "./platform.js";

hostBinaryPath("./nanvix", "mkramfs");
// "./nanvix/bin/mkramfs.exe" on Windows
// "./nanvix/bin/mkramfs.elf" on Linux
```

> **Note:** Guest binaries (`python3.12`, `qjs.elf`) always use ELF format and are not
> affected by `hostBinaryName()`. Only host-side tools (`nanvixd`, `mkramfs`) vary by platform.
