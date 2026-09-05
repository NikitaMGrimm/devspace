import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import { isPathInsideRoot } from "./roots.js";

type Diagnostic = LoadSkillsResult["diagnostics"][number];
interface PluginSkills { paths: string[]; diagnostics: Diagnostic[] }
const MAX_METADATA_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function metadata(path: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw new Error("Invalid metadata file.");
  return readFileSync(path, "utf8");
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

function validateSkillTree(directory: string): void {
  const pending = [directory];
  let entries = 0;
  while (pending.length) {
    for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
      if (++entries > 4096) throw new Error("Skill tree exceeds discovery limit.");
      if (entry.isSymbolicLink()) throw new Error("Symlink in plugin skill tree.");
      if (entry.isDirectory()) pending.push(join(entry.parentPath, entry.name));
    }
  }
}

/** Import skill directories, not Codex's runtime, credentials, hooks, or MCP servers. */
export function discoverCodexPluginSkills(agentDir: string): PluginSkills {
  const result: PluginSkills = { paths: [], diagnostics: [] };
  const configPath = join(agentDir, "config.toml");
  const warn = (path: string, message: string) => {
    result.diagnostics.push({ type: "warning", path, message });
  };
  let plugins: Record<string, unknown>;
  try {
    plugins = record(parse(metadata(configPath)).plugins);
  } catch (error) {
    // Never echo TOML parser errors: nearby configuration may contain credentials.
    if (!missing(error)) warn(configPath, "Cannot read Codex plugin configuration; no plugin skills were imported.");
    return result;
  }
  for (const [id, settings] of Object.entries(plugins)) {
    if (record(settings).enabled !== true) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) {
      warn(configPath, "Skipping an invalid Codex plugin identifier.");
      continue;
    }
    const [name, marketplace] = id.split("@");
    const cacheRoot = join(agentDir, "plugins", "cache");
    const installed = join(cacheRoot, marketplace, name);
    try {
      const canonicalCache = realpathSync(cacheRoot);
      const canonicalInstalled = realpathSync(installed);
      if (!isPathInsideRoot(canonicalInstalled, canonicalCache)) throw new Error("Cache escape.");
      const versions = readdirSync(canonicalInstalled, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
      // Config records enabled state, not a selected version. Do not guess among stale installs.
      if (versions.length !== 1) {
        warn(installed, `Plugin ${id} has ${versions.length} cached versions; select its skill directory with DEVSPACE_SKILL_PATHS.`);
        continue;
      }
      const pluginRoot = realpathSync(join(canonicalInstalled, versions[0].name));
      const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
      if (!isPathInsideRoot(realpathSync(manifestPath), pluginRoot)) throw new Error("Manifest escape.");
      const manifest = record(JSON.parse(metadata(manifestPath)));
      if (manifest.name !== name) throw new Error("Manifest name mismatch.");
      const declared = manifest.skills ?? "./skills";
      const paths = typeof declared === "string" ? [declared] : declared;
      if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
        throw new Error("Invalid skill directories.");
      }
      const accepted: string[] = [];
      for (const path of paths as string[]) {
        if (isAbsolute(path) || path.includes("\\") || !path.trim()) throw new Error("Invalid skill path.");
        const candidate = resolve(pluginRoot, path);
        if (!isPathInsideRoot(candidate, pluginRoot)) throw new Error("Skill path escape.");
        let directory: string;
        try { directory = realpathSync(candidate); } catch (error) {
          if (manifest.skills === undefined && missing(error)) continue;
          throw error;
        }
        if (!isPathInsideRoot(directory, pluginRoot) || !statSync(directory).isDirectory()) {
          throw new Error("Invalid skill directory.");
        }
        // The existing loader handles skill contents and applies the resource read boundary.
        // Do not traverse a symlinked skills tree supplied by a plugin manifest.
        if (lstatSync(candidate).isSymbolicLink()) throw new Error("Symlinked skill directory.");
        validateSkillTree(directory);
        accepted.push(directory);
      }
      result.paths.push(...accepted);
    } catch {
      warn(installed, `Cannot safely load cached skills for plugin ${id}; no skills from this plugin were imported.`);
    }
  }
  result.paths = [...new Set(result.paths)];
  return result;
}
