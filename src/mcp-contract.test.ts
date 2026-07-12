import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { createMcpServerForTesting } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-mcp-contract-"));
const stateDir = await mkdtemp(join(tmpdir(), "devspace-mcp-state-"));
const configDir = await mkdtemp(join(tmpdir(), "devspace-mcp-config-"));
const externalSkills = await mkdtemp(join(tmpdir(), "devspace-mcp-skills-"));
await mkdir(join(externalSkills, "outside-skill"));
await writeFile(
  join(externalSkills, "outside-skill", "SKILL.md"),
  "---\nname: outside-skill\ndescription: External skill for contract testing.\n---\n\n# Outside\n",
);
await writeFile(join(root, "AGENTS.md"), "root instructions\n");
await writeFile(join(root, "sample.txt"), "hello\nworld\n");
await mkdir(join(root, "nested"));
await writeFile(join(root, "nested", "AGENTS.override.md"), "nested instructions\n");
await git(root, ["init"]);
await git(root, ["config", "user.email", "devspace@example.com"]);
await git(root, ["config", "user.name", "DevSpace Test"]);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "Initial"]);

const running = createMcpServerForTesting(loadConfig({
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_TOOL_MODE: "codex",
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_SKILL_PATHS: externalSkills,
}));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "devspace-contract-test", version: "1" });
await running.server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "apply_patch", "exec_command", "open_workspace", "read", "write_stdin",
  ]);
  for (const tool of listed.tools) assert.ok(tool.outputSchema, `${tool.name} needs outputSchema`);
  const patchTool = listed.tools.find((tool) => tool.name === "apply_patch");
  assert.ok(patchTool);
  assert.equal(patchTool.inputSchema.additionalProperties, false);
  const operationSchema = (patchTool.inputSchema.properties as Record<string, Record<string, unknown>>).operation;
  assert.ok(Array.isArray(operationSchema.oneOf));
  assert.equal(operationSchema.oneOf.length, 3);
  assert.equal(listed.tools.some((tool) => tool.name === "show_changes"), false);
  assert.equal(listed.tools.some((tool) => tool.name === "export_file"), false);

  const opened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  const workspace = opened.structuredContent as Record<string, unknown>;
  const workspaceId = workspace.workspaceId as string;
  assert.equal(workspace.root, root);
  assert.deepEqual(workspace.instructionSources, ["AGENTS.md"]);
  assert.match(workspace.instructions as string, /root instructions/);
  assert.equal((workspace.git as Record<string, unknown>).isRepository, true);
  const externalSkill = (workspace.skills as Array<Record<string, unknown>>)
    .find((skill) => skill.name === "outside-skill");
  assert.ok(externalSkill);
  const skillRead = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: externalSkill.path, offset: 1, limit: 20 },
  });
  assert.match((skillRead.structuredContent as Record<string, unknown>).content as string, /# Outside/);

  const read = await client.callTool({
    name: "read", arguments: { workspaceId, path: "sample.txt", offset: 1, limit: 1 },
  });
  assert.deepEqual(read.structuredContent, {
    path: "sample.txt", startLine: 1, endLine: 1, totalLines: 2, content: "hello", truncated: true,
  });

  const patched = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      operation: { type: "update_file", path: "sample.txt", diff: "@@\n-hello\n+HELLO" },
    },
  });
  assert.equal((patched.structuredContent as Record<string, unknown>).status, "completed");
  assert.equal(JSON.stringify(patched.structuredContent).includes("@@"), false);
  assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "HELLO\nworld\n");

  const preflight = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "printf should-not-run", workingDirectory: "nested" },
  });
  assert.equal((preflight.structuredContent as Record<string, unknown>).status, "instructions_required");
  assert.equal((preflight.structuredContent as Record<string, unknown>).retryRequired, true);
  assert.deepEqual((preflight.structuredContent as Record<string, unknown>).instructionSources, [
    "AGENTS.md", "nested/AGENTS.override.md",
  ]);

  const separated = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: "printf out; printf err >&2",
      workingDirectory: "nested",
      yieldTimeMs: 10_000,
    },
  });
  const separatedResult = separated.structuredContent as Record<string, unknown>;
  assert.equal(separatedResult.stdout, "out");
  assert.equal(separatedResult.stderr, "err");
  assert.equal((separatedResult.outcome as Record<string, unknown>).type, "exit");

  const background = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "sleep 0.1; printf done", yieldTimeMs: 0 },
  });
  const runningOutcome = (background.structuredContent as Record<string, unknown>).outcome as Record<string, unknown>;
  assert.equal(runningOutcome.type, "running");
  const polled = await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId: runningOutcome.sessionId, yieldTimeMs: 10_000 },
  });
  assert.equal(((polled.structuredContent as Record<string, unknown>).outcome as Record<string, unknown>).type, "exit");
  assert.match((polled.structuredContent as Record<string, unknown>).stdout as string, /done/);

  const generated = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "printf 'formatted\\n' >> sample.txt", yieldTimeMs: 10_000 },
  });
  assert.equal(((generated.structuredContent as Record<string, unknown>).outcome as Record<string, unknown>).type, "exit");
  const inspected = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "git status --short; git diff --stat; git diff -- sample.txt", yieldTimeMs: 10_000 },
  });
  const inspectionOutput = (inspected.structuredContent as Record<string, unknown>).stdout as string;
  assert.match(inspectionOutput, /M sample\.txt/);
  assert.match(inspectionOutput, /formatted/);
} finally {
  await client.close();
  await running.close();
}
