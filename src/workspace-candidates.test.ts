import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatWorkspacePathFailure,
  resolveWorkspaceCandidates,
} from "./workspace-candidates.js";
import type { WorkspaceSession } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workspace-candidates-test-"));

try {
  await testNameRanking();
  await testHistoryValidationAndMerging();
  await testBoundedRepositoryScanning();
  await testNoMatchFallbackAndFormatting();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testNameRanking(): Promise<void> {
  const allowedRoot = join(root, "name-ranking");
  const exact = join(allowedRoot, "personal-vps");
  const normalized = join(allowedRoot, "personal_vps");
  const partial = join(allowedRoot, "personal-vps-archive");
  await Promise.all([exact, normalized, partial].map(createRepository));

  const ranked = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "personal-vps"),
    allowedRoots: [allowedRoot],
  });
  assert.deepEqual(ranked.slice(0, 3).map((candidate) => candidate.path), [
    exact,
    normalized,
    partial,
  ]);
  assert.deepEqual(ranked.slice(0, 3).map((candidate) => candidate.matchTier), [0, 1, 2]);

  const emptyHistory = join(allowedRoot, "empty");
  await mkdir(emptyHistory);
  const withoutEmptyHistory = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "empty"),
    allowedRoots: [allowedRoot],
    sessions: [workspaceSession("ws_empty", emptyHistory)],
  });
  assert.equal(withoutEmptyHistory.some((candidate) => candidate.path === emptyHistory), false);
  assert.equal(withoutEmptyHistory.every((candidate) => candidate.gitRepository), true);
}

async function testHistoryValidationAndMerging(): Promise<void> {
  const historyRoot = join(root, "history-root");
  const scanRoot = join(root, "scan-root");
  const historyProject = join(historyRoot, "shared-project");
  const scanProject = join(scanRoot, "shared-project");
  await createRepository(historyProject);
  await createRepository(scanProject);

  const ranked = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "shared-project"),
    allowedRoots: [historyRoot, scanRoot],
    sessions: [workspaceSession("ws_history", historyProject)],
  });
  assert.equal(ranked[0]?.path, historyProject);
  assert.equal(ranked[0]?.previouslyOpened, true);
  assert.equal(ranked.filter((candidate) => candidate.path === historyProject).length, 1);

  const validationRoot = join(root, "history-validation");
  const valid = join(validationRoot, "valid-project");
  const superseded = join(validationRoot, "superseded-project");
  const worktree = join(validationRoot, "worktree-project");
  const outside = join(root, "outside-history", "outside-project");
  await createRepository(valid);
  await createPlainWorkspace(superseded);
  await createPlainWorkspace(worktree);
  await createRepository(outside);
  const missing = join(validationRoot, "missing-project");

  const validated = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "valid-project"),
    allowedRoots: [validationRoot],
    sessions: [
      workspaceSession("ws_valid", valid, {
        lastUsedAt: "2000-01-01T00:00:00.000Z",
      }),
      workspaceSession("ws_missing", missing),
      workspaceSession("ws_superseded", superseded, { status: "superseded" }),
      workspaceSession("ws_worktree", worktree, { mode: "worktree" }),
      workspaceSession("ws_outside", outside),
    ],
  });
  assert.equal(validated.some((candidate) => candidate.path === valid), true);
  for (const invalid of [missing, superseded, worktree, outside]) {
    assert.equal(validated.some((candidate) => candidate.path === invalid), false);
  }
}

async function testBoundedRepositoryScanning(): Promise<void> {
  const scanRoot = join(root, "bounded-scan");
  const depthFour = join(scanRoot, "within", "one", "two", "repository");
  const depthFive = join(scanRoot, "beyond", "one", "two", "three", "repository");
  await createRepository(depthFour);
  await createRepository(depthFive);

  const outsideSymlinkTarget = join(root, "symlink-target", "linked-repository");
  await createRepository(outsideSymlinkTarget);
  await symlink(outsideSymlinkTarget, join(scanRoot, "linked-repository"), "dir");

  const found = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "four"),
    allowedRoots: [scanRoot],
  });
  assert.equal(found.some((candidate) => candidate.path === depthFour), true);
  assert.equal(found.some((candidate) => candidate.path === depthFive), false);
  assert.equal(found.some((candidate) => candidate.path === outsideSymlinkTarget), false);

  const cappedRoot = join(root, "directory-cap");
  await mkdir(cappedRoot);
  for (let index = 0; index < 10; index += 1) {
    await mkdir(join(cappedRoot, `directory-${index}`));
  }
  let inspected = 0;
  await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "none"),
    allowedRoots: [cappedRoot],
    limits: { maxDirectories: 3 },
    onDirectoryInspected: () => {
      inspected += 1;
    },
  });
  assert.equal(inspected, 3);

  const deterministicRoot = join(root, "deterministic");
  for (let index = 0; index < 8; index += 1) {
    await createRepository(join(deterministicRoot, `project-${index}`));
  }
  const first = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "project"),
    allowedRoots: [deterministicRoot],
  });
  const second = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "project"),
    allowedRoots: [deterministicRoot],
  });
  assert.equal(first.length, 5);
  assert.deepEqual(second, first);
}

async function testNoMatchFallbackAndFormatting(): Promise<void> {
  const allowedRoot = join(root, "no-match");
  const historyPaths: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const path = join(allowedRoot, `history-${index}`);
    await createPlainWorkspace(path);
    historyPaths.push(path);
  }
  for (let index = 0; index < 4; index += 1) {
    await createRepository(join(allowedRoot, `repository-${index}`));
  }

  const candidates = await resolveWorkspaceCandidates({
    requestedPath: join(root, "guessed", "unrelated-name"),
    allowedRoots: [allowedRoot],
    sessions: historyPaths.map((path, index) => workspaceSession(
      `ws_history_${index}`,
      path,
      { lastUsedAt: `2026-01-0${index + 1}T00:00:00.000Z` },
    )),
  });
  assert.equal(candidates.length, 5);
  assert.deepEqual(
    candidates.slice(0, 3).map((candidate) => candidate.path),
    historyPaths.slice(1).reverse(),
  );
  assert.equal(candidates.slice(3).every((candidate) => candidate.gitRepository), true);
  assert.equal(candidates.slice(3).every((candidate) => !candidate.previouslyOpened), true);

  const message = formatWorkspacePathFailure(
    "Workspace path does not exist",
    join(root, "guessed", "unrelated-name"),
    candidates,
  );
  assert.match(message, /Possible existing workspaces:/);
  assert.match(message, /Retry open_workspace with one of these existing paths/);
  for (const candidate of candidates) assert.match(message, new RegExp(escapeRegex(candidate.path)));
}

async function createRepository(path: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
}

async function createPlainWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "workspace\n");
}

function workspaceSession(
  id: string,
  path: string,
  overrides: Partial<WorkspaceSession> = {},
): WorkspaceSession {
  return {
    id,
    root: path,
    status: "active",
    mode: "checkout",
    managed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
