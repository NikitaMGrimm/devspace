import { constants } from "node:os";
import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";
import { applyCodexPatch, containedPatchPath, parseCodexPatch } from "./codex-patch.js";

// Tool descriptions/schema descriptions adapted from OpenAI Codex (Apache-2.0).
// See docs/licenses/openai-codex-Apache-2.0.txt.
// Pinned, not downloaded at startup. See docs/codex-compatibility.md for deliberate deviations.
export const CODEX_COMPAT_COMMIT = "c126b0d8ef87fbcde2df7b9c40f24aa91b855758";
export const CODEX_SERVER_INSTRUCTIONS = "Use these tools directly; do not delegate to Codex. Call open_workspace once for a project or worktree. It returns environment_id, cwd and project instructions. Omit environment_id only when one environment is open; otherwise supply it explicitly. Use exec_command for file inspection, searches and commands, apply_patch for edits, and write_stdin to poll or interact with a running process. Use view_image for local images. The read extension resolves advertised skill:// resources; read a matching skill before using it. If a tool reports that project instructions changed, read them and retry: that operation was not executed. MCP carries apply_patch in the JSON string field patch, not as a freeform transport. File tools are workspace-scoped; shell commands are not an OS sandbox. Tool definitions are fixed for the lifetime of this profile.";

const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });
const environment = string("Environment ID returned by open_workspace. Omit only when exactly one environment is open.");
const budget = number("Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.");
const outputSchema: Tool["inputSchema"] = {
  type: "object", additionalProperties: false,
  properties: {
    chunk_id: string("Chunk identifier included when the response reports one."),
    wall_time_seconds: number("Elapsed wall time spent waiting for output in seconds."),
    exit_code: number("Process exit code when the command finished during this call."),
    session_id: number("Session identifier to pass to write_stdin when the process is still running."),
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
    }, ["path"], true),
    definition("read", "DevSpace extension: read a bounded text file or an advertised skill:// resource. Prefer exec_command for ordinary code inspection and searches. Read a skill's SKILL.md before its other resources.", {
      path: string("Workspace-relative text path or advertised skill:// resource."),
      offset: number("One-based first line. Defaults to 1."),
      limit: number("Maximum lines to return. Defaults to 2000; capped at 2000."),
      environment_id: environment,
    }, ["path"], true),
  ];
}

type Arguments = Record<string, unknown>;
type SchemaProperty = { type: string; enum?: string[] };
function validate(tool: Tool, args: Arguments): void {
  const properties = tool.inputSchema.properties as Record<string, SchemaProperty>;
  for (const name of tool.inputSchema.required ?? []) {
    if (!Object.hasOwn(args, name)) throw new Error(`Missing argument: ${name}`);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) throw new Error(`Unknown argument: ${name}`);
    if (typeof value !== property.type || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`Invalid ${name}: expected ${property.type}.`);
    }
    if (property.enum && !property.enum.includes(value as string)) throw new Error(`Invalid ${name}.`);
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
  };
  return objectResult(data);
}

async function readSmallFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a regular file.");
    if (stat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte tool limit.`);
    // A bounded read also protects against a file growing after stat().
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size || used > maxBytes) throw new Error("File grew during read; retry.");
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}
function imageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("Unsupported image; use PNG, JPEG, GIF or WebP. SVG is not accepted.");
}

interface Environment { workspace: Workspace; cwd: string }
export interface CodexCallLog { tool: string; success: boolean; durationMs: number; error?: string; command?: string; workspaceId?: string }

/** One immutable tool catalog per MCP connection; no mutable process-wide selected workspace. */
export function createCodexToolset(
  workspaces: WorkspaceRegistry,
  processes: ProcessSessionManager,
  log?: (entry: CodexCallLog) => void,
): { tools: Tool[]; call(name: string, args?: Arguments): Promise<CallToolResult> } {
  const tools = codexToolDefinitions();
  const environments = new Map<string, Environment>();
  function isolatedWorkspace(workspace: Workspace): Workspace {
    return { ...workspace, deliveredInstructionHashes: new Map(), activatedSkillIds: new Set() };
  }
  async function environment(id?: string): Promise<Environment> {
    if (!id) {
      if (environments.size !== 1) throw new Error("Call open_workspace first, then specify environment_id when more than one project is open.");
      id = environments.keys().next().value!;
    }
    // Explicit IDs can be restored after reconnect, using the existing registry's allowlist checks.
    const current = await workspaces.getWorkspace(id);
    let entry = environments.get(id);
    if (!entry) { entry = { workspace: isolatedWorkspace(current), cwd: current.root }; environments.set(id, entry); }
    return entry;
  }
  async function preflight(entry: Environment, directories: string[], processTool = false): Promise<CallToolResult | undefined> {
    const instructions: string[] = [];
    for (const directory of new Set(directories)) {
      const required = await workspaces.preflightInstructions(entry.workspace, directory);
      if (required) instructions.push(required.instructions);
    }
    if (!instructions.length) return undefined;
    const output = "Operation was NOT executed. Read the applicable project instructions below and retry the same tool call.\n\n" + instructions.join("\n\n");
    return processTool ? objectResult({ output, wall_time_seconds: 0 }) : textResult(output);
  }
  async function call(name: string, args: Arguments): Promise<CallToolResult> {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validate(tool, args);
    if (name === "open_workspace") {
      const context = await workspaces.openWorkspace({ path: args.path as string, mode: args.mode as "checkout" | "worktree" | undefined, baseRef: args.base_ref as string | undefined });
      const entry: Environment = environments.get(context.workspace.id) ?? { workspace: isolatedWorkspace(context.workspace), cwd: context.instructionChain.scope };
      entry.cwd = context.instructionChain.scope;
      // Preserve per-connection instruction/skill state, refreshing the advertised catalog.
      entry.workspace.skillResources = context.workspace.skillResources;
      entry.workspace.skills = context.workspace.skills;
      environments.set(entry.workspace.id, entry);
      const chain = await workspaces.markInstructionsDelivered(entry.workspace, entry.cwd);
      return objectResult({
        environment_id: entry.workspace.id, cwd: entry.cwd, mode: entry.workspace.mode,
        ...(entry.workspace.worktree ? { worktree: entry.workspace.worktree } : {}),
        instructions: chain.instructions, instructions_truncated: chain.truncated,
        skills: entry.workspace.skillResources.map(({ skill, resource }) => ({ name: skill.name, description: skill.description, resource })),
      });
    }
    if (name === "write_stdin") {
      const sessionId = args.session_id as number;
      if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Invalid session_id.");
      const workspaceId = processes.workspaceForSession(sessionId);
      await workspaces.getWorkspace(workspaceId);
      const chars = (args.chars as string | undefined) ?? "";
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
    if (name === "exec_command") {
      if (!(args.cmd as string).trim()) throw new Error("Command cannot be empty.");
      if (args.tty === true && process.platform === "win32") throw new Error("This DevSpace runtime has no Windows ConPTY support; use WSL for tty=true.");
      const cwd = workspaces.resolveWorkingDirectory(entry.workspace, resolve(entry.cwd, (args.workdir as string | undefined) ?? "."));
      const control = await preflight(entry, [cwd], true);
      if (control) return control;
      return codexProcessResult(await processes.start({
        workspaceId: entry.workspace.id, workspaceRoot: entry.workspace.root, cwd,
        command: args.cmd as string, tty: args.tty as boolean | undefined,
        captureCombinedOutput: true, closeStdin: args.tty !== true,
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
      return control ?? textResult(await applyCodexPatch(entry.workspace.root, parsed));
    }
    if (name === "view_image") {
      const path = await containedPatchPath(entry.workspace.root, resolve(entry.cwd, args.path as string));
      const control = await preflight(entry, [dirname(path)]);
      if (control) return control;
      const data = await readSmallFile(path, 8 * 1024 * 1024);
      return { content: [{ type: "image", data: data.toString("base64"), mimeType: imageMime(data) }] };
    }
    const readPath = workspaces.resolveReadPath(entry.workspace, args.path as string);
    const directInstructions = !readPath.skillRead && await workspaces.isDirectInstructionRead(entry.workspace, args.path as string);
    if (!readPath.skillRead && !directInstructions) {
      const control = await preflight(entry, [dirname(readPath.absolutePath)]);
      if (control) return control;
    }
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
    return objectResult({ path: args.path, start_line: first, total_lines: lines.length, content, truncated: selected.length > content.length || first - 1 + count < lines.length });
  }
  return { tools, async call(name, args = {}) {
    const start = performance.now();
    try {
      const result = await call(name, args);
      log?.({ tool: name, success: true, durationMs: performance.now() - start, command: name === "exec_command" ? args.cmd as string : undefined, workspaceId: args.environment_id as string | undefined });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.({ tool: name, success: false, durationMs: performance.now() - start, error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  } };
}
