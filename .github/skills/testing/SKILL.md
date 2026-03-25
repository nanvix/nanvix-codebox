---
name: testing
description: "Write, run, or debug tests for nanvix-codebox. Use when: adding unit tests, fixing test failures, extending test coverage, writing test cases for CLI parsing, encoding, runtime detection, or any new module."
---

# Testing

## Overview

Tests use the **Node.js built-in test runner** (`node:test`) with `node:assert/strict`. No external test frameworks are needed.

## Running Tests

```bash
npm test
```

This runs two steps:
1. `pretest` — compiles TypeScript with `tsc`
2. `test` — runs `node --test dist/test/*.test.js`

## Test Location and Structure

All tests live in `test/` and are compiled alongside source code via `tsconfig.json`.

Current test file: `test/sandbox.test.ts` with three `describe` blocks:
- `encoding` — base64 roundtrip tests
- `cli` — argument parsing tests
- `platform` — platform detection and host binary name resolution tests

## Writing a New Test

### In an existing file

Add a new `describe` or `it` block in `test/sandbox.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("my feature", () => {
    it("should do something", () => {
        assert.equal(actual, expected);
    });
});
```

### In a new file

Create `test/<name>.test.ts`. It will be picked up automatically by `node --test dist/test/*.test.js` after compilation.

## Import Patterns

Source imports use the `.js` extension (ESM resolution):

```typescript
import { encodeBase64, decodeBase64 } from "../src/encoding.js";
import { parseArgs } from "../src/cli.js";
```

## What Can Be Unit Tested

| Module | Testable functions | Notes |
|--------|-------------------|-------|
| `src/encoding.ts` | `encodeBase64()`, `decodeBase64()` | Pure functions, fully testable |
| `src/cli.ts` | `parseArgs()` | Pure function, pass synthetic `argv` arrays |
| `src/platform.ts` | `IS_WINDOWS`, `hostBinaryName()`, `hostBinaryPath()` | Exported constants and pure functions, fully testable |
| `src/copilot.ts` | `detectRuntime()` (private) | Would need to be exported or tested indirectly |
| `src/sandbox.ts` | `getRuntimeConfig()` (private) | Would need to be exported or tested indirectly |

## What Requires Infrastructure

- `runInSandbox()` — requires KVM, nanvixd.elf, mkramfs.elf
- `runAgenticWorkload()` — requires GitHub Copilot subscription and `gh` CLI auth
- `setup()` — requires network access to GitHub Releases API

## Conventions

1. Use `node:assert/strict` (not `node:assert`) for strict equality
2. Group related tests in `describe()` blocks
3. Test names should start with "should"
4. Test both success paths and edge cases (empty strings, unicode, invalid inputs)
5. For CLI tests, always include `["node", "index.js", ...]` as the first two argv elements
