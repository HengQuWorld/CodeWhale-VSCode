# Security policy

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

Please use
[GitHub's private vulnerability reporting](https://github.com/HengQuWorld/CodeWhale-VSCode/security/advisories/new)
— do not open a public issue for security problems. Reports are appreciated even
when you are unsure whether something counts as a vulnerability.

## Scope

- **This repository** — the VS Code extension: webview UI, engine process
  management, local IPC. The extension talks to the engine on `127.0.0.1`
  only, generates a per-process Runtime token that stays out of command
  arguments, settings and logs, and contains no telemetry or analytics.
- **The agent engine** (`codewhale` CLI — model traffic, tools, sandboxing,
  prompts) is a separate project. Report engine vulnerabilities to
  [Hmbown/CodeWhale](https://github.com/Hmbown/CodeWhale/security), not here.
