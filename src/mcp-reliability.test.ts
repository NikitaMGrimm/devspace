import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import { loadConfig } from "./config.js";
import { createCodexToolset } from "./codex-tools.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { requestContext } from "./request-context.js";
import { DevSpaceExportManager, byteRange } from "./export-manager.js";
import type { CodexCallLog } from "./codex-tools.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-reliability-"));
  const project = join(root, "project");
  await mkdir(join(project, "nested", "deep"), { recursive: true });
  await mkdir(join(project, "sibling"));
  await writeFile(join(project, "AGENTS.md"), "Project instructions.\n");
  const registry = new WorkspaceRegistry(loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"), DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_ALLOWED_ROOTS: project, DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-long-enough",
  }));
  const processes = new ProcessSessionManager();
  t.after(async () => { processes.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, project, registry, processes };
}

test("unchanged inherited instruction chains do not gate each directory", async (t) => {
  const { project, registry } = await fixture(t);
  const { workspace } = await registry.openWorkspace(project);
  for (const directory of ["nested", "nested/deep", "sibling"]) {
    assert.equal(await registry.preflightInstructions(workspace, join(project, directory)), undefined);
  }
});

test("nested additions and changed guidance still block, with independent clients", async (t) => {
  const { project, registry, processes } = await fixture(t);
  const first = createCodexToolset(registry, processes);
  const second = createCodexToolset(registry, processes);
  const opened = await first.call("open_workspace", { path: project });
  await second.call("open_workspace", { path: project });
  const environment_id = opened.structuredContent!.environment_id;
  await writeFile(join(project, "nested", "AGENTS.md"), "New nested instructions.\n");
  const patch = "*** Begin Patch\n*** Add File: nested/new.txt\n+hello\n*** End Patch";
  const blocked = await first.call("apply_patch", { patch, environment_id });
  assert.equal(blocked.structuredContent?.status, "instructions_required");
  assert.equal(blocked.structuredContent?.executed, false);
  assert.match(String(blocked.structuredContent?.instructions_hash), /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(join(project, "nested", "new.txt")), { code: "ENOENT" });
  assert.equal((await second.call("apply_patch", { patch })).structuredContent?.executed, false);
  const reconnected = createCodexToolset(registry, processes);
  assert.equal((await reconnected.call("apply_patch", { patch, environment_id })).isError, undefined);
  assert.equal(await readFile(join(project, "nested", "new.txt"), "utf8"), "hello\n");
  await writeFile(join(project, "AGENTS.md"), "Changed root instructions.\n");
  const changed = await reconnected.call("read", { path: "nested/new.txt", environment_id });
  assert.equal(changed.structuredContent?.executed, false);
});

test("removing nested guidance is reported before execution", async (t) => {
  const { project, registry } = await fixture(t);
  const { workspace } = await registry.openWorkspace(project);
  await writeFile(join(project, "nested", "AGENTS.md"), "Nested rules");
  await registry.preflightInstructions(workspace, join(project, "nested"));
  await rm(join(project, "nested", "AGENTS.md"));
  assert.equal((await registry.preflightInstructions(workspace, join(project, "nested")))?.status, "instructions_required");
  assert.equal(await registry.preflightInstructions(workspace, join(project, "nested")), undefined);
});

test("native images retain bytes and cropped batches report original coordinates", async (t) => {
  const { project, registry, processes } = await fixture(t);
  const a = await sharp({ create: { width: 100, height: 80, channels: 3, background: "white" } }).png().toBuffer();
  const red = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  const b = await sharp(a).composite([{ input: red, left: 20, top: 10 }]).png().toBuffer();
  await writeFile(join(project, "a.png"), a); await writeFile(join(project, "b.png"), b);
  const api = createCodexToolset(registry, processes);
  await api.call("open_workspace", { path: project });
  const native = await api.call("view_image", { path: "a.png" });
  assert.equal(native.isError, undefined);
  assert.deepEqual(native.content[0], { type: "image", mimeType: "image/png", data: a.toString("base64") });
  const result = await api.call("view_images", { images: [
    { path: "a.png", crop: { x: 10, y: 5, width: 50, height: 40 } },
    { path: "b.png", crop: { width: 50, height: 40, y: 5, x: 10 } },
  ], difference: true, max_dimension: 64 });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content.filter((item) => item.type === "image").length, 3);
  const images = result.structuredContent!.images as Array<Record<string, unknown>>;
  assert.equal(images[0]!.original_width, 100); assert.equal(images[0]!.width, 50);
  assert.deepEqual(images[0]!.source_pixels_per_output_pixel, { x: 1, y: 1 });
  assert.equal((result.structuredContent!.difference as Record<string, unknown>).changed_pixels, 1);
  assert.deepEqual(await readFile(join(project, "a.png")), a);
});

test("image and batch argument validation is bounded and workspace contained", async (t) => {
  const { root, project, registry, processes } = await fixture(t);
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
  await writeFile(join(project, "image.png"), image);
  await writeFile(join(root, "outside.png"), image);
  await writeFile(join(project, "bad.svg"), "<svg/>");
  const api = createCodexToolset(registry, processes); await api.call("open_workspace", { path: project });
  for (const args of [
    { path: "image.png", crop: { x: -1, y: 0, width: 2, height: 2 } },
    { path: "image.png", crop: { x: 9, y: 0, width: 2, height: 2 } },
    { path: "image.png", crop: { x: 0, y: 0, width: 2.5, height: 2 } },
    { path: "image.png", max_dimension: 5000 },
    { path: "../outside.png" }, { path: "bad.svg" },
  ]) assert.equal((await api.call("view_image", args)).isError, true);
  for (const args of [{ images: [] }, { images: Array(5).fill({ path: "image.png" }) },
    { images: [{ path: "image.png", extra: true }] }, { images: [{ path: "image.png" }], difference: true }]) {
    assert.equal((await api.call("view_images", args)).isError, true);
  }
  if (process.platform !== "win32") {
    await symlink(join(root, "outside.png"), join(project, "link.png"));
    assert.equal((await api.call("view_image", { path: "link.png" })).isError, true);
  }
});

test("file inspection reports root/missing metadata and bounded hashes without writes", async (t) => {
  const { project, registry, processes } = await fixture(t);
  await writeFile(join(project, "nested", "value.txt"), "fixture\n");
  await writeFile(join(project, "large.bin"), "");
  await truncate(join(project, "large.bin"), 129 * 1024 * 1024);
  const api = createCodexToolset(registry, processes); await api.call("open_workspace", { path: project });
  const result = await api.call("inspect_files", { paths: [".", "nested/value.txt", "missing/thing", "large.bin"], sha256: true });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const files = result.structuredContent!.files as Array<Record<string, unknown>>;
  assert.equal(files[0]!.type, "directory");
  assert.equal(files[1]!.sha256, createHash("sha256").update("fixture\n").digest("hex"));
  assert.equal(files[2]!.type, "missing");
  assert.match(String(files[3]!.hash_error), /budget/);
  assert.equal((await api.call("inspect_files", { paths: ["../outside"] })).isError, true);
  assert.equal((await api.call("inspect_files", { paths: Array(51).fill(".") })).isError, true);
  await writeFile(join(project, "nested", "AGENTS.md"), "Nested policy");
  assert.equal((await api.call("inspect_files", { paths: ["nested"] })).structuredContent?.executed, false);
});

test("request diagnostics correlate validation errors and never claim a failed write did not start", async (t) => {
  const { project, registry, processes } = await fixture(t);
  const logs: CodexCallLog[] = [];
  const api = createCodexToolset(registry, processes, (entry) => logs.push(entry));
  const invalid = await requestContext.run({ requestId: "http-fixture-id" }, () => api.call("exec_command", { cmd: "noop", bad: true }, "rpc-7"));
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent?.execution_state, "not_started");
  assert.equal(invalid.structuredContent?.failure_layer, "validation");
  assert.equal(invalid.structuredContent?.http_request_id, "http-fixture-id");
  assert.equal(logs[0]!.phase, "received"); assert.equal(logs[1]!.phase, "finished");
  assert.equal(logs[0]!.requestId, invalid.structuredContent?.request_id);
  assert.equal(logs[0]!.rpcRequestId, "rpc-7");
  await api.call("open_workspace", { path: project });
  await writeFile(join(project, "existing.txt"), "original");
  const failed = await api.call("apply_patch", { patch: "*** Begin Patch\n*** Add File: existing.txt\n+replacement\n*** End Patch" });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent?.execution_state, "unknown");
  assert.equal(failed.structuredContent?.retry_safe, false);
  assert.equal(await readFile(join(project, "existing.txt"), "utf8"), "original");
});

const nodeCommand = (script: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
test("finished strict commands retain replayable results and non-consuming history across reconnects", { skip: process.platform === "win32" }, async (t) => {
  const { project, registry, processes } = await fixture(t);
  const first = createCodexToolset(registry, processes); await first.call("open_workspace", { path: project });
  const started = await first.call("exec_command", { cmd: nodeCommand("process.stdout.write('hello'); process.stderr.write('problem'); setTimeout(()=>process.exit(7),600)"), yield_time_ms: 250 });
  assert.equal(started.isError, undefined);
  const id = started.structuredContent!.session_id;
  assert.equal(typeof id, "number");
  const next = createCodexToolset(registry, processes);
  const done = await next.call("write_stdin", { session_id: id });
  assert.equal(done.structuredContent!.exit_code, 7);
  const history = await next.call("process_status", { session_id: id });
  assert.equal(history.structuredContent!.stdout, "hello");
  assert.equal(history.structuredContent!.stderr, "problem");
  assert.equal(history.structuredContent!.state, "exited");
  assert.ok(Number(history.structuredContent!.elapsed_seconds) >= .5);
  const replay = await next.call("write_stdin", { session_id: id, max_output_tokens: 0 });
  assert.equal(replay.structuredContent!.output, "");
  assert.equal(replay.structuredContent!.exit_code, 7);
  assert.equal((replay._meta?.devspace_process as Record<string, unknown>).replayed, true);
  assert.equal((await next.call("write_stdin", { session_id: id, chars: "rerun" })).isError, true);
});

test("retained history does not consume polls; completion TTL and capacity are bounded", { skip: process.platform === "win32" }, async (t) => {
  const { project } = await fixture(t);
  const manager = new ProcessSessionManager({ completedSessionTtlMs: 80, maxSessions: 1 });
  t.after(() => manager.shutdown());
  const input = { workspaceId: "w", cwd: project, timeoutMs: 0, retainCompleted: true, captureCombinedOutput: true, closeStdin: true };
  const start = await manager.start({ ...input, command: nodeCommand("setTimeout(()=>process.stdout.write('late'),100);setTimeout(()=>{},300)"), yieldTimeMs: 0 });
  await assert.rejects(manager.start({ ...input, command: "echo not-started", yieldTimeMs: 0 }), /capacity/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const inspected = manager.inspect("w", start.sessionId!);
  assert.equal(inspected.stdout, "late");
  const poll = await manager.write({ workspaceId: "w", sessionId: start.sessionId!, yieldTimeMs: 0 });
  assert.equal(poll.stdout, "late");
  await manager.write({ workspaceId: "w", sessionId: start.sessionId!, chars: "\u0003", yieldTimeMs: 1000 });
  const final = manager.inspect("w", start.sessionId!);
  assert.equal(final.cancelRequested, true); assert.equal(final.running, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.throws(() => manager.inspect("w", start.sessionId!), /unknown/);
});

test("native resource export uses immutable snapshots and never fetches arbitrary URLs", async (t) => {
  const { project, root, registry, processes } = await fixture(t);
  let now = 1000;
  const exporter = new DevSpaceExportManager({ publicBaseUrl: "https://fixture.example", ttlSeconds: 5,
    maxBytes: 8 * 1024 * 1024, maxEntries: 8, maxTotalBytes: 32 * 1024 * 1024,
    cleanupIntervalSeconds: 60, spoolDir: join(root, "spool"), now: () => now });
  t.after(() => exporter.close());
  await writeFile(join(project, "file.txt"), "original");
  const api = createCodexToolset(registry, processes, undefined, exporter); await api.call("open_workspace", { path: project });
  const result = await api.call("export_file", { path: "file.txt", delivery: "embedded" });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const resource = result.content.find((item) => item.type === "resource");
  assert.ok(resource?.type === "resource" && "blob" in resource.resource);
  assert.equal(Buffer.from(String(resource.resource.blob), "base64").toString(), "original");
  await writeFile(join(project, "file.txt"), "changed");
  const uri = String(result.structuredContent!.url);
  assert.equal(Buffer.from((await exporter.readResource(uri)).blob, "base64").toString(), "original");
  await assert.rejects(exporter.readResource("https://outside.example/file"), /Unknown/);
  await writeFile(join(project, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal((await api.call("export_file", { path: "large.bin", delivery: "embedded" })).isError, true);
  now = 7000;
  await assert.rejects(exporter.readResource(uri), /expired/);
});

test("download range parser rejects ambiguous/unbounded ranges", () => {
  assert.deepEqual(byteRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=0-999", 10), { start: 0, end: 9 });
  for (const value of ["bytes=-0", "bytes=10-", "bytes=9-2", "bytes=0-1,3-4", "bytes=-", "items=1-2"]) {
    assert.throws(() => byteRange(value, 10));
  }
  assert.throws(() => byteRange("bytes=0-1", 0));
});
