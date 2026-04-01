import fs from "node:fs";
import path from "node:path";

export function resolveBuiltInPolicyPath(pluginRoot) {
  return path.join(pluginRoot, "policies", "default-sidecar-policy.json");
}

export function loadScoringPolicy(pluginRoot, policyPath = null) {
  const resolvedPath = policyPath || resolveBuiltInPolicyPath(pluginRoot);
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return {
    ...parsed,
    path: resolvedPath
  };
}
