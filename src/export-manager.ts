import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, realpath, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import type { Request, Response } from "express";
import type { ExportConfig } from "./config.js";

const DOWNLOAD_PATH_PREFIX = "/devspace-files/d/";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

export interface ExportResult {
  url: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt: string;
}

export function exportToolResult(result: ExportResult): {
  content: Array<{
    type: "resource_link";
    uri: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [
      {
        type: "resource_link",
        uri: result.url,
        name: result.name,
        mimeType: result.mimeType,
        size: result.size,
      },
    ],
    structuredContent: { ...result },
  };
}

interface ExportEntry {
  snapshotPath: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAtMs: number;
}

type ExportLog = (
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
) => void;

interface ExportManagerOptions extends ExportConfig {
  publicBaseUrl: string;
  spoolDir?: string;
  now?: () => number;
  log?: ExportLog;
}

export class ExportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFileError";
  }
}

function isInside(candidate: string, root: string): boolean {
  const relationship = relative(root, candidate);
  return (
    relationship === "" ||
    (relationship !== ".." &&
      !relationship.startsWith(`..${sep}`) &&
      !isAbsolute(relationship))
  );
}

function safeDownloadName(value: string | undefined, fallback: string): string {
  const raw = (value?.trim() || fallback).replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  const cleaned = Array.from(
    raw
    .replace(/[\\/]/gu, "_")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim(),
  ).slice(0, 200).join("");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

function contentDisposition(name: string): string {
  const ascii =
    name
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_")
      .trim() || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sameFile(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

async function verifyOpenedPath(
  source: FileHandle,
  canonicalPath: string,
  canonicalRoot: string,
): Promise<Stats> {
  const opened = await source.stat();
  if (!opened.isFile()) throw new ExportFileError("Path is not a regular file.");

  // Linux usually exposes the actual object behind an open descriptor. If procfs
  // is unavailable, use the same identity check as macOS and Windows.
  if (process.platform === "linux") {
    try {
      const openedPath = await realpath(`/proc/self/fd/${source.fd}`);
      if (!isInside(openedPath, canonicalRoot)) {
        throw new ExportFileError("Path resolves outside the workspace.");
      }
      return opened;
    } catch (error) {
      if (error instanceof ExportFileError) throw error;
    }
  }

  const currentPath = await realpath(canonicalPath);
  const current = await stat(currentPath);
  if (!isInside(currentPath, canonicalRoot) || !sameFile(opened, current)) {
    throw new ExportFileError("Path changed while being exported.");
  }

  return opened;
}

async function writeAll(
  destination: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await destination.write(
      buffer,
      written,
      length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new ExportFileError("Unable to create export snapshot.");
    }
    written += result.bytesWritten;
  }
}

async function copyAndHash(
  source: FileHandle,
  destination: FileHandle,
  size: number,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(size, 1)));
  let position = 0;

  while (position < size) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead === 0) throw new ExportFileError("File changed while being exported.");
    hash.update(buffer.subarray(0, bytesRead));
    await writeAll(destination, buffer, bytesRead, position);
    position += bytesRead;
  }

  return hash.digest("hex");
}

export function redactExportRequestPath(path: string): string {
  return path.startsWith(DOWNLOAD_PATH_PREFIX)
    ? `${DOWNLOAD_PATH_PREFIX}[redacted]`
    : path;
}

export class DevSpaceExportManager {
  private readonly publicBaseUrl: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly spoolDir: string;
  private readonly now: () => number;
  private readonly log: ExportLog;
  private readonly entries = new Map<string, ExportEntry>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private totalBytes = 0;
  private pendingEntries = 0;
  private reservedBytes = 0;
  private spoolReady: Promise<string | undefined> | undefined;

  constructor(options: ExportManagerOptions) {
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/u, "");
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries;
    this.maxTotalBytes = options.maxTotalBytes;
    this.spoolDir =
      options.spoolDir ??
      join(tmpdir(), `devspace-exports-${process.pid}-${randomBytes(8).toString("hex")}`);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpired(),
      options.cleanupIntervalSeconds * 1000,
    );
    this.cleanupTimer.unref?.();
  }

  async exportFile(input: {
    workspaceRoot: string;
    path: string;
    downloadName?: string;
  }): Promise<ExportResult> {
    await this.cleanupExpired();
    if (typeof input.path !== "string" || !input.path.trim()) {
      throw new ExportFileError("File not found in workspace.");
    }
    if (input.path.includes("\0") || isAbsolute(input.path) || win32.isAbsolute(input.path)) {
      throw new ExportFileError("Path must be relative to the workspace.");
    }
    if (input.path.split(/[\\/]+/u).includes("..")) {
      throw new ExportFileError("Path resolves outside the workspace.");
    }

    let canonicalRoot: string;
    let canonicalPath: string;
    try {
      canonicalRoot = await realpath(input.workspaceRoot);
      canonicalPath = await realpath(resolve(canonicalRoot, input.path));
    } catch {
      throw new ExportFileError("File not found in workspace.");
    }
    if (!isInside(canonicalPath, canonicalRoot)) {
      throw new ExportFileError("Path resolves outside the workspace.");
    }

    const candidate = await stat(canonicalPath).catch(() => undefined);
    if (!candidate?.isFile()) throw new ExportFileError("Path is not a regular file.");
    if (candidate.size > this.maxBytes) {
      throw new ExportFileError("File exceeds the export size limit.");
    }

    let source: FileHandle | undefined;
    let snapshot: FileHandle | undefined;
    let snapshotPath: string | undefined;
    let reservedSize = 0;
    let reserved = false;
    let committed = false;

    try {
      source = await open(
        canonicalPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const before = await verifyOpenedPath(source, canonicalPath, canonicalRoot);
      if (before.size > this.maxBytes) {
        throw new ExportFileError("File exceeds the export size limit.");
      }
      if (
        this.entries.size + this.pendingEntries >= this.maxEntries ||
        this.totalBytes + this.reservedBytes + before.size > this.maxTotalBytes
      ) {
        throw new ExportFileError("Export capacity is temporarily unavailable.");
      }

      this.pendingEntries++;
      this.reservedBytes += before.size;
      reservedSize = before.size;
      reserved = true;

      await this.ensureSpool();
      const token = randomBytes(32).toString("base64url");
      snapshotPath = join(this.spoolDir, `${token}.bin`);
      snapshot = await open(
        snapshotPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      const sha256 = await copyAndHash(source, snapshot, before.size);
      const after = await source.stat();
      if (
        !sameFile(before, after) ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new ExportFileError("File changed while being exported.");
      }

      await snapshot.sync();
      await snapshot.close();
      snapshot = undefined;
      await source.close();
      source = undefined;

      const name = safeDownloadName(input.downloadName, basename(canonicalPath));
      const mimeType = MIME_TYPES.get(extname(name).toLowerCase()) ?? "application/octet-stream";
      const expiresAtMs = this.now() + this.ttlMs;
      const entry: ExportEntry = {
        snapshotPath,
        name,
        mimeType,
        size: before.size,
        sha256,
        expiresAtMs,
      };
      this.entries.set(token, entry);
      this.totalBytes += entry.size;
      committed = true;
      this.log("info", "file_export_created", {
        size: entry.size,
        mimeType,
        sha256Prefix: sha256.slice(0, 12),
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      return {
        url: `${this.publicBaseUrl}${DOWNLOAD_PATH_PREFIX}${token}`,
        name,
        mimeType,
        size: entry.size,
        sha256,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    } catch (error) {
      if (error instanceof ExportFileError) throw error;
      if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
        throw new ExportFileError("Path resolves outside the workspace.");
      }
      throw new ExportFileError("File not found in workspace.");
    } finally {
      if (reserved) {
        this.pendingEntries--;
        this.reservedBytes -= reservedSize;
      }
      await source?.close().catch(() => undefined);
      await snapshot?.close().catch(() => undefined);
      if (!committed && snapshotPath) {
        await unlink(snapshotPath).catch(() => undefined);
      }
    }
  }

  async handleHttp(req: Request, res: Response, token: string): Promise<void> {
    const startedAt = performance.now();
    const entry = await this.getEntry(token);
    if (!entry) {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.sendStatus(404);
      this.log("warn", "file_export_download", {
        status: 404,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return;
    }

    const current = await stat(entry.snapshotPath).catch(() => undefined);
    if (!current?.isFile() || current.size !== entry.size) {
      await this.deleteEntry(token, entry);
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.sendStatus(404);
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", entry.mimeType);
    res.setHeader("Content-Disposition", contentDisposition(entry.name));
    res.setHeader("Content-Length", String(entry.size));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("ETag", `"sha256-${entry.sha256}"`);
    res.on("finish", () => {
      this.log("info", "file_export_download", {
        status: res.statusCode,
        size: entry.size,
        mimeType: entry.mimeType,
        sha256Prefix: entry.sha256.slice(0, 12),
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    if (req.method === "HEAD" || entry.size === 0) {
      res.end();
      return;
    }

    const stream = createReadStream(entry.snapshotPath, {
      start: 0,
      end: entry.size - 1,
    });
    stream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.sendStatus(404);
    });
    stream.pipe(res);
  }

  async cleanupExpired(): Promise<number> {
    const expired = [...this.entries.entries()].filter(
      ([, entry]) => entry.expiresAtMs <= this.now(),
    );
    await Promise.all(expired.map(([token, entry]) => this.deleteEntry(token, entry)));
    return expired.length;
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.all(
      [...this.entries.entries()].map(([token, entry]) => this.deleteEntry(token, entry)),
    );
    await rm(this.spoolDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async getEntry(token: string): Promise<ExportEntry | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      await this.deleteEntry(token, entry);
      return undefined;
    }
    return entry;
  }

  private async deleteEntry(token: string, entry: ExportEntry): Promise<void> {
    if (this.entries.get(token) !== entry) return;
    this.entries.delete(token);
    this.totalBytes = Math.max(0, this.totalBytes - entry.size);
    await unlink(entry.snapshotPath).catch(() => undefined);
  }

  private async ensureSpool(): Promise<void> {
    this.spoolReady ??= mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    await this.spoolReady;
  }
}
