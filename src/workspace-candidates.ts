import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { isPathInsideRoot } from "./roots.js";
import type { WorkspaceSession } from "./workspace-store.js";

export const WORKSPACE_SCAN_MAX_DEPTH = 4;
export const WORKSPACE_SCAN_MAX_DIRECTORIES = 2_000;
export const WORKSPACE_CANDIDATE_LIMIT = 5;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  "node_modules",
  ".venv",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
]);

export interface WorkspaceCandidate {
  path: string;
  gitRepository: boolean;
  previouslyOpened: boolean;
  lastUsedAt?: string;
  matchTier: number;
  depth: number;
}

export interface WorkspaceCandidateLimits {
  maxDepth: number;
  maxDirectories: number;
  maxCandidates: number;
}

export interface ResolveWorkspaceCandidatesInput {
  requestedPath: string;
  allowedRoots: string[];
  sessions?: WorkspaceSession[];
  limits?: Partial<WorkspaceCandidateLimits>;
  onDirectoryInspected?: (path: string) => void;
}

export type WorkspaceCandidateResolver = (
  input: ResolveWorkspaceCandidatesInput,
) => Promise<WorkspaceCandidate[]>;

interface CandidateRecord {
  path: string;
  gitRepository: boolean;
  previouslyOpened: boolean;
  lastUsedAt?: string;
  depth: number;
}

interface ScanEntry {
  path: string;
  depth: number;
  allowedRoot: string;
}

export const resolveWorkspaceCandidates: WorkspaceCandidateResolver = async (input) => {
  const limits: WorkspaceCandidateLimits = {
    maxDepth: boundedLimit(input.limits?.maxDepth, WORKSPACE_SCAN_MAX_DEPTH),
    maxDirectories: boundedLimit(
      input.limits?.maxDirectories,
      WORKSPACE_SCAN_MAX_DIRECTORIES,
    ),
    maxCandidates: boundedLimit(
      input.limits?.maxCandidates,
      WORKSPACE_CANDIDATE_LIMIT,
    ),
  };
  const allowedRoots = await canonicalAllowedRoots(input.allowedRoots);
  const candidates = new Map<string, CandidateRecord>();

  for (const session of input.sessions ?? []) {
    const candidate = await storedSessionCandidate(session, allowedRoots);
    if (candidate) mergeCandidate(candidates, candidate);
  }

  for (const candidate of await scanGitRepositories(
    allowedRoots,
    limits,
    input.onDirectoryInspected,
  )) {
    mergeCandidate(candidates, candidate);
  }

  const requestedBasename = basename(resolve(input.requestedPath));
  const ranked = Array.from(candidates.values())
    .map((candidate): WorkspaceCandidate => ({
      ...candidate,
      matchTier: nameMatchTier(requestedBasename, basename(candidate.path)),
    }))
    .sort(compareCandidates);

  if (ranked.length > 0 && ranked.every((candidate) => candidate.matchTier === 4)) {
    const history = ranked
      .filter((candidate) => candidate.previouslyOpened)
      .sort(compareNoMatchHistory)
      .slice(0, 3);
    const discovered = ranked
      .filter((candidate) => !candidate.previouslyOpened && candidate.gitRepository)
      .sort(compareShallowCandidates)
      .slice(0, 2);
    return [...history, ...discovered].slice(0, limits.maxCandidates);
  }

  return ranked.slice(0, limits.maxCandidates);
};

export function formatWorkspacePathFailure(
  heading: string,
  requestedPath: string,
  candidates: WorkspaceCandidate[],
): string {
  const lines = [`${heading}:`, `  ${requestedPath}`];
  if (candidates.length === 0) {
    lines.push(
      "",
      "No existing workspace candidates were found under configured allowed roots.",
      "",
      "Retry open_workspace with an existing directory under an allowed root.",
    );
    return lines.join("\n");
  }

  lines.push("", "Possible existing workspaces:");
  for (const [index, candidate] of candidates.entries()) {
    lines.push(
      `${index + 1}. ${candidate.path}`,
      `   ${workspaceCandidateSummary(candidate)}`,
    );
  }
  lines.push("", "Retry open_workspace with one of these existing paths.");
  return lines.join("\n");
}

export function normalizeWorkspaceName(name: string): string {
  return name.toLowerCase().replace(/[\s._-]+/g, "");
}

async function canonicalAllowedRoots(roots: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    try {
      const path = await realpath(resolve(root));
      if ((await stat(path)).isDirectory() && !canonical.includes(path)) canonical.push(path);
    } catch (error) {
      if (!isIgnorableDirectoryError(error)) throw error;
    }
  }
  return canonical.sort((left, right) => left.localeCompare(right));
}

async function storedSessionCandidate(
  session: WorkspaceSession,
  allowedRoots: string[],
): Promise<CandidateRecord | undefined> {
  if (session.mode !== "checkout" || session.status !== "active") return undefined;

  try {
    const path = await realpath(resolve(session.root));
    if (!(await stat(path)).isDirectory()) return undefined;
    const allowedRoot = allowedRoots.find((root) => isPathInsideRoot(path, root));
    if (!allowedRoot) return undefined;

    const entries = await readdir(path, { withFileTypes: true });
    const gitRepository = entries.some(
      (entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()),
    );
    if (!gitRepository && entries.length === 0) return undefined;

    return {
      path,
      gitRepository,
      previouslyOpened: true,
      lastUsedAt: session.lastUsedAt,
      depth: pathDepth(path, allowedRoot),
    };
  } catch (error) {
    if (isIgnorableDirectoryError(error)) return undefined;
    throw error;
  }
}

async function scanGitRepositories(
  allowedRoots: string[],
  limits: WorkspaceCandidateLimits,
  onDirectoryInspected: ResolveWorkspaceCandidatesInput["onDirectoryInspected"],
): Promise<CandidateRecord[]> {
  const candidates: CandidateRecord[] = [];
  const queue: ScanEntry[] = allowedRoots.map((path) => ({
    path,
    depth: 0,
    allowedRoot: path,
  }));
  let inspected = 0;

  while (queue.length > 0 && inspected < limits.maxDirectories) {
    const current = queue.shift();
    if (!current) break;
    inspected += 1;
    onDirectoryInspected?.(current.path);

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      if (isIgnorableDirectoryError(error)) continue;
      throw error;
    }

    const gitRepository = entries.some(
      (entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()),
    );
    if (gitRepository) {
      try {
        const path = await realpath(current.path);
        if (isPathInsideRoot(path, current.allowedRoot)) {
          candidates.push({
            path,
            gitRepository: true,
            previouslyOpened: false,
            depth: current.depth,
          });
        }
      } catch (error) {
        if (!isIgnorableDirectoryError(error)) throw error;
      }
      continue;
    }

    if (current.depth >= limits.maxDepth) continue;
    const children = entries
      .filter((entry) =>
        entry.isDirectory()
        && !entry.name.startsWith(".")
        && !SKIPPED_DIRECTORY_NAMES.has(entry.name)
      )
      .map((entry) => join(current.path, entry.name))
      .sort((left, right) => left.localeCompare(right));
    for (const path of children) {
      queue.push({
        path,
        depth: current.depth + 1,
        allowedRoot: current.allowedRoot,
      });
    }
  }

  return candidates;
}

function mergeCandidate(
  candidates: Map<string, CandidateRecord>,
  candidate: CandidateRecord,
): void {
  const existing = candidates.get(candidate.path);
  if (!existing) {
    candidates.set(candidate.path, candidate);
    return;
  }

  candidates.set(candidate.path, {
    path: candidate.path,
    gitRepository: existing.gitRepository || candidate.gitRepository,
    previouslyOpened: existing.previouslyOpened || candidate.previouslyOpened,
    lastUsedAt: mostRecent(existing.lastUsedAt, candidate.lastUsedAt),
    depth: Math.min(existing.depth, candidate.depth),
  });
}

function nameMatchTier(requestedName: string, candidateName: string): number {
  const requestedLower = requestedName.toLowerCase();
  const candidateLower = candidateName.toLowerCase();
  if (requestedLower === candidateLower) return 0;

  const requested = normalizeWorkspaceName(requestedName);
  const candidate = normalizeWorkspaceName(candidateName);
  if (requested === candidate) return 1;
  if (requested.includes(candidate) || candidate.includes(requested)) return 2;
  if (requested && candidate && editDistance(requested, candidate) <= 2) return 3;
  return 4;
}

function compareCandidates(left: WorkspaceCandidate, right: WorkspaceCandidate): number {
  return left.matchTier - right.matchTier
    || Number(right.gitRepository) - Number(left.gitRepository)
    || Number(right.previouslyOpened) - Number(left.previouslyOpened)
    || (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "")
    || left.depth - right.depth
    || left.path.localeCompare(right.path);
}

function compareNoMatchHistory(left: WorkspaceCandidate, right: WorkspaceCandidate): number {
  return (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "")
    || Number(right.gitRepository) - Number(left.gitRepository)
    || left.depth - right.depth
    || left.path.localeCompare(right.path);
}

function compareShallowCandidates(left: WorkspaceCandidate, right: WorkspaceCandidate): number {
  return left.depth - right.depth || left.path.localeCompare(right.path);
}

function workspaceCandidateSummary(candidate: WorkspaceCandidate): string {
  const reasons: string[] = [];
  if (candidate.matchTier === 0) reasons.push("exact name match");
  if (candidate.matchTier === 1) reasons.push("exact normalized name match");
  if (candidate.matchTier === 2) reasons.push("partial name match");
  if (candidate.matchTier === 3) reasons.push("similar name");
  if (candidate.gitRepository) reasons.push("Git repository");
  if (candidate.previouslyOpened) reasons.push("previously opened");
  return reasons.length > 0 ? reasons.join(", ") : "existing workspace";
}

function pathDepth(path: string, root: string): number {
  const relationship = relative(root, path);
  if (!relationship) return 0;
  return relationship.split(sep).filter(Boolean).length;
}

function mostRecent(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function isIgnorableDirectoryError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(
      String((error as NodeJS.ErrnoException).code),
    );
}

function boundedLimit(value: number | undefined, maximum: number): number {
  return Math.max(0, Math.min(value ?? maximum, maximum));
}
