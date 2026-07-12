import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
const configDir = await mkdtemp(join(tmpdir(), "devspace-server-config-test-"));
const running = createServer(
  loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TRUST_PROXY: "1",
  }),
);
const httpServer = createHttpServer(running.app);
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

try {
  assert.equal(running.app.get("trust proxy"), 1);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const metadataResponse = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  assert.equal(metadataResponse.status, 200);
  assert.deepEqual(await metadataResponse.json(), {
    issuer: "https://devspace.example.com/",
    authorization_endpoint: "https://devspace.example.com/authorize",
    token_endpoint: "https://devspace.example.com/token",
    registration_endpoint: "https://devspace.example.com/register",
    revocation_endpoint: "https://devspace.example.com/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["devspace"],
  });

  const token = "A".repeat(43);
  const originalLog = console.log;
  const originalWarn = console.warn;
  const output: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.warn = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    const missing = await fetch(`${baseUrl}/devspace-files/d/${token}`);
    assert.equal(missing.status, 404);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  assert.equal(output.some((line) => line.includes(token)), false);
  assert.equal(output.some((line) => line.includes("/devspace-files/d/[redacted]")), true);
} finally {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
  await running.close();
  await rm(stateDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}
