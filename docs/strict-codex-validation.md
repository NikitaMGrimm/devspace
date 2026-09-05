# strict-codex validation — 2026-09-05

## Scope

The source bundle targeted base commit `eb8339889aed3a37b60eadb783165af2cdae6c46`.
The importer verified that base and applied the bundle in an isolated worktree.
The original archive checksums passed. No production service changed during testing.

The test machine used Ubuntu 24.04 under WSL2, Node 22.23.1, and npm 10.9.8.
Dependencies came from the repository lockfile through `npm ci`.

## Corrections

The dependency-backed TypeScript check found an SDK schema type mismatch.
Tool property definitions now use the MCP SDK's declared property type.

The native PTY test found that a Ctrl-C interrupt could report exit code zero.
The result adapter now accepts numeric PTY signals and named pipe signals.
Signal termination takes precedence over the PTY's raw zero status.
Regression tests cover SIGINT, SIGTERM, normal exits, and native terminal input.

## Checks

The following commands passed on the reviewed branch:

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm run check:codex-compat
```

The compatibility checks include 23 component tests and 10 process tests.
The new HTTP suite adds nine integration scenarios. All passed without skips on WSL.
The test runner also counts the HTTP suite's parent test separately.

The HTTP scenarios cover OAuth denial, client registration, PKCE authorization,
and token refresh. They check the tool catalog before workspace opening and
reject legacy arguments. They also check independent instruction and skill state,
isolated worktrees, multi-file patches, image content, stdin EOF, polling,
real POSIX terminal input, Ctrl-C, and explicit environment IDs after reconnect.

The upstream fingerprint check matched all four files at the pinned Codex commit.
The build emits a non-fatal UI chunk-size warning. The strict profile does not
use the legacy change-card UI.

## Limits

These checks do not certify native Windows, macOS, ChatGPT rendering, or a public tunnel.
The real HTTP server used an isolated loopback port and temporary OAuth state.
It did not use production credentials or modify the production database.

The profile changes tools and their schemas. It does not start a Codex agent,
provide another model, or reproduce the full Codex harness. Shell commands retain
the server account's permissions. The profile does not add an operating-system sandbox.

Before activation, keep a working rollback path outside the MCP service.
After activation, refresh the client tool definitions and start a new chat.
