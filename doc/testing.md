# Testing

This document describes the test suite and how to run tests.

## Running Tests

```bash
npm test
```

This runs two steps (defined in `package.json`):

1. `pretest` — compiles TypeScript with `tsc`
2. `test` — runs `node --test dist/test/*.test.js`

Tests use the **Node.js built-in test runner** (`node:test`), which requires Node.js 22.5+.
Tests are cross-platform and run on both Linux and Windows.

## Test Structure

Tests live in the `test/` directory and are compiled alongside the source code via `tsconfig.json`.

### `test/sandbox.test.ts`

Contains three test suites:

#### `encoding`

Tests the base64 encoding/decoding used for transporting code to the sandbox.

| Test | Description |
| --- | --- |
| `should base64 encode a string` | Verifies `encodeBase64()` produces correct output |
| `should base64 decode a string` | Verifies `decodeBase64()` produces correct output |
| `should roundtrip encode/decode` | Verifies encode→decode is identity for various inputs including Python code, JavaScript code, empty strings, special characters, and Unicode |

#### `cli`

Tests the CLI argument parser.

| Test | Description |
| --- | --- |
| `should parse a simple prompt` | Positional args become the prompt |
| `should parse --runtime flag` | Validates `python` and `javascript` values |
| `should parse --verbose flag` | Boolean flag parsing |
| `should parse --setup flag` | Setup mode detection |
| `should parse --help flag` | Help mode detection |
| `should parse --perf flag` | Performance timing flag parsing |
| `should parse --nanvix-home flag` | Path resolution for custom Nanvix directory |

#### `platform`

Tests the platform detection and host binary name resolution.

| Test | Description |
| --- | --- |
| `hostBinaryName() returns platform extension` | Verifies `.elf` on Linux and `.exe` on Windows |
| `hostBinaryPath() resolves full path` | Verifies correct path construction under `nanvix/bin/` |
| `IS_WINDOWS matches process.platform` | Verifies the constant agrees with the Node.js runtime |
| `should not change guest binary names` | Documents that guest binaries (`python.elf`, `qjs.elf`) are always ELF regardless of host OS |

## What's Tested vs. Not Tested

**Tested (unit tests):**

- Base64 encoding/decoding correctness
- CLI argument parsing logic

**Not tested (requires infrastructure):**

- Sandbox execution (`runInSandbox`) — requires Nanvix binaries and hardware virtualization (KVM/WHP)
- Copilot integration (`runAgenticWorkload`) — requires GitHub Copilot subscription
- Setup/download process — requires network and GitHub API access

## Adding Tests

1. Create a new `.test.ts` file in `test/` or add to the existing `sandbox.test.ts`
2. Import from `node:test` and `node:assert/strict`
3. Run `npm test` to compile and execute

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("my feature", () => {
    it("should work", () => {
        assert.equal(1 + 1, 2);
    });
});
```
