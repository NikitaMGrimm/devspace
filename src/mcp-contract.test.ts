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
const remote = await mkdtemp(join(tmpdir(), "devspace-mcp-remote-"));
await mkdir(join(externalSkills, "outside-skill"));
await mkdir(join(externalSkills, "broken-skill"));
await writeFile(
  join(externalSkills, "outside-skill", "SKILL.md"),
  "---\nname: outside-skill\ndescription: External skill for contract testing.\n---\n\n# Outside\n",
);
await writeFile(join(externalSkills, "outside-skill", "reference.md"), "skill reference\n");
await writeFile(join(externalSkills, "broken-skill", "SKILL.md"), "not valid skill frontmatter\n");
await mkdir(join(configDir, "agents"));
await writeFile(
  join(configDir, "agents", "reviewer.md"),
  "---\nname: reviewer\ndescription: Focused review agent.\nprovider: codex\n---\n\nReview changes.\n",
);
await writeFile(join(root, "AGENTS.md"), "root instructions\n");
await writeFile(join(root, "sample.txt"), "hello\nworld\n");
await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
await mkdir(join(root, ".agents", "skills", "project-skill"), { recursive: true });
await writeFile(
  join(root, ".agents", "skills", "project-skill", "SKILL.md"),
  "---\nname: project-skill\ndescription: Project skill for contract testing.\n---\n\n# Project\n",
);
await mkdir(join(root, "nested"));
await writeFile(join(root, "nested", "AGENTS.override.md"), "nested instructions\n");
await mkdir(join(root, "exports"));
await writeFile(join(root, "exports", "AGENTS.md"), "export instructions\n");
await writeFile(join(root, "exports", "artifact.txt"), "download me\n");
await git(root, ["init"]);
await git(root, ["config", "user.email", "devspace@example.com"]);
await git(root, ["config", "user.name", "DevSpace Test"]);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "Initial"]);
await git(remote, ["init", "--bare"]);
await git(root, ["remote", "add", "origin", remote]);
await git(root, ["push", "--set-upstream", "origin", "HEAD"]);

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
  DEVSPACE_SUBAGENTS: "1",
}));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "devspace-contract-test", version: "1" });
await running.server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "apply_patch", "exec_command", "export_file", "open_workspace", "read", "write_stdin",
  ]);
  assert.deepEqual(
    listed.tools
      .filter((tool) => tool._meta?.ui !== undefined)
      .map((tool) => tool.name),
    ["open_workspace"],
    "changes mode should advertise UI only for tools that return a workspace card",
  );
  for (const name of ["apply_patch", "export_file", "exec_command", "read", "write_stdin"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.equal(tool._meta, undefined, `${name} should omit disabled UI metadata`);
  }
  for (const tool of listed.tools) assert.ok(tool.outputSchema, `${tool.name} needs outputSchema`);
  const patchTool = listed.tools.find((tool) => tool.name === "apply_patch");
  assert.ok(patchTool);
  assert.equal(patchTool.inputSchema.additionalProperties, false);
  const operationSchema = (patchTool.inputSchema.properties as Record<string, Record<string, unknown>>).operation;
  assert.ok(Array.isArray(operationSchema.oneOf));
  assert.equal(operationSchema.oneOf.length, 3);
  assert.equal(listed.tools.some((tool) => tool.name === "show_changes"), false);
  const openTool = listed.tools.find((tool) => tool.name === "open_workspace");
  assert.ok(openTool);
  assert.equal(openTool.annotations?.readOnlyHint, false);
  assert.equal(openTool.annotations?.destructiveHint, false);
  const execTool = listed.tools.find((tool) => tool.name === "exec_command");
  assert.ok(execTool);
  assert.deepEqual(Object.keys(execTool.inputSchema.properties ?? {}).sort(), [
    "cmd", "max_output_tokens", "timeout_ms", "tty", "workdir", "workspace_id", "yield_time_ms",
  ]);
  assert.equal(execTool.inputSchema.additionalProperties, false);
  const stdinTool = listed.tools.find((tool) => tool.name === "write_stdin");
  assert.ok(stdinTool);
  assert.deepEqual(Object.keys(stdinTool.inputSchema.properties ?? {}).sort(), [
    "chars", "max_output_tokens", "session_id", "workspace_id", "yield_time_ms",
  ]);
  const unknownProperty = await client.callTool({
    name: "exec_command",
    arguments: { workspace_id: "unused", cmd: "true", unexpected: true },
  });
  assert.equal(unknownProperty.isError, true);
  assert.match(JSON.stringify(unknownProperty.content), /additional properties|unexpected/i);
  const legacyProperty = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId: "legacy", cmd: "true" },
  });
  assert.equal(legacyProperty.isError, true);
  assert.match(JSON.stringify(legacyProperty.content), /workspace_id|required/i);

  const opened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  const workspace = opened.structuredContent as Record<string, unknown>;
  const workspaceCard = (opened._meta as Record<string, unknown>).card as Record<string, unknown>;
  assert.deepEqual(workspaceCard.instructionSources, ["AGENTS.md"]);
  const workspaceId = workspace.workspace_id as string;
  const reopened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  assert.equal(
    (reopened.structuredContent as Record<string, unknown>).workspace_id,
    workspaceId,
  );
  assert.equal(workspace.root, root);
  assert.deepEqual(workspace.instruction_sources, ["AGENTS.md"]);
  assert.match(workspace.instructions as string, /root instructions/);
  const gitState = workspace.git as Record<string, unknown>;
  assert.equal(gitState.is_repository, true);
  assert.equal(gitState.upstream_branch, "origin/main");
  assert.equal(gitState.ahead, 0);
  assert.equal(gitState.behind, 0);
  assert.equal(gitState.synchronized, true);
  const externalSkill = (workspace.skills as Array<Record<string, unknown>>)
    .find((skill) => skill.name === "outside-skill");
  assert.ok(externalSkill);
  assert.deepEqual(Object.keys(externalSkill).sort(), ["description", "name", "origin", "resource"]);
  assert.equal(externalSkill.origin, "global");
  assert.match(externalSkill.resource as string, /^skill:\/\/catalog\/[a-f0-9]{64}\/SKILL\.md$/u);
  const projectSkill = (workspace.skills as Array<Record<string, unknown>>)
    .find((skill) => skill.name === "project-skill");
  assert.ok(projectSkill);
  assert.equal(projectSkill.origin, "workspace-local");

  await writeFile(join(root, "ahead.txt"), "ahead\n");
  await git(root, ["add", "ahead.txt"]);
  await git(root, ["commit", "-m", "Ahead"]);
  const aheadOpened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  const aheadGit = (aheadOpened.structuredContent as Record<string, unknown>)
    .git as Record<string, unknown>;
  assert.equal(aheadGit.dirty, false);
  assert.equal(aheadGit.ahead, 1);
  assert.equal(aheadGit.behind, 0);
  assert.equal(aheadGit.synchronized, false);
  const reviewer = (workspace.agents as Array<Record<string, unknown>>)
    .find((agent) => agent.name === "reviewer");
  assert.ok(reviewer);
  assert.equal("providerAvailable" in reviewer, false);
  assert.equal(reviewer.provider, "codex");
  assert.equal("agent_providers" in workspace, false);
  assert.ok(Array.isArray(workspace.skill_diagnostics));
  assert.ok((workspace.skill_diagnostics as unknown[]).length > 0);
  assert.equal(JSON.stringify(workspace.skill_diagnostics).includes(externalSkills), false);
  assert.equal("skillDiagnostics" in workspace, false);
  const skillRead = await client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: externalSkill.resource, offset: 1, limit: 20 },
  });
  assert.match((skillRead.structuredContent as Record<string, unknown>).content as string, /# Outside/);
  const skillReference = await client.callTool({
    name: "read",
    arguments: {
      workspace_id: workspaceId,
      path: (externalSkill.resource as string).replace("SKILL.md", "reference.md"),
    },
  });
  assert.match(
    (skillReference.structuredContent as Record<string, unknown>).content as string,
    /skill reference/,
  );

  const read = await client.callTool({
    name: "read", arguments: { workspace_id: workspaceId, path: "sample.txt", offset: 1, limit: 1 },
  });
  assert.deepEqual(read.structuredContent, {
    path: "sample.txt", start_line: 1, end_line: 1, total_lines: 2, content: "hello", truncated: true,
  });

  const patched = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      operation: { type: "update_file", path: "sample.txt", diff: "@@\n-hello\n+HELLO" },
    },
  });
  assert.equal((patched.structuredContent as Record<string, unknown>).status, "completed");
  assert.equal("fuzz" in (patched.structuredContent as Record<string, unknown>), false);
  assert.equal(JSON.stringify(patched.structuredContent).includes("@@"), false);
  assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "HELLO\nworld\n");

  const preflight = await client.callTool({
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "printf should-not-run", workdir: "nested" },
  });
  assert.equal((preflight.structuredContent as Record<string, unknown>).status, "instructions_required");
  assert.equal((preflight.structuredContent as Record<string, unknown>).retry_required, true);
  assert.deepEqual((preflight.structuredContent as Record<string, unknown>).instruction_sources, [
    "AGENTS.md", "nested/AGENTS.override.md",
  ]);

  const separated = await client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: "printf out; printf err >&2",
      workdir: "nested",
      yield_time_ms: 10_000,
      timeout_ms: 20_000,
      max_output_tokens: 100,
    },
  });
  const separatedResult = separated.structuredContent as Record<string, unknown>;
  assert.equal(separatedResult.stdout, "out");
  assert.equal(separatedResult.stderr, "err");
  assert.equal((separatedResult.outcome as Record<string, unknown>).type, "exit");

  const tinyOutput = await client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: "printf abcdef; printf ABCDEF >&2",
      max_output_tokens: 1,
    },
  });
  const tinyResult = tinyOutput.structuredContent as Record<string, unknown>;
  assert.ok(Array.from(`${tinyResult.stdout}${tinyResult.stderr}`).length <= 4);
  assert.equal(tinyResult.original_output_tokens, 3);

  const background = await client.callTool({
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "sleep 0.1; printf done", yield_time_ms: 0 },
  });
  const runningOutcome = (background.structuredContent as Record<string, unknown>).outcome as Record<string, unknown>;
  assert.equal(runningOutcome.type, "running");
  const polled = await client.callTool({
    name: "write_stdin",
    arguments: { workspace_id: workspaceId, session_id: runningOutcome.session_id, yield_time_ms: 10_000, max_output_tokens: 100 },
  });
  assert.equal(((polled.structuredContent as Record<string, unknown>).outcome as Record<string, unknown>).type, "exit");
  assert.match((polled.structuredContent as Record<string, unknown>).stdout as string, /done/);

  const generated = await client.callTool({
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "printf 'formatted\\n' >> sample.txt", yield_time_ms: 10_000 },
  });
  assert.equal(((generated.structuredContent as Record<string, unknown>).outcome as Record<string, unknown>).type, "exit");
  const inspected = await client.callTool({
    name: "exec_command",
    arguments: { workspace_id: workspaceId, cmd: "git status --short; git diff --stat; git diff -- sample.txt", yield_time_ms: 10_000 },
  });
  const inspectionOutput = (inspected.structuredContent as Record<string, unknown>).stdout as string;
  assert.match(inspectionOutput, /M sample\.txt/);
  assert.match(inspectionOutput, /formatted/);

  const binaryRead = await client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: "binary.bin" },
  });
  assert.equal(binaryRead.isError, true);
  assert.match(JSON.stringify(binaryRead.content), /export_file/);

  const exportPreflight = await client.callTool({
    name: "export_file",
    arguments: { workspace_id: workspaceId, path: "exports/artifact.txt" },
  });
  assert.deepEqual(exportPreflight.structuredContent, {
    status: "instructions_required",
    instruction_sources: ["AGENTS.md", "exports/AGENTS.md"],
    instructions: "root instructions\n\n\nexport instructions\n",
    truncated: false,
    retry_required: true,
  });
  const exported = await client.callTool({
    name: "export_file",
    arguments: { workspace_id: workspaceId, path: "exports/artifact.txt" },
  });
  const exportResult = exported.structuredContent as Record<string, unknown>;
  assert.equal(exportResult.filename, "artifact.txt");
  assert.equal(exportResult.mime_type, "text/plain; charset=utf-8");
  assert.equal(typeof exportResult.url, "string");
  assert.match(exportResult.sha256 as string, /^[a-f0-9]{64}$/u);
  assert.equal((exported.content as Array<{ type: string }>)[0]?.type, "resource_link");
} finally {
  await client.close();
  await running.close();
}

for (const [widgetMode, expectedUiTools] of [
  ["full", ["exec_command", "open_workspace", "read", "write_stdin"]],
  ["off", []],
] as const) {
  const widgetServer = createMcpServerForTesting(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: widgetMode,
    DEVSPACE_LOG_LEVEL: "silent",
  }));
  const [widgetClientTransport, widgetServerTransport] = InMemoryTransport.createLinkedPair();
  const widgetClient = new Client({ name: `devspace-${widgetMode}-widget-test`, version: "1" });
  await widgetServer.server.connect(widgetServerTransport);
  await widgetClient.connect(widgetClientTransport);
  try {
    const tools = await widgetClient.listTools();
    const expectedUiToolNames = new Set<string>(expectedUiTools);
    assert.deepEqual(
      tools.tools
        .filter((tool) => tool._meta?.ui !== undefined)
        .map((tool) => tool.name)
        .sort(),
      [...expectedUiTools].sort(),
    );
    for (const tool of tools.tools.filter((candidate) => !expectedUiToolNames.has(candidate.name))) {
      assert.equal(tool._meta, undefined, `${tool.name} should omit disabled UI metadata`);
    }
  } finally {
    await widgetClient.close();
    await widgetServer.close();
  }
}

for (const mode of ["minimal", "full"] as const) {
  const compatibilityServer = createMcpServerForTesting(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TOOL_MODE: mode,
    DEVSPACE_LOG_LEVEL: "silent",
  }));
  const [compatibilityClientTransport, compatibilityServerTransport] = InMemoryTransport.createLinkedPair();
  const compatibilityClient = new Client({ name: `devspace-${mode}-compatibility-test`, version: "1" });
  await compatibilityServer.server.connect(compatibilityServerTransport);
  await compatibilityClient.connect(compatibilityClientTransport);
  try {
    const tools = await compatibilityClient.listTools();
    const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
    const exportTool = tools.tools.find((tool) => tool.name === "export_file");
    assert.ok(openTool);
    assert.ok(exportTool);
    assert.ok("baseRef" in (openTool.inputSchema.properties ?? {}));
    assert.ok("workspaceId" in (exportTool.inputSchema.properties ?? {}));
  } finally {
    await compatibilityClient.close();
    await compatibilityServer.close();
  }
}
