# nanvix-codex

A blazingly fast, sandboxed code execution environment powered by
[Nanvix](https://github.com/nanvix/nanvix) and the [GitHub Copilot
SDK](https://github.com/github/copilot-sdk). Code runs inside an air-gapped, hypervisor-isolated
microvm with **no access to the host machine** — no filesystem, no network, no host processes. The
hypervisor boundary guarantees full isolation.

For architecture and implementation details, see [doc/design.md](doc/design.md).

## 📋 Prerequisites

- Node.js 22.5+ (required for `node:sqlite` used by the Copilot SDK)
- [GitHub CLI](https://cli.github.com/) (`gh`) installed
- A [GitHub Copilot](https://docs.github.com/en/copilot) subscription
- Linux with KVM support **or** Windows with Windows Hypervisor Platform (WHP) (for microvm sandbox)

### 🔑 GitHub Copilot Authentication

The Copilot SDK authenticates through the GitHub CLI. Sign in and install the
Copilot extension before running nanvix-codex:

```sh
# Authenticate with GitHub
gh auth login

# Install the Copilot CLI extension
gh extension install github/gh-copilot
```

> These commands work in both Bash and PowerShell.

## 🚀 Quick Start

```sh
# Install dependencies
npm install

# Download Nanvix sandbox and runtime binaries
npm run setup

# Build
npm run build

# Run with a prompt
npx nanvix-codex "What OS are you running on?"

# Specify a model
npx nanvix-codex --model gpt-4.1 "Solve the Tower of Hanoi for 4 disks"

# Specify a runtime
npx nanvix-codex --runtime python "Print all environment variables"
npx nanvix-codex --runtime javascript "List files on /"
```

> All `npm` and `npx` commands work on both Linux (Bash) and Windows (PowerShell).

## ⚙️ CLI Usage

```text
nanvix-codex [options] <prompt>

Options:
  --model <name>                 LLM model to use (default: gpt-4.1)
  --runtime <python|javascript>  Runtime to use (default: auto-detect from prompt)
  --verbose                      Show detailed execution info
  --trace                        Show generated code before sandbox execution
  --perf                         Show performance timing for each step
  --nanvix-home <path>           Path to Nanvix binaries (default: ./nanvix)
  --setup                        Download Nanvix binaries and exit
  --help                         Show help
```

## ⚠️ Usage Statement

This project is a prototype. As such, we provide no guarantees that it will work and you are assuming any risks with using the code. We welcome comments and feedback. Please send any questions or comments to any of the following maintainers of the project:

- [Pedro Henrique Penna](https://github.com/ppenna) - [ppenna@microsoft.com](mailto:ppenna@microsoft.com)

> By sending feedback, you are consenting that it may be used in the further development of this project.

## 📄 License

This project is distributed under the [MIT License](LICENSE.txt).
