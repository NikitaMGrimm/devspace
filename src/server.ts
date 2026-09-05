import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { dirname, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { requestContext } from "./request-context.js";
import { CODEX_SERVER_INSTRUCTIONS, createCodexToolset } from "./codex-tools.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool as registerMcpAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyStructuredPatch, type StructuredPatchOperation } from "./apply-patch.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import { git } from "./git.js";
import {
  DevSpaceExportManager,
  ExportFileError,
  exportToolResult,
  redactExportRequestPath,
} from "./export-manager.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";

type Transport = StreamableHTTPServerTransport;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const registerDevSpaceTool: typeof registerMcpAppTool = (server, name, config, handler) => {
  if (config._meta?.ui?.resourceUri) {
    return registerMcpAppTool(server, name, config, handler);
  }
  const { _meta: _unusedMeta, ...plainConfig } = config;
  return server.registerTool(name, plainConfig, handler);
};

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
  size?: number;
  mimeType?: string;
  sha256Prefix?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  resultCategory?: string;
  exitCode?: number;
  requestId?: string;
  httpRequestId?: string;
  rpcRequestId?: string | number;
  phase?: "received" | "finished";
  executionState?: string;
  failureLayer?: string;
}

function serverInstructions(config: ServerConfig): string {
  if (config.toolMode === "strict-codex") return CODEX_SERVER_INSTRUCTIONS;
  if (config.toolMode === "codex") {
    return "Call open_workspace once per project or worktree and reuse its workspace_id. Respect the project instructions it returns and any later instructions_required response. When a returned skill matches the task, read its advertised skill:// resource before proceeding; resolve referenced files beneath that resource. Use read for a known text file, exec_command for searches and commands, apply_patch for structured text edits, write_stdin for running sessions, and export_file for downloadable artifacts. Keep command output bounded.";
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's advertised resource before proceeding. Resolve relative files named by SKILL.md beneath the same skill resource; ${toolNames.read} permits them only after SKILL.md is loaded. `
    : "";

  const agentsMd = `Follow the project instructions returned by ${toolNames.openWorkspace}. If a tool returns instructions_required for a nested or changed scope, read those instructions and retry the original call. `;

  return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId and reuse it. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for intentional direct text edits and ${toolNames.write} for new files or complete rewrites. Commands may modify files when required by formatters, package managers, build systems, migrations, generators, Git operations, or project scripts. Inspect resulting changes and avoid unrelated modifications.`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  resource: z.string(),
  origin: z.enum(["workspace-local", "global"]),
});

function modelSkillDiagnostics(
  diagnostics: Array<{
    type: string;
    message: string;
    collision?: { resourceType?: string; name?: string };
  }>,
): Array<Record<string, unknown>> {
  return diagnostics.map((diagnostic) => ({
    type: diagnostic.type,
    message: diagnostic.message,
    ...(diagnostic.collision
      ? {
          collision: {
            resource_type: diagnostic.collision.resourceType,
            name: diagnostic.collision.name,
          },
        }
      : {}),
  }));
}

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const codexWorkspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  provider_available: z.boolean().optional(),
  provider_unavailable_reason: z.string().optional(),
});

const codexWorkspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", fields.phase === "received" ? "tool_call_received" : "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function instructionPreflightResponse(preflight: {
  status: "instructions_required";
  instructionSources: string[];
  instructions: string;
  truncated: boolean;
  retryRequired: true;
}, codex = false) {
  const structuredContent = codex ? {
    status: preflight.status,
    instruction_sources: preflight.instructionSources,
    instructions: preflight.instructions,
    truncated: preflight.truncated,
    retry_required: preflight.retryRequired,
  } : { ...preflight };
  return {
    content: [textBlock("Project instructions changed for this scope; read them and retry the original call.")],
    structuredContent,
  };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

async function readBoundedTextFile(
  absolutePath: string,
  displayPath: string,
  offset = 1,
  limit = 2_000,
): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}> {
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    throw new Error("Binary files cannot be read as text; use export_file to return a downloadable artifact.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8 text; use export_file to return a downloadable artifact.");
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized === "" ? [] : normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const startIndex = Math.min(offset - 1, lines.length);
  const selected = lines.slice(startIndex, startIndex + limit);
  const content = selected.join("\n") + (
    selected.length > 0 && startIndex + selected.length === lines.length && text.endsWith("\n") ? "\n" : ""
  );
  return {
    path: displayPath,
    startLine: startIndex + 1,
    endLine: startIndex + selected.length,
    totalLines: lines.length,
    content,
    truncated: startIndex + selected.length < lines.length,
  };
}

async function workspaceGitState(root: string): Promise<{
  isRepository: boolean;
  branch?: string;
  detached: boolean;
  headCommit?: string;
  dirty: boolean;
  upstreamBranch?: string;
  ahead?: number;
  behind?: number;
  synchronized?: boolean;
}> {
  try {
    const headCommit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    let branch: string | undefined;
    try {
      branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || undefined;
    } catch {
      branch = undefined;
    }
    const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=normal"])).stdout.length > 0;
    let upstreamBranch: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    try {
      upstreamBranch = (await git(root, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ])).stdout.trim() || undefined;
      const counts = (await git(root, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ])).stdout.trim().split(/\s+/u).map(Number);
      if (counts.length === 2 && counts.every(Number.isSafeInteger)) {
        [ahead, behind] = counts;
      }
    } catch {
      upstreamBranch = undefined;
    }
    return {
      isRepository: true,
      branch,
      detached: !branch,
      headCommit,
      dirty,
      upstreamBranch,
      ahead,
      behind,
      synchronized: ahead !== undefined && behind !== undefined
        ? ahead === 0 && behind === 0
        : undefined,
    };
  } catch {
    return { isRepository: false, detached: false, dirty: false };
  }
}

function skillOrigin(workspaceRoot: string, filePath: string): "workspace-local" | "global" {
  const root = resolve(workspaceRoot);
  const skill = resolve(filePath);
  return skill === root || skill.startsWith(`${root}${sep}`) ? "workspace-local" : "global";
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processOutputSchema(): z.ZodRawShape {
  return {
    status: z.enum(["instructions_required", "failed"]).optional(),
    instruction_sources: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    truncated: z.boolean().optional(),
    retry_required: z.boolean().optional(),
    error: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    outcome: z.discriminatedUnion("type", [
      z.object({ type: z.literal("exit"), exit_code: z.number().int(), signal: z.string().optional() }).strict(),
      z.object({ type: z.literal("running"), session_id: z.number().int() }).strict(),
      z.object({ type: z.literal("timeout") }).strict(),
    ]).optional(),
    wall_time_seconds: z.number().nonnegative().optional().describe("Elapsed wall time spent waiting for output during this tool call."),
    stdout_truncated: z.literal(true).optional(),
    stderr_truncated: z.literal(true).optional(),
    original_output_tokens: z.number().int().nonnegative().optional(),
  };
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const outcome = snapshot.timedOut
    ? { type: "timeout" as const }
    : snapshot.running
      ? { type: "running" as const, session_id: snapshot.sessionId! }
      : { type: "exit" as const, exit_code: snapshot.exitCode ?? 1, signal: snapshot.signal };
  const result = outcome.type === "running"
    ? `Process is still running (session ${outcome.session_id}).`
    : outcome.type === "timeout"
      ? "Process reached its execution timeout."
      : `Process exited with code ${outcome.exit_code}.`;
  return {
    content: [textBlock(result)],
    _meta: {
      tool,
      card: {
        workspaceId,
        summary,
      },
    },
    structuredContent: {
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      outcome,
      wall_time_seconds: snapshot.wallTimeMs / 1_000,
      ...(snapshot.stdoutTruncated ? { stdout_truncated: true as const } : {}),
      ...(snapshot.stderrTruncated ? { stderr_truncated: true as const } : {}),
      ...(snapshot.originalOutputTokens !== undefined
        ? { original_output_tokens: snapshot.originalOutputTokens }
        : {}),
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  registerDevSpaceTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a shell command inside an open workspace, returning output or a session_id for ongoing interaction.",
      inputSchema: z.object({
        workspace_id: z.string().describe("Workspace returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        workdir: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Time to wait for output before returning a running session. Defaults to 10000. Zero yields immediately."),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .max(86_400_000)
          .optional()
          .describe("Execution timeout in milliseconds. Defaults to 60000; use 0 to disable."),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      }).strict(),
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, cmd, tty, workdir, yield_time_ms, timeout_ms, max_output_tokens }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workdir);
      const preflight = await workspaces.preflightInstructions(workspace, cwd);
      if (preflight) return instructionPreflightResponse(preflight, true);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        yieldTimeMs: yield_time_ms,
        timeoutMs: timeout_ms,
        maxOutputTokens: max_output_tokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workdir ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        stdoutBytes: Buffer.byteLength(snapshot.stdout),
        stderrBytes: Buffer.byteLength(snapshot.stderr),
        stdoutTruncated: snapshot.stdoutTruncated,
        stderrTruncated: snapshot.stderrTruncated,
        resultCategory: snapshot.timedOut ? "timeout" : snapshot.running ? "running" : "exit",
        exitCode: snapshot.exitCode,
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workdir ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerDevSpaceTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Write characters to an existing exec_command session and return recent output.",
      inputSchema: z.object({
        workspace_id: z.string().describe("Workspace that owns the session."),
        session_id: z.number().describe("Session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll. Pass \\u0003 for Ctrl-C."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      }).strict(),
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, session_id, chars, yield_time_ms, max_output_tokens }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      await workspaces.getWorkspace(workspaceId);
      let snapshot: ProcessSnapshot;
      try {
        snapshot = await processSessions.write({
          workspaceId,
          sessionId,
          chars,
          yieldTimeMs: yield_time_ms,
          maxOutputTokens: max_output_tokens,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to interact with process session.";
        logToolCall(config, {
          tool: "write_stdin",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return {
          content: [textBlock(message)],
          structuredContent: { status: "failed" as const, error: message },
          isError: true,
        };
      }

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        stdoutBytes: Buffer.byteLength(snapshot.stdout),
        stderrBytes: Buffer.byteLength(snapshot.stderr),
        stdoutTruncated: snapshot.stdoutTruncated,
        stderrTruncated: snapshot.stderrTruncated,
        resultCategory: snapshot.timedOut ? "timeout" : snapshot.running ? "running" : "exit",
        exitCode: snapshot.exitCode,
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  exportManager: DevSpaceExportManager,
): McpServer {
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  if (config.toolMode === "strict-codex") {
    const tools = createCodexToolset(workspaces, processSessions, (entry) => logToolCall(config, entry), exportManager);
    server.server.registerCapabilities({ tools: {}, resources: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.tools }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      tools.call(request.params.name, request.params.arguments, extra.requestId),
    );
    // Links are capabilities, not a browsable listing of another client's exports.
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [await exportManager.readResource(request.params.uri)],
    }));
    return server;
  }

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  const handleExportFile = async (
    workspaceId: string,
    path: string,
    downloadName?: string,
    codexResult = false,
  ) => {
    const startedAt = performance.now();
    try {
      const workspace = await workspaces.getWorkspace(workspaceId);
      const target = workspaces.resolvePath(workspace, path);
      const preflight = await workspaces.preflightInstructions(workspace, dirname(target));
      if (preflight) return instructionPreflightResponse(preflight, codexResult);
      const result = await exportManager.exportFile({
        workspaceRoot: workspace.root,
        path,
        downloadName,
      });
      logToolCall(config, {
        tool: "export_file",
        workspaceId,
        size: result.size,
        mimeType: result.mimeType,
        sha256Prefix: result.sha256.slice(0, 12),
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (!codexResult) return exportToolResult(result);
      return {
        content: [{
          type: "resource_link" as const,
          uri: result.url,
          name: result.name,
          mimeType: result.mimeType,
          size: result.size,
        }],
        structuredContent: {
          url: result.url,
          filename: result.name,
          mime_type: result.mimeType,
          size: result.size,
          sha256: result.sha256,
          expires_at: result.expiresAt,
        },
      };
    } catch (error) {
      const message =
        error instanceof ExportFileError
          ? error.message
          : error instanceof Error && error.message.startsWith("Unknown workspaceId:")
            ? "Unknown workspace. Call open_workspace first."
            : "Unable to export file.";
      logToolCall(config, {
        tool: "export_file",
        workspaceId,
        success: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: message,
      });
      return { content: [textBlock(message)], isError: true };
    }
  };

  if (config.toolMode === "codex") registerDevSpaceTool(
    server,
    "export_file",
    {
      title: "Export file",
      description:
        "Export a regular workspace file as a downloadable resource. Use this for binary or downloadable artifacts instead of printing binary or base64 data.",
      inputSchema: z.object({
        workspace_id: z.string().describe("Workspace containing the file."),
        path: z.string().describe("Workspace-relative path to a regular file."),
      }).strict(),
      outputSchema: {
        status: z.literal("instructions_required").optional(),
        instruction_sources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        truncated: z.boolean().optional(),
        retry_required: z.boolean().optional(),
        url: z.string().url().optional(),
        filename: z.string().optional(),
        mime_type: z.string().optional(),
        size: z.number().int().nonnegative().optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        expires_at: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace_id, path }) => handleExportFile(workspace_id, path, undefined, true),
  );

  if (config.toolMode !== "codex") registerDevSpaceTool(
    server,
    "export_file",
    {
      title: "Export file",
      description:
        "Create a short-lived HTTPS download link for a regular file in an open workspace. The file is copied to an immutable temporary snapshot and is never returned in tool output.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("File path relative to the workspace root."),
        downloadName: z.string().optional().describe("Optional safe attachment filename."),
      },
      outputSchema: {
        status: z.literal("instructions_required").optional(),
        instructionSources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        truncated: z.boolean().optional(),
        retryRequired: z.boolean().optional(),
        url: z.string().url().optional(),
        name: z.string().optional(),
        mimeType: z.string().optional(),
        size: z.number().int().nonnegative().optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        expiresAt: z.string().optional(),
      },
      _meta: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ workspaceId, path, downloadName }) => handleExportFile(workspaceId, path, downloadName),
  );

  registerDevSpaceTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        config.toolMode === "codex"
          ? "Open a project checkout or managed worktree and return a reusable workspace_id, repository state, and active project instructions. Call once per project or worktree and reuse its workspace_id."
          : "Open a project checkout or managed worktree as a contained coding workspace. Call once per project or worktree and reuse the returned workspaceId. The result includes repository state and the active project-instruction chain.",
      inputSchema: config.toolMode === "codex" ? z.object({
        path: z.string().describe("Absolute or supported home-relative path inside an allowed root."),
        mode: z.enum(["checkout", "worktree"]).optional().describe("Open the existing checkout or create an isolated managed worktree."),
        base_ref: z.string().optional().describe("Git ref used only when creating a worktree. Defaults to HEAD."),
      }).strict() : z.object({
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      }).strict(),
      outputSchema: config.toolMode === "codex" ? {
        workspace_id: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        source_root: z.string().optional(),
        worktree: z.object({
          path: z.string(),
          base_ref: z.string(),
          base_sha: z.string(),
          dirty_source: z.boolean(),
          detached: z.boolean(),
          managed: z.boolean(),
        }).optional(),
        git: z.object({
          is_repository: z.boolean(),
          branch: z.string().optional(),
          detached: z.boolean(),
          head_commit: z.string().optional(),
          dirty: z.boolean(),
          upstream_branch: z.string().optional(),
          ahead: z.number().int().nonnegative().optional(),
          behind: z.number().int().nonnegative().optional(),
          synchronized: z.boolean().optional(),
        }),
        instruction_sources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        instructions_truncated: z.literal(true).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agent_providers: z.array(codexWorkspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(codexWorkspaceLocalAgentOutputSchema).optional(),
        skill_diagnostics: z.array(z.unknown()).optional(),
      } : {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        git: z.object({
          isRepository: z.boolean(),
          branch: z.string().optional(),
          detached: z.boolean(),
          headCommit: z.string().optional(),
          dirty: z.boolean(),
          upstreamBranch: z.string().optional(),
          ahead: z.number().int().nonnegative().optional(),
          behind: z.number().int().nonnegative().optional(),
          synchronized: z.boolean().optional(),
        }),
        instructionSources: z.array(z.string()),
        instructions: z.string(),
        instructionsTruncated: z.boolean(),
        skills: z.array(workspaceSkillOutputSchema),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema),
        agents: z.array(workspaceLocalAgentOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (rawInput: unknown) => {
      const input = rawInput as Record<string, unknown>;
      const path = input.path as string;
      const mode = input.mode as "checkout" | "worktree" | undefined;
      const baseRef = (config.toolMode === "codex" ? input.base_ref : input.baseRef) as string | undefined;
      const startedAt = performance.now();
      const { workspace, instructionChain } = await workspaces.openWorkspace({ path, mode, baseRef });
      const gitState = await workspaceGitState(workspace.root);
      const visibleSkills = workspace.skillResources
        .map(({ skill, resource }) => ({
          name: skill.name,
          description: skill.description,
          resource,
          origin: skillOrigin(workspace.root, skill.filePath),
        }));
      const visibleSkillDiagnostics = modelSkillDiagnostics(workspace.skillDiagnostics);
      const visibleAgentProviders = config.subagents ? localAgentProviders : [];
      const visibleAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = visibleAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const instructionSources = instructionChain.sources.map((source) =>
        formatAgentsPath(source.path, workspace.root)
      );
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: `Opened ${workspace.mode} workspace ${workspace.id} at ${workspace.root}.`,
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const sharedResult = {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            instructionSources,
            summary: {
              skills: visibleSkills.length,
              agentProviders: visibleAgentProviders.length,
              agents: visibleAgents.length,
              skillDiagnostics: visibleSkillDiagnostics.length,
            },
          },
        },
      };
      if (config.toolMode === "codex") {
        const codexAgents = visibleAgents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          provider: agent.provider,
          model: agent.model,
          thinking: agent.thinking,
          provider_available: agent.providerAvailable,
          provider_unavailable_reason: agent.providerUnavailableReason,
        }));
        return {
          ...sharedResult,
          structuredContent: {
            workspace_id: workspace.id,
            root: workspace.root,
            mode: workspace.mode,
            source_root: workspace.sourceRoot,
            worktree: workspace.worktree ? {
              path: workspace.worktree.path,
              base_ref: workspace.worktree.baseRef,
              base_sha: workspace.worktree.baseSha,
              dirty_source: workspace.worktree.dirtySource,
              detached: workspace.worktree.detached,
              managed: workspace.worktree.managed,
            } : undefined,
            git: {
              is_repository: gitState.isRepository,
              branch: gitState.branch,
              detached: gitState.detached,
              head_commit: gitState.headCommit,
              dirty: gitState.dirty,
              upstream_branch: gitState.upstreamBranch,
              ahead: gitState.ahead,
              behind: gitState.behind,
              synchronized: gitState.synchronized,
            },
            ...(instructionSources.length > 0 ? { instruction_sources: instructionSources } : {}),
            ...(instructionChain.instructions ? { instructions: instructionChain.instructions } : {}),
            ...(instructionChain.truncated ? { instructions_truncated: true as const } : {}),
            ...(visibleSkills.length > 0 ? { skills: visibleSkills } : {}),
            ...(visibleAgentProviders.length > 0 ? { agent_providers: visibleAgentProviders } : {}),
            ...(codexAgents.length > 0 ? { agents: codexAgents } : {}),
            ...(visibleSkillDiagnostics.length > 0
              ? { skill_diagnostics: visibleSkillDiagnostics }
              : {}),
          },
        };
      }
      return {
        ...sharedResult,
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          git: gitState,
          instructionSources,
          instructions: instructionChain.instructions,
          instructionsTruncated: instructionChain.truncated,
          skills: visibleSkills,
          agentProviders: visibleAgentProviders,
          agents: visibleAgents,
          skillDiagnostics: visibleSkillDiagnostics,
        },
      };
    },
  );

  registerDevSpaceTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        config.toolMode === "codex"
          ? "Read a bounded line range from a known workspace text file or advertised skill resource. Use exec_command for search, filtering, logs, generated output, or multi-file inspection."
          : "Read a bounded line range from a text file inside an open workspace. Use this for targeted inspection of a known file. Use exec_command for searches, filtering, logs, generated output, or multi-file inspection.",
      inputSchema: config.toolMode === "codex" ? z.object({
        workspace_id: z.string().describe("Workspace returned by open_workspace."),
        path: z.string().describe("Workspace-relative text-file path or advertised skill:// resource."),
        offset: z.number().int().positive().optional().describe("One-based first line. Defaults to 1."),
        limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
      }).strict() : z.object({
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill resource from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      }).strict(),
      outputSchema: config.toolMode === "codex" ? {
        status: z.literal("instructions_required").optional(),
        instruction_sources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        retry_required: z.boolean().optional(),
        path: z.string().optional(),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().nonnegative().optional(),
        total_lines: z.number().int().nonnegative().optional(),
        content: z.string().optional(),
        truncated: z.literal(true).optional(),
      } : {
        status: z.literal("instructions_required").optional(),
        instructionSources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        retryRequired: z.boolean().optional(),
        path: z.string().optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().nonnegative().optional(),
        totalLines: z.number().int().nonnegative().optional(),
        content: z.string().optional(),
        truncated: z.boolean(),
      },
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async (rawInput: unknown) => {
      const values = rawInput as Record<string, unknown>;
      const workspaceId = (config.toolMode === "codex" ? values.workspace_id : values.workspaceId) as string;
      const input = {
        path: values.path as string,
        offset: values.offset as number | undefined,
        limit: values.limit as number | undefined,
      };
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const directInstructionRead = readPath.skillRead
        ? false
        : await workspaces.isDirectInstructionRead(workspace, input.path);
      if (!readPath.skillRead && !directInstructionRead) {
        const preflight = await workspaces.preflightInstructions(workspace, dirname(readPath.absolutePath));
        if (preflight) return instructionPreflightResponse(preflight, config.toolMode === "codex");
      }
      let result;
      try {
        result = await readBoundedTextFile(
          readPath.absolutePath,
          input.path,
          input.offset,
          input.limit,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read text file.";
        logToolCall(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        return { content: [textBlock(message)], isError: true };
      }
      workspaces.markReadPathLoaded(workspace, readPath);
      if (directInstructionRead) {
        await workspaces.markInstructionsDelivered(workspace, dirname(readPath.absolutePath));
      }
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: [textBlock(`Read ${result.startLine}-${result.endLine} of ${result.totalLines} lines from ${input.path}.`)],
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary: {
              startLine: result.startLine,
              endLine: result.endLine,
              totalLines: result.totalLines,
              truncated: result.truncated,
            },
          },
        },
        structuredContent: config.toolMode === "codex" ? {
          path: result.path,
          start_line: result.startLine,
          end_line: result.endLine,
          total_lines: result.totalLines,
          content: result.content,
          ...(result.truncated ? { truncated: true as const } : {}),
        } : result,
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerDevSpaceTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: {
        result: z.string().optional(),
        status: z.literal("instructions_required").optional(),
        instructionSources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        truncated: z.boolean().optional(),
        retryRequired: z.boolean().optional(),
      },
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const target = workspaces.resolvePath(workspace, input.path);
      const preflight = await workspaces.preflightInstructions(workspace, dirname(target));
      if (preflight) return instructionPreflightResponse(preflight);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerDevSpaceTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: {
        result: z.string().optional(),
        status: z.enum(["applied", "instructions_required"]),
        instructionSources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        truncated: z.boolean().optional(),
        retryRequired: z.boolean().optional(),
      },
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const target = workspaces.resolvePath(workspace, input.path);
      const preflight = await workspaces.preflightInstructions(workspace, dirname(target));
      if (preflight) return instructionPreflightResponse(preflight);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    const patchOperationSchema = z.discriminatedUnion("type", [
      z.object({
        type: z.literal("create_file"),
        path: z.string().min(1).describe("Workspace-relative path for a file that must not already exist."),
        diff: z.string().describe("Complete new file as a V4A creation diff. Prefix every content line with + and do not include an @@ hunk header."),
      }).strict(),
      z.object({
        type: z.literal("update_file"),
        path: z.string().min(1).describe("Workspace-relative path for an existing file."),
        diff: z.string().describe("V4A update diff containing one or more @@ hunks."),
      }).strict(),
      z.object({
        type: z.literal("delete_file"),
        path: z.string().min(1).describe("Workspace-relative path for an existing file to delete."),
      }).strict(),
    ]);
    registerDevSpaceTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one structured text-file create, update, or delete operation inside an open workspace. Do not use *** Begin Patch or file-header wrappers.",
        inputSchema: z.object({
          workspace_id: z
            .string()
            .min(1)
            .describe("Workspace returned by open_workspace."),
          operation: patchOperationSchema,
        }).strict(),
        outputSchema: {
          status: z.enum(["completed", "failed", "instructions_required"]),
          instruction_sources: z.array(z.string()).optional(),
          instructions: z.string().optional(),
          truncated: z.boolean().optional(),
          retry_required: z.boolean().optional(),
          operation: z.enum(["create_file", "update_file", "delete_file"]).optional(),
          path: z.string().optional(),
          changed: z.boolean().optional(),
          fuzz: z.number().int().nonnegative().optional(),
          error: z.string().optional(),
        },
        _meta: {},
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspace_id, operation }) => {
        const startedAt = performance.now();
        const workspaceId = workspace_id;
        const workspace = await workspaces.getWorkspace(workspaceId);
        try {
          const target = workspaces.resolvePath(workspace, operation.path);
          const preflight = await workspaces.preflightInstructions(workspace, dirname(target));
          if (preflight) return instructionPreflightResponse(preflight, true);
          const applied = await applyStructuredPatch(workspace.root, operation as StructuredPatchOperation);
          logToolCall(config, {
            tool: "apply_patch",
            workspaceId,
            path: operation.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(`${operation.type} completed for ${operation.path}.`)],
            structuredContent: {
              status: applied.status,
              operation: applied.operation,
              path: applied.path,
              changed: applied.changed,
              ...(applied.fuzz > 0 ? { fuzz: applied.fuzz } : {}),
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "File operation failed; inspect the path and retry.";
          logToolCall(config, {
            tool: "apply_patch",
            workspaceId,
            path: operation.path,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error: message,
          });
          return {
            content: [textBlock(message)],
            structuredContent: {
              status: "failed" as const,
              operation: operation.type,
              path: operation.path,
              error: message,
            },
            isError: true,
          };
        }
      },
    );
  }

  if (config.toolMode === "full") {
    registerDevSpaceTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = await workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerDevSpaceTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = await workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerDevSpaceTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = await workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerDevSpaceTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? "Run a shell command inside an open workspace. In minimal mode, use command-line tools such as rg, find, and ls for search and directory inspection. Commands may modify files when required by formatters, package managers, builds, migrations, generators, Git operations, or project scripts. Keep output bounded and inspect resulting changes."
        : "Run a shell command inside an open workspace. Use it for tests, builds, Git inspection, package operations, and multi-file work. Commands may modify files when required by formatters, package managers, builds, migrations, generators, Git operations, or project scripts. Keep output bounded and inspect resulting changes.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe("Shell command to run inside the workspace."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: {
        result: z.string().optional(),
        status: z.literal("instructions_required").optional(),
        instructionSources: z.array(z.string()).optional(),
        instructions: z.string().optional(),
        truncated: z.boolean().optional(),
        retryRequired: z.boolean().optional(),
      },
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const preflight = await workspaces.preflightInstructions(workspace, cwd);
      if (preflight) return instructionPreflightResponse(preflight);
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions);
  }

  return server;
}

export function createMcpServerForTesting(config: ServerConfig): {
  server: McpServer;
  close(): Promise<void>;
} {
  const workspaces = new WorkspaceRegistry(config);
  const processSessions = new ProcessSessionManager();
  const exportManager = new DevSpaceExportManager({
    publicBaseUrl: config.publicBaseUrl,
    ...config.exports,
  });
  const server = createMcpServer(config, workspaces, processSessions, [], exportManager);
  return {
    server,
    async close() {
      processSessions.shutdown();
      await exportManager.close();
      await server.close();
    },
  };
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const exportManager = new DevSpaceExportManager({
    publicBaseUrl: config.publicBaseUrl,
    ...config.exports,
    log: (level, event, fields) => logEvent(config.logging, level, event, fields),
  });
  const processSessions = new ProcessSessionManager();
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error: result.error instanceof Error ? result.error.message : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(config.mcpSessionIdleTimeoutMs)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    res.on("finish", () => {
      const path = redactExportRequestPath(requestPath(req));
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    requestContext.run({ requestId }, next);
  });

  const handleDownload = async (req: Request, res: Response): Promise<void> => {
    try {
      await exportManager.handleHttp(req, res, String(req.params.token));
    } catch {
      if (res.headersSent) res.destroy();
      else res.sendStatus(404);
    }
  };
  app.head("/devspace-files/d/:token", handleDownload);
  app.get("/devspace-files/d/:token", handleDownload);

  app.get("/.well-known/openid-configuration", (_req, res) => {
    const baseUrl = config.publicBaseUrl.replace(/\/$/u, "");
    res.json({
      issuer: `${baseUrl}/`,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      revocation_endpoint: `${baseUrl}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      revocation_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: config.oauth.scopes,
    });
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
      clientRegistrationOptions: { rateLimit: false },
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.register(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId && transports.remove(closedSessionId)) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          processSessions,
          localAgentProviders,
          exportManager,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        processSessions.shutdown();
        oauthProvider.close();
        workspaceStore.close?.();
        await exportManager.close();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
