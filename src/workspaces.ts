import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { mkdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { git } from "./git.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import {
  isProjectInstructionFile,
  resolveProjectInstructions,
  type ProjectInstructionChain,
} from "./project-instructions.js";
import {
  createSkillResourceCatalog,
  isSkillResource,
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";
import {
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillResources: ReturnType<typeof createSkillResourceCatalog>;
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
  activatedSkillIds: Set<string>;
  deliveredInstructionHashes: Map<string, string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  instructionChain: ProjectInstructionChain;
}

export interface WorkspaceInstructionPreflight {
  status: "instructions_required";
  instructionSources: string[];
  instructions: string;
  truncated: boolean;
  retryRequired: true;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly checkoutWorkspacesByRoot = new Map<string, Workspace>();
  private readonly checkoutOpenPromises = new Map<string, Promise<Workspace>>();
  private readonly workspaceRestorePromises = new Map<string, Promise<Workspace>>();
  private readonly reconciledCheckoutRoots = new Set<string>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const pending = this.workspaceRestorePromises.get(workspaceId);
    if (pending) return pending;

    const restoring = this.restoreWorkspace(workspaceId);
    this.workspaceRestorePromises.set(workspaceId, restoring);
    try {
      return await restoring;
    } finally {
      if (this.workspaceRestorePromises.get(workspaceId) === restoring) {
        this.workspaceRestorePromises.delete(workspaceId);
      }
    }
  }

  private async restoreWorkspace(workspaceId: string): Promise<Workspace> {
    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }
    if (session.status !== "active") {
      throw new Error(`Workspace ${workspaceId} is no longer active. Call open_workspace again.`);
    }

    const root = await this.assertStoredWorkspaceRootAllowed(
      session.root,
      session.mode,
      session.sourceRoot,
    );
    if (session.mode === "checkout") {
      await this.reconcileStoredCheckoutSessions(root);
      if (this.store?.getSession(workspaceId)?.status !== "active") {
        throw new Error(`Workspace ${workspaceId} is no longer active. Call open_workspace again.`);
      }
    }
    const loadedSkills = this.loadSkillsForWorkspace(root);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...loadedSkills,
      skillResources: createSkillResourceCatalog(loadedSkills.skills),
      agentProfiles: await loadLocalAgentProfiles(this.config, root),
      activatedSkillIds: new Set(),
      deliveredInstructionHashes: new Map(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);
    if (session.mode === "checkout" && session.status === "active") {
      this.checkoutWorkspacesByRoot.set(root, restoredWorkspace);
    }

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    if (isSkillResource(inputPath)) {
      const skillRead = resolveSkillReadPath(
        workspace.skillResources,
        workspace.activatedSkillIds,
        inputPath,
      );
      if (!skillRead) throw new Error(`Unknown skill resource: ${inputPath}`);

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }

    return {
      absolutePath: this.resolvePath(workspace, inputPath),
      readRoots: [workspace.root],
    };
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillIds, readPath.skillRead.resourceId);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  async getInstructionChain(
    workspace: Workspace,
    scopeDirectory: string = workspace.root,
  ): Promise<ProjectInstructionChain> {
    const scope = assertAllowedPath(scopeDirectory, [workspace.root]);
    return resolveProjectInstructions(workspace.root, scope, this.config.projectInstructions);
  }

  async preflightInstructions(
    workspace: Workspace,
    scopeDirectory: string = workspace.root,
  ): Promise<WorkspaceInstructionPreflight | undefined> {
    const chain = await this.getInstructionChain(workspace, scopeDirectory);
    if (workspace.deliveredInstructionHashes.get(chain.scope) === chain.hash) return undefined;

    workspace.deliveredInstructionHashes.set(chain.scope, chain.hash);
    if (chain.instructions.length === 0) return undefined;
    return {
      status: "instructions_required",
      instructionSources: chain.sources.map((source) => formatAgentsPath(source.path, workspace.root)),
      instructions: chain.instructions,
      truncated: chain.truncated,
      retryRequired: true,
    };
  }

  async markInstructionsDelivered(
    workspace: Workspace,
    scopeDirectory: string = workspace.root,
  ): Promise<ProjectInstructionChain> {
    const chain = await this.getInstructionChain(workspace, scopeDirectory);
    workspace.deliveredInstructionHashes.set(chain.scope, chain.hash);
    return chain;
  }

  async isDirectInstructionRead(workspace: Workspace, inputPath: string): Promise<boolean> {
    return isProjectInstructionFile(workspace.root, inputPath, this.config.projectInstructions);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const requestedRoot = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(requestedRoot);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    const canonicalAllowedRoots = await this.canonicalAllowedRoots();
    const canonicalRequestedRoot = assertAllowedPath(
      await realpath(requestedRoot),
      canonicalAllowedRoots,
    );
    const root = await this.findProjectRoot(canonicalRequestedRoot, canonicalAllowedRoots);
    const workspace = await this.openCanonicalCheckoutWorkspace(root);
    return this.createContext(workspace, canonicalRequestedRoot);
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
    initialScope?: string;
  }): Promise<WorkspaceContext> {
    const loadedSkills = this.loadSkillsForWorkspace(input.root);
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...loadedSkills,
      skillResources: createSkillResourceCatalog(loadedSkills.skills),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillIds: new Set(),
      deliveredInstructionHashes: new Map(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    return this.createContext(workspace, input.initialScope ?? workspace.root);
  }

  private async createContext(
    workspace: Workspace,
    initialScope: string,
  ): Promise<WorkspaceContext> {
    const instructionChain = await this.markInstructionsDelivered(workspace, initialScope);
    const agentsFiles = instructionChain.sources.map((source) => ({
      path: source.path,
      content: source.content,
    }));
    const availableAgentsFiles: AvailableAgentsFile[] = [];

    return { workspace, agentsFiles, availableAgentsFiles, instructionChain };
  }

  private async openCanonicalCheckoutWorkspace(root: string): Promise<Workspace> {
    const pending = this.checkoutOpenPromises.get(root);
    if (pending) return pending;

    const opening = (async () => {
      const existing = this.checkoutWorkspacesByRoot.get(root);
      if (existing) {
        await this.refreshWorkspaceMetadata(existing);
        this.store?.touchSession(existing.id);
        return existing;
      }

      const id = `ws_${randomUUID()}`;
      await this.reconcileStoredCheckoutSessions(root);
      const session = this.store?.getOrCreateCheckoutSession({ id, root });
      const persisted = session ? this.workspaces.get(session.id) : undefined;
      if (persisted) {
        await this.refreshWorkspaceMetadata(persisted);
        this.checkoutWorkspacesByRoot.set(root, persisted);
        return persisted;
      }

      const loadedSkills = this.loadSkillsForWorkspace(root);
      const workspace: Workspace = {
        id: session?.id ?? id,
        root,
        mode: "checkout",
        ...loadedSkills,
        skillResources: createSkillResourceCatalog(loadedSkills.skills),
        agentProfiles: await loadLocalAgentProfiles(this.config, root),
        activatedSkillIds: new Set(),
        deliveredInstructionHashes: new Map(),
      };
      this.workspaces.set(workspace.id, workspace);
      this.checkoutWorkspacesByRoot.set(root, workspace);
      return workspace;
    })();

    this.checkoutOpenPromises.set(root, opening);
    try {
      return await opening;
    } finally {
      if (this.checkoutOpenPromises.get(root) === opening) {
        this.checkoutOpenPromises.delete(root);
      }
    }
  }

  private async reconcileStoredCheckoutSessions(root: string): Promise<void> {
    if (!this.store || this.reconciledCheckoutRoots.has(root)) return;

    const matchingIds: string[] = [];
    for (const session of this.store.listActiveCheckoutSessions()) {
      try {
        if (await realpath(session.root) === root) matchingIds.push(session.id);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      }
    }
    this.store.reconcileCheckoutSessions(root, matchingIds);
    this.reconciledCheckoutRoots.add(root);
  }

  private async refreshWorkspaceMetadata(workspace: Workspace): Promise<void> {
    const loadedSkills = this.loadSkillsForWorkspace(workspace.root);
    const agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    workspace.skills = loadedSkills.skills;
    workspace.skillResources = createSkillResourceCatalog(loadedSkills.skills);
    workspace.skillDiagnostics = loadedSkills.skillDiagnostics;
    workspace.agentProfiles = agentProfiles;
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async assertStoredWorkspaceRootAllowed(
    root: string,
    mode: WorkspaceMode,
    sourceRoot: string | undefined,
  ): Promise<string> {
    if (mode === "worktree") {
      return this.assertWorkspaceRootAllowed(root, mode, sourceRoot);
    }

    return assertAllowedPath(await realpath(root), await this.canonicalAllowedRoots());
  }

  private async canonicalAllowedRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const allowedRoot of this.config.allowedRoots) {
      try {
        roots.push(await realpath(resolve(allowedRoot)));
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      }
    }
    if (roots.length === 0) {
      throw new Error("No configured allowed root exists.");
    }
    return roots;
  }

  private async findProjectRoot(requestedRoot: string, allowedRoots: string[]): Promise<string> {
    try {
      const gitRoot = (await git(requestedRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
      if (!gitRoot) return requestedRoot;
      const allowedGitRoot = assertAllowedPath(await realpath(gitRoot), allowedRoots);
      if (!isPathInsideRoot(requestedRoot, allowedGitRoot)) return requestedRoot;
      return await realpath(allowedGitRoot);
    } catch {
      return requestedRoot;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
