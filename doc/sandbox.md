# Sandbox

This document details the Nanvix sandbox isolation model, runtime environments, and how code
executes inside the microvm.

## Isolation Model

nanvix-copilot runs all generated code inside a **Nanvix microvm** — a lightweight virtual
machine backed by hardware virtualization (KVM on Linux, WHP on Windows). The hypervisor
boundary provides hardware-enforced isolation:

- **No host filesystem access** — the guest sees only a FAT32 ramfs mounted at `/`
- **No network access** — no virtual NIC is attached to the guest
- **No host process visibility** — the guest kernel is a separate Nanvix instance
- **Memory-limited** — 256 MB total VM memory
- **Time-limited** — 120-second execution timeout (configurable)

The sandbox is fully air-gapped. Code running inside the VM cannot interact with the host
machine under any circumstances.

## Microvm Components

| Binary | Purpose |
| --- | --- |
| `nanvixd.elf` / `nanvixd.exe` | Nanvix microvm hypervisor daemon. Boots the guest VM with a given ramfs and runtime binary |
| `mkramfs.elf` / `mkramfs.exe` | Builds a FAT32 ramfs image from a host directory |

Both binaries live in `nanvix/bin/` and are downloaded during setup. The extension is `.elf`
on Linux and `.exe` on Windows; guest binaries always use ELF format.

## Execution Flow

```text
1. mkramfs builds the sysroot directory into a FAT32 image
2. nanvixd boots the microvm:
   - Loads the runtime binary (e.g. python.elf) as initrd
   - Mounts the ramfs image at /
   - Passes program arguments and environment variables
3. The runtime binary executes the eval wrapper (eval_stdin.py or eval_stdin.js)
4. The eval wrapper reads base64-encoded user code from stdin
5. The wrapper decodes and executes the code
6. stdout and stderr are captured by the host process
7. The VM exits and the temporary ramfs image is cleaned up
```

### nanvixd Invocation

> **Note:** The examples below use `.elf` (Linux). On Windows, substitute `nanvixd.exe` and
> `mkramfs.exe` for the host binaries. Guest binaries (`python.elf`, `qjs.elf`) are unchanged.

```bash
nanvixd.elf \
  -bin-dir ./bin \
  -ramfs /tmp/nanvix-python-<pid>.img \
  -- \
  ./runtimes/python-sysroot/bin/python.elf \
  "-B /eval_stdin.py;PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1"
```

**Arguments:**

- `-bin-dir` — directory containing Nanvix support binaries
- `-ramfs` — path to the FAT32 image to mount as the guest root filesystem
- `--` — separator between nanvixd options and the guest program
- First positional arg — **host** path to the runtime binary (loaded as initrd)
- Second positional arg — program flags and environment variables, separated by `;`

The format for the combined argument is: `<program-args>;<env-vars>`

## Supported Runtimes

### Python (CPython 3.12)

| Property | Value |
| --- | --- |
| Binary | `runtimes/python-sysroot/bin/python.elf` |
| Sysroot | `runtimes/python-sysroot/` (~26 MB trimmed) |
| Eval wrapper | `/eval_stdin.py` (inside ramfs) |
| Program args | `-B /eval_stdin.py` |
| Environment | `PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1` |
| Standard library | Python 3.12 stdlib (trimmed, see below) |

**Available modules:** The full Python 3.12 standard library is available, except for modules
removed during sysroot trimming:

- `idlelib`, `tkinter`, `turtledemo` — GUI modules (no display)
- `lib2to3` — Python 2→3 migration tool
- `ensurepip`, `pydoc_data` — package installer and documentation data
- `unittest`, `test` — testing frameworks
- `__pycache__` — bytecode caches (Python compiles from `.py` at runtime)

The `-B` flag prevents Python from writing `.pyc` files (ramfs is read-only in practice).
`PYTHONHOME=/` tells Python the sysroot is at the ramfs root.

### JavaScript (QuickJS)

| Property | Value |
| --- | --- |
| Binary | `runtimes/quickjs-sysroot/bin/qjs.elf` |
| Sysroot | `runtimes/quickjs-sysroot/` (minimal) |
| Eval wrapper | `/eval_stdin.js` (inside ramfs) |
| Program args | `--std /eval_stdin.js` |
| Environment | (none) |
| Available modules | `std`, `os` (QuickJS built-ins) |

The `--std` flag makes the `std` and `os` modules available. QuickJS has no built-in `atob()`
or `Buffer`, so the eval wrapper includes a custom base64 decoder.

## Sysroot Trimming

The CPython sysroot is trimmed during setup to fit within the VM memory limit:

| Removed | Size | Reason |
| --- | --- | --- |
| `libpython3.12.a` | ~53 MB | Static library, not needed at runtime |
| `config-3.12-*` | ~53 MB | Build configuration files |
| `include/` | — | C header files |
| `pkgconfig/`, `share/` | — | Build metadata |
| `idlelib`, `tkinter`, `turtledemo` | — | GUI modules (no display in sandbox) |
| `lib2to3`, `ensurepip`, `pydoc_data` | — | Unused tools |
| `unittest`, `test` | — | Testing frameworks |
| `__pycache__/` | — | Bytecode caches |

**Final sysroot size:** ~26 MB directory → ~79 MB FAT32 ramfs image

## Timeout and Error Handling

- **Timeout:** 120 seconds by default. If the sandbox process exceeds this, it is terminated
  and an error is reported. On Linux the process is killed with `SIGKILL`; on Windows
  `TerminateProcess` is used via the Node.js child process API.
- **Spawn failure:** If `nanvixd` cannot be started (e.g., missing KVM on Linux or WHP not
  enabled on Windows), an error is thrown immediately.
- **Non-zero exit:** The sandbox exit code is forwarded to the caller. Stderr is captured and
  filtered to remove noisy Nanvix VFS debug logs.
- **Missing sysroot:** If the runtime sysroot directory does not exist, the sandbox throws an
  error advising the user to run `nanvix-copilot --setup`.

## Running Code Directly (Without Copilot)

You can bypass the Copilot SDK and run code directly in the sandbox:

**Linux (bash):**

```bash
# Build the ramfs image from the sysroot
cd nanvix
./bin/mkramfs.elf -o /tmp/rootfs.img ./runtimes/python-sysroot

# Encode your script as base64
echo -n "print('Hello from Nanvix!')" | base64 > /tmp/input.b64

# Run in the sandbox
./bin/nanvixd.elf -bin-dir ./bin -ramfs /tmp/rootfs.img \
  -- ./runtimes/python-sysroot/bin/python.elf \
  "-B /eval_stdin.py;PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1" \
  < /tmp/input.b64
```

**Windows (PowerShell):**

```powershell
cd nanvix
.\bin\mkramfs.exe -o $env:TEMP\rootfs.img .\runtimes\python-sysroot

$code = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("print('Hello from Nanvix!')"))
$code | Out-File -NoNewline $env:TEMP\input.b64

Get-Content $env:TEMP\input.b64 | .\bin\nanvixd.exe -bin-dir .\bin -ramfs $env:TEMP\rootfs.img `
  -- .\runtimes\python-sysroot\bin\python.elf `
  "-B /eval_stdin.py;PYTHONHOME=/ PYTHONDONTWRITEBYTECODE=1"
```

For JavaScript:

**Linux (bash):**

```bash
cd nanvix
./bin/mkramfs.elf -o /tmp/rootfs.img ./runtimes/quickjs-sysroot

echo -n "console.log('Hello from QuickJS!')" | base64 > /tmp/input.b64

./bin/nanvixd.elf -bin-dir ./bin -ramfs /tmp/rootfs.img \
  -- ./runtimes/quickjs-sysroot/bin/qjs.elf \
  "--std /eval_stdin.js;" \
  < /tmp/input.b64
```

**Windows (PowerShell):**

```powershell
cd nanvix
.\bin\mkramfs.exe -o $env:TEMP\rootfs.img .\runtimes\quickjs-sysroot

$code = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("console.log('Hello from QuickJS!')"))
$code | Out-File -NoNewline $env:TEMP\input.b64

Get-Content $env:TEMP\input.b64 | .\bin\nanvixd.exe -bin-dir .\bin -ramfs $env:TEMP\rootfs.img `
  -- .\runtimes\quickjs-sysroot\bin\qjs.elf `
  "--std /eval_stdin.js;"
```
