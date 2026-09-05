import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

export async function readSmallFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Not a regular file.");
    if (before.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte tool limit.`);
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("File changed during read; retry.");
    }
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

export async function inspectFiles(paths: Array<{ path: string; absolutePath: string }>, hash: boolean) {
  const maxFile = 128 * 1024 * 1024;
  let remainingBytes = 256 * 1024 * 1024;
  const result: Array<Record<string, unknown>> = [];
  for (const item of paths) {
    const metadata = await stat(item.absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (!metadata) { result.push({ path: item.path, type: "missing" }); continue; }
    const entry: Record<string, unknown> = {
      path: item.path, absolute_path: item.absolutePath,
      type: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other",
      size: metadata.size, modified_at: metadata.mtime.toISOString(),
    };
    if (hash && metadata.isFile()) {
      if (metadata.size > maxFile || metadata.size > remainingBytes) {
        entry.hash_error = "Hash budget exceeded (128 MiB/file, 256 MiB/call).";
      } else {
        remainingBytes -= metadata.size;
        const handle = await open(item.absolutePath, "r");
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size !== metadata.size || before.ino !== metadata.ino || before.dev !== metadata.dev) {
            throw new Error("File changed before hashing; retry.");
          }
          const digest = createHash("sha256");
          const block = Buffer.alloc(1024 * 1024);
          let read = 0;
          while (read < before.size) {
            const { bytesRead } = await handle.read(block, 0, Math.min(block.length, before.size - read), read);
            if (!bytesRead) throw new Error("File changed during hashing; retry.");
            digest.update(block.subarray(0, bytesRead));
            read += bytesRead;
          }
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new Error("File changed during hashing; retry.");
          }
          entry.sha256 = digest.digest("hex");
        } finally { await handle.close(); }
      }
    }
    result.push(entry);
  }
  return { files: result, hash_requested: hash, hash_byte_budget: 256 * 1024 * 1024 };
}
