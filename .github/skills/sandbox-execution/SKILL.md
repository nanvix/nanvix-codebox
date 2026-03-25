---
name: sandbox-execution
description: "Debug, modify, or extend the Nanvix sandbox execution engine. Use when: troubleshooting sandbox failures, modifying nanvixd invocation, changing ramfs build, adjusting timeouts, updating eval wrappers, fixing exit code handling, or investigating microvm behavior."
---

# Sandbox Execution

## Overview

The sandbox executes user code inside a Nanvix microvm with KVM-based hardware isolation. Code is base64-encoded, piped via stdin to an eval wrapper script inside a FAT32 ramfs, and executed by the runtime interpreter.

## Key Files

- `src/sandbox.ts` — Core sandbox logic: runtime configs, ramfs building, nanvixd spawning
- `src/encoding.ts` — Base64 encode/decode for stdin transport protocol
- `nanvix/bin/nanvixd.elf` — Hypervisor binary (downloaded during setup)
- `nanvix/bin/mkramfs.elf` — FAT32 ramfs image builder (downloaded during setup)
- `nanvix/runtimes/python-sysroot/eval_stdin.py` — Python eval wrapper
- `nanvix/runtimes/quickjs-sysroot/eval_stdin.js` — JavaScript eval wrapper

## Execution Flow

1. `runInSandbox()` receives `SandboxOptions` with runtime, code, nanvixHome
2. `getRuntimeConfig()` returns sysroot path, binary path, program args, env vars
3. `mkramfs.elf` builds a FAT32 image from the sysroot directory
4. User code is base64-encoded via `encodeBase64()`
5. `nanvixd.elf` is spawned with the ramfs image and runtime binary as initrd
6. Encoded code is piped to stdin; the eval wrapper decodes and executes it
7. stdout/stderr are captured; timeout (default 120s) kills the process if exceeded
8. Ramfs temp file is cleaned up in a `finally` block

## Runtime Configurations

Each runtime is defined in `getRuntimeConfig()`:

**Python:**
- Sysroot: `nanvixHome/runtimes/python-sysroot`
- Binary: `bin/python3.12`
- Args: `-B /eval_stdin.py`
- Env: `PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1`

**JavaScript:**
- Sysroot: `nanvixHome/runtimes/quickjs-sysroot`
- Binary: `bin/qjs.elf`
- Args: `--std /eval_stdin.js`
- Env: (none)

## nanvixd Argument Format

```
nanvixd.elf -bin-dir <binDir> -ramfs <ramfsImage> -- <hostBinPath> <progArgs>;<envVars>
```

The `--` separates nanvixd flags from the guest program. Environment variables follow a `;` separator after program args.

## Common Debugging

- Use `--verbose` to see ramfs build commands and nanvixd invocation args
- Use `--trace` to see the generated code before execution
- Sandbox timeout is enforced with `setTimeout` + `SIGKILL`
- Exit code 0 = success; non-zero is propagated from the guest process
- stderr lines starting with `[ERROR]` are Nanvix VFS debug logs (filtered out in `src/index.ts`)

## Modifying the Sandbox

### Change timeout
Update the `timeoutMs` default (currently `120_000`) in `runInSandbox()`.

### Change VM memory
Update `nanvix/manifest.json` and ensure sysroots fit within the new limit.

### Modify eval wrappers
Edit `PYTHON_EVAL_WRAPPER` or `JS_EVAL_WRAPPER` constants in `src/sandbox.ts`. These are baked into sysroots during setup via `src/setup.ts`.

### Add program arguments
The `args` field in `SandboxOptions` appends to `progArgs` before the env separator.
