import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Development/CI check only. Nothing in the MCP runtime fetches or adopts upstream definitions.
const lock = JSON.parse(await readFile(new URL("../codex-compat.lock.json", import.meta.url), "utf8"));
const ref = process.argv[2] ?? lock.commit;
if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error("Invalid upstream revision.");
let failed = false;
for (const [path, expected] of Object.entries(lock.files)) {
  try {
    const url = `https://raw.githubusercontent.com/${lock.repository}/${encodeURIComponent(ref)}/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== expected) {
      failed = true;
      console.error(`CHANGED ${path}\n  pinned: ${expected}\n  ${ref}: ${actual}`);
    } else console.log(`UNCHANGED ${path}`);
  } catch (error) {
    failed = true;
    console.error(`UNVERIFIED ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) {
  console.error("Review upstream descriptions, schemas and behavior together. This check never updates the runtime or lock file.");
  process.exitCode = 1;
}
