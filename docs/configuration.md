# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS` | Idle lifetime for MCP transports. Defaults to `86400` (24 hours). |

MCP clients sometimes reconnect without closing their previous transport.
DevSpace refreshes activity on every request, checks for idle transports every
five minutes, and closes transports that exceed this timeout. Remaining
transports are closed during graceful shutdown.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
```

Each entry in `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` allows that exact host and
its subdomains. For example, `chatgpt.com` also permits
`connector.chatgpt.com`, but not `notchatgpt.com`. Loopback redirect hosts are
always permitted.

## File Exports

The `export_file` tool creates an immutable temporary snapshot and returns a
short-lived download URL. The URL serves `GET` and `HEAD` without OAuth because
its 256-bit random token is the download credential.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DEVSPACE_EXPORT_TTL_SECONDS` | `300` | Lifetime of each download URL. |
| `DEVSPACE_EXPORT_MAX_BYTES` | `104857600` | Maximum size of one exported file (100 MiB). |
| `DEVSPACE_EXPORT_MAX_ENTRIES` | `64` | Maximum number of live exports. |
| `DEVSPACE_EXPORT_MAX_TOTAL_BYTES` | `536870912` | Maximum total live snapshot size (512 MiB). |
| `DEVSPACE_EXPORT_CLEANUP_INTERVAL_SECONDS` | `60` | Interval for deleting expired snapshots. |

Export paths must be relative to an open workspace and resolve to regular files
inside it. Snapshots live in a private, process-specific directory under the
operating system temporary directory and are removed at expiry or shutdown.

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Exposes only `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation, export, and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions. Standard commands return separate `stdout` and `stderr` fields with an
explicit `exit`, `running`, or `timeout` outcome. The default execution timeout
is 60 seconds; set `timeoutMs: 0` to disable it for a deliberate long-running
process.

Codex-mode `apply_patch` accepts one `create_file`, `update_file`, or
`delete_file` operation per call. Create and update operations use a bare V4A
diff. The previous `*** Begin Patch` wrapper format is intentionally not
accepted and no legacy patch tool is exposed.

## Global and project instructions

DevSpace reads global guidance before project guidance. It selects the first non-empty
`AGENTS.override.md` or `AGENTS.md` in the configured agent directory.
The directory priority is `DEVSPACE_AGENT_DIR`, the saved `agentDir`, `CODEX_HOME`, then `~/.codex`.
Global symlinks must stay inside that directory. This does not expand workspace file access.
The merged byte limit below covers both global and project guidance.


DevSpace selects project instructions from the Git/project root through the
requested scope. Each directory contributes at most one non-empty file, in this
order: `AGENTS.override.md`, `AGENTS.md`, then configured fallback names. The
merged root-to-leaf content defaults to a 32 KiB limit. A first operation in a
new or changed nested scope returns `instructions_required`; retry the original
call after reading that result.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_INSTRUCTION_FALLBACK_FILENAMES` | empty | Comma-separated fallback filenames, in precedence order. |
| `DEVSPACE_INSTRUCTION_MAX_BYTES` | `32768` | Maximum merged instruction bytes returned to the model. |

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Attaches widget UI to `open_workspace`. Kept as a display compatibility setting; it does not expose `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Overrides the agent directory for global instructions, skills, and cached plugin metadata. Defaults to `CODEX_HOME` or `~/.codex`. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

When `DEVSPACE_TRUST_PROXY=1`, DevSpace trusts one reverse-proxy hop. Export
download tokens are redacted from request logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.

## Codex plugin skills

DevSpace reads enabled plugin entries from the agent directory's `config.toml`.
It imports skill directories from installed `plugins/cache/<marketplace>/<plugin>/<version>` bundles.
It does not download plugins or execute their installation hooks.
The existing `DEVSPACE_SKILLS=0` switch also disables these imports.

DevSpace skips disabled plugins, invalid manifests, path escapes, symlinked skill trees, and ambiguous cached versions.
It reports skipped imports through skill diagnostics. For multiple cached versions, select the intended skill directory with `DEVSPACE_SKILL_PATHS`.
Do not remove another application's cache automatically.

This imports instructions and skills, not a Codex session.
MCP servers, apps, hooks, credentials, approval settings, and other Codex configuration stay separate.
A skill that calls an external API still needs its runtime and credentials in the DevSpace service environment.

For containers, provide a read-only context directory with global instructions, plugin enablement metadata, and installed skill bundles.
Set `DEVSPACE_AGENT_DIR` to its container path. Exclude authentication files, session databases, and unrelated secrets.
Do not assume that the container can read the host user's Codex home.
