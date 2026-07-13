import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { databasePath } from "./db/client.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { ensureCheckoutWorkspaceRoot, WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  if (platform() === "win32") {
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);
  const reopened = await registry.openWorkspace(root);

  assert.equal(reopened.workspace, workspace);
  assert.equal(reopened.workspace.id, workspace.id);

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["root instructions\n"],
  );
  assert.deepEqual(availableAgentsFiles, []);
  assert.deepEqual(
    workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [
      {
        name: "reviewer",
        description: "Read-only project reviewer.",
        provider: "codex",
        body: "Review only.",
      },
    ],
  );

  if (platform() !== "win32") {
    const unsafeAgentDir = join(root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));
    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(root);
    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  {
    let mkdirCalls = 0;
    const existingStats = await ensureCheckoutWorkspaceRoot(root, {
      stat: async (path) => {
        assert.equal(path, root);
        return await stat(path);
      },
      mkdir: async () => {
        mkdirCalls += 1;
      },
    });
    assert.equal(existingStats.isDirectory(), true);
    assert.equal(mkdirCalls, 0);
  }

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await mkdir(join(gitRoot, "nested"));
  await writeFile(join(gitRoot, "nested", "AGENTS.md"), "git nested instructions\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const nestedGitWorkspace = await registry.openWorkspace(join(gitRoot, "nested"));
  assert.equal(nestedGitWorkspace.workspace.root, gitRoot);
  assert.deepEqual(
    nestedGitWorkspace.instructionChain.sources.map((source) => source.content),
    ["git root instructions\n", "git nested instructions\n"],
  );
  const gitRootWorkspace = await registry.openWorkspace(gitRoot);
  assert.equal(gitRootWorkspace.workspace.id, nestedGitWorkspace.workspace.id);
  assert.deepEqual(
    gitRootWorkspace.instructionChain.sources.map((source) => source.content),
    ["git root instructions\n"],
  );
  const concurrentGitWorkspaces = await Promise.all(
    Array.from({ length: 20 }, () => registry.openWorkspace(join(gitRoot, "nested"))),
  );
  assert.deepEqual(
    new Set(concurrentGitWorkspaces.map((context) => context.workspace.id)),
    new Set([nestedGitWorkspace.workspace.id]),
  );

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);
  const secondWorktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.notEqual(secondWorktreeWorkspace.workspace.id, worktreeWorkspace.workspace.id);
  assert.notEqual(secondWorktreeWorkspace.workspace.root, worktreeWorkspace.workspace.root);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const concurrentlyRestored = await Promise.all(
    Array.from(
      { length: 20 },
      () => restoredRegistry.getWorkspace(persistentWorkspace.workspace.id),
    ),
  );
  assert.equal(new Set(concurrentlyRestored).size, 1);
  const restoredWorkspace = concurrentlyRestored[0];
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");
  assert.deepEqual(
    restoredWorkspace.agentProfiles.map((profile) => profile.name),
    ["reviewer"],
  );
  const persistentlyReopenedWorkspace = await restoredRegistry.openWorkspace(root);
  assert.equal(persistentlyReopenedWorkspace.workspace.id, persistentWorkspace.workspace.id);

  const restoredWorktree = await restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);
  secondStore.close();

  const migrationStateDir = join(root, ".migration-state");
  await mkdir(migrationStateDir);
  const legacyDatabase = new Database(databasePath(migrationStateDir));
  legacyDatabase.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    insert into devspace_schema_migrations values
      (1, 'workspace-state', '2026-01-01T00:00:00.000Z'),
      (2, 'oauth-state', '2026-01-01T00:00:00.000Z'),
      (3, 'local-agent-sessions', '2026-01-01T00:00:00.000Z');
    create table workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );
    insert into workspace_sessions values
      ('ws_older', '${root.replaceAll("'", "''")}', 'active', 'checkout', null, null, null, 'false',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('ws_newer', '${root.replaceAll("'", "''")}', 'active', 'checkout', null, null, null, 'false',
       '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  `);
  legacyDatabase.close();
  const migratedStore = new SqliteWorkspaceStore(migrationStateDir);
  assert.equal(migratedStore.getSession("ws_older")?.status, "superseded");
  assert.equal(migratedStore.getSession("ws_newer")?.status, "active");
  await assert.rejects(
    () => new WorkspaceRegistry(config, migratedStore).getWorkspace("ws_older"),
    /no longer active.*open_workspace/i,
  );
  assert.equal(
    migratedStore.getOrCreateCheckoutSession({ id: "ws_unused", root }).id,
    "ws_newer",
  );
  migratedStore.close();

  if (platform() !== "win32") {
    const plainRoot = join(root, "plain-project");
    const plainAlias = join(root, "plain-project-alias");
    await mkdir(plainRoot);
    await writeFile(join(plainRoot, "AGENTS.md"), "plain instructions\n");
    await symlink(plainRoot, plainAlias, "dir");
    const plainWorkspace = await registry.openWorkspace(plainRoot);
    const plainAliasWorkspace = await registry.openWorkspace(plainAlias);
    assert.equal(plainAliasWorkspace.workspace.id, plainWorkspace.workspace.id);
    assert.equal(plainAliasWorkspace.workspace.root, plainRoot);

    const aliasStateDir = join(root, ".alias-state");
    const aliasStore = new SqliteWorkspaceStore(aliasStateDir);
    aliasStore.createSession({
      id: "ws_legacy_alias",
      root: plainAlias,
      mode: "checkout",
    });
    const persistedAliasWorkspace = await new WorkspaceRegistry(config, aliasStore)
      .openWorkspace(plainAlias);
    assert.equal(persistedAliasWorkspace.workspace.id, "ws_legacy_alias");
    assert.equal(persistedAliasWorkspace.workspace.root, plainRoot);
    assert.equal(aliasStore.getSession("ws_legacy_alias")?.root, plainRoot);
    aliasStore.close();

    const escapeAlias = join(root, "outside-alias");
    await symlink(outsideRoot, escapeAlias, "dir");
    await assert.rejects(
      () => registry.openWorkspace(escapeAlias),
      /outside allowed roots/i,
    );

    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));

    const allowedAliasStateDir = join(root, ".allowed-alias-state");
    const allowedAliasStore = new SqliteWorkspaceStore(allowedAliasStateDir);
    allowedAliasStore.createSession({
      id: "ws_legacy_allowed_alias",
      root: aliasRoot,
      mode: "checkout",
    });
    const aliasCheckout = await new WorkspaceRegistry(aliasConfig, allowedAliasStore)
      .openWorkspace(aliasRoot);
    assert.equal(aliasCheckout.workspace.id, "ws_legacy_allowed_alias");
    assert.equal(aliasCheckout.workspace.root, root);
    assert.equal(allowedAliasStore.getSession("ws_legacy_allowed_alias")?.root, root);
    assert.deepEqual(
      aliasCheckout.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
    allowedAliasStore.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
