# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

Do not reopen the same folder unless:

- the `workspaceId` is rejected as unknown
- the user switches to another folder
- the user switches between checkout and worktree mode
- the user explicitly asks to reopen

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace resolves the active instruction chain from the
Git/project root to the requested directory. Each directory selects at most one
non-empty file: `AGENTS.override.md`, then `AGENTS.md`, then configured fallback
filenames. Files are merged root-to-leaf and capped at 32 KiB by default.

Before the first read, command, or patch in a nested scope, DevSpace checks the
chain again. New or modified instructions produce an `instructions_required`
control result without running the requested action. The model reads it and
retries the same call.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `skill://` resource before following that skill. Skill resources are
opaque references resolved by DevSpace; they do not expose host filesystem
paths and can be passed unchanged to `read`.

Each advertised skill includes an `origin` of `workspace-local` or `global` so
clients can distinguish project-owned guidance from user, DevSpace, bundled, or
explicit external catalogs without exposing host paths.

For Git workspaces, `open_workspace` reports working-tree cleanliness separately
from upstream synchronization. When a tracking branch exists, the Git summary
includes the upstream branch, ahead and behind counts, and whether the branch is
synchronized. A clean working tree can still be ahead of or behind its upstream.

DevSpace only permits reading:

- advertised `skill://.../SKILL.md` resources
- resources beneath that skill URI after its `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`devspace agents ls`, `devspace agents run`, and `devspace agents show`
workflow. The catalog comes from `open_workspace`; `devspace agents ls` lists
existing subagent sessions for that workspace.

## Tool Names

DevSpace exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for search and directory inspection.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The Codex-native surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `export_file` is also hidden so the coding surface stays at five
tools. `apply_patch` performs one structured create, update, or delete operation
using a bare V4A diff; wrapper-style patch documents are rejected.

`exec_command` separates stdout and stderr and returns an explicit exit,
running, or timeout outcome. A running outcome includes the session ID for
`write_stdin`, which can poll, send input, resize a PTY, or send Ctrl-C. Set
`tty: true` only for commands that need a terminal.

## Change inspection

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI to exposed workspace, file, edit, and
shell tools. `show_changes` is not model-callable in any mode. Inspect changes
when useful with normal Git commands through `exec_command` or `bash`, such as
`git status --short`, `git diff --stat`, and a bounded `git diff`.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

Use edit/write or structured `apply_patch` for intentional direct text edits.
Commands may modify files when required by formatters, package managers, build
systems, migrations, generators, Git operations, or project scripts. Inspect
the resulting changes and avoid unrelated modifications.
