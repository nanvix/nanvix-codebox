# Setup

This document describes the setup process that downloads and prepares Nanvix sandbox binaries
and runtime sysroots.

## Running Setup

```bash
# Via npm script
npm run setup

# Via CLI
npx nanvix-codex --setup

# With verbose output
npx nanvix-codex --setup --verbose

# Custom installation directory
npx nanvix-codex --setup --nanvix-home /opt/nanvix
```

## What Gets Downloaded

Setup fetches the latest releases from three GitHub repositories:

### 1. Nanvix Sandbox (`nanvix/nanvix`)

**Asset pattern:** `nanvix-microvm-standalone-release-128mb-*.tar.bz2` (Linux) or `nanvix-microvm-standalone-release-128mb-*.zip` (Windows)

Provides:

- `bin/nanvixd.elf` (Linux) or `bin/nanvixd.exe` (Windows) — the microvm hypervisor daemon
- `bin/mkramfs.elf` (Linux) or `bin/mkramfs.exe` (Windows) — the FAT32 ramfs image builder
- `manifest.json` — microvm metadata (version, memory size, target architecture)

### 2. CPython Runtime (`nanvix/cpython`)

**Asset pattern:** `cpython-microvm-standalone-128mb.tar.bz2`

Provides a full CPython 3.12 sysroot with the interpreter binary and standard library.
After extraction, the sysroot is **trimmed** to fit within the 128 MB VM memory limit.

**Trimmed artifacts:**

| Path | Reason |
| --- | --- |
| `lib/libpython3.12.a` | Static library (~53 MB), not needed at runtime |
| `lib/python3.12/config-3.12*` | Build configuration files (~53 MB) |
| `include/` | C header files for embedding |
| `lib/pkgconfig/` | pkg-config metadata |
| `share/` | Documentation and data files |
| `lib/python3.12/idlelib` | IDLE GUI editor |
| `lib/python3.12/tkinter` | Tk GUI toolkit |
| `lib/python3.12/turtledemo` | Turtle graphics demos |
| `lib/python3.12/lib2to3` | Python 2→3 migration tool |
| `lib/python3.12/ensurepip` | pip bootstrapper |
| `lib/python3.12/pydoc_data` | pydoc documentation data |
| `lib/python3.12/unittest` | Unit testing framework |
| `lib/python3.12/test` | CPython test suite |
| `**/__pycache__/` | Bytecode caches (recompiled from `.py` at runtime) |

**Result:** ~160 MB → ~26 MB sysroot → ~79 MB FAT32 ramfs image

After trimming, the `eval_stdin.py` wrapper is written into the sysroot root directory.

### 3. QuickJS Runtime (`nanvix/quickjs`)

**Asset pattern:** `quickjs-microvm-standalone-128mb.tar.bz2`

Provides the `qjs.elf` binary. Setup creates a minimal sysroot directory with:

- `bin/qjs.elf` — the QuickJS interpreter
- `eval_stdin.js` — the eval wrapper script

## Directory Layout After Setup

```text
nanvix/
├── bin/
│   ├── nanvixd.elf (.exe on Windows)
│   └── mkramfs.elf (.exe on Windows)
├── etc/
│   └── scripts/
│       └── common/
│           ├── logging.sh
│           └── utils.sh
├── lib/
│   └── user.ld
├── logs/
├── manifest.json
└── runtimes/
    ├── python-sysroot/
    │   ├── bin/
    │   │   ├── python3.12
    │   │   └── (other Python symlinks)
    │   ├── lib/
    │   │   └── python3.12/
    │   │       └── (standard library .py files)
    │   └── eval_stdin.py
    └── quickjs-sysroot/
        ├── bin/
        │   └── qjs.elf
        └── eval_stdin.js
```

## Authentication

Setup downloads release assets from GitHub's public API. For rate-limited or private
repositories, set the `GITHUB_TOKEN` environment variable:

```bash
export GITHUB_TOKEN="ghp_..."
npx nanvix-codex --setup
```

The token is used for both API metadata requests and binary downloads.

## Staging

Downloads are extracted to a temporary `.staging/` directory under the Nanvix home path. This
directory is cleaned up after each component is processed. If setup fails partway through,
you may need to remove `.staging/` manually before retrying.

## Verification

After setup completes, the process verifies that the `mkramfs` binary exists (`mkramfs.elf` on
Linux, `mkramfs.exe` on Windows). If the binary is missing, setup throws an error indicating
the extraction failed.
