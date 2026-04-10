---
name: add-runtime
description: "Add a new language runtime to the Nanvix sandbox. Use when: adding support for a new programming language, creating a new sysroot, writing an eval wrapper, or integrating a new interpreter with the sandbox execution engine."
---

# Add Runtime

## Overview

Adding a new runtime to nanvix-copilot requires changes across four files and creation of a new sysroot with an eval wrapper. Each runtime runs inside a 256MB microvm with no network or host filesystem access.

## Procedure

### 1. Define the Runtime type

In `src/sandbox.ts`, extend the `Runtime` type union:

```typescript
export type Runtime = "python" | "javascript" | "newlang";
```

### 2. Add runtime configuration

In `src/sandbox.ts`, add a new case to `getRuntimeConfig()`:

```typescript
case "newlang":
    return {
        sysrootDir: path.join(nanvixHome, "runtimes", "newlang-sysroot"),
        hostBinPath: path.join(nanvixHome, "runtimes", "newlang-sysroot", "bin", "newlang"),
        progArgs: "/eval_stdin.newlang",
        envVars: "",
    };
```

Fields:
- `sysrootDir` — host directory packaged into the FAT32 ramfs
- `hostBinPath` — host path to the interpreter binary (loaded as initrd by nanvixd)
- `progArgs` — arguments passed to the interpreter inside the guest
- `envVars` — environment variables injected after a `;` separator

### 3. Create the eval wrapper

Add a constant in `src/sandbox.ts` following the pattern of `PYTHON_EVAL_WRAPPER` and `JS_EVAL_WRAPPER`:

```typescript
export const NEWLANG_EVAL_WRAPPER = `
// Read base64 from stdin, decode, execute
`.trim();
```

The wrapper must:
1. Read all of stdin as a string
2. Base64-decode the string to get source code
3. Execute the decoded source code
4. Print output to stdout

### 4. Add runtime detection heuristics

In `src/copilot.ts`, add patterns to `detectRuntime()`:

```typescript
const newlangSignals = [
    /pattern1/,
    /pattern2/,
];
const newlangScore = newlangSignals.filter((r) => r.test(code)).length;
```

Then include the new score in the comparison logic to select the highest-scoring runtime.

### 5. Add download logic to setup

In `src/setup.ts`, add a section to download and extract the new runtime from GitHub Releases:

1. `fetchLatestRelease("nanvix/newlang-repo")` to get the release
2. `findAsset()` with a regex matching the tarball name
3. `downloadAndExtract()` to the staging directory
4. Move the extracted sysroot to `nanvixHome/runtimes/newlang-sysroot/`
5. Bake the eval wrapper: `writeFile(path.join(sysrootDest, "eval_stdin.newlang"), NEWLANG_EVAL_WRAPPER)`
6. Trim unnecessary files to fit within VM memory

### 6. Update the CLI

In `src/cli.ts`, update the `--runtime` validation to accept the new value:

```typescript
if (value !== "python" && value !== "javascript" && value !== "newlang") {
```

Update `HELP_TEXT` to list the new runtime option.

### 7. Update the Copilot system prompt

In `src/copilot.ts`, add a constraint line for the new runtime in the `agentPrompt` array describing what standard library is available.

## Constraints

- **256MB VM memory**: The sysroot + interpreter must fit in RAM. Aggressively trim build artifacts, tests, and documentation.
- **No network**: The runtime cannot download packages at execution time.
- **Stdin transport**: All user code goes through base64-encoded stdin — no file injection into the guest.
- **FAT32 ramfs**: The filesystem is FAT32; respect filename and path length limits.
