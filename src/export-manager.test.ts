import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import express from "express";
import {
  DevSpaceExportManager,
  ExportFileError,
  exportToolResult,
  redactExportRequestPath,
} from "./export-manager.js";

const testRoot = await mkdtemp(join(tmpdir(), "devspace-export-test-"));
const workspace = join(testRoot, "workspace");
const outside = join(testRoot, "outside");
await mkdir(workspace);
await mkdir(outside);

try {
  await testSnapshotDownload();
  await testExpiry();
  await testPathAndFileTypeValidation();
  await testCapacityLimits();
  testRequestPathRedaction();
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

function manager(
  name: string,
  overrides: Partial<ConstructorParameters<typeof DevSpaceExportManager>[0]> = {},
): DevSpaceExportManager {
  return new DevSpaceExportManager({
    publicBaseUrl: "https://devspace.example.com",
    ttlSeconds: 300,
    maxBytes: 1024 * 1024,
    cleanupIntervalSeconds: 60,
    maxEntries: 8,
    maxTotalBytes: 8 * 1024 * 1024,
    spoolDir: join(testRoot, `spool-${name}`),
    ...overrides,
  });
}

async function testSnapshotDownload(): Promise<void> {
  const sourceName = "résumé source.pdf";
  const sourcePath = join(workspace, sourceName);
  const original = Buffer.from("immutable export bytes\n", "utf8");
  await writeFile(sourcePath, original);
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const exports = manager("download", {
    log: (_level, event, fields) => logs.push({ event, fields }),
  });
  const app = express();
  app.head("/devspace-files/d/:token", (req, res) => {
    void exports.handleHttp(req, res, String(req.params.token));
  });
  app.get("/devspace-files/d/:token", (req, res) => {
    void exports.handleHttp(req, res, String(req.params.token));
  });
  const httpServer = createHttpServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  try {
    const result = await exports.exportFile({
      workspaceRoot: workspace,
      path: sourceName,
      downloadName: "Résumé final.pdf",
    });
    assert.match(result.url, /^https:\/\/devspace\.example\.com\/devspace-files\/d\/[\w-]{43}$/u);
    assert.equal(result.name, "Résumé final.pdf");
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.size, original.length);
    assert.equal(result.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(logs[0]?.event, "file_export_created");
    assert.equal(JSON.stringify(logs).includes(basename(result.url)), false);

    await writeFile(sourcePath, "changed after export");
    const address = httpServer.address();
    assert.ok(address && typeof address !== "string");
    const token = result.url.split("/").at(-1);
    const url = `http://127.0.0.1:${address.port}/devspace-files/d/${token}`;

    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-type"), "application/pdf");
    assert.equal(head.headers.get("content-length"), String(original.length));
    assert.equal(head.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.equal(head.headers.get("etag"), `"sha256-${result.sha256}"`);
    assert.match(
      head.headers.get("content-disposition") ?? "",
      /filename\*=UTF-8''R%C3%A9sum%C3%A9%20final\.pdf/u,
    );

    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);

    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    await writeFile(join(workspace, "archive.zip"), zipBytes);
    const zip = await exports.exportFile({
      workspaceRoot: workspace,
      path: "archive.zip",
      downloadName: "folder/archive\n.zip",
    });
    assert.equal(zip.name, "folder_archive.zip");
    assert.equal(zip.mimeType, "application/zip");
    const zipToken = zip.url.split("/").at(-1);
    const zipResponse = await fetch(
      `http://127.0.0.1:${address.port}/devspace-files/d/${zipToken}`,
    );
    assert.deepEqual(Buffer.from(await zipResponse.arrayBuffer()), zipBytes);

    const toolResult = exportToolResult(zip);
    assert.deepEqual(toolResult.content, [
      {
        type: "resource_link",
        uri: zip.url,
        name: zip.name,
        mimeType: zip.mimeType,
        size: zip.size,
      },
    ]);
    assert.deepEqual(toolResult.structuredContent, zip);
    assert.equal(JSON.stringify(toolResult).includes(zipBytes.toString("base64")), false);
    assert.equal(JSON.stringify(toolResult).includes(workspace), false);

    const missing = await fetch(`${url}x`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "private, no-store, max-age=0");
  } finally {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    await exports.close();
  }

  assert.equal(existsSync(join(testRoot, "spool-download")), false);
}

async function testExpiry(): Promise<void> {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const source = join(workspace, "expires.txt");
  await writeFile(source, "temporary");
  const exports = manager("expiry", { ttlSeconds: 1, now: () => now });
  const app = express();
  app.get("/devspace-files/d/:token", (req, res) => {
    void exports.handleHttp(req, res, String(req.params.token));
  });
  const httpServer = createHttpServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const result = await exports.exportFile({ workspaceRoot: workspace, path: "expires.txt" });
    now += 1001;
    const address = httpServer.address();
    assert.ok(address && typeof address !== "string");
    const token = result.url.split("/").at(-1);
    const expired = await fetch(
      `http://127.0.0.1:${address.port}/devspace-files/d/${token}`,
    );
    assert.equal(expired.status, 404);
    assert.equal(await exports.cleanupExpired(), 0);
    assert.deepEqual(await readdir(join(testRoot, "spool-expiry")), []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    await exports.close();
  }
}

async function testPathAndFileTypeValidation(): Promise<void> {
  await writeFile(join(outside, "secret.txt"), "not exportable");
  await mkdir(join(workspace, "directory"));
  const exports = manager("paths");
  try {
    await assert.rejects(
      exports.exportFile({ workspaceRoot: workspace, path: "missing.pdf" }),
      /File not found in workspace/u,
    );
    await assert.rejects(
      exports.exportFile({ workspaceRoot: workspace, path: "../outside/secret.txt" }),
      (error: unknown) =>
        error instanceof ExportFileError && error.message === "Path resolves outside the workspace.",
    );
    await assert.rejects(
      exports.exportFile({ workspaceRoot: workspace, path: join(outside, "secret.txt") }),
      /Path must be relative to the workspace/u,
    );
    await assert.rejects(
      exports.exportFile({ workspaceRoot: workspace, path: "C:\\Windows\\system.ini" }),
      /Path must be relative to the workspace/u,
    );
    await assert.rejects(
      exports.exportFile({ workspaceRoot: workspace, path: "directory" }),
      /Path is not a regular file/u,
    );

    const link = join(workspace, "outside-link.txt");
    try {
      await symlink(join(outside, "secret.txt"), link);
      await assert.rejects(
        exports.exportFile({ workspaceRoot: workspace, path: "outside-link.txt" }),
        /Path resolves outside the workspace/u,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    if (process.platform !== "win32") {
      const fifo = join(workspace, "special.fifo");
      const created = spawnSync("mkfifo", [fifo]);
      if (created.status === 0) {
        await assert.rejects(
          exports.exportFile({ workspaceRoot: workspace, path: "special.fifo" }),
          /Path is not a regular file/u,
        );
      }
    }
  } finally {
    await exports.close();
  }
}

async function testCapacityLimits(): Promise<void> {
  await writeFile(join(workspace, "one.txt"), "12345");
  await writeFile(join(workspace, "two.txt"), "67890");

  const sizeLimited = manager("size-limit", { maxBytes: 4 });
  try {
    await assert.rejects(
      sizeLimited.exportFile({ workspaceRoot: workspace, path: "one.txt" }),
      /File exceeds the export size limit/u,
    );
  } finally {
    await sizeLimited.close();
  }

  const entryLimited = manager("entry-limit", { maxEntries: 1 });
  try {
    await entryLimited.exportFile({ workspaceRoot: workspace, path: "one.txt" });
    await assert.rejects(
      entryLimited.exportFile({ workspaceRoot: workspace, path: "two.txt" }),
      /Export capacity is temporarily unavailable/u,
    );
  } finally {
    await entryLimited.close();
  }

  const totalLimited = manager("total-limit", { maxTotalBytes: 9 });
  try {
    await totalLimited.exportFile({ workspaceRoot: workspace, path: "one.txt" });
    await assert.rejects(
      totalLimited.exportFile({ workspaceRoot: workspace, path: "two.txt" }),
      /Export capacity is temporarily unavailable/u,
    );
  } finally {
    await totalLimited.close();
  }
}

function testRequestPathRedaction(): void {
  const token = "A".repeat(43);
  assert.equal(
    redactExportRequestPath(`/devspace-files/d/${token}`),
    "/devspace-files/d/[redacted]",
  );
  assert.equal(redactExportRequestPath("/mcp"), "/mcp");
}
