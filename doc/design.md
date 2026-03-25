# Design

## Overview

nanvix-copilot is a sandboxed code execution environment that bridges GitHub Copilot's AI code
generation with Nanvix's hypervisor-isolated microvm. Generated code runs inside a lightweight
VM with **no access to the host machine** — no host filesystem, no network, no host processes.
The hypervisor boundary provides hardware-enforced isolation (KVM on Linux, WHP on Windows),
ensuring that user code cannot escape the sandbox under any circumstances.

It uses the Copilot SDK to generate Python and JavaScript code, then executes it inside a
Nanvix microvm sandbox with 128MB of memory.

## Architecture

```text
User Prompt
    ↓
Copilot SDK (generates code)
    ↓
Base64 encode → stdin
    ↓
nanvixd -bin-dir ./bin -ramfs <sysroot.img> -- <host-path-to-binary> "<args>;<env>"
    ↓
runtime executes eval_stdin wrapper → decodes base64 → exec(user code)
    ↓
stdout → Execution Result
```

## Execution Details

Each runtime sysroot ships with a small **eval wrapper** (`eval_stdin.py` / `eval_stdin.js`)
baked into the ramfs during setup. The wrapper:

1. Reads base64-encoded user code from **stdin**
2. Decodes it
3. Executes it via `exec()` / `eval()`

This means the ramfs only needs to be rebuilt from the cached sysroot directory — the user
script never touches the filesystem. At execution time, `mkramfs` packages the sysroot
into a FAT32 ramfs image (mounted at `/` in the guest), `nanvixd` boots the microvm with
the runtime binary as the initrd, and the base64-encoded code flows through stdin.

**Key details:**

- The guest VM is fully isolated by the hypervisor — it has no access to the host filesystem, network, or processes
- The ramfs image mounts at `/` inside the guest VM
- `PYTHONHOME=/` (not `/sysroot`) because the ramfs root IS the sysroot
- The runtime binary (e.g. `python3.12`) is specified by its **host** path — nanvixd loads it as initrd
- The sysroot is trimmed during setup to ~26MB (from ~160MB) to fit within 128MB VM memory

## How It Works

1. Your natural-language prompt is sent to the Copilot SDK, which generates executable code
2. The generated code is base64-encoded and piped via stdin to `nanvixd`
3. Inside the Nanvix sandbox, the appropriate runtime (CPython or QuickJS) decodes and executes
   the code
4. The execution output is captured from stdout
5. Results are displayed in the terminal

## Nanvix Binaries

Binaries are downloaded from GitHub Releases during setup. Host binaries use `.elf` on Linux
and `.exe` on Windows. Guest binaries always use ELF format regardless of the host platform.

| Component       | Repository                                          | Description                  |
|-----------------|-----------------------------------------------------|------------------------------|
| Nanvix Sandbox  | [nanvix/nanvix](https://github.com/nanvix/nanvix)   | microvm standalone 128MB     |
| CPython Runtime | [nanvix/cpython](https://github.com/nanvix/cpython) | Python 3.12 for Nanvix       |
| QuickJS Runtime | [nanvix/quickjs](https://github.com/nanvix/quickjs) | QuickJS JS engine for Nanvix |

### Sysroot Trimming

The CPython sysroot is trimmed during setup to fit within the 128MB VM:

- Removes `libpython3.12.a` (53MB static library)
- Removes `config-3.12` (53MB build configs)
- Removes `include/`, `pkgconfig/`, `share/`
- Removes unused stdlib modules: `idlelib`, `tkinter`, `lib2to3`, `unittest`, `test`, etc.
- Removes `__pycache__` directories (Python compiles from `.py` sources at runtime)
- Final sysroot: ~26MB → ~79MB FAT32 ramfs image

## Running Code Directly (without Copilot)

You can also run Python code directly in the sandbox. The examples below use Linux (bash)
commands; on Windows, substitute `mkramfs.exe`/`nanvixd.exe` and use PowerShell equivalents
(see [sandbox.md](sandbox.md#running-code-directly-without-copilot) for PowerShell examples).

```bash
# Build the ramfs image from the sysroot
cd nanvix && ./bin/mkramfs.elf -o /tmp/rootfs.img ./runtimes/python-sysroot

# Encode your script as base64
echo -n "print('Hello from Nanvix!')" | base64 > /tmp/input.b64

# Run in the sandbox (eval wrapper reads base64 from stdin)
./bin/nanvixd.elf -bin-dir ./bin -ramfs /tmp/rootfs.img \
  -- ./runtimes/python-sysroot/bin/python3.12 \
  "-B /eval_stdin.py;PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1" \
  < /tmp/input.b64

# Run Fibonacci example
echo -n 'def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

for i in range(10):
    print(f"fib({i}) = {fib(i)}")' | base64 > /tmp/fib.b64

./bin/nanvixd.elf -bin-dir ./bin -ramfs /tmp/rootfs.img \
  -- ./runtimes/python-sysroot/bin/python3.12 \
  "-B /eval_stdin.py;PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1" \
  < /tmp/fib.b64
```
