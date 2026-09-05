import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";
import type { ProcessSessionManager, ProcessSnapshot } from "./process-sessions.js";
import { applyCodexPatch, parseCodexPatch } from "./codex-patch.js";
import { CODEX_COMPAT_COMMIT, codexProcessResult, codexToolDefinitions, createCodexToolset } from "./codex-tools.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const wrap = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const apply = (root: string, ...lines: string[]) => applyCodexPatch(root, parseCodexPatch(wrap(...lines)));

test("add, update, delete and move in one document", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "old.txt"), "old\n");
  await writeFile(join(root, "obsolete.txt"), "delete me\n");
  const result = await apply(root,
    "*** Update File: old.txt", "*** Move to: nested/new.txt", "@@", "-old", "+new",
    "*** Add File: nested/added.txt", "+hello", "+world",
    "*** Delete File: obsolete.txt");
  assert.match(result, /Success/);
  assert.equal(await readFile(join(root, "nested/new.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(root, "nested/added.txt"), "utf8"), "hello\nworld\n");
  await assert.rejects(stat(join(root, "old.txt")), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "obsolete.txt")), { code: "ENOENT" });
});
test("a later bad hunk leaves every file untouched and creates no directories", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "a"), "before\n");
  await assert.rejects(apply(root, "*** Add File: new/deep/file", "+created", "*** Update File: a", "@@", "-wrong", "+after"), /context did not match/);
  assert.equal(await readFile(join(root, "a"), "utf8"), "before\n");
  await assert.rejects(stat(join(root, "new")), { code: "ENOENT" });
});
test("multiple hunks, skip-ahead context and optional first @@", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "a"), "head\nfirst\ndef second():\nlast\n");
  await apply(root, "*** Update File: a", "-head", "+HEAD", "@@ def second():", "-last", "+LAST", "*** End of File");
  assert.equal(await readFile(join(root, "a"), "utf8"), "HEAD\nfirst\ndef second():\nLAST\n");
});
test("preserves CRLF, executable mode and unchanged fuzzy context", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "a"), "  heading  \r\nbefore\r\n");
  await chmod(join(root, "a"), 0o755);
  await apply(root, "*** Update File: a", "@@", " heading", "-before", "+after");
  assert.equal(await readFile(join(root, "a"), "utf8"), "  heading  \r\nafter\r\n");
  if (process.platform !== "win32") assert.equal((await stat(join(root, "a"))).mode & 0o777, 0o755);
});
test("empty file, move-only update and file without a trailing newline", async (t) => {
  const root = await temporary(t);
  await apply(root, "*** Add File: empty");
  assert.equal((await stat(join(root, "empty"))).size, 0);
  await writeFile(join(root, "a"), "old");
  await apply(root, "*** Update File: a", "@@", "-old", "+new");
  await apply(root, "*** Update File: a", "*** Move to: b");
  assert.equal(await readFile(join(root, "b"), "utf8"), "new");
});
test("rejects malformed envelopes and unsupported bodies", () => {
  for (const value of ["", "```\n" + wrap("*** Add File: a", "+a") + "\n```", wrap(), wrap("*** Add File: a", "a"), wrap("*** Delete File: a", "+unexpected")]) {
    assert.throws(() => parseCodexPatch(value));
  }
  assert.equal(parseCodexPatch(wrap("*** Environment ID: ws_x", "*** Add File: a", "+a")).environmentId, "ws_x");
});
test("rejects parent traversal and absolute paths outside the workspace", async (t) => {
  const root = await temporary(t);
  for (const path of ["../escape", "dir/../../escape", "/tmp/devspace-outside", "C:\\outside"]) {
    await assert.rejects(apply(root, `*** Add File: ${path}`, "+bad"));
  }
});
test("rejects symlink leaf, dangling symlink and symlink parent", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporary(t);
  const outside = await temporary(t);
  await writeFile(join(outside, "a"), "safe\n");
  await symlink(join(outside, "a"), join(root, "leaf"));
  await symlink(join(outside, "missing"), join(root, "dangling"));
  await symlink(outside, join(root, "parent"));
  for (const path of ["leaf", "dangling", "parent/a"]) await assert.rejects(apply(root, `*** Delete File: ${path}`), /Symlink/);
  assert.equal(await readFile(join(outside, "a"), "utf8"), "safe\n");
});
test("will not overwrite an existing add/move destination or create a file-parent conflict", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "a"), "a\n"); await writeFile(join(root, "b"), "b\n");
  await assert.rejects(apply(root, "*** Add File: a", "+bad"), /already exists/);
  await assert.rejects(apply(root, "*** Update File: a", "*** Move to: b"), /already exists/);
  await assert.rejects(apply(root, "*** Add File: new", "+a", "*** Add File: new/child", "+b"), /both a file and a directory/);
  assert.equal(await readFile(join(root, "b"), "utf8"), "b\n");
});
test("invalid UTF-8 and binary update are rejected without changing bytes", async (t) => {
  const root = await temporary(t);
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])]) {
    await writeFile(join(root, "a"), bytes);
    await assert.rejects(apply(root, "*** Update File: a", "@@", "+new"));
    assert.deepEqual(await readFile(join(root, "a")), bytes);
  }
});
test("concurrent patches serialize within a root, without a global workspace lock", async (t) => {
  const a = await temporary(t), b = await temporary(t);
  await Promise.all([apply(a, "*** Add File: a", "+a"), apply(a, "*** Add File: b", "+b"), apply(b, "*** Add File: a", "+other")]);
  assert.equal(await readFile(join(a, "b"), "utf8"), "b\n");
  assert.equal(await readFile(join(b, "a"), "utf8"), "other\n");
});
test("rolls back an earlier installed file when a later installation fails", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("Run as an unprivileged user to exercise filesystem denial."); return; }
  const root = await temporary(t);
  await writeFile(join(root, "a"), "before\n");
  await mkdir(join(root, "readonly")); await chmod(join(root, "readonly"), 0o555);
  try {
    await assert.rejects(apply(root, "*** Update File: a", "@@", "-before", "+after", "*** Add File: readonly/b", "+b"), /rolled back/);
    assert.equal(await readFile(join(root, "a"), "utf8"), "before\n");
  } finally { await chmod(join(root, "readonly"), 0o755); }
});

function fixtures(root: string) {
  const instructions = new Map<string, string>([[root, "Root instructions"]]);
  const spaces = new Map<string, Workspace>();
  const starts: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
  const workspaceFor = (path: string) => {
    const id = path === root ? "ws_one" : "ws_two";
    let workspace = spaces.get(id);
    if (!workspace) {
      workspace = { id, root: path, mode: "checkout", skills: [], skillResources: [], skillDiagnostics: [], agentProfiles: [], activatedSkillIds: new Set(), deliveredInstructionHashes: new Map() };
      spaces.set(id, workspace);
    }
    return workspace;
  };
  const chain = (scope: string) => ({ scope, hash: instructions.get(scope) ?? "", sources: [], instructions: instructions.get(scope) ?? "", truncated: false });
  const registry = {
    async openWorkspace(input: {path: string}) { return { workspace: workspaceFor(input.path), instructionChain: chain(input.path) }; },
    async getWorkspace(id: string) { if (!spaces.has(id)) throw new Error("Unknown workspace."); return spaces.get(id)!; },
    async markInstructionsDelivered(workspace: Workspace, scope: string) { const c = chain(scope); workspace.deliveredInstructionHashes.set(scope, c.hash); return c; },
    async preflightInstructions(workspace: Workspace, scope: string) {
      const c = chain(scope);
      if (workspace.deliveredInstructionHashes.get(scope) === c.hash) return undefined;
      workspace.deliveredInstructionHashes.set(scope, c.hash);
      return c.instructions ? { instructions: c.instructions, status: "instructions_required", retryRequired: true } : undefined;
    },
    resolveWorkingDirectory(workspace: Workspace, path?: string) {
      const cwd = resolve(workspace.root, path ?? ".");
      if (relative(workspace.root, cwd).startsWith("..")) throw new Error("Outside workspace.");
      if (!statSync(cwd).isDirectory()) throw new Error("Not a directory.");
      return cwd;
    },
    resolveReadPath(workspace: Workspace, path: string) {
      const absolutePath = resolve(workspace.root, path);
      if (relative(workspace.root, absolutePath).startsWith("..")) throw new Error("Outside workspace.");
      return { absolutePath, readRoots: [workspace.root] };
    },
    async isDirectInstructionRead(_workspace: Workspace, path: string) { return path.endsWith("AGENTS.md"); },
    markReadPathLoaded() {},
  } as unknown as WorkspaceRegistry;
  const processes = {
    async start(input: Record<string, unknown>) { starts.push(input); return { output: "start\n", stdout: "start\n", stderr: "", running: true, sessionId: 42, wallTimeMs: 250 }; },
    workspaceForSession(id: number) { if (id !== 42) throw new Error("Unknown session."); return "ws_one"; },
    async write(input: Record<string, unknown>) { writes.push(input); return { output: "done\n", stdout: "done\n", stderr: "", running: false, exitCode: 0, wallTimeMs: 10 }; },
  } as unknown as ProcessSessionManager;
  return { registry, processes, instructions, starts, writes };
}

test("catalog is available before open_workspace and never changes after opening projects", async (t) => {
  const root = await temporary(t), other = await temporary(t);
  const f = fixtures(root), api = createCodexToolset(f.registry, f.processes);
  const original = JSON.stringify(api.tools);
  assert.deepEqual(api.tools.map((tool) => tool.name), ["open_workspace", "exec_command", "write_stdin", "apply_patch", "view_image", "read"]);
  assert.equal(CODEX_COMPAT_COMMIT.length, 40);
  await api.call("open_workspace", {path:root}); await api.call("open_workspace", {path:other});
  assert.equal(JSON.stringify(api.tools), original);
});
test("exec parameters and output use the pinned contract; yield does not kill the process", async (t) => {
  const root = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  await api.call("open_workspace", {path:root});
  const result = await api.call("exec_command", {cmd:"test",yield_time_ms:0});
  assert.deepEqual(result.structuredContent, {output:"start\n",wall_time_seconds:0.25,session_id:42});
  assert.equal(f.starts[0]!.timeoutMs,0); assert.equal(f.starts[0]!.closeStdin,true);
  assert.equal(f.starts[0]!.captureCombinedOutput,true);
  assert.equal(f.starts[0]!.yieldTimeMs,process.platform === "win32" ? 10_000 : 250);
  assert.match((result.content[0] as {text:string}).text,/start/);
});
test("unsupported sandbox, timeout and shell arguments fail instead of pretending to implement them", async (t) => {
  const root = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  await api.call("open_workspace", {path:root});
  for (const extra of [{timeout_ms:1}, {sandbox_permissions:"require_escalated"}, {shell:"bash"}]) {
    assert.equal((await api.call("exec_command",{cmd:"test",...extra})).isError,true);
  }
  assert.equal(f.starts.length,0);
});
test("multiple environments require an explicit ID; reopening one does not change the default", async (t) => {
  const root = await temporary(t), other = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  await api.call("open_workspace",{path:root}); await api.call("open_workspace",{path:other});
  await api.call("open_workspace",{path:root});
  assert.equal((await api.call("exec_command",{cmd:"test"})).isError,true);
  assert.equal((await api.call("exec_command",{cmd:"test",environment_id:"ws_two"})).isError,undefined);
  assert.equal(f.starts[0]!.cwd,other);
});
test("write_stdin routes by session ID, distinguishes writing from polling, and validates IDs", async (t) => {
  const root = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  await api.call("open_workspace",{path:root});
  await api.call("write_stdin",{session_id:42,chars:"hello\n"});
  await api.call("write_stdin",{session_id:42});
  assert.equal(f.writes[0]!.yieldTimeMs,250); assert.equal(f.writes[1]!.yieldTimeMs,5000);
  assert.equal(f.writes[0]!.workspaceId,"ws_one");
  assert.equal((await api.call("write_stdin",{session_id:0})).isError,true);
  assert.equal((await api.call("write_stdin",{session_id:42,environment_id:"ws_one"})).isError,true);
});
test("instruction delivery is per connection and blocks before any nested edit", async (t) => {
  const root = await temporary(t), f = fixtures(root);
  const nested = join(root,"nested"); await mkdir(nested); f.instructions.set(nested,"Nested instructions");
  const a = createCodexToolset(f.registry,f.processes), b = createCodexToolset(f.registry,f.processes);
  await a.call("open_workspace",{path:root}); await b.call("open_workspace",{path:root});
  const patch = wrap("*** Add File: nested/file", "+hello");
  assert.match(((await a.call("apply_patch",{patch})).content[0] as {text: string}).text,/NOT executed/);
  assert.match(((await b.call("apply_patch",{patch})).content[0] as {text: string}).text,/NOT executed/);
  await assert.rejects(stat(join(nested,"file")),{code:"ENOENT"});
  assert.equal((await a.call("apply_patch",{patch})).isError,undefined);
  assert.equal(await readFile(join(nested,"file"),"utf8"),"hello\n");
});
test("patch environment header selects a project; conflicts are rejected", async (t) => {
  const root = await temporary(t), other = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  await api.call("open_workspace",{path:root}); await api.call("open_workspace",{path:other});
  const patch = wrap("*** Environment ID: ws_two","*** Add File: file","+hello");
  assert.equal((await api.call("apply_patch",{patch,environment_id:"ws_one"})).isError,true);
  assert.equal((await api.call("apply_patch",{patch})).isError,undefined);
  assert.equal(await readFile(join(other,"file"),"utf8"),"hello\n");
});
test("view_image sends MCP image content, not a textual data-URL result", async (t) => {
  const root = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlN8AAAAASUVORK5CYII=","base64");
  await writeFile(join(root,"image.png"),png); await writeFile(join(root,"bad.svg"),"<svg/>");
  await api.call("open_workspace",{path:root});
  const result = await api.call("view_image",{path:"image.png"});
  assert.deepEqual(result.content,[{type:"image",mimeType:"image/png",data:png.toString("base64")}]);
  assert.equal((await api.call("view_image",{path:"bad.svg"})).isError,true);
});
test("read bounds long-line output and errors are explicit MCP error results", async (t) => {
  const root = await temporary(t), f = fixtures(root), api = createCodexToolset(f.registry,f.processes);
  await writeFile(join(root,"large"),"a".repeat(50_000)); await api.call("open_workspace",{path:root});
  const result = await api.call("read",{path:"large"});
  assert.equal((result.structuredContent!.content as string).length,40_000);
  assert.equal(result.structuredContent!.truncated,true);
  assert.equal((await api.call("read",{path:"missing"})).isError,true);
});
test("process formatting retains combined output order and only native result keys", () => {
  const result = codexProcessResult({output:"out1\nerr\nout2\n",stdout:"out1\nout2\n",stderr:"err\n",wallTimeMs:10,running:false,exitCode:2,originalOutputTokens:99} as ProcessSnapshot);
  assert.deepEqual(result.structuredContent,{output:"out1\nerr\nout2\n",wall_time_seconds:0.01,exit_code:2,original_token_count:99});
  assert.deepEqual(codexToolDefinitions().find(t=>t.name==="write_stdin")!.inputSchema.required,["session_id"]);
});

test("signal exit codes support pipe names and native PTY numbers", () => {
  const snapshot = { output: "", stdout: "", stderr: "", running: false, wallTimeMs: 0 } as ProcessSnapshot;
  assert.equal(codexProcessResult({ ...snapshot, signal: "SIGINT" }).structuredContent?.exit_code, 130);
  assert.equal(codexProcessResult({ ...snapshot, signal: "2", exitCode: 0 }).structuredContent?.exit_code, 130);
  assert.equal(codexProcessResult({ ...snapshot, signal: "15", exitCode: 0 }).structuredContent?.exit_code, 143);
  assert.equal(codexProcessResult({ ...snapshot, signal: "0", exitCode: 7 }).structuredContent?.exit_code, 7);
  assert.equal(codexProcessResult({ ...snapshot, exitCode: 0 }).structuredContent?.exit_code, 0);
});
