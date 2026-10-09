/**
 * Discover installed skills (via getCommands) and tools (via getAllTools).
 * Pi has no invokeSkill() — skills appear as slash commands with source "skill".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiscoveredSkill, DiscoveredTool } from "./types.ts";

function commandSource(cmd: {
  source?: string;
  sourceInfo?: { source?: string; origin?: string };
}): string {
  return (
    cmd.source ??
    cmd.sourceInfo?.source ??
    cmd.sourceInfo?.origin ??
    ""
  ).toLowerCase();
}

function commandSkillPath(cmd: {
  path?: string;
  filePath?: string;
  sourceInfo?: { path?: string; filePath?: string };
}): string | undefined {
  return (
    cmd.path ??
    cmd.filePath ??
    cmd.sourceInfo?.path ??
    cmd.sourceInfo?.filePath
  );
}

/** List skills registered as slash commands (source === "skill"). */
export function discoverSkills(pi: ExtensionAPI): DiscoveredSkill[] {
  const cmds = pi.getCommands?.() ?? [];
  const skills: DiscoveredSkill[] = [];

  for (const cmd of cmds) {
    if (commandSource(cmd) !== "skill") continue;
    const name = (cmd.name ?? "").replace(/^\//, "");
    if (!name) continue;
    skills.push({
      name,
      description: cmd.description ?? "",
      skillMdPath: commandSkillPath(cmd),
    });
  }

  // Prefer AgentKit-style names first for planner context (stable order otherwise).
  const akPreferred = (n: string) =>
    /^ak-/.test(n) || /brainstorm|plan|cook|implement|review/.test(n);
  skills.sort((a, b) => {
    const ap = akPreferred(a.name) ? 0 : 1;
    const bp = akPreferred(b.name) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });

  return skills;
}

/** List all registered tools (informational; planner may mention them). */
export function discoverTools(pi: ExtensionAPI): DiscoveredTool[] {
  const tools = pi.getAllTools?.() ?? [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
  }));
}

/** Format skills for a soft-prompt / status listing. */
export function formatSkillsList(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return "(no skills discovered)";
  return skills
    .map((s) => {
      const desc = s.description ? ` — ${s.description}` : "";
      const path = s.skillMdPath ? ` [${s.skillMdPath}]` : "";
      return `- ${s.name}${desc}${path}`;
    })
    .join("\n");
}
