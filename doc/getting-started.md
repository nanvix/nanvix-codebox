# Getting Started

This guide walks you through installing, configuring, and running your first prompt with
nanvix-copilot.

## Prerequisites

| Requirement | Minimum Version | Why |
| --- | --- | --- |
| Node.js | 22.5+ | `node:sqlite` built-in module used by `@github/copilot-sdk` |
| GitHub CLI (`gh`) | Latest | Copilot SDK authenticates through `gh` |
| GitHub Copilot | Active subscription | Powers the code-generation backend |
| Linux with KVM **or** Windows with WHP | — | Nanvix microvm requires hardware virtualization (KVM on Linux, Windows Hypervisor Platform on Windows) |

Check your Node.js version:

```bash
node --version   # must print v22.5.0 or later
```

Verify hardware virtualization is available:

**Linux (KVM):**

```bash
ls /dev/kvm      # should exist
```

**Windows (WHP):**

```powershell
Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
# State should be "Enabled"
```

## Authentication

The Copilot SDK authenticates through the GitHub CLI. Sign in and install the Copilot
extension **once** before using nanvix-copilot:

```bash
# Authenticate with GitHub
gh auth login

# Install the Copilot CLI extension
gh extension install github/gh-copilot
```

## Installation

```bash
# Clone the repository
git clone https://github.com/nanvix/nanvix-copilot.git
cd nanvix-copilot

# Install Node.js dependencies
npm install

# Download Nanvix sandbox binaries and runtime sysroots
npm run setup

# Build the TypeScript source
npm run build
```

The setup step downloads three components from GitHub Releases:

| Component | Repository | Description |
| --- | --- | --- |
| Nanvix Sandbox | `nanvix/nanvix` | `nanvixd` hypervisor and `mkramfs` image builder (`.elf` on Linux, `.exe` on Windows) |
| CPython Runtime | `nanvix/cpython` | Python 3.12 binary and standard library for Nanvix |
| QuickJS Runtime | `nanvix/quickjs` | QuickJS JavaScript engine for Nanvix |

After setup, the `nanvix/` directory will contain:

```text
nanvix/
├── bin/
│   ├── nanvixd.elf (.exe on Windows)  # Nanvix microvm hypervisor
│   └── mkramfs.elf (.exe on Windows)  # FAT32 ramfs image builder
└── runtimes/
    ├── python-sysroot/    # Trimmed CPython 3.12 sysroot (~26 MB)
    │   ├── bin/python3.12
    │   ├── lib/python3.12/
    │   └── eval_stdin.py
    └── quickjs-sysroot/   # QuickJS sysroot
        ├── bin/qjs.elf
        └── eval_stdin.js
```

> **Note:** Host binaries (`nanvixd`, `mkramfs`) use `.elf` on Linux and `.exe` on Windows.
> Guest binaries (`python3.12`, `qjs.elf`) always use ELF format regardless of host OS.

## Running Your First Prompt

```bash
# Ask a question — nanvix-copilot generates code, runs it in a sandbox, and prints the output
npx nanvix-copilot "What OS are you running on?"
```

The tool:

1. Sends your prompt to GitHub Copilot, which generates a self-contained program
2. Auto-detects whether the generated code is Python or JavaScript
3. Executes the code inside a Nanvix microvm sandbox
4. Prints the program's stdout

## More Examples

```bash
# Specify a model
npx nanvix-copilot --model gpt-4.1 "Solve the Tower of Hanoi for 4 disks"

# Force a specific runtime
npx nanvix-copilot --runtime python "Print all environment variables"
npx nanvix-copilot --runtime javascript "List files on /"

# See the generated code before execution
npx nanvix-copilot --trace "Calculate the first 20 prime numbers"

# Full verbose output (code + sandbox logs)
npx nanvix-copilot --verbose "Print a multiplication table"
```

## Running Tests

```bash
npm test
```

This compiles the TypeScript source and runs the test suite with the Node.js built-in test
runner. Tests cover base64 encoding/decoding and CLI argument parsing.

## Next Steps

- [CLI Reference](cli-reference.md) — full list of options and flags
- [Architecture](architecture.md) — how the system works end-to-end
- [Sandbox](sandbox.md) — isolation model and runtime details
- [API Reference](api-reference.md) — programmatic usage of the TypeScript modules
