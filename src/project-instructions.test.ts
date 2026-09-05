import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProjectInstructionFile,
  resolveProjectInstructions,
  type ProjectInstructionConfig,
} from "./project-instructions.js";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-project-instructions-"));
const outside = await mkdtemp(join(tmpdir(), "devspace-project-instructions-outside-"));
const defaults: ProjectInstructionConfig = { fallbackFileNames: [], maxBytes: 32 * 1024 };

try {
  await mkdir(join(root, "services", "payments", "deep"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "root guidance\n");
  await writeFile(join(root, "services", "AGENTS.md"), "service guidance\n");
  await writeFile(join(root, "services", "payments", "AGENTS.md"), "ignored ordinary guidance\n");
  await writeFile(join(root, "services", "payments", "AGENTS.override.md"), "payment override\n");

  const nested = await resolveProjectInstructions(
    root,
    join(root, "services", "payments", "deep"),
    defaults,
  );
  assert.deepEqual(
    nested.sources.map((source) => source.path),
    [
      join(root, "AGENTS.md"),
      join(root, "services", "AGENTS.md"),
      join(root, "services", "payments", "AGENTS.override.md"),
    ],
  );
  assert.equal(
    nested.instructions,
    "root guidance\n\n\nservice guidance\n\n\npayment override\n",
  );
  assert.equal(nested.truncated, false);

  await mkdir(join(root, "fallback"));
  await writeFile(join(root, "fallback", "AGENTS.override.md"), "  \n");
  await writeFile(join(root, "fallback", "AGENTS.md"), "\n");
  await writeFile(join(root, "fallback", "PROJECT.md"), "fallback guidance\n");
  const fallback = await resolveProjectInstructions(root, join(root, "fallback"), {
    fallbackFileNames: ["PROJECT.md", "OTHER.md"],
    maxBytes: 32 * 1024,
  });
  assert.equal(fallback.sources.at(-1)?.path, join(root, "fallback", "PROJECT.md"));

  await mkdir(join(root, "limited"));
  await writeFile(join(root, "limited", "AGENTS.md"), "🙂".repeat(100));
  const limited = await resolveProjectInstructions(root, join(root, "limited"), {
    fallbackFileNames: [],
    maxBytes: 25,
  });
  assert.equal(Buffer.byteLength(limited.instructions, "utf8") <= 25, true);
  assert.equal(limited.instructions.includes("�"), false);
  assert.equal(limited.truncated, true);

  assert.equal(await isProjectInstructionFile(root, "AGENTS.md", defaults), true);
  assert.equal(await isProjectInstructionFile(root, "services/payments/AGENTS.override.md", defaults), true);
  assert.equal(await isProjectInstructionFile(root, "services/payments/not-instructions.md", defaults), false);

  if (process.platform !== "win32") {
    await writeFile(join(outside, "AGENTS.md"), "outside\n");
    await symlink(join(outside, "AGENTS.md"), join(root, "services", "payments", "deep", "AGENTS.md"));
    const symlinkChain = await resolveProjectInstructions(
      root,
      join(root, "services", "payments", "deep"),
      defaults,
    );
    assert.equal(
      symlinkChain.sources.some((source) => source.path === join(outside, "AGENTS.md")),
      false,
    );
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_AGENT_DIR: join(root, ".test-agent-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const opened = await registry.openWorkspace(root);
  assert.equal(await registry.preflightInstructions(opened.workspace, root), undefined);

  const firstNested = await registry.preflightInstructions(
    opened.workspace,
    join(root, "services", "payments"),
  );
  assert.equal(firstNested?.status, "instructions_required");
  assert.deepEqual(firstNested?.instructionSources, [
    "AGENTS.md",
    "services/AGENTS.md",
    "services/payments/AGENTS.override.md",
  ]);
  assert.equal(
    await registry.preflightInstructions(opened.workspace, join(root, "services", "payments")),
    undefined,
  );

  await writeFile(join(root, "services", "payments", "AGENTS.override.md"), "changed override\n");
  const changed = await registry.preflightInstructions(
    opened.workspace,
    join(root, "services", "payments"),
  );
  assert.equal(changed?.status, "instructions_required");
  assert.match(changed?.instructions ?? "", /changed override/);

  assert.equal(
    await registry.isDirectInstructionRead(opened.workspace, "services/payments/AGENTS.override.md"),
    true,
  );
  await registry.markInstructionsDelivered(opened.workspace, join(root, "services", "payments"));
  assert.equal(
    await registry.preflightInstructions(opened.workspace, join(root, "services", "payments")),
    undefined,
  );

  await rm(join(root, "AGENTS.md"));
  await mkdir(join(root, "empty-scope"));
  await writeFile(join(root, "empty-scope", "AGENTS.md"), "  \n");
  const emptyRegistry = new WorkspaceRegistry(config);
  const emptyWorkspace = await emptyRegistry.openWorkspace(root);
  assert.equal(
    await emptyRegistry.preflightInstructions(emptyWorkspace.workspace, join(root, "empty-scope")),
    undefined,
  );
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
