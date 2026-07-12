// V4A parsing behavior is adapted from OpenAI's Agents SDK applyDiff utility:
// https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/utils/applyDiff.ts
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export type StructuredPatchOperation =
  | { type: "create_file"; path: string; diff: string }
  | { type: "update_file"; path: string; diff: string }
  | { type: "delete_file"; path: string };

export interface StructuredPatchResult {
  status: "completed";
  operation: StructuredPatchOperation["type"];
  path: string;
  changed: boolean;
  fuzz: number;
}

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface UpdateHunk {
  lines: HunkLine[];
  changeContext?: string;
  endOfFile: boolean;
}

const workspaceLocks = new Map<string, Promise<void>>();

function operationError(message: string): Error {
  return new Error(message);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function withWorkspaceLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(root) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const tail = previous.then(() => current);
  workspaceLocks.set(root, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (workspaceLocks.get(root) === tail) workspaceLocks.delete(root);
  }
}

async function resolveOperationPath(root: string, input: string): Promise<string> {
  if (
    !input
    || input.includes("\0")
    || isAbsolute(input)
    || /^[A-Za-z]:[\\/]/u.test(input)
    || input.startsWith("\\\\")
  ) {
    throw operationError("Path must be a non-empty relative path inside the workspace root.");
  }
  if (input.split(/[\\/]/).includes("..")) {
    throw operationError("Path traversal with '..' is not allowed.");
  }

  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, input);
  if (!isInside(canonicalRoot, target)) throw operationError("Path resolves outside the workspace root.");

  let leaf;
  try {
    leaf = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (leaf?.isSymbolicLink()) throw operationError("Editing through a symlink leaf is not allowed.");

  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw operationError("Parent directory does not exist; create it first and retry.");
    }
    throw error;
  }
  if (!isInside(canonicalRoot, parent)) throw operationError("Path resolves outside the workspace root.");
  return join(parent, basename(target));
}

function splitLines(value: string): { lines: string[]; eol: "\n" | "\r\n"; finalNewline: boolean } {
  const eol = value.includes("\r\n") ? "\r\n" : "\n";
  const normalized = value.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function parseCreateDiff(diff: string): string {
  if (diff.includes("*** Begin Patch") || /\*\*\* (?:Add|Update|Delete) File:/.test(diff)) {
    throw operationError("Use a bare V4A diff without patch or file-header wrappers.");
  }
  if (diff === "") return "";
  const parsed = splitLines(diff);
  if (parsed.lines.some((line) => !line.startsWith("+"))) {
    throw operationError("Every create-file diff line must start with '+'.");
  }
  const body = parsed.lines.map((line) => line.slice(1)).join(parsed.eol);
  return body + (parsed.finalNewline ? parsed.eol : "");
}

function parseUpdateDiff(diff: string): UpdateHunk[] {
  if (diff.includes("*** Begin Patch") || /\*\*\* (?:Add|Update|Delete) File:/.test(diff)) {
    throw operationError("Use a bare V4A diff without patch or file-header wrappers.");
  }
  const { lines } = splitLines(diff);
  const hunks: UpdateHunk[] = [];
  let current: UpdateHunk | undefined;
  const finish = (): void => {
    if (!current) return;
    if (current.lines.length === 0) throw operationError("Patch contains an empty update hunk.");
    hunks.push(current);
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      finish();
      const context = line.slice(2).trim();
      current = { lines: [], changeContext: context || undefined, endOfFile: false };
      continue;
    }
    if (line === "*** End of File") {
      if (!current) throw operationError("End-of-file marker must follow an update hunk.");
      current.endOfFile = true;
      continue;
    }
    if (line === "\\ No newline at end of file") continue;
    if (!current) throw operationError("Update diff must begin with an '@@' hunk header.");
    if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) });
    else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "remove", text: line.slice(1) });
    else throw operationError("Hunk lines must start with space, '+', or '-'.");
  }
  finish();
  if (hunks.length === 0) throw operationError("Patch contains no update hunks.");
  return hunks;
}

function findSequence(
  haystack: string[],
  needle: string[],
  from: number,
  endOfFile: boolean,
): { index: number; fuzz: number } | undefined {
  if (needle.length === 0) return { index: endOfFile ? haystack.length : from, fuzz: 0 };
  const normalizers = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
  ];
  for (let fuzz = 0; fuzz < normalizers.length; fuzz += 1) {
    const normalize = normalizers[fuzz];
    const first = endOfFile ? haystack.length - needle.length : from;
    const last = haystack.length - needle.length;
    for (let index = first; index <= last; index += 1) {
      if (index >= from && needle.every((line, offset) => normalize(haystack[index + offset] ?? "") === normalize(line))) {
        return { index, fuzz };
      }
    }
  }
  return undefined;
}

function applyUpdateDiff(content: string, diff: string): { content: string; fuzz: number } {
  const source = splitLines(content);
  const lines = [...source.lines];
  const hunks = parseUpdateDiff(diff);
  let cursor = 0;
  let fuzz = 0;

  for (const hunk of hunks) {
    if (hunk.changeContext) {
      const context = findSequence(lines, [hunk.changeContext], cursor, false);
      if (!context) throw operationError("Patch context did not match; read the current file and regenerate the hunk.");
      cursor = context.index + 1;
      fuzz += context.fuzz;
    }
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const match = findSequence(lines, oldLines, cursor, hunk.endOfFile);
    if (!match) throw operationError("Patch context did not match; read the current file and regenerate the hunk.");
    let oldOffset = 0;
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.kind === "add") newLines.push(line.text);
      else if (line.kind === "context") newLines.push(lines[match.index + oldOffset++] ?? line.text);
      else oldOffset += 1;
    }
    lines.splice(match.index, oldLines.length, ...newLines);
    cursor = match.index + newLines.length;
    fuzz += match.fuzz;
  }

  const normalized = lines.join("\n") + (source.finalNewline ? "\n" : "");
  return {
    content: source.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized,
    fuzz,
  };
}

async function readTextFile(path: string): Promise<{ content: string; mode: number }> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw operationError("Path is not a regular file.");
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw operationError("Binary files containing NUL bytes cannot be patched.");
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), mode: metadata.mode };
  } catch {
    throw operationError("File is not valid UTF-8 text.");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(destination: string, content: string, mode?: number): Promise<void> {
  const temporary = `${destination}.devspace-patch-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content, "utf8");
    if (mode !== undefined) await handle.chmod(mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32" || !(await exists(destination))) {
      await rename(temporary, destination);
    } else {
      const backup = `${temporary}.original`;
      await rename(destination, backup);
      try {
        await rename(temporary, destination);
        await rm(backup, { force: true }).catch(() => undefined);
      } catch (error) {
        await rename(backup, destination).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applyStructuredPatch(
  root: string,
  operation: StructuredPatchOperation,
): Promise<StructuredPatchResult> {
  return withWorkspaceLock(resolve(root), async () => {
    const destination = await resolveOperationPath(root, operation.path);

    if (operation.type === "create_file") {
      if (await exists(destination)) throw operationError("File already exists; use update_file instead.");
      const content = parseCreateDiff(operation.diff);
      if (content.includes("\0")) throw operationError("Binary content containing NUL bytes is not supported.");
      await atomicWrite(destination, content);
      return { status: "completed", operation: operation.type, path: operation.path, changed: true, fuzz: 0 };
    }

    if (!(await exists(destination))) throw operationError("File does not exist; re-read the directory and retry with the current path.");
    if (operation.type === "delete_file") {
      const metadata = await lstat(destination);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw operationError("Path is not a regular file.");
      await rm(destination);
      return { status: "completed", operation: operation.type, path: operation.path, changed: true, fuzz: 0 };
    }

    const current = await readTextFile(destination);
    const updated = applyUpdateDiff(current.content, operation.diff);
    if (updated.content !== current.content) await atomicWrite(destination, updated.content, current.mode);
    return {
      status: "completed",
      operation: operation.type,
      path: operation.path,
      changed: updated.content !== current.content,
      fuzz: updated.fuzz,
    };
  });
}
