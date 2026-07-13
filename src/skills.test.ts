import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  effectiveSkillPaths,
  createSkillResourceCatalog,
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  SkillResourceError,
} from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skills-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

try {
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const explicitSkills = join(root, "explicit-skills");
  const devspaceSkills = join(root, ".devspace", "skills");
  const globalAgentsSkills = join(root, ".agents", "skills");
  const projectAgentsSkills = join(projectRoot, ".agents", "skills");
  const globalClaudeSkills = join(root, ".claude", "skills");
  const projectClaudeSkills = join(projectRoot, ".claude", "skills");
  await mkdir(join(globalAgentsSkills, "agent-global-skill"), { recursive: true });
  await mkdir(join(projectAgentsSkills, "agent-project-skill"), { recursive: true });
  await mkdir(join(globalClaudeSkills, "claude-global-skill"), { recursive: true });
  await mkdir(join(projectClaudeSkills, "claude-project-skill"), { recursive: true });
  await mkdir(join(projectRoot, ".pi", "skills", "project-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "subagent-delegation"), { recursive: true });
  await mkdir(join(explicitSkills, "duplicate"), { recursive: true });
  await mkdir(join(explicitSkills, "disabled"), { recursive: true });
  await mkdir(join(explicitSkills, "subagent-delegation"), { recursive: true });
  await mkdir(join(devspaceSkills, "devspace-local-skill"), { recursive: true });

  await writeFile(
    join(globalAgentsSkills, "agent-global-skill", "SKILL.md"),
    [
      "---",
      "name: agent-global-skill",
      "description: Agent global skill description.",
      "---",
      "",
      "# Agent Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectAgentsSkills, "agent-project-skill", "SKILL.md"),
    [
      "---",
      "name: agent-project-skill",
      "description: Agent project skill description.",
      "---",
      "",
      "# Agent Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(globalClaudeSkills, "claude-global-skill", "SKILL.md"),
    [
      "---",
      "name: claude-global-skill",
      "description: Claude global skill description.",
      "---",
      "",
      "# Claude Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectClaudeSkills, "claude-project-skill", "SKILL.md"),
    [
      "---",
      "name: claude-project-skill",
      "description: Claude project skill description.",
      "---",
      "",
      "# Claude Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectRoot, ".pi", "skills", "project-skill", "SKILL.md"),
    [
      "---",
      "name: project-skill",
      "description: Project skill description.",
      "---",
      "",
      "# Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(devspaceSkills, "devspace-local-skill", "SKILL.md"),
    [
      "---",
      "name: devspace-local-skill",
      "description: DevSpace local skill description.",
      "---",
      "",
      "# DevSpace Local Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: First duplicate wins.",
      "---",
      "",
      "# Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "duplicate", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: Duplicate loser.",
      "---",
      "",
      "# Duplicate Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "subagent-delegation", "SKILL.md"),
    [
      "---",
      "name: subagent-delegation",
      "description: Hidden subagent skill winner.",
      "---",
      "",
      "# Subagent Delegation",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "subagent-delegation", "SKILL.md"),
    [
      "---",
      "name: subagent-delegation",
      "description: Hidden subagent skill loser.",
      "---",
      "",
      "# Subagent Delegation Duplicate",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "disabled", "SKILL.md"),
    [
      "---",
      "name: hidden-skill",
      "description: Hidden skill.",
      "disable-model-invocation: true",
      "---",
      "",
      "# Hidden Skill",
    ].join("\n"),
  );

  const disabledConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.deepEqual(loadWorkspaceSkills(disabledConfig, projectRoot).skills, []);

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: [explicitSkills, "~/.claude/skills", "./.claude/skills"].join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(loaded.skills.some((skill) => skill.name === "agent-global-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "agent-project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "claude-global-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "claude-project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "project-skill"), false);
  assert.equal(loaded.skills.some((skill) => skill.name === "devspace-local-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "subagent-delegation"), false);
  assert.equal(loaded.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
  assert.equal(loaded.skills.some((skill) => skill.name === "hidden-skill"), true);
  assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.type === "collision"), true);
  assert.equal(
    loaded.diagnostics.some(
      (diagnostic) => diagnostic.collision?.name === "subagent-delegation",
    ),
    false,
  );

  const experimentalConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.equal(
    loadWorkspaceSkills(experimentalConfig, projectRoot).skills.some(
      (skill) => skill.name === "subagent-delegation",
    ),
    true,
  );

  const duplicateConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: [explicitSkills, "./.agents/skills"].join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.equal(
    effectiveSkillPaths(duplicateConfig, projectRoot).filter((path) => path === projectAgentsSkills).length,
    1,
  );

  const legacyPiConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: [explicitSkills, join(projectRoot, ".pi", "skills")].join(","),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.equal(
    loadWorkspaceSkills(legacyPiConfig, projectRoot).skills.some((skill) => skill.name === "project-skill"),
    true,
  );

  const projectSkill = loaded.skills.find((skill) => skill.name === "agent-project-skill");
  assert.ok(projectSkill);
  const resources = createSkillResourceCatalog(loaded.skills);
  assert.equal(resources.some((resource) => resource.skill.name === "hidden-skill"), false);
  assert.equal(resources.filter((resource) => resource.skill.name === "duplicate-skill").length, 1);
  const projectResource = resources.find(
    (resource) => resource.skill.name === "agent-project-skill",
  );
  assert.ok(projectResource);
  assert.match(projectResource.resource, /^skill:\/\/catalog\/[a-f0-9]{64}\/SKILL\.md$/u);
  assert.equal(
    projectResource.id,
    createHash("sha256")
      .update(await realpath(projectSkill.filePath))
      .update("\0")
      .update(await readFile(projectSkill.filePath))
      .digest("hex"),
  );
  assert.equal(createSkillResourceCatalog(loaded.skills).find(
    (resource) => resource.skill.name === "agent-project-skill",
  )?.id, projectResource.id);

  const activatedSkillIds = new Set<string>();
  const skillFileRead = resolveSkillReadPath(
    resources,
    activatedSkillIds,
    projectResource.resource,
  );
  assert.equal(skillFileRead?.isSkillFile, true);
  assert.equal(skillFileRead?.absolutePath, projectSkill.filePath);
  assert.equal(skillFileRead?.resourceId, projectResource.id);
  assert.equal(resolveSkillReadPath(resources, activatedSkillIds, projectSkill.filePath), undefined);

  const resourcePath = join(projectSkill.baseDir, "references.md");
  await writeFile(resourcePath, "reference\n");
  const relativeResource = projectResource.resource.replace("SKILL.md", "references.md");
  assert.throws(
    () => resolveSkillReadPath(resources, activatedSkillIds, relativeResource),
    SkillResourceError,
  );
  markSkillActivated(activatedSkillIds, projectResource.id);
  const resourceRead = resolveSkillReadPath(resources, activatedSkillIds, relativeResource);
  assert.equal(resourceRead?.isSkillFile, false);
  assert.equal(resourceRead?.absolutePath, resourcePath);

  for (const invalidResource of [
    projectResource.resource.replace("SKILL.md", "../outside.txt"),
    projectResource.resource.replace("SKILL.md", "%2e%2e/outside.txt"),
    projectResource.resource.replace("SKILL.md", "%2Fetc%2Fpasswd"),
    projectResource.resource.replace("SKILL.md", "references%5Coutside.md"),
    `${projectResource.resource}?query=1`,
    `skill://catalog/${projectResource.id}//references.md`,
    "skill://catalog/not-an-id/SKILL.md",
  ]) {
    assert.throws(
      () => resolveSkillReadPath(resources, activatedSkillIds, invalidResource),
      SkillResourceError,
    );
  }

  const outsideFile = join(root, "outside-reference.md");
  const escapingLink = join(projectSkill.baseDir, "escaping-reference.md");
  await writeFile(outsideFile, "outside\n");
  await symlink(outsideFile, escapingLink);
  assert.throws(
    () => resolveSkillReadPath(
      resources,
      activatedSkillIds,
      projectResource.resource.replace("SKILL.md", "escaping-reference.md"),
    ),
    SkillResourceError,
  );

  const insideTarget = join(projectSkill.baseDir, "inside-reference.md");
  const insideLink = join(projectSkill.baseDir, "inside-link.md");
  await writeFile(insideTarget, "inside\n");
  await symlink(insideTarget, insideLink);
  assert.equal(
    resolveSkillReadPath(
      resources,
      activatedSkillIds,
      projectResource.resource.replace("SKILL.md", "inside-link.md"),
    )?.absolutePath,
    insideTarget,
  );

  await writeFile(
    projectSkill.filePath,
    [
      "---",
      "name: agent-project-skill",
      "description: Updated agent project skill description.",
      "---",
      "",
      "# Updated Agent Project Skill",
    ].join("\n"),
  );
  assert.throws(
    () => resolveSkillReadPath(resources, activatedSkillIds, relativeResource),
    /changed after discovery/u,
  );

  const refreshedResources = createSkillResourceCatalog(loaded.skills);
  const refreshedProjectResource = refreshedResources.find(
    (resource) => resource.skill.name === "agent-project-skill",
  );
  assert.ok(refreshedProjectResource);
  assert.notEqual(refreshedProjectResource.id, projectResource.id);
  const refreshedRelativeResource = refreshedProjectResource.resource.replace(
    "SKILL.md",
    "references.md",
  );
  assert.throws(
    () => resolveSkillReadPath(
      refreshedResources,
      activatedSkillIds,
      refreshedRelativeResource,
    ),
    /Read the skill's SKILL\.md resource/u,
  );
  const refreshedMainRead = resolveSkillReadPath(
    refreshedResources,
    activatedSkillIds,
    refreshedProjectResource.resource,
  );
  assert.equal(refreshedMainRead?.isSkillFile, true);
  markSkillActivated(activatedSkillIds, refreshedProjectResource.id);
  assert.equal(
    resolveSkillReadPath(
      refreshedResources,
      activatedSkillIds,
      refreshedRelativeResource,
    )?.absolutePath,
    resourcePath,
  );
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
}
