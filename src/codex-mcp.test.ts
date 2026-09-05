import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      DEVSPACE_ALLOWED_ROOTS: project, DEVSPACE_PUBLIC_BASE_URL: baseUrl,
      DEVSPACE_STATE_DIR: join(temporary, "state"), DEVSPACE_WORKTREE_ROOT: join(temporary, "worktrees"),
      DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken, DEVSPACE_TOOL_MODE: "strict-codex",
      DEVSPACE_WIDGETS: "off", DEVSPACE_LOG_LEVEL: "silent", DEVSPACE_SUBAGENTS: "0",
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
        ["apply_patch", "exec_command", "open_workspace", "read", "view_image", "write_stdin"]);
      assert.equal((await call(first, "exec_command", { cmd: "echo bad", workspace_id: "legacy" })).isError, true);
      assert.equal((await call(first, "exec_command", { cmd: "echo no-workspace" })).isError, true);
    });
    const opened = (await ok(first, "open_workspace", { path: project })).structuredContent!;
    const environment_id = opened.environment_id as string;
    assert.equal((await ok(second, "open_workspace", { path: project })).structuredContent!.environment_id, environment_id);
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
      assert.match(String((await ok(third, "exec_command", { environment_id, cmd: "echo RESTORED" })).structuredContent!.output), /NOT executed/);
      assert.match(String((await ok(third, "exec_command", { environment_id, cmd: "echo RESTORED" })).structuredContent!.output), /RESTORED/);
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await running?.close();
    http.closeAllConnections();
    if (http.listening) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
