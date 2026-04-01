import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";
import { ensureParentDir, resolveTelemetryWorktreeDir } from "./strap-paths.mjs";

function relativeArtifactPath(sessionId, checkpointId, extension) {
  return path.join(".strap", "checkpoints", sessionId, `${checkpointId}.${extension}`);
}

export function writeTelemetryArtifacts({ workspaceRoot, sessionId, checkpointId, artifactJson, artifactLog }) {
  const worktreeDir = ensureTelemetryWorktree(workspaceRoot, sessionId).worktreeDir;
  const jsonRelative = relativeArtifactPath(sessionId, checkpointId, "json");
  const logRelative = relativeArtifactPath(sessionId, checkpointId, "log");
  const jsonPath = path.join(worktreeDir, jsonRelative);
  const logPath = path.join(worktreeDir, logRelative);

  ensureParentDir(jsonPath);
  fs.writeFileSync(jsonPath, `${JSON.stringify(artifactJson, null, 2)}\n`, "utf8");
  fs.writeFileSync(logPath, `${artifactLog.trimEnd()}\n`, "utf8");

  return { worktreeDir, jsonRelative, logRelative, jsonPath, logPath };
}

export function ensureTelemetryWorktree(workspaceRoot, sessionId) {
  const branch = `sidecar/telemetry/${sessionId}`;
  const worktreeDir = resolveTelemetryWorktreeDir(workspaceRoot, sessionId);

  if (!fs.existsSync(path.join(worktreeDir, ".git"))) {
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    const branchExists = runCommand("git", ["-C", workspaceRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (branchExists.status === 0) {
      runCommandChecked("git", ["-C", workspaceRoot, "worktree", "add", worktreeDir, branch]);
    } else {
      runCommandChecked("git", ["-C", workspaceRoot, "worktree", "add", "-B", branch, worktreeDir, "HEAD"]);
    }
  }

  return { branch, worktreeDir };
}

export function commitTelemetryCheckpoint({ workspaceRoot, sessionId, checkpointId, artifactJson, artifactLog }) {
  const { branch, worktreeDir } = ensureTelemetryWorktree(workspaceRoot, sessionId);
  const { jsonRelative, logRelative } = writeTelemetryArtifacts({
    workspaceRoot,
    sessionId,
    checkpointId,
    artifactJson,
    artifactLog
  });

  runCommandChecked("git", ["-C", worktreeDir, "add", jsonRelative, logRelative]);
  const stagedDiff = runCommand("git", ["-C", worktreeDir, "diff", "--cached", "--quiet"]);
  if (stagedDiff.status === 0) {
    const head = runCommandChecked("git", ["-C", worktreeDir, "rev-parse", "HEAD"]).stdout.trim();
    return { branch, commit: head, worktreeDir };
  }

  runCommandChecked("git", [
    "-C",
    worktreeDir,
    "-c",
    "user.name=Strap Sidecar",
    "-c",
    "user.email=strap-sidecar@local",
    "commit",
    "-m",
    `strap checkpoint ${checkpointId}`
  ]);
  const commit = runCommandChecked("git", ["-C", worktreeDir, "rev-parse", "HEAD"]).stdout.trim();
  return { branch, commit, worktreeDir };
}
