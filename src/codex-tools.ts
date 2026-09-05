import { createHash, randomUUID } from "node:crypto";
import { constants, homedir } from "node:os";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatAgentsPath, type Workspace, type WorkspaceRegistry } from "./workspaces.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";
import { ExportFileError, type DevSpaceExportManager } from "./export-manager.js";
import { applyCodexPatch, containedPatchPath, parseCodexPatch } from "./codex-patch.js";
import { inspectFiles, readSmallFile } from "./file-inspection.js";
import { viewImages, type Crop } from "./image-tools.js";
import { requestContext, SERVER_INSTANCE_ID } from "./request-context.js";

// Tool descriptions/schema descriptions adapted from OpenAI Codex (Apache-2.0).
// See docs/licenses/openai-codex-Apache-2.0.txt.
// Pinned, not downloaded at startup. See docs/codex-compatibility.md for deliberate deviations.
export const CODEX_COMPAT_COMMIT = "c126b0d8ef87fbcde2df7b9c40f24aa91b855758";
export const CODEX_SERVER_INSTRUCTIONS = "Use these tools directly; do not delegate to Codex. Call open_workspace once for a project or worktree. It returns environment_id, cwd and project instructions. Omit environment_id only when one environment is open; otherwise supply it explicitly. Use exec_command for file inspection, searches and commands, apply_patch for edits, and write_stdin to poll or interact with a running process. Use view_image for a local image or pixel crop, view_images for a bounded comparison, and inspect_files for metadata or hashes. process_status reads retained stdout/stderr without consuming polls; use the returned process_id even after a command exits. A replayed terminal poll is old output, not a rerun. The read extension resolves advertised skill:// resources; read a matching skill before using it. Use the export_file extension for downloadable artifacts instead of printing file bytes or base64. Export links expire and grant access to anyone who has the link. For files up to 4 MiB, delivery=embedded also returns a native MCP resource without a second HTTP fetch; file-card rendering is controlled by the host. If a tool reports that project instructions changed, read them and retry: that operation was not executed. MCP carries apply_patch in the JSON string field patch, not as a freeform transport. Errors include a request ID and execution state. Unknown execution state is not permission to repeat a write blindly. File tools are workspace-scoped; shell commands are not an OS sandbox. Tool definitions are fixed for the lifetime of this profile.";

const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });
const environment = string("Environment ID returned by open_workspace. Omit only when exactly one environment is open.");
const budget = number("Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.");
const cropSchema = { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"],
  description: "Optional crop in original raster pixels, before EXIF orientation.",
  properties: { x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } } };
const dimensionSchema = { type: "integer", minimum: 64, maximum: 4096,
  description: "Bound the displayed image's long edge without enlarging it. Returned metadata preserves original coordinates." };
const instructionControlProperties = {
  status: { type: "string", enum: ["instructions_required"] },
  executed: { type: "boolean" },
  instructions: { type: "string" },
  instructions_hash: { type: "string" },
  instruction_sources: { type: "array", items: { type: "string" } },
  instructions_truncated: { type: "boolean" },
  retry_required: { type: "boolean" },
  output: { type: "string" },
};
const errorProperties = {
  error: { type: "string" }, request_id: { type: "string" }, http_request_id: { type: "string" },
  rpc_request_id: { anyOf: [{ type: "string" }, { type: "number" }] },
  server_instance_id: { type: "string" }, failure_layer: { type: "string" },
  execution_state: { type: "string", enum: ["not_started", "unknown"] }, retry_safe: { type: "boolean" },
};
const outputSchema: Tool["inputSchema"] = {
  type: "object", additionalProperties: false,
  properties: {
    ...instructionControlProperties,
    ...errorProperties,
    chunk_id: string("Chunk identifier included when the response reports one."),
    wall_time_seconds: number("Elapsed wall time spent waiting for output in seconds."),
    exit_code: number("Process exit code when the command finished during this call."),
    session_id: number("Session identifier to pass to write_stdin when the process is still running."),
    process_id: number("Retained strict-profile process handle, including commands that already finished. Use process_status to inspect it."),
    replayed: { type: "boolean", description: "True when this is the retained final poll response, not newly consumed output." },
    original_token_count: number("Approximate token count before output truncation."),
    output: string("Command output text, possibly truncated."),
  },
  required: ["wall_time_seconds", "output"],
};
function definition(name: string, description: string, properties: NonNullable<Tool["inputSchema"]["properties"]>, required: string[], readOnly = false): Tool {
  return {
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: name === "exec_command" || name === "write_stdin" },
    ...(name === "exec_command" || name === "write_stdin" ? { outputSchema } : {}),
  };
}

/** Standard MCP JSON schemas, available through tools/list before any workspace is open. */
export function codexToolDefinitions(): Tool[] {
  return [
    { ...definition("open_workspace", "Open a project checkout or managed worktree and return environment_id, cwd, project instructions and available skills. Call once per project or worktree.", {
      path: string("Project directory on the server."),
      mode: { type: "string", enum: ["checkout", "worktree"], description: "Defaults to checkout. Use worktree to isolate parallel file edits." },
      base_ref: string("Git base reference for a new worktree; defaults to HEAD."),
    }, ["path"]), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    definition("exec_command", "Runs a command in a PTY, returning output or a session ID for ongoing interaction.", {
      cmd: string("Shell command to execute."),
      workdir: string("Working directory for the command. Defaults to the turn cwd."),
      tty: { type: "boolean", description: "True allocates a PTY for the command; false or omitted uses plain pipes." },
      yield_time_ms: number(process.platform === "win32"
        ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
        : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms."),
      max_output_tokens: budget, environment_id: environment,
    }, ["cmd"]),
    definition("write_stdin", "Writes characters to an existing unified exec session and returns recent output.", {
      session_id: number("Identifier of the running unified exec session."),
      chars: string("Bytes to write to stdin. Defaults to empty, which polls without writing."),
      yield_time_ms: number("Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default."),
      max_output_tokens: budget,
    }, ["session_id"]),
    definition("apply_patch", "Edit files using Codex patch syntax. Pass the complete *** Begin Patch / *** End Patch document in patch, without Markdown fences. Supports Add File, Update File, Delete File and Move to. This MCP tool uses JSON arguments, not Codex's freeform transport.", {
      patch: string("Complete Codex patch document. An optional *** Environment ID: line selects the environment."),
      environment_id: environment,
    }, ["patch"]),
    definition("view_image", "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.", {
      path: string("Local filesystem path to an image file."), environment_id: environment,
      crop: cropSchema, max_dimension: dimensionSchema,
    }, ["path"], true),
    definition("read", "DevSpace extension: read a bounded text file or an advertised skill:// resource. Prefer exec_command for ordinary code inspection and searches. Read a skill's SKILL.md before its other resources.", {
      path: string("Workspace-relative text path or advertised skill:// resource."),
      offset: number("One-based first line. Defaults to 1."),
      limit: number("Maximum lines to return. Defaults to 2000; capped at 2000."),
      environment_id: environment,
    }, ["path"], true),
    {
      ...definition("export_file", "DevSpace extension: export a regular workspace file as a downloadable resource. Use this for downloadable artifacts instead of printing binary or base64 data. The link expires and grants access to anyone who has it.", {
        path: string("Workspace-relative path to a regular file."),
        environment_id: environment,
        delivery: { type: "string", enum: ["link", "embedded"], description: "Default link. Embedded also returns a native MCP resource (up to 4 MiB), avoiding a separate HTTP download. Attachment rendering is host-controlled." },
      }, ["path"], true),
      outputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri" },
          filename: { type: "string" },
          mime_type: { type: "string" },
          size: { type: "integer", minimum: 0 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          expires_at: { type: "string" },
          ...instructionControlProperties,
          ...errorProperties,
        },
      },
    },
    definition("view_images", "DevSpace extension: inspect up to four local images or crops in one call. For two aligned inputs, difference adds an absolute-pixel difference image. Does not edit files.", {
      images: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false,
        properties: { path: string("Workspace image path."), crop: cropSchema, label: { type: "string", maxLength: 200 } }, required: ["path"] } },
      max_dimension: { ...dimensionSchema, description: "Long-edge display limit. Default 1600; applies to all images." },
      difference: { type: "boolean", description: "Default false. Requires exactly two images with equal dimensions and the same crop." },
      environment_id: environment,
    }, ["images"], true),
    definition("inspect_files", "DevSpace extension: inspect up to 50 workspace paths without shell quoting. Returns type, size, modification time, and optional SHA-256. Hashing is bounded to 128 MiB per file and 256 MiB per call.", {
      paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      sha256: { type: "boolean", description: "Default false. Hash regular files; never recursively hash directories." },
      environment_id: environment,
    }, ["paths"], true),
    definition("process_status", "DevSpace extension: inspect bounded process history without consuming poll output or sending input. Includes stdout, stderr, elapsed time, exit status and cancellation requests. Completed strict-profile sessions survive reconnects for five minutes, subject to capacity; not a server restart.", {
      session_id: number("The process_id or running session_id returned by exec_command/write_stdin."),
      max_output_tokens: budget,
    }, ["session_id"], true),
  ];
}

type Arguments = Record<string, unknown>;
type SchemaProperty = { type: string; enum?: string[]; properties?: Record<string, SchemaProperty>;
  required?: string[]; items?: SchemaProperty; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number; maxLength?: number };
function validateValue(property: SchemaProperty, value: unknown, name: string): void {
  const validType = property.type === "array" ? Array.isArray(value)
    : property.type === "integer" ? Number.isSafeInteger(value)
    : property.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : typeof value === property.type;
  if (!validType || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`Invalid ${name}: expected ${property.type}.`);
  if (property.enum && !property.enum.includes(value as string)) throw new Error(`Invalid ${name}.`);
  if (typeof value === "number" && ((property.minimum !== undefined && value < property.minimum) || (property.maximum !== undefined && value > property.maximum))) throw new Error(`Invalid ${name}: outside supported range.`);
  if (typeof value === "string" && property.maxLength !== undefined && value.length > property.maxLength) throw new Error(`Invalid ${name}: too long.`);
  if (Array.isArray(value)) {
    if (value.length < (property.minItems ?? 0) || value.length > (property.maxItems ?? Infinity)) throw new Error(`Invalid ${name}: unsupported number of items.`);
    value.forEach((item, index) => validateValue(property.items!, item, `${name}[${index}]`));
  } else if (property.type === "object") {
    const object = value as Arguments;
    for (const key of property.required ?? []) if (!Object.hasOwn(object, key)) throw new Error(`Missing argument: ${name}.${key}`);
    for (const [key, item] of Object.entries(object)) {
      if (!property.properties?.[key]) throw new Error(`Unknown argument: ${name}.${key}`);
      validateValue(property.properties[key], item, `${name}.${key}`);
    }
  }
}
function validate(tool: Tool, args: Arguments): void {
  const properties = tool.inputSchema.properties as Record<string, SchemaProperty>;
  for (const name of tool.inputSchema.required ?? []) {
    if (!Object.hasOwn(args, name)) throw new Error(`Missing argument: ${name}`);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) throw new Error(`Unknown argument: ${name}`);
    validateValue(property, value, name);
  }
}
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return value === undefined ? fallback : Math.min(max, Math.max(min, Math.floor(value as number)));
}
function textResult(text: string): CallToolResult { return { content: [{ type: "text", text }] }; }
function objectResult(data: Record<string, unknown>): CallToolResult {
  // Include the actual result, not just a success sentence, in text for plain MCP hosts.
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}
export function codexProcessResult(snapshot: ProcessSnapshot): CallToolResult {
  // Pipe sessions use signal names. node-pty reports numeric signals and may also report exitCode=0.
  const signal = snapshot.signal && /^\d+$/.test(snapshot.signal)
    ? Number(snapshot.signal)
    : snapshot.signal ? constants.signals[snapshot.signal as keyof typeof constants.signals] : undefined;
  const data: Record<string, unknown> = {
    output: snapshot.output ?? snapshot.stdout + snapshot.stderr,
    wall_time_seconds: snapshot.wallTimeMs / 1_000,
    ...(snapshot.running ? { session_id: snapshot.sessionId } : { exit_code: signal ? 128 + signal : snapshot.exitCode ?? 1 }),
    ...(snapshot.originalOutputTokens !== undefined ? { original_token_count: snapshot.originalOutputTokens } : {}),
    ...(snapshot.processId !== undefined ? { process_id: snapshot.processId } : {}),
    ...(snapshot.replayed ? { replayed: true } : {}),
  };
  return { ...objectResult(data), ...(snapshot.processId !== undefined ? {
    _meta: { devspace_process: { session_id: snapshot.processId, elapsed_seconds: (snapshot.elapsedMs ?? 0) / 1000,
      cancel_requested: snapshot.cancelRequested ?? false, timed_out: snapshot.timedOut,
      replayed: snapshot.replayed ?? false, retained_after_exit: true } },
  } : {}) };
}

interface Environment { workspace: Workspace; cwd: string }
// An opaque environment handle carries context across HTTP reconnects. Separate
// opens get separate handles, even when they share the same canonical checkout.
// Bound retained contexts without adding a persistence layer or cleanup timer.
const environmentContexts = new WeakMap<WorkspaceRegistry, Map<string, Environment>>();
const MAX_ENVIRONMENT_CONTEXTS = 256;
export interface CodexCallLog {
  tool: string; success: boolean; durationMs: number; error?: string; command?: string; workspaceId?: string;
  requestId?: string; httpRequestId?: string; rpcRequestId?: string | number;
  phase?: "received" | "finished"; executionState?: string; failureLayer?: string;
}
interface CallTrace {
  request_id: string;
  http_request_id?: string;
  rpc_request_id?: string | number;
  phase: "validation" | "workspace" | "instructions" | "execution" | "resource";
  started: boolean;
}

/** One immutable tool catalog per MCP connection; no mutable process-wide selected workspace. */
export function createCodexToolset(
  workspaces: WorkspaceRegistry,
  processes: ProcessSessionManager,
  log?: (entry: CodexCallLog) => void,
  exportManager?: Pick<DevSpaceExportManager, "exportFile"> & Partial<Pick<DevSpaceExportManager, "readResource">>,
): { tools: Tool[]; call(name: string, args?: Arguments, rpcRequestId?: string | number): Promise<CallToolResult> } {
  const tools = codexToolDefinitions();
  const environments = new Map<string, Environment>();
  let retained = environmentContexts.get(workspaces);
  if (!retained) {
    retained = new Map();
    environmentContexts.set(workspaces, retained);
  }
  const contexts = retained;
  function remember(id: string, entry: Environment): void {
    contexts.delete(id);
    contexts.set(id, entry);
    while (contexts.size > MAX_ENVIRONMENT_CONTEXTS) contexts.delete(contexts.keys().next().value!);
    environments.set(id, entry);
  }
  function isolatedWorkspace(workspace: Workspace): Workspace {
    return { ...workspace, deliveredInstructionHashes: new Map(), activatedSkillIds: new Set() };
  }
  async function environment(id?: string): Promise<Environment> {
    if (!id) {
      if (environments.size !== 1) throw new Error("Call open_workspace first, then specify environment_id when more than one project is open.");
      id = environments.keys().next().value!;
    }
    let entry = environments.get(id) ?? contexts.get(id);
    // Accept legacy workspace IDs within an already-open connection.
    if (!entry) {
      const legacy = [...environments.entries()].find(([, candidate]) => candidate.workspace.id === id);
      if (legacy) { id = legacy[0]; entry = legacy[1]; }
    }
    if (entry) {
      await workspaces.getWorkspace(entry.workspace.id);
    } else {
      // After a restart or cache eviction, restore the checkout but require fresh
      // instruction delivery. The next reconnect can resume that acknowledgement.
      const match = /^(ws_[^.]+)(?:\.([0-9a-f-]{36}))?$/u.exec(id);
      if (!match) throw new Error("Unknown environment ID.");
      const current = await workspaces.getWorkspace(match[1]);
      entry = { workspace: isolatedWorkspace(current), cwd: current.root };
    }
    remember(id, entry);
    return entry;
  }
  async function preflight(entry: Environment, directories: string[], processTool = false): Promise<CallToolResult | undefined> {
    const chains = new Map<string, Awaited<ReturnType<WorkspaceRegistry["preflightInstructions"]>>>();
    for (const directory of new Set(directories)) {
      const required = await workspaces.preflightInstructions(entry.workspace, directory);
      if (required) chains.set(required.instructionHash ?? required.instructions, required);
    }
    if (!chains.size) return undefined;
    const required = [...chains.values()].filter((value) => value !== undefined);
    const instructions = required.map((value) => value.instructions).join("\n\n");
    const output = "Operation was NOT executed. Read the applicable project instructions below and retry the same tool call.\n\n" + instructions;
    return objectResult({
      status: "instructions_required", executed: false, retry_required: true,
      instructions, output,
      instructions_hash: required.length === 1 && required[0]!.instructionHash
        ? required[0]!.instructionHash : createHash("sha256").update(instructions).digest("hex"),
      instruction_sources: [...new Set(required.flatMap((value) => value.instructionSources ?? []))],
      instructions_truncated: required.some((value) => value.truncated),
      ...(processTool ? { wall_time_seconds: 0 } : {}),
    });
  }
  async function call(name: string, args: Arguments, trace: CallTrace): Promise<CallToolResult> {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validate(tool, args);
    trace.phase = "workspace";
    if (name === "open_workspace") {
      trace.started = true;
      const context = await workspaces.openWorkspace({ path: args.path as string, mode: args.mode as "checkout" | "worktree" | undefined, baseRef: args.base_ref as string | undefined });
      const existing = [...environments.entries()].find(([, value]) => value.workspace.id === context.workspace.id);
      const environmentId = existing?.[0] ?? `${context.workspace.id}.${randomUUID()}`;
      const entry: Environment = existing?.[1] ?? { workspace: isolatedWorkspace(context.workspace), cwd: context.instructionChain.scope };
      entry.cwd = context.instructionChain.scope;
      // Preserve per-environment instruction/skill state, refreshing the advertised catalog.
      entry.workspace.skillResources = context.workspace.skillResources;
      entry.workspace.skills = context.workspace.skills;
      entry.workspace.skillDiagnostics = context.workspace.skillDiagnostics;
      remember(environmentId, entry);
      const chain = await workspaces.markInstructionsDelivered(entry.workspace, entry.cwd);
      return objectResult({
        environment_id: environmentId, cwd: entry.cwd, mode: entry.workspace.mode,
        runtime: {
          platform: process.platform, architecture: process.arch, node: process.version,
          home: homedir(), server_instance_id: SERVER_INSTANCE_ID,
          ...(process.platform === "linux" && /^[A-Za-z0-9._-]+$/.test(process.env.WSL_DISTRO_NAME ?? "") ? {
            wsl_distribution: process.env.WSL_DISTRO_NAME,
            windows_workspace_path: `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME}${entry.cwd.replaceAll("/", "\\")}`,
          } : {}),
        },
        ...(entry.workspace.worktree ? { worktree: entry.workspace.worktree } : {}),
        instructions: chain.instructions, instructions_truncated: chain.truncated,
        instructions_hash: chain.hash,
        instruction_sources: chain.sources.map((source) => formatAgentsPath(source.path, entry.workspace.root)),
        ...(entry.workspace.skillDiagnostics.length ? { skill_diagnostics: entry.workspace.skillDiagnostics } : {}),
        context_note: "Codex instructions and skills are imported; MCP servers, apps, hooks, settings and credentials are not inherited.",
        skills: entry.workspace.skillResources.map(({ skill, resource }) => ({ name: skill.name, description: skill.description, resource })),
      });
    }
    if (name === "write_stdin" || name === "process_status") {
      const sessionId = args.session_id as number;
      if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Invalid session_id.");
      const workspaceId = processes.workspaceForSession(sessionId);
      await workspaces.getWorkspace(workspaceId);
      trace.phase = "execution";
      if (name === "process_status") {
        const snapshot = processes.inspect(workspaceId, sessionId, bounded(args.max_output_tokens, 10_000, 0, 100_000));
        return objectResult({
          session_id: sessionId, state: snapshot.running ? "running" : "exited",
          stdout: snapshot.stdout, stderr: snapshot.stderr, output: snapshot.output,
          stdout_truncated: snapshot.stdoutTruncated, stderr_truncated: snapshot.stderrTruncated,
          elapsed_seconds: (snapshot.elapsedMs ?? 0) / 1000,
          started_at: snapshot.startedAt, completed_at: snapshot.completedAt,
          timed_out: snapshot.timedOut, cancel_requested: snapshot.cancelRequested,
          exit_code: codexProcessResult(snapshot).structuredContent?.exit_code,
          signal: snapshot.signal, server_instance_id: SERVER_INSTANCE_ID,
          note: "Bounded history; does not consume pending poll output. Retained for five minutes after exit, subject to capacity. Not durable across server restart.",
        });
      }
      const chars = (args.chars as string | undefined) ?? "";
      trace.started = true;
      return codexProcessResult(await processes.write({
        workspaceId, sessionId, chars,
        yieldTimeMs: bounded(args.yield_time_ms, chars ? 250 : 5_000, chars ? 0 : 5_000, chars ? 30_000 : 300_000),
        maxOutputTokens: bounded(args.max_output_tokens, 10_000, 0, 100_000),
      }));
    }
    const parsed = name === "apply_patch" ? parseCodexPatch(args.patch as string) : undefined;
    const id = args.environment_id as string | undefined;
    if (id && parsed?.environmentId && id !== parsed.environmentId) throw new Error("Conflicting environment IDs in arguments and patch.");
    const entry = await environment(id ?? parsed?.environmentId);
    trace.phase = "instructions";
    if (name === "exec_command") {
      if (!(args.cmd as string).trim()) throw new Error("Command cannot be empty.");
      if (args.tty === true && process.platform === "win32") throw new Error("This DevSpace runtime has no Windows ConPTY support; use WSL for tty=true.");
      const cwd = workspaces.resolveWorkingDirectory(entry.workspace, resolve(entry.cwd, (args.workdir as string | undefined) ?? "."));
      const control = await preflight(entry, [cwd], true);
      if (control) return control;
      trace.phase = "execution"; trace.started = true;
      return codexProcessResult(await processes.start({
        workspaceId: entry.workspace.id, workspaceRoot: entry.workspace.root, cwd,
        command: args.cmd as string, tty: args.tty as boolean | undefined,
        captureCombinedOutput: true, closeStdin: args.tty !== true,
        retainCompleted: true,
        timeoutMs: 0, // A yield is not a kill timeout. Long commands remain pollable.
        yieldTimeMs: bounded(args.yield_time_ms, 10_000, process.platform === "win32" ? 10_000 : 250, 30_000),
        maxOutputTokens: bounded(args.max_output_tokens, 10_000, 0, 100_000),
      }));
    }
    if (parsed) {
      const directories: string[] = [];
      for (const operation of parsed.operations) {
        const path = await containedPatchPath(entry.workspace.root, operation.path);
        directories.push(dirname(path));
        if (operation.kind === "update" && operation.moveTo) directories.push(dirname(await containedPatchPath(entry.workspace.root, operation.moveTo)));
      }
      // New directories may not exist: instruction discovery uses the deepest existing scope.
      const scopes = await Promise.all(directories.map(async (directory) => {
        let scope = directory;
        while (scope !== entry.workspace.root) {
          try {
            if (!(await stat(scope)).isDirectory()) throw new Error("Not a directory.");
            workspaces.resolveWorkingDirectory(entry.workspace, scope);
            return scope;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            scope = dirname(scope);
          }
        }
        return scope;
      }));
      const control = await preflight(entry, scopes);
      if (control) return control;
      trace.phase = "execution"; trace.started = true;
      return textResult(await applyCodexPatch(entry.workspace.root, parsed));
    }
    if (name === "view_image" || name === "view_images") {
      const inputs = name === "view_image"
        ? [{ path: args.path as string, crop: args.crop as Crop | undefined }]
        : args.images as Array<{ path: string; crop?: Crop; label?: string }>;
      if (args.difference && inputs.length !== 2) throw new Error("A difference view needs exactly two images.");
      const resolved = await Promise.all(inputs.map(async (input) => ({ ...input,
        absolutePath: await containedPatchPath(entry.workspace.root, resolve(entry.cwd, input.path)),
      })));
      const control = await preflight(entry, resolved.map((input) => dirname(input.absolutePath)));
      if (control) return control;
      trace.phase = "resource";
      return viewImages(resolved, args.max_dimension as number | undefined ?? (name === "view_images" ? 1600 : undefined), args.difference === true);
    }
    if (name === "inspect_files") {
      const paths = await Promise.all((args.paths as string[]).map(async (path) => ({
        path, absolutePath: path === "." || path === entry.workspace.root ? entry.workspace.root
          : await containedPatchPath(entry.workspace.root, path),
      })));
      const scopes = await Promise.all(paths.map(async ({ absolutePath }) => {
        let scope = (await stat(absolutePath).catch(() => undefined))?.isDirectory()
          ? absolutePath : dirname(absolutePath);
        while (scope !== entry.workspace.root) {
          try { if ((await stat(scope)).isDirectory()) return scope; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          scope = dirname(scope);
        }
        return scope;
      }));
      const control = await preflight(entry, scopes);
      if (control) return control;
      trace.phase = "resource";
      return objectResult(await inspectFiles(paths, args.sha256 === true));
    }
    if (name === "export_file") {
      if (!exportManager) throw new Error("File export is not configured for this server.");
      try {
        const path = args.path as string;
        const target = workspaces.resolvePath(entry.workspace, path);
        const control = await preflight(entry, [dirname(target)]);
        if (control) return control;
        if (args.delivery === "embedded") {
          if (!exportManager.readResource) throw new ExportFileError("Embedded resource delivery is unavailable.");
          if ((await stat(target)).size > 4 * 1024 * 1024) throw new ExportFileError("Embedded delivery is limited to 4 MiB; use link delivery for larger files.");
        }
        trace.phase = "resource"; trace.started = true;
        const exported = await exportManager.exportFile({ workspaceRoot: entry.workspace.root, path });
        const result = objectResult({
          url: exported.url, filename: exported.name, mime_type: exported.mimeType,
          size: exported.size, sha256: exported.sha256, expires_at: exported.expiresAt,
        });
        result.content.unshift({
          type: "resource_link", uri: exported.url, name: exported.name,
          mimeType: exported.mimeType, size: exported.size,
        });
        if (args.delivery === "embedded") {
          const resource = await exportManager.readResource!(exported.url);
          result.content.push({ type: "resource", resource });
        }
        return result;
      } catch (error) {
        if (error instanceof ExportFileError) throw error;
        throw new Error("Unable to export file.");
      }
    }
    const readPath = workspaces.resolveReadPath(entry.workspace, args.path as string);
    const directInstructions = !readPath.skillRead && await workspaces.isDirectInstructionRead(entry.workspace, args.path as string);
    if (!readPath.skillRead && !directInstructions) {
      const control = await preflight(entry, [dirname(readPath.absolutePath)]);
      if (control) return control;
    }
    trace.phase = "resource";
    const bytes = await readSmallFile(readPath.absolutePath, 8 * 1024 * 1024);
    if (bytes.includes(0)) throw new Error("Not a text file; use view_image for images.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = text.split("\n");
    if (text.endsWith("\n") || text === "") lines.pop();
    const first = bounded(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const count = bounded(args.limit, 2_000, 1, 2_000);
    const selected = lines.slice(first - 1, first - 1 + count).join("\n");
    const content = selected.slice(0, 40_000);
    workspaces.markReadPathLoaded(entry.workspace, readPath);
    return objectResult({ path: args.path, ...(readPath.skillRead ? { source_path: readPath.absolutePath } : {}), start_line: first, total_lines: lines.length, content, truncated: selected.length > content.length || first - 1 + count < lines.length });
  }
  return { tools, async call(name, args = {}, rpcRequestId) {
    const start = performance.now();
    const trace: CallTrace = { request_id: randomUUID(), http_request_id: requestContext.getStore()?.requestId,
      rpc_request_id: rpcRequestId, phase: "validation", started: false };
    const correlation = { requestId: trace.request_id, httpRequestId: trace.http_request_id, rpcRequestId };
    log?.({ ...correlation, tool: name, success: true, durationMs: 0, phase: "received", executionState: "not_started" });
    try {
      const result = await call(name, args, trace);
      const blocked = result.structuredContent?.status === "instructions_required";
      const executionState = blocked ? "not_started" : "completed";
      log?.({ ...correlation, tool: name, phase: "finished", executionState, failureLayer: blocked ? "instructions" : undefined,
        success: !blocked, durationMs: performance.now() - start, command: name === "exec_command" ? args.cmd as string : undefined, workspaceId: args.environment_id as string | undefined });
      return { ...result, _meta: { ...result._meta, devspace: {
        request_id: trace.request_id, http_request_id: trace.http_request_id, rpc_request_id: rpcRequestId,
        server_instance_id: SERVER_INSTANCE_ID, execution_state: executionState,
        ...(blocked ? { failure_layer: "instructions", retry_safe: true } : {}),
      } } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const executionState = trace.started ? "unknown" : "not_started";
      log?.({ ...correlation, tool: name, phase: "finished", executionState, failureLayer: trace.phase, success: false, durationMs: performance.now() - start, error: message.slice(0, 1000) });
      const details = { error: message, request_id: trace.request_id, http_request_id: trace.http_request_id,
        rpc_request_id: rpcRequestId, server_instance_id: SERVER_INSTANCE_ID,
        failure_layer: trace.phase, execution_state: executionState,
        retry_safe: !trace.started || tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint === true };
      const structured = name === "exec_command" || name === "write_stdin"
        ? { ...details, output: message, wall_time_seconds: (performance.now() - start) / 1000 } : details;
      return { ...objectResult(structured), isError: true, _meta: { devspace: details } };
    }
  } };
}
