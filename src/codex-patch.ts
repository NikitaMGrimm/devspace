import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type CodexPatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; lines: string[] };
export interface CodexPatch { environmentId?: string; operations: CodexPatchOperation[] }

/** The Codex patch envelope, carried in MCP's JSON string argument. */
export function parseCodexPatch(patch: string): CodexPatch {
  if (Buffer.byteLength(patch) > 4 * 1024 * 1024 || patch.includes("\0")) {
    throw new Error("Patch is too large or contains NUL bytes.");
  }
  const lines = patch.trim().replace(/\r\n/g, "\n").split("\n");
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error("Expected *** Begin Patch and *** End Patch; do not include Markdown fences.");
  }
  let environmentId: string | undefined;
  if (lines[0]?.startsWith("*** Environment ID: ")) {
    environmentId = lines.shift()!.slice("*** Environment ID: ".length).trim();
    if (!environmentId) throw new Error("Empty environment ID.");
  }
  const operations: CodexPatchOperation[] = [];
  for (let i = 0; i < lines.length;) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]!);
    if (!header) throw new Error(`Invalid patch header at line ${i + 1}.`);
    const path = header[2]!.trim();
    if (!path) throw new Error("Empty patch path.");
    if (header[1] === "Delete") {
      operations.push({ kind: "delete", path });
      continue;
    }
    let moveTo: string | undefined;
    if (header[1] === "Update" && lines[i]?.startsWith("*** Move to: ")) {
      moveTo = lines[i++]!.slice("*** Move to: ".length).trim();
      if (!moveTo) throw new Error("Empty move destination.");
    }
    const body: string[] = [];
    while (i < lines.length && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[i]!)) {
      body.push(lines[i++]!);
    }
    if (header[1] === "Add") {
      if (body.some((line) => !line.startsWith("+"))) throw new Error("Add-file lines must start with '+'.");
      operations.push({ kind: "add", path, lines: body.map((line) => line.slice(1)) });
    } else {
      operations.push({ kind: "update", path, moveTo, lines: body });
    }
  }
  if (!operations.length) throw new Error("Patch contains no file operations.");
  return { environmentId, operations };
}

const normalizers = [
  (s: string) => s,
  (s: string) => s.trimEnd(),
  (s: string) => s.trim(),
];
function locate(lines: string[], needle: string[], start: number, eof = false): number {
  if (!needle.length) return lines.length;
  for (const normalize of normalizers) {
    const from = eof ? lines.length - needle.length : start;
    const to = eof ? from : lines.length - needle.length;
    for (let i = Math.max(start, from); i <= to; i++) {
      if (needle.every((line, j) => normalize(lines[i + j]!) === normalize(line))) return i;
    }
  }
  throw new Error("Patch context did not match; read the current file and regenerate the patch.");
}

function updateText(source: Buffer, body: string[]): Buffer {
  if (source.includes(0)) throw new Error("Cannot update a binary file.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (!body.length) return source;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hadNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hadNewline || text === "") lines.pop();
  let cursor = 0;
  for (let i = 0; i < body.length;) {
    const header = body[i]!;
    if (header === "@@" || header.startsWith("@@ ")) {
      i++;
      const context = header.slice(2).trim();
      if (context) cursor = locate(lines, [context], cursor) + 1;
    } else if (i !== 0) {
      throw new Error("Expected an '@@' hunk header.");
    }
    const oldLines: string[] = [];
    const actions: Array<{ kind: "add" | "remove" | "context"; text: string }> = [];
    let eof = false;
    let consumed = 0;
    while (i < body.length && body[i] !== "@@" && !body[i]!.startsWith("@@ ")) {
      const line = body[i++]!;
      if (line === "*** End of File") { eof = true; break; }
      if (line === "\\ No newline at end of file") continue;
      if (line.startsWith("+")) actions.push({ kind: "add", text: line.slice(1) });
      else if (line.startsWith("-")) { oldLines.push(line.slice(1)); actions.push({ kind: "remove", text: line.slice(1) }); }
      else if (line.startsWith(" ") || line === "") {
        oldLines.push(line.slice(1)); actions.push({ kind: "context", text: line.slice(1) });
      } else throw new Error("Hunk lines must start with space, '+' or '-'.");
      consumed++;
    }
    if (!consumed) throw new Error("Empty update hunk.");
    const at = locate(lines, oldLines, cursor, eof);
    let offset = 0;
    const replacement: string[] = [];
    for (const action of actions) {
      if (action.kind === "add") replacement.push(action.text);
      else if (action.kind === "context") replacement.push(lines[at + offset++]!);
      else offset++;
    }
    lines.splice(at, oldLines.length, ...replacement);
    cursor = at + replacement.length;
  }
  // Preserve an existing file's newline convention instead of silently reformatting it.
  return Buffer.from(lines.join(eol) + (lines.length && (hadNewline || text === "") ? eol : ""));
}

interface Snapshot { data: Buffer | null; mode?: number }
const locks = new Map<string, Promise<void>>();
export async function withPatchLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const tail = previous.then(() => current);
  locks.set(root, tail);
  await previous;
  try { return await run(); }
  finally { release(); if (locks.get(root) === tail) locks.delete(root); }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Reject symlink components, including dangling leaves and parents not yet created. */
export async function containedPatchPath(root: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || input.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid path or '..' path traversal.");
  }
  if (process.platform !== "win32" && (/^[A-Za-z]:/.test(input) || input.includes("\\"))) {
    throw new Error("Use paths native to the server's operating system.");
  }
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Path must name a file inside the workspace.");
  }
  let current = root;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Symlink paths are not allowed.");
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error("A parent path is not a directory.");
    } catch (error) { if (missing(error)) break; throw error; }
  }
  return path;
}
async function snapshot(path: string): Promise<Snapshot> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Patch target is not a regular file.");
    if (info.size > 16 * 1024 * 1024) throw new Error("Patch target exceeds 16 MiB.");
    return { data: await readFile(path), mode: info.mode & 0o777 };
  } catch (error) { if (missing(error)) return { data: null }; throw error; }
}
function equal(a: Snapshot, b: Snapshot): boolean {
  return a.mode === b.mode && (a.data === null ? b.data === null : b.data !== null && a.data.equals(b.data));
}
async function install(path: string, value: Snapshot): Promise<void> {
  if (value.data === null) { await unlink(path); return; }
  const temporary = join(dirname(path), `.${basename(path)}.devspace-${randomUUID()}`);
  const handle = await open(temporary, "wx", value.mode ?? 0o600);
  try {
    await handle.writeFile(value.data);
    if (value.mode !== undefined) await handle.chmod(value.mode);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
}

/** Validate the entire patch first; atomically replace individual files and roll back on failure. */
export async function applyCodexPatch(rootInput: string, patch: CodexPatch): Promise<string> {
  const root = await realpath(rootInput);
  return withPatchLock(root, async () => {
    const before = new Map<string, Snapshot>();
    const after = new Map<string, Snapshot>();
    const acquire = async (input: string): Promise<string> => {
      const path = await containedPatchPath(root, input);
      if (!before.has(path)) { const value = await snapshot(path); before.set(path, value); after.set(path, value); }
      return path;
    };
    for (const operation of patch.operations) {
      const path = await acquire(operation.path);
      const value = after.get(path)!;
      if (operation.kind === "add") {
        if (value.data !== null) throw new Error(`File already exists: ${operation.path}`);
        after.set(path, { data: Buffer.from(operation.lines.length ? operation.lines.join("\n") + "\n" : ""), mode: 0o666 & ~process.umask() });
      } else {
        if (value.data === null) throw new Error(`File does not exist: ${operation.path}`);
        if (operation.kind === "delete") { after.set(path, { data: null }); continue; }
        const updated = { data: updateText(value.data, operation.lines), mode: value.mode };
        if (operation.moveTo) {
          const destination = await acquire(operation.moveTo);
          if (destination === path) { after.set(path, updated); continue; }
          if (after.get(destination)!.data !== null) throw new Error(`Move destination already exists: ${operation.moveTo}`);
          after.set(destination, updated);
          after.set(path, { data: null });
        } else after.set(path, updated);
      }
    }
    const changed = [...after].filter(([path, value]) => !equal(before.get(path)!, value));
    for (const [path] of changed) {
      if (!equal(await snapshot(path), before.get(path)!)) throw new Error(`File changed while preparing patch: ${relative(root, path)}`);
      for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
        if (after.get(parent)?.data) throw new Error("Patch would create both a file and a directory at the same path.");
      }
    }
    const installed: string[] = [];
    const createdDirectories: string[] = [];
    try {
      for (const [path, value] of changed) {
        await containedPatchPath(root, path);
        if (!equal(await snapshot(path), before.get(path)!)) throw new Error(`File changed before installation: ${relative(root, path)}`);
        if (value.data !== null) {
          const parents: string[] = [];
          for (let parent = dirname(path); parent !== root; parent = dirname(parent)) parents.unshift(parent);
          for (const parent of parents) {
            try { await mkdir(parent); createdDirectories.push(parent); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          }
          await containedPatchPath(root, path);
        }
        await install(path, value);
        installed.push(path);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const path of installed.reverse()) {
        try {
          await containedPatchPath(root, path);
          if (!equal(await snapshot(path), after.get(path)!)) throw new Error("changed by another writer");
          await install(path, before.get(path)!);
        } catch { rollbackErrors.push(relative(root, path)); }
      }
      for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}${rollbackErrors.length ? `; rollback incomplete: ${rollbackErrors.join(", ")}. Inspect these files before retrying.` : "; installed changes were rolled back."}`);
    }
    return changed.length
      ? "Success. Updated the following files:\n" + changed.map(([path, value]) => `${value.data === null ? "D" : before.get(path)!.data === null ? "A" : "M"} ${relative(root, path)}`).join("\n")
      : "Success. No files changed.";
  });
}
