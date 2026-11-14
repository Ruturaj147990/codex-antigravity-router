# Antigravity Task Router

A Codex desktop plugin that sends scoped engineering tasks to an authenticated Antigravity CLI. Codex chooses the task boundaries and acceptance checks. The router runs independent workers in separate Git worktrees, checks paths and results, and pauses higher-risk changes for review.

[Website](https://antigravity-task-router.waxyhedgehog16.chatgpt.site/) · [Feedback](https://antigravity-task-router.waxyhedgehog16.chatgpt.site/feedback.html) · [MIT license](LICENSE)

## Requirements

- Windows desktop with Codex, Git, and Node.js 22 or newer.
- Antigravity CLI installed and signed in. Run `agy models` to check your available models. The router uses `%USERPROFILE%\.gemini\bin\agy.exe` by default. Launch Codex with `CODEX_ANTIGRAVITY_CLI` set to the executable path if yours is elsewhere.
- A Git repository. Give Codex the repository root and a narrow task, for example: “Use Antigravity delegation to fix the input validation in this repo and report the verification results.”

## Install

```powershell
codex plugin marketplace add Ruturaj147990/codex-antigravity-router
```

Open Plugins in Codex desktop, switch to **Antigravity Task Router**, and install the plugin. If the marketplace does not appear, restart Codex desktop. The bundled Codex hook suggests delegation for suitable engineering prompts. You can also invoke the Antigravity delegation skill yourself.

## Verification permissions

The package defaults to fail-closed verification. Worktrees keep edits apart. They do not isolate a program from your OS or other files you can access.

If you want the controller to run test commands locally and accept the risks, set `CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE=trusted-local` in the environment that launches Codex and restart it. In PowerShell, set `$env:CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE = 'trusted-local'` before launching Codex from the same shell. Run only commands you trust in repositories you trust. The commands use your normal Windows permissions. Alternatively, configure a compatible restricted execution provider with `CODEX_ANTIGRAVITY_EXECUTION_PROVIDER`.

Ask Codex to open the router dashboard to get a temporary loopback URL. Choose the preferred CLI model and a worker ceiling from 1 to 32, default 4. Delegation respects ready order and only overlaps independent tasks. Quotas depend on your Antigravity access. The router pauses delegation when it recognizes an Antigravity quota error.

## Release

Version 1.0.0 includes the local browser dashboard, preferred-model selection, configurable worker ceiling, worktree scheduling, verification, and cancellation and recovery controls. Actual time and Codex usage savings have not been benchmarked.

Run the automated tests with `node --test` from `plugins/codex-antigravity-router`. The HTTP tests require loopback access. For reports, use the feedback form and redact tokens and private logs.
