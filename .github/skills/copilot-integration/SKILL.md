---
name: copilot-integration
description: "Modify the GitHub Copilot SDK integration, system prompts, or runtime detection logic. Use when: changing the AI system prompt, tuning code generation constraints, adjusting runtime auto-detection heuristics, modifying Copilot client lifecycle, or fixing response parsing (markdown fence stripping)."
---

# Copilot Integration

## Overview

The Copilot integration in `src/copilot.ts` bridges the GitHub Copilot SDK with the Nanvix sandbox. It handles client lifecycle, prompt engineering, response cleaning, runtime detection, and orchestration of sandbox execution.

## Key Files

- `src/copilot.ts` — Copilot client, system prompt, runtime detection, response parsing
- `src/sandbox.ts` — Called by `runAgenticWorkload()` to execute generated code

## Architecture

```
runAgenticWorkload(prompt, options)
  ├─ CopilotClient.start()
  ├─ client.createSession({ model, onPermissionRequest: approveAll })
  ├─ session.sendAndWait({ prompt: agentPrompt })
  ├─ Strip markdown fences from response
  ├─ detectRuntime(code) or use preferredRuntime
  ├─ runInSandbox({ code, runtime, ... })
  └─ CopilotClient.stop()
```

## System Prompt

The system prompt constrains Copilot to generate sandbox-safe code. Key constraints:

- **Self-contained**: No third-party packages, stdlib only
- **No network**: Generate mock/sample data instead of fetching
- **No filesystem writes**: Read-only environment
- **Output to stdout**: All results via `print()` or `console.log()`
- **Raw code only**: No markdown fences, no explanations

The prompt is built as a string array joined by `\n` in the `agentPrompt` variable.

## Modifying the System Prompt

Edit the `agentPrompt` array in `runAgenticWorkload()`. Common modifications:

- Add runtime-specific stdlib guidance
- Constrain output format (JSON, CSV, etc.)
- Add safety constraints for specific use cases
- Adjust the runtime hint based on `preferredRuntime`

## Runtime Detection

`detectRuntime()` uses regex heuristics to classify generated code:

**Python signals** (6 patterns):
- `^import\s`, `^from\s+\S+\s+import`, `^def\s+\w+`, `^class\s+\w+`, `print\s*\(`, `:\s*$`

**JavaScript signals** (6 patterns):
- `\bfunction\s+\w+`, `\bconst\s+\w+`, `\blet\s+\w+`, `\bvar\s+\w+`, `console\.log`, `=>\s*[{(]`

The language with the higher score wins. On a tie, Python is preferred (`>=` comparison).

### Improving Detection

To add more signals, append regex patterns to the respective arrays. Consider:
- Language-specific keywords (`elif`, `lambda`, `async def` for Python)
- Syntax patterns (semicolons, braces for JS)
- Avoid patterns that appear in both languages (`if`, `while`, `for`)

## Response Parsing

Copilot responses may include markdown code fences. Two regex replacements strip them:

```typescript
.replace(/^```(?:python|javascript|js|py)?\s*\n?/i, "")
.replace(/\n?```\s*$/i, "")
```

If adding a new runtime, add its language identifier to the first regex alternation.

## Dependencies

- `@github/copilot-sdk` — provides `CopilotClient` and `approveAll`
- Requires `gh` CLI authenticated with a Copilot-enabled GitHub account
- Requires Node.js 22.5+ (for `node:sqlite` used internally by the SDK)
