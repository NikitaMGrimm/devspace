import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";
import { discoverCodexPluginSkills } from "./codex-plugin-skills.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
  resourceId: string;
}

export interface SkillResource {
  id: string;
  resource: string;
  skill: Skill;
  canonicalBaseDir: string;
  canonicalSkillFile: string;
}

export class SkillResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResourceError";
  }
}

const SUBAGENT_DELEGATION_NAME = "subagent-delegation";
const SUBAGENT_DELEGATION_SKILL = join(SUBAGENT_DELEGATION_NAME, "SKILL.md");
const SKILL_RESOURCE_PREFIX = "skill://catalog/";
const SKILL_RESOURCE_PATTERN = /^skill:\/\/catalog\/([a-f0-9]{64})\/(.+)$/u;

function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function hasSubagentDelegationSkill(skillDir: string): boolean {
  return existsSync(join(skillDir, SUBAGENT_DELEGATION_SKILL));
}

export function effectiveSkillPaths(
  config: ServerConfig,
  cwd: string,
  pluginPaths = discoverCodexPluginSkills(config.agentDir).paths,
): string[] {
  const bundledSkills = bundledSkillsDir();
  const defaultPathCandidates = [
    join(homedir(), ".agents", "skills"),
    resolve(cwd, ".agents", "skills"),
    config.devspaceSkillsDir,
    join(config.agentDir, "skills"),
    config.subagents && !hasSubagentDelegationSkill(config.devspaceSkillsDir)
      ? bundledSkills
      : undefined,
  ];
  const defaultPaths = defaultPathCandidates.filter(
    (path): path is string => path !== undefined && existsSync(path),
  );

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths, ...pluginPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const plugins = discoverCodexPluginSkills(config.agentDir);
  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd, plugins.paths),
    includeDefaults: false,
  });

  result.diagnostics.push(...plugins.diagnostics);
  if (config.subagents) return result;

  return {
    skills: result.skills.filter((skill) => skill.name !== SUBAGENT_DELEGATION_NAME),
    diagnostics: result.diagnostics.filter((diagnostic) => {
      const collision = diagnostic.collision;
      return !(collision?.resourceType === "skill" && collision.name === SUBAGENT_DELEGATION_NAME);
    }),
  };
}

export function createSkillResourceCatalog(skills: Skill[]): SkillResource[] {
  const resources: SkillResource[] = [];
  const seenNames = new Set<string>();

  for (const skill of skills) {
    if (seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    if (skill.disableModelInvocation) continue;

    try {
      const canonicalBaseDir = realpathSync(skill.baseDir);
      const canonicalSkillFile = realpathSync(skill.filePath);
      if (!statSync(canonicalSkillFile).isFile()) continue;
      if (!isPathInsideRoot(canonicalSkillFile, canonicalBaseDir)) continue;

      const id = createSkillResourceId(canonicalSkillFile);
      resources.push({
        id,
        resource: `${SKILL_RESOURCE_PREFIX}${id}/SKILL.md`,
        skill,
        canonicalBaseDir,
        canonicalSkillFile,
      });
    } catch {
      // Discovery is best-effort. A skill removed or made unreadable while the
      // catalog is built is simply unavailable to the model.
    }
  }

  return resources;
}

export function isSkillResource(input: string): boolean {
  return input.startsWith("skill:");
}

export function resolveSkillReadPath(
  resources: SkillResource[],
  activatedSkillIds: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  if (!isSkillResource(inputPath)) return undefined;
  if (inputPath.includes("?") || inputPath.includes("#")) {
    throw new SkillResourceError("Skill resource URIs cannot contain a query or fragment.");
  }

  const match = SKILL_RESOURCE_PATTERN.exec(inputPath);
  if (!match) throw new SkillResourceError("Invalid skill resource URI.");

  const [, resourceId, encodedPath] = match;
  const resource = resources.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new SkillResourceError("Unknown skill resource.");

  const segments = parseResourceSegments(encodedPath);
  const isSkillFile = segments.length === 1 && segments[0] === "SKILL.md";
  if (!isSkillFile && !activatedSkillIds.has(resource.id)) {
    throw new SkillResourceError("Read the skill's SKILL.md resource before its relative files.");
  }

  let currentBaseDir: string;
  try {
    currentBaseDir = realpathSync(resource.skill.baseDir);
  } catch {
    throw new SkillResourceError("Skill resource is no longer available.");
  }
  if (currentBaseDir !== resource.canonicalBaseDir) {
    throw new SkillResourceError("Skill resource changed after discovery.");
  }
  try {
    const currentSkillFile = realpathSync(resource.skill.filePath);
    if (
      currentSkillFile !== resource.canonicalSkillFile ||
      !statSync(currentSkillFile).isFile() ||
      createSkillResourceId(currentSkillFile) !== resource.id
    ) {
      throw new SkillResourceError("Skill resource changed after discovery.");
    }
  } catch (error) {
    if (error instanceof SkillResourceError) throw error;
    throw new SkillResourceError("Skill resource changed after discovery.");
  }

  const candidate = resolve(resource.canonicalBaseDir, ...segments);
  if (!isPathInsideRoot(candidate, resource.canonicalBaseDir)) {
    throw new SkillResourceError("Skill resource path escapes its skill directory.");
  }

  let absolutePath: string;
  try {
    absolutePath = realpathSync(candidate);
    if (!statSync(absolutePath).isFile()) {
      throw new SkillResourceError("Skill resource is not a regular file.");
    }
  } catch (error) {
    if (error instanceof SkillResourceError) throw error;
    throw new SkillResourceError("Skill resource is not an available regular file.");
  }

  if (!isPathInsideRoot(absolutePath, resource.canonicalBaseDir)) {
    throw new SkillResourceError("Skill resource path escapes its skill directory.");
  }
  if (isSkillFile && absolutePath !== resource.canonicalSkillFile) {
    throw new SkillResourceError("Skill resource changed after discovery.");
  }

  return { absolutePath, skill: resource.skill, isSkillFile, resourceId: resource.id };
}

export function markSkillActivated(
  activatedSkillIds: Set<string>,
  resourceId: string,
): void {
  activatedSkillIds.add(resourceId);
}

function parseResourceSegments(encodedPath: string): string[] {
  const encodedSegments = encodedPath.split("/");
  if (encodedSegments.some((segment) => segment.length === 0)) {
    throw new SkillResourceError("Invalid skill resource URI.");
  }

  return encodedSegments.map((encodedSegment) => {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      throw new SkillResourceError("Invalid skill resource URI encoding.");
    }

    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new SkillResourceError("Invalid skill resource path segment.");
    }
    return segment;
  });
}

function createSkillResourceId(canonicalSkillFile: string): string {
  return createHash("sha256")
    .update(canonicalSkillFile)
    .update("\0")
    .update(readFileSync(canonicalSkillFile))
    .digest("hex");
}
