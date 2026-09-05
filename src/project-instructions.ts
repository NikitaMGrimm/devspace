import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export const DEFAULT_PROJECT_INSTRUCTION_MAX_BYTES = 32 * 1024;

export interface ProjectInstructionConfig {
  fallbackFileNames: string[];
  maxBytes: number;
}

export interface ProjectInstructionSource {
  path: string;
  content: string;
}

export interface ProjectInstructionChain {
  scope: string;
  sources: ProjectInstructionSource[];
  instructions: string;
  hash: string;
  truncated: boolean;
}

export function instructionFileNames(config: ProjectInstructionConfig): string[] {
  return Array.from(
    new Set([
      "AGENTS.override.md",
      "AGENTS.md",
      ...config.fallbackFileNames,
    ]),
  );
}

export function validateInstructionFallbackFileNames(fileNames: string[]): string[] {
  return Array.from(new Set(fileNames.map((entry) => entry.trim()).filter(Boolean))).map((entry) => {
    if (entry === "." || entry === ".." || basename(entry) !== entry || entry.includes("/") || entry.includes("\\")) {
      throw new Error(`Invalid project instruction fallback filename: ${entry}`);
    }
    return entry;
  });
}

export async function resolveProjectInstructions(
  projectRoot: string,
  requestedScope: string,
  config: ProjectInstructionConfig,
  globalDirectory?: string,
): Promise<ProjectInstructionChain> {
  const root = await realpath(projectRoot);
  const scope = await realpath(requestedScope);
  assertInside(root, scope);

  const sources: ProjectInstructionSource[] = [];
  if (globalDirectory) {
    try {
      const globalRoot = await realpath(globalDirectory);
      const selected = await selectInstructionFile(
        globalRoot, globalRoot, { ...config, fallbackFileNames: [] }, true,
      );
      if (selected) sources.push(selected);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  for (const directory of directoriesFromRoot(root, scope)) {
    const selected = await selectInstructionFile(root, directory, config);
    if (selected && !sources.some((source) => source.path === selected.path)) sources.push(selected);
  }

  const completeInstructions = sources.map((source) => source.content).join("\n\n");
  const encoded = Buffer.from(completeInstructions, "utf8");
  const truncated = encoded.byteLength > config.maxBytes;
  const instructions = truncated
    ? decodeCompleteUtf8Prefix(encoded, config.maxBytes)
    : completeInstructions;
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        sources.map((source) => ({
          path: relative(root, source.path).split(sep).join("/"),
          content: source.content,
        })),
      ),
    )
    .digest("hex");

  return { scope, sources, instructions, hash, truncated };
}

export async function isProjectInstructionFile(
  projectRoot: string,
  inputPath: string,
  config: ProjectInstructionConfig,
): Promise<boolean> {
  const root = await realpath(projectRoot);
  const absolute = resolve(root, inputPath);
  assertInside(root, absolute);
  if (!instructionFileNames(config).includes(basename(absolute))) return false;

  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const resolved = await realpath(absolute);
    assertInside(root, resolved);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function selectInstructionFile(
  root: string,
  directory: string,
  config: ProjectInstructionConfig,
  allowContainedSymlink = false,
): Promise<ProjectInstructionSource | undefined> {
  for (const fileName of instructionFileNames(config)) {
    const path = join(directory, fileName);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() && !(allowContainedSymlink && metadata.isSymbolicLink())) continue;
      const resolvedPath = await realpath(path);
      // A global symlink may target this configured directory, never an unrelated file.
      if (metadata.isSymbolicLink()) {
        try { assertInside(root, resolvedPath); } catch { continue; }
        if (!(await stat(resolvedPath)).isFile()) continue;
      }
      assertInside(root, resolvedPath);
      const content = decodeInstruction(await readFile(resolvedPath), resolvedPath);
      if (content.trim().length === 0) continue;
      return { path: resolvedPath, content };
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
  }
  return undefined;
}

function directoriesFromRoot(root: string, scope: string): string[] {
  const relationship = relative(root, scope);
  if (!relationship) return [root];
  const segments = relationship.split(sep).filter(Boolean);
  const directories = [root];
  for (let index = 1; index <= segments.length; index += 1) {
    directories.push(join(root, ...segments.slice(0, index)));
  }
  return directories;
}

function decodeInstruction(bytes: Buffer, path: string): string {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0")) throw new Error(`Project instruction file is binary: ${path}`);
    return content;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Project instruction file is binary:")) {
      throw error;
    }
    throw new Error(`Project instruction file is not valid UTF-8 text: ${path}`);
  }
}

function decodeCompleteUtf8Prefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function assertInside(root: string, path: string): void {
  const relationship = relative(root, path);
  if (
    relationship === "" ||
    (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`))
  ) {
    return;
  }
  throw new Error(`Instruction scope is outside workspace root: ${path}`);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
