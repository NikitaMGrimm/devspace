import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { git } from "./git.js";
import { createServer } from "./server.js";

const patch = (...operations: string[]) => ["*** Begin Patch", ...operations, "*** End Patch"].join("\n");

test("strict-codex over authenticated HTTP with independent clients", { timeout: 60_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "devspace-strict-http-"));
  const project = join(temporary, "project");
  const configDir = join(temporary, "config");
  const clients: Client[] = [];
  let running: ReturnType<typeof createServer> | undefined;
  const http = createHttpServer((request, response) => running!.app(request, response));
  try {
    await mkdir(join(project, "nested"), { recursive: true });
    const skillDir = join(project, ".agents", "skills", "http-test");
    await mkdir(skillDir, { recursive: true });
    await mkdir(configDir);
    const agentDir = join(temporary, "codex-home");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "AGENTS.md"), "Global HTTP test instructions.\n");
    const pluginRoot = join(agentDir, "plugins", "cache", "personal", "video", "1.0.0");
    const pluginSkill = join(pluginRoot, "skills", "video");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(pluginSkill, "scripts"), { recursive: true });
    await writeFile(join(agentDir, "config.toml"), '[plugins."video@personal"]\nenabled = true\n');
    await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "video", skills: "./skills" }));
    await writeFile(join(pluginSkill, "SKILL.md"), "---\nname: video\ndescription: Imported plugin skill fixture.\n---\nUse the local helper.\n");
    await writeFile(join(pluginSkill, "reference.md"), "Imported plugin reference.\n");
    await writeFile(join(pluginSkill, "scripts", "doctor.cjs"), "console.log('PLUGIN_DOCTOR_OK');\n");
    await writeFile(join(project, "AGENTS.md"), "Root HTTP test instructions.\n");
    await writeFile(join(project, "nested", "AGENTS.md"), "Nested HTTP test instructions.\n");
    await writeFile(join(project, "sample.txt"), "original\n");
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: http-test\ndescription: Isolated HTTP test skill.\n---\nRead this test skill.\n");
    await writeFile(join(skillDir, "reference.md"), "Skill reference.\n");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGisAAAAASUVORK5CYII=", "base64");
    await writeFile(join(project, "pixel.png"), png);
    await git(project, ["init", "--initial-branch=main"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "HTTP test fixture"]);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const resource = `${baseUrl}/mcp`;
    const ownerToken = randomBytes(32).toString("hex");
    running = createServer(loadConfig({
      HOST: "127.0.0.1", PORT: String(address.port), DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: project, DEVSPACE_PUBLIC_BASE_URL: baseUrl, DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_STATE_DIR: join(temporary, "state"), DEVSPACE_WORKTREE_ROOT: join(temporary, "worktrees"),
      DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken, DEVSPACE_TOOL_MODE: "strict-codex",
      DEVSPACE_WIDGETS: "off", DEVSPACE_LOG_LEVEL: "silent", DEVSPACE_SUBAGENTS: "0",
      DEVSPACE_EXPORT_MAX_BYTES: "4096",
    }));
    const postForm = (path: string, fields: Record<string, string>) => fetch(`${baseUrl}${path}`, {
      method: "POST", redirect: "manual", body: new URLSearchParams(fields),
    });
    let accessToken = "";
    await t.test("health, OAuth denial, registration, PKCE authorization and refresh", async () => {
      assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
      assert.equal((await fetch(resource)).status, 401);
      const registration = await fetch(`${baseUrl}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "DevSpace HTTP test", token_endpoint_auth_method: "none",
          redirect_uris: ["http://127.0.0.1:3210/callback"],
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
      });
      assert.equal(registration.status, 201);
      const registered = await registration.json() as { client_id: string };
      const verifier = randomBytes(32).toString("base64url");
      const fields = {
        client_id: registered.client_id, response_type: "code", scope: "devspace", resource,
        redirect_uri: "http://127.0.0.1:3210/callback", state: "strict-test",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      };
      assert.equal((await postForm("/authorize", { ...fields, owner_token: "wrong-test-password" })).status, 401);
      const authorized = await postForm("/authorize", { ...fields, owner_token: ownerToken });
      assert.equal(authorized.status, 302);
      const redirect = new URL(authorized.headers.get("location")!);
      assert.equal(redirect.searchParams.get("state"), "strict-test");
      const response = await postForm("/token", { grant_type: "authorization_code", client_id: registered.client_id,
        code: redirect.searchParams.get("code")!, code_verifier: verifier, redirect_uri: fields.redirect_uri, resource });
      assert.equal(response.status, 200);
      const tokens = await response.json() as { access_token: string; refresh_token: string };
      assert.ok(tokens.access_token && tokens.refresh_token);
      const refreshed = await postForm("/token", { grant_type: "refresh_token", client_id: registered.client_id,
        refresh_token: tokens.refresh_token, resource });
      assert.equal(refreshed.status, 200);
      accessToken = (await refreshed.json() as { access_token: string }).access_token;
      assert.ok(accessToken && accessToken !== tokens.access_token);
    });
    assert.ok(accessToken, "OAuth setup must succeed before MCP checks");
    async function connect(name: string) {
      const client = new Client({ name, version: "1" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }));
      return client;
    }
    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
      return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    }
    async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
      const result = await call(client, name, args);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result;
    }
    const first = await connect("first-client");
    const second = await connect("second-client");
    const catalog = await first.listTools();
    await t.test("fixed catalog before workspace opening and schema rejection", async () => {
      assert.deepEqual(catalog.tools.map(({ name }) => name).sort(),
        ["apply_patch", "exec_command", "export_file", "open_workspace", "read", "view_image", "write_stdin"]);
      assert.equal((await call(first, "exec_command", { cmd: "echo bad", workspace_id: "legacy" })).isError, true);
      assert.equal((await call(first, "exec_command", { cmd: "echo no-workspace" })).isError, true);
    });
    const opened = (await ok(first, "open_workspace", { path: project })).structuredContent!;
    const environment_id = opened.environment_id as string;
    assert.notEqual((await ok(second, "open_workspace", { path: project })).structuredContent!.environment_id, environment_id);
    assert.match(String(opened.instructions), /Global HTTP test instructions[\s\S]*Root HTTP test instructions/);
    assert.deepEqual(opened.instruction_sources, [join(agentDir, "AGENTS.md"), "AGENTS.md"]);
    await t.test("independent project instructions across clients", async () => {
      for (const client of [first, second]) {
        const preflight = await ok(client, "exec_command", { cmd: "echo EXECUTED_MARKER", workdir: "nested" });
        assert.match(String(preflight.structuredContent!.output), /NOT executed/);
        assert.match(String(preflight.structuredContent!.output), /Nested HTTP test instructions/);
        const executed = await ok(client, "exec_command", { cmd: "echo EXECUTED_MARKER", workdir: "nested" });
        assert.equal(executed.structuredContent!.exit_code, 0);
        assert.match(String(executed.structuredContent!.output), /EXECUTED_MARKER/);
      }
      assert.deepEqual((await first.listTools()).tools, catalog.tools);
    });
    await t.test("multi-file patches, moves, deletes and containment", async () => {
      await ok(first, "apply_patch", { patch: patch("*** Update File: sample.txt", "@@", "-original", "+changed", "*** Add File: temporary.txt", "+remove me") });
      await ok(first, "apply_patch", { patch: patch("*** Update File: sample.txt", "*** Move to: moved.txt", "*** Delete File: temporary.txt") });
      assert.equal(await readFile(join(project, "moved.txt"), "utf8"), "changed\n");
      assert.equal((await call(first, "apply_patch", { patch: patch("*** Add File: ../outside.txt", "+not allowed") })).isError, true);
    });
    await t.test("native MCP image blocks and opaque skill references", async () => {
      const image = await ok(first, "view_image", { path: "pixel.png" });
      const block = image.content[0]!;
      assert.ok(block.type === "image");
      assert.equal(block.mimeType, "image/png");
      assert.deepEqual(Buffer.from(block.data, "base64"), png);
      const skill = (opened.skills as Array<{ name: string; resource: string }>).find(({ name }) => name === "http-test")!;
      assert.ok(skill);
      const reference = skill.resource.replace("SKILL.md", "reference.md");
      assert.equal((await call(first, "read", { path: reference })).isError, true);
      await ok(first, "read", { path: skill.resource });
      assert.match(String((await ok(first, "read", { path: reference })).structuredContent!.content), /Skill reference/);
      assert.equal((await call(second, "read", { path: reference })).isError, true);
    });
    await t.test("cached plugin skills expose helper paths and preserve activation across reconnects", async () => {
      const skill = (opened.skills as Array<{ name: string; resource: string }>).find(({ name }) => name === "video");
      assert.ok(skill);
      const loaded = await ok(first, "read", { path: skill.resource });
      assert.equal(loaded.structuredContent!.source_path, join(pluginSkill, "SKILL.md"));
      const reconnected = await connect("plugin-reconnected-client");
      const reference = skill.resource.replace("SKILL.md", "reference.md");
      assert.match(String((await ok(reconnected, "read", { environment_id, path: reference })).structuredContent!.content), /Imported plugin reference/);
      assert.equal((await call(second, "read", { path: reference })).isError, true);
      const helper = join(pluginSkill, "scripts", "doctor.cjs");
      const executed = await ok(reconnected, "exec_command", { environment_id, cmd: `node "${helper}"` });
      assert.equal(executed.structuredContent!.exit_code, 0);
      assert.match(String(executed.structuredContent!.output), /PLUGIN_DOCTOR_OK/);
    });
    await t.test("export_file returns downloadable immutable bytes and complete metadata", async () => {
      const result = await ok(first, "export_file", { path: "pixel.png" });
      const metadata = result.structuredContent!;
      const link = result.content.find((block) => block.type === "resource_link");
      assert.ok(link?.type === "resource_link");
      assert.equal(link.uri, metadata.url);
      assert.equal(link.name, "pixel.png");
      assert.equal(link.mimeType, "image/png");
      assert.equal(link.size, png.length);
      assert.deepEqual(Object.keys(metadata).sort(), ["expires_at", "filename", "mime_type", "sha256", "size", "url"]);
      assert.equal(metadata.sha256, createHash("sha256").update(png).digest("hex"));
      assert.ok(Date.parse(String(metadata.expires_at)) > Date.now());
      assert.equal(String(metadata.url).startsWith(baseUrl + "/devspace-files/d/"), true);
      const text = result.content.find((block) => block.type === "text");
      assert.ok(text?.type === "text");
      assert.deepEqual(JSON.parse(text.text), metadata);
      await writeFile(join(project, "pixel.png"), "changed after export");
      const head = await fetch(String(metadata.url), { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-type"), "image/png");
      assert.equal(head.headers.get("content-length"), String(png.length));
      assert.match(head.headers.get("content-disposition")!, /attachment.*pixel\.png/);
      assert.equal(head.headers.get("x-content-type-options"), "nosniff");
      const downloaded = await fetch(String(metadata.url));
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
      await writeFile(join(project, "pixel.png"), png);
    });
    await t.test("export_file rejects traversal, symlink escapes, directories and oversized files", async () => {
      await writeFile(join(temporary, "outside.txt"), "outside the workspace");
      await writeFile(join(project, "too-large.bin"), Buffer.alloc(4097));
      for (const path of ["../outside.txt", join(project, "pixel.png"), "nested", "missing.txt", "too-large.bin"]) {
        const denied = await call(first, "export_file", { path });
        assert.equal(denied.isError, true, path);
        assert.equal(denied.content.some((block) => block.type === "resource_link"), false);
      }
      if (process.platform !== "win32") {
        await symlink(join(temporary, "outside.txt"), join(project, "outside-link.txt"));
        assert.equal((await call(first, "export_file", { path: "outside-link.txt" })).isError, true);
      }
      assert.equal((await call(first, "export_file", { path: "pixel.png", workspace_id: environment_id })).isError, true);
    });
    await t.test("export_file waits for each client's project instructions before publishing a link", async () => {
      await mkdir(join(project, "exports"));
      await writeFile(join(project, "exports", "AGENTS.md"), "Review these export instructions.\n");
      await writeFile(join(project, "exports", "report.txt"), "downloadable report\n");
      for (const client of [first, second]) {
        const blocked = await ok(client, "export_file", { path: "exports/report.txt" });
        assert.equal(blocked.structuredContent?.status, "instructions_required");
        assert.equal(blocked.structuredContent?.retry_required, true);
        assert.match(String(blocked.structuredContent?.instructions), /Review these export instructions/);
        assert.equal(blocked.content.some((block) => block.type === "resource_link"), false);
        const result = await ok(client, "export_file", { path: "exports/report.txt" });
        assert.equal(await (await fetch(String(result.structuredContent!.url))).text(), "downloadable report\n");
      }
    });
    const worktree = (await ok(first, "open_workspace", { path: project, mode: "worktree" })).structuredContent!;
    const worktreeId = worktree.environment_id as string;
    await t.test("explicit environment selection and isolated worktrees", async () => {
      assert.notEqual(worktreeId, environment_id);
      assert.equal((await call(first, "exec_command", { cmd: "echo ambiguous" })).isError, true);
      await ok(first, "apply_patch", { environment_id: worktreeId,
        patch: patch("*** Update File: sample.txt", "@@", "-original", "+worktree-only") });
      assert.equal(await readFile(join(String(worktree.cwd), "sample.txt"), "utf8"), "worktree-only\n");
      assert.equal(await readFile(join(project, "moved.txt"), "utf8"), "changed\n");
      assert.match(String((await ok(second, "exec_command", { cmd: "echo peer-project" })).structuredContent!.output), /peer-project/);
    });
    await t.test("export_file selects the explicit environment and retains existing links", async () => {
      assert.equal((await call(first, "export_file", { path: "sample.txt" })).isError, true);
      const worktreeExport = await ok(first, "export_file", { environment_id: worktreeId, path: "sample.txt" });
      assert.equal(await (await fetch(String(worktreeExport.structuredContent!.url))).text(), "worktree-only\n");
      const checkoutExport = await ok(first, "export_file", { environment_id, path: "moved.txt" });
      assert.equal(await (await fetch(String(checkoutExport.structuredContent!.url))).text(), "changed\n");
      assert.deepEqual((await first.listTools()).tools, catalog.tools);
    });
    await t.test("stdin EOF and persistent process polling", async () => {
      const eof = await ok(first, "exec_command", { environment_id,
        cmd: `node -e "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF_OK'))"` });
      assert.equal(eof.structuredContent!.exit_code, 0);
      assert.match(String(eof.structuredContent!.output), /EOF_OK/);
      const started = await ok(first, "exec_command", { environment_id: worktreeId,
        cmd: `node -e "console.log('START');setTimeout(()=>console.log('FINISH'),600)"`, yield_time_ms: 250 });
      assert.equal(typeof started.structuredContent!.session_id, "number");
      const polled = await ok(first, "write_stdin", { session_id: started.structuredContent!.session_id });
      assert.equal(polled.structuredContent!.exit_code, 0);
      assert.match(String(started.structuredContent!.output) + String(polled.structuredContent!.output), /START[\s\S]*FINISH/);
      assert.doesNotMatch(String(polled.structuredContent!.output), /START/);
    });
    await t.test("real POSIX PTY, interactive input and Ctrl-C", { skip: process.platform === "win32" }, async () => {
      const started = await ok(first, "exec_command", { environment_id, tty: true, yield_time_ms: 250,
        cmd: "test -t 0 && test -t 1 || exit 42; printf 'PTY_OK\\n'; read -r line; printf 'INPUT:%s\\n' \"$line\"" });
      assert.match(String(started.structuredContent!.output), /PTY_OK/);
      const input = await ok(first, "write_stdin", { session_id: started.structuredContent!.session_id, chars: "hello\n", yield_time_ms: 1_000 });
      assert.equal(input.structuredContent!.exit_code, 0);
      assert.match(String(input.structuredContent!.output), /INPUT:hello/);
      const waiting = await ok(first, "exec_command", { environment_id, tty: true, yield_time_ms: 250,
        cmd: `node -e "console.log('WAITING');setInterval(()=>{},1000)"` });
      assert.match(String(waiting.structuredContent!.output), /WAITING/);
      const interrupted = await ok(first, "write_stdin", { session_id: waiting.structuredContent!.session_id, chars: "\u0003", yield_time_ms: 1_000 });
      assert.equal(interrupted.structuredContent!.session_id, undefined);
      assert.equal(typeof interrupted.structuredContent!.exit_code, "number");
      assert.notEqual(interrupted.structuredContent!.exit_code, 0);
    });
    await t.test("explicit environment IDs restore state after reconnect", async () => {
      const third = await connect("reconnected-client");
      const restored = await ok(third, "exec_command", { environment_id, cmd: "echo RESTORED" });
      assert.equal(restored.structuredContent!.exit_code, 0);
      assert.match(String(restored.structuredContent!.output), /RESTORED/);
      await writeFile(join(agentDir, "AGENTS.md"), "Changed global HTTP instructions.\n");
      const blocked = await ok(third, "exec_command", { environment_id, cmd: "echo AFTER_CHANGE" });
      assert.match(String(blocked.structuredContent!.output), /NOT executed/);
      assert.match(String(blocked.structuredContent!.output), /Changed global HTTP instructions/);
      const fourth = await connect("retry-reconnected-client");
      const retried = await ok(fourth, "exec_command", { environment_id, cmd: "echo AFTER_CHANGE" });
      assert.equal(retried.structuredContent!.exit_code, 0);
      assert.match(String(retried.structuredContent!.output), /AFTER_CHANGE/);
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await running?.close();
    http.closeAllConnections();
    if (http.listening) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
