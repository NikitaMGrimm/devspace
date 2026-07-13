import type { ToolResultCard } from "./card-types.js";

export function workspacePayloadText(card: ToolResultCard): string {
  const instructions = card.instructionSources ?? [];
  const skills = card.skills ?? [];

  return [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    instructions.length > 0
      ? `Instructions: ${instructions.join(", ")}`
      : "Instructions: none",
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.resource ?? "unnamed").join(", ")}`
      : "Skills: none",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}
