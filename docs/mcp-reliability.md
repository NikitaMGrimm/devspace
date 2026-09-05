# Strict-profile reliability extensions

The strict profile keeps its original seven tools and adds `view_images`,
`inspect_files`, and `process_status`. Its ten-tool catalog is fixed before any
workspace opens. Refresh the client tool catalog after deploying this update.
These additions are explicit DevSpace extensions, not exact Codex parity.

## Instructions and diagnostics

Opening a workspace delivers its root/global instruction chain and hash. A new
subdirectory that only inherits an already delivered chain no longer causes
another gate. New nested rules, edits, overrides and removal of previously
applicable rules still block the action before execution. Acknowledgement is
environment-local and survives HTTP reconnect when that context is retained.
A different environment does not share the acknowledgement.

Gates return `status=instructions_required`, `executed=false`,
`retry_required=true`, `instructions_hash`, source paths and truncation status.
Identical chains for several affected paths are deduplicated within the reply.

HTTP responses that reach application middleware include `X-Request-ID`.
Strict tool results include `_meta.devspace` with tool, HTTP and RPC request IDs,
server instance ID, and execution state. Errors also return these as structured
and text data. Logs correlate received and finished events without adding full
arguments, credentials or environment dumps.

`not_started` means the action did not start; `unknown` means it entered a
side-effecting stage before failing. Inspect before repeating a write.
`completed` describes the tool call, not a child process that is still running.
There is no automatic write retry or claim of idempotency.

DevSpace cannot prevent a ChatGPT safety/dispatch failure before the request
reaches the server. Missing server evidence does not identify which upstream
component rejected it. Correlation IDs make that boundary diagnosable.

## Process history

Strict command replies include `process_id` even when they finish immediately;
running commands also return the existing `session_id`. Pass either handle to
`process_status` as `session_id`. It reads bounded stdout/stderr and combined
history without consuming pending poll output. It includes start/completion time,
elapsed time, exit code, signal, timeout and cancellation requests.

While running, `write_stdin` still polls incrementally. After the final response,
an empty poll can replay it with `replayed=true`, subject to the new output
budget. It does not rerun the command. New input to completed sessions is rejected.

Completed strict sessions are retained for five minutes, subject to a maximum
of 128 sessions. Capacity pressure removes the oldest completed session, never a
running one. If all slots are running, new commands are rejected. Legacy
profiles keep their previous consume-and-remove behavior.

History survives HTTP reconnects while the server remains running, not service
restart or redeployment. IDs begin at a randomized safe integer to avoid
predictable reuse after restart. No command-history database is written.
Cancellation requested is not proof of termination; check state and signal.
Shell access is still trusted host access, not an OS sandbox.

## Images and file metadata

`view_image` retains native image content and accepts optional `crop` with
integer `x`, `y`, `width`, `height` in original stored-raster pixels. Optional
`max_dimension` (64–4096) bounds the displayed long edge without enlargement.
Returned metadata gives original/display dimensions, crop, scale and EXIF
orientation. No implicit orientation transform is applied.

`view_images` accepts 1–4 `{path, crop?, label?}` entries, default long edge 1600.
`difference=true` needs exactly two equally sized images with the same crop. It
adds an absolute pixel-difference image and changed-pixel count at the displayed
resolution, not a semantic comparison. Downsampling may hide fine differences.

Supported input is PNG, JPEG, GIF and WebP. SVG and symlink paths are rejected.
Single native input/output is bounded to 8 MiB; crop/resize input can be up to
32 MiB and 100 million pixels. Combined image output, including a difference,
must fit 8 MiB. Multi-frame transforms use the first frame and identify that
choice. The pinned `sharp` dependency works locally without OCR or model calls.

`inspect_files` accepts 1–50 workspace paths, including `.`. It reports missing
paths, type, size and modification time. `sha256=true` hashes regular files up
to 128 MiB/file and 256 MiB/call, checks concurrent changes and reports budget
errors. It does not recurse or allow arbitrary host paths. Directory instruction
gates apply before inspection.

## Export delivery

Default `export_file` delivery remains a temporary native `resource_link` plus
filename, MIME type, size, SHA-256, expiry and URL. HTTP downloads now support
single/suffix byte ranges, `If-Range`, and HEAD. Invalid or multiple ranges return
416. Disconnecting closes the download stream. Snapshot/path/expiry/capacity
guards remain in force.

For files up to 4 MiB, use `delivery=embedded`. The result additionally includes
a native MCP binary resource, not base64 printed as assistant prose. The server
advertises resources and supports `resources/read` for an issued export URI.
It verifies snapshot size/hash and does not fetch arbitrary URLs.
`resources/list` does not enumerate other clients' exports. Larger files use
HTTP delivery. Export links remain temporary bearer capabilities.

Native resource delivery avoids a separate HTTP download when the client supports
it. The MCP host still controls file cards and mounted attachments. DevSpace
cannot manufacture a path inside ChatGPT's sandbox or guarantee host UI behavior.

## Runtime context and verification

`open_workspace` returns platform, architecture, Node version, effective home
directory and server instance ID. In WSL it also returns distribution and the
Windows UNC workspace path when available. No credentials or full environment
are returned.

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Tests include authenticated loopback MCP clients, resources/read and embedded
delivery, range downloads, process reconnect/TTL/capacity, crops/differences,
containment, and changed instructions. They do not deploy a public service or
call inference models. Production ingress and host attachment rendering still
need checking after the user deploys.

At preparation time, npm audit reported the same 15 advisories in the original
and updated lockfiles (including six high-severity entries); none named the
added image dependency. Unrelated breaking dependency upgrades are not part of
this change. This is not a clean-security-audit claim.

Protocol basis: MCP 2025-11-25 server tools and resources contracts for native
images, resource links, embedded resources, structured content and resources/read;
sharp constructor and resize documentation for bounded raster extraction. The
server's existing protocol version is unchanged.
