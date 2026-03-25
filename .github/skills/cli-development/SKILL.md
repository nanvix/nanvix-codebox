---
name: cli-development
description: "Add, modify, or debug CLI flags and commands for nanvix-codebox. Use when: adding new CLI options, changing argument parsing, updating help text, fixing CLI validation, or modifying how flags are consumed downstream."
---

# CLI Development

## Overview

The CLI is implemented in `src/cli.ts` with a hand-rolled argument parser. It produces a typed `CliArgs` object consumed by `src/index.ts`.

## Key Files

- `src/cli.ts` — Argument parser, `CliArgs` interface, help text
- `src/index.ts` — Entry point that reads `CliArgs` and routes to setup/help/execution
- `test/sandbox.test.ts` — CLI parsing tests (under `describe("cli", ...)`)

## Current Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--model <name>` | string | `gpt-4.1` | LLM model name |
| `--runtime <python\|javascript>` | enum | auto-detect | Force a runtime |
| `--nanvix-home <path>` | string | `./nanvix` | Path to Nanvix binaries |
| `--verbose` / `-v` | boolean | false | Detailed execution info |
| `--trace` | boolean | false | Show generated code |
| `--setup` | boolean | false | Download binaries mode |
| `--help` / `-h` | boolean | false | Show help text |

Positional arguments are concatenated into `prompt`.

## Adding a New Flag

### 1. Update the `CliArgs` interface

```typescript
export interface CliArgs {
    // ... existing fields
    newFlag: boolean;  // or string, number, etc.
}
```

### 2. Add parsing logic

Add a case in the `switch` statement inside `parseArgs()`:

**Boolean flag:**
```typescript
case "--new-flag":
    newFlag = true;
    break;
```

**Value flag:**
```typescript
case "--new-flag": {
    const value = args[++i];
    if (!value) {
        console.error("Error: --new-flag requires a value");
        process.exit(1);
    }
    newFlag = value;
    break;
}
```

### 3. Initialize the default and include in the return

Add the default value declaration near the top of `parseArgs()` and include the field in the return object.

### 4. Update `HELP_TEXT`

Add the flag to the OPTIONS section in `HELP_TEXT` at the top of `cli.ts`.

### 5. Consume the flag

Use the new field from `args` in `src/index.ts` (or pass it through to `copilot.ts`/`sandbox.ts` via their options interfaces).

### 6. Add a test

In `test/sandbox.test.ts` under the `cli` describe block:

```typescript
it("should parse --new-flag", () => {
    const args = parseArgs(["node", "index.js", "--new-flag", "prompt"]);
    assert.equal(args.newFlag, true);
});
```

Important: always prefix argv with `["node", "index.js"]` since `parseArgs` calls `argv.slice(2)`.

## Conventions

- Unknown flags starting with `-` cause an error exit
- Value flags consume the next argument (`args[++i]`)
- Boolean flags are simply set to `true`
- `process.exit(1)` is used for validation errors (not exceptions)
- The `DEFAULT_MODEL` constant is exported for reuse
