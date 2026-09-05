# Codex-compatible MCP profile

The reliability update adds optional image crop/display bounds, native embedded
exports, retained process handles and three DevSpace extensions. See
[Reliability extensions](mcp-reliability.md) for the current ten-tool contract
and deliberate departures from the pinned Codex baseline described below.

Enable the opt-in profile with `DEVSPACE_TOOL_MODE=strict-codex`. Existing
`minimal`, `full`, and `codex` registrations remain unchanged. Test it in a
separate development instance; changing this source does not deploy it.
Refresh/review the ChatGPT app's tool definitions after deliberately switching
the running instance to the new profile.

## Scope

The ChatGPT model itself calls the tools. No Codex agent, Codex SDK invocation,
second model, or API key is involved. The profile uses existing workspace and
process infrastructure. Plugin configuration parsing uses `smol-toml`.

The catalog is available at `tools/list` before `open_workspace`, and remains
stable when workspaces are opened. The ten tools are:

- `open_workspace`: DevSpace bootstrap; returns `environment_id`, `cwd`, project
  instructions, worktree information, and the existing skill catalog.
- `exec_command`: the familiar `cmd`, `workdir`, `tty`, `yield_time_ms`,
  `max_output_tokens`, and optional `environment_id` interface.
- `write_stdin`: `session_id`, optional `chars`, `yield_time_ms`, and
  `max_output_tokens`. Session IDs route to the owning workspace; callers do
  not need to invent a workspace parameter for this tool.
- `apply_patch`: a complete Codex patch document in the JSON string `patch`.
  An optional `environment_id` argument or `*** Environment ID:` header selects
  the project; conflicting IDs fail before any operation.
- `view_image`: returns actual MCP image content for local PNG, JPEG, GIF, or
  WebP files, bounded to 8 MiB, with optional crop/display bounds. It does not
  advertise unsupported `detail` behavior.
- `read`: a small DevSpace extension retained for opaque `skill://` references
  and bounded text access. Removing it without replacing skill-resource access
  would break the existing skill workflow. Prefer the shell for normal code inspection.
- `export_file`: a DevSpace extension for downloadable artifacts. It accepts a
  workspace-relative `path`, optional `environment_id`, and optional `delivery`.
  It returns a resource link and metadata; `delivery=embedded` also includes a
  native resource for files up to 4 MiB.
- `view_images`: bounded batch crops and optional two-image pixel comparison.
- `inspect_files`: bounded file metadata and optional SHA-256 without shell quoting.
- `process_status`: non-consuming retained command history and lifecycle status.

No process-wide mutable "selected workspace" is introduced. With exactly one
open environment, its ID may be omitted. With multiple environments it is
required, rather than silently directing work to the last-opened project.
Explicit environment IDs can restore registry-backed workspaces after a
connection change. Instruction-delivery hashes and activated skills belong to
that environment context, not every chat that opens the same checkout.
The OS files are still shared: use separate worktrees to isolate concurrent edits.

## Upstream reference and unavoidable differences

The reference is `openai/codex` commit
`c126b0d8ef87fbcde2df7b9c40f24aa91b855758`, not a moving `main` branch.
`codex-compat.lock.json` records the inspected upstream Git blob hashes.
Relevant source files are `shell_spec.rs`, `apply_patch_spec.rs`,
`view_image_spec.rs`, and `assets/tools/apply_patch.lark` in that revision.

This is an MCP adaptation, **not a byte-for-byte copy of the Codex harness**:

* MCP uses JSON arguments. The patch description therefore explicitly says to
  use the `patch` string; copying Codex's "do not wrap in JSON" instruction
  would be incorrect here. Namespacing/rendering also remains host-controlled.
* Bootstrap, opaque skill reads, and workspace containment are DevSpace extensions.
  The environment parameter description documents the actual default-selection rule.
* Unsupported shell overrides, login flags, sandbox escalation, approval
  machinery, and image-detail options are not advertised or silently accepted.
  The existing server shell resolver is used; this is not a full shell-profile port.
* Image bytes are returned as MCP image content rather than a textual data URL.
* The patch engine is an independent implementation of the common Codex syntax,
  not a vendored Rust engine. It preserves existing CRLF/LF and final-newline
  conventions, refuses existing add/move destinations, rejects symlink paths,
  and bounds a patch to 4 MiB and individual patch targets to 16 MiB. Its context
  matching supports exact, trailing-whitespace and surrounding-whitespace matches;
  it does not reproduce every upstream Unicode-normalization fallback.

Descriptions, parameter names and successful command-result field names follow
that reference where the implementation supports the same behavior. This alone
cannot reproduce ChatGPT's hidden host-side prompting, context management,
scheduling, or the Codex agent loop, and is not a measured model-performance claim.

## Downloadable files

`export_file` uses the existing DevSpace export manager and HTTP download route.
The original required arguments remain; additive options/extensions are documented above.
The export extension accepts `path`, optional `environment_id` and `delivery`,
not legacy `workspace_id`.
With multiple environments open, the caller must provide the environment ID.

The result includes a native MCP `resource_link` and these metadata fields:
`url`, `filename`, `mime_type`, `size`, `sha256`, and `expires_at`.
A text block also contains this metadata for clients without structured-result support.
Default link delivery does not include source bytes. Embedded delivery uses
binary MCP resource encoding, never base64 printed as ordinary assistant prose.

Exports use immutable snapshots. Later changes to a source file do not change an existing download.
The existing expiry, file-size limits, capacity limits, path checks, and token-redacted logs still apply.
The tool checks project instructions for each client before it creates a link.
An instruction response contains `status: "instructions_required"` and `retry_required: true`, without a download link.

Creating a link requires the normal authenticated MCP connection.
Anyone with the resulting link can download the snapshot until it expires or the service stops.
Treat the URL as a temporary access credential. Do not export secrets without a deliberate request.
The new profile does not restore the legacy change-card UI.

## Commands and output

`exec_command` returns `output`, `wall_time_seconds`, and either `session_id` or
`exit_code`; `original_token_count` appears when output is truncated. The text
also includes a retained `process_id`; a repeated final poll sets `replayed=true`.
The text
content includes the real result for hosts that do not expose structured content.
Stdout/stderr are collected into a bounded combined buffer in observed arrival
order; legacy profiles retain their separate stdout/stderr fields.

A yield is not an execution timeout: strict-profile commands remain alive until
completion, interruption, or server shutdown. There is no advertised `timeout_ms`.
Non-TTY commands receive stdin EOF. Use `tty: true` for terminal interaction.
`write_stdin` with empty `chars` polls. Ctrl-C sends SIGINT through the existing
process backend. Signal termination reports `128 + signal`, including numeric
PTY signals. This profile does not add process containment or a job sandbox.
Non-empty writes default to 250 ms; empty polls default to 5,000 ms and allow
up to 300,000 ms. Your host/proxy may enforce a shorter request timeout.
Incremental UTF-8 decoding prevents corruption when a character spans pipe chunks.
Windows ConPTY is **not** implemented: strict mode rejects `tty: true` there,
rather than silently substituting pipes. WSL uses the POSIX path.

## Patch safety and project instructions

All patch operations are parsed and prepared before installation. Individual
files are installed with replacement/rename; stale baselines fail rather than
blindly overwriting a concurrent writer. On an installation error the engine
attempts rollback, preserving a concurrent third-party edit rather than replacing
it. Partial rollback is reported explicitly. This is **not** a filesystem-wide,
crash-safe transaction, and pathname checks are not protection against a hostile
local process racing filesystem operations. Symlink files/parents are rejected.

Instruction checks cover command working directories, explicit read/image paths,
and every affected patch source/destination directory. A changed instruction
chain returns instructions without performing the operation; the model retries.
The server does not parse arbitrary shell scripts to infer every file they access.
A preflight is workflow guidance, not an OS security boundary.

The existing OAuth, configured roots and worktree infrastructure remain in use.
Shell execution still has the server account's permissions. This work does not
add Landlock, a container sandbox, network isolation,
or new project-root-marker configuration.

## Verification and maintenance

After importing the implementation on a supported development machine:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` includes the new component/process tests. They can also be run with
`npm run test:codex-compat`. Test a separate MCP instance with `tools/list`
**before** opening a workspace, then test a patch, a long command, polling,
Ctrl-C, image content, skills, and two independent clients/worktrees.
Do not switch the live service until those integration checks pass.

The standalone preparation environment ran the new component/process tests on
Linux, but could not install the full project's dependencies or exercise live
MCP/OAuth, ChatGPT, Windows, macOS, or node-pty. See the delivered verification report.

Run `npm run check:codex-compat` to compare upstream files at the pinned revision,
or `npm run check:codex-compat -- main` to detect drift. The separate weekly
workflow performs the latter after the workflow exists on the default branch.
It reports differences only: no runtime downloads, automated adoption, dependency
updates, deployments, or commits occur. Review contracts and behavior together
before deliberately changing the pin.

Tool descriptions/schema text adapted from OpenAI Codex are Apache-2.0 licensed.
The accompanying license is in `docs/licenses/openai-codex-Apache-2.0.txt`.

## WSL validation update — 2026-09-05

The full dependency-backed typecheck, test suite, and production build now pass
on WSL2 with Node 22.23.1. The reviewed branch fixes two issues found during
integration: an MCP SDK schema type mismatch and a false zero exit code after
a native PTY interrupt.

`test:codex-compat` now includes `src/codex-mcp.test.ts`. That test uses a real
loopback HTTP server, the installed MCP SDK, OAuth with PKCE, and native node-pty.
It also checks independent client state, worktrees, patches, image blocks, skill
references, polling, and reconnects. See [the validation report](strict-codex-validation.md).

The HTTP test does not validate ChatGPT rendering or a public tunnel.
A live profile switch still requires a client tool refresh and a new chat.

The strict profile includes `export_file`. It does not expose the legacy change-card UI.
Use a retained profile when those extensions are required.

## Shared instructions and skills

`open_workspace` returns global guidance before project guidance and lists the source paths in `instruction_sources`.
It also advertises enabled, unambiguous cached Codex plugin skills.
`skill_diagnostics` explains imports that DevSpace skipped. See [configuration](configuration.md#codex-plugin-skills) for the supported scope.
The `read` extension returns `source_path` for skill resources. Use this path to locate their scripts.
These additions do not change tool names or input schemas.

An `environment_id` identifies an instruction context, not only a checkout.
Keep the complete opaque value across HTTP reconnects. Independent workspace opens get separate contexts.
Reconnecting with that value preserves instruction acknowledgements, the current directory, and activated skill resources.
The server retains at most 256 contexts. A restart or eviction requires fresh instruction delivery.
Changed instructions still block the requested operation until the next call.
