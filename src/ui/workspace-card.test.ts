import assert from "node:assert/strict";
import { workspacePayloadText } from "./workspace-card.js";

const text = workspacePayloadText({
  tool: "open_workspace",
  workspaceId: "ws_test",
  root: "/workspace/project",
  instructionSources: ["AGENTS.md"],
  skills: [],
});

assert.equal(
  text,
  [
    "Workspace: ws_test",
    "Root: /workspace/project",
    "Instructions: AGENTS.md",
    "Skills: none",
  ].join("\n"),
);

assert.equal(text.includes("none loaded"), false);

assert.match(
  workspacePayloadText({
    tool: "open_workspace",
    skills: [
      { name: "project-skill", origin: "workspace-local" },
      { name: "shared-skill", origin: "global" },
    ],
  }),
  /Skills: project-skill \(workspace-local\), shared-skill \(global\)/u,
);
