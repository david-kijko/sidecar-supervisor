import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sanitizeFragment(value, fallback = "default") {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function hashPath(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function resolveStrapRoot() {
  return process.env.STRAP_ROOT || path.join(os.homedir(), ".claude", "strap");
}

export function resolveStrapDbPath() {
  return path.join(resolveStrapRoot(), "db", "strap.db");
}

export function resolveRepoDescriptor(workspaceRoot) {
  let canonicalRoot = workspaceRoot;
  try {
    canonicalRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalRoot = workspaceRoot;
  }

  return {
    workspaceRoot,
    canonicalRoot,
    slug: sanitizeFragment(path.basename(workspaceRoot), "workspace"),
    hash: hashPath(canonicalRoot)
  };
}

export function resolveRepoStateDir(workspaceRoot) {
  const descriptor = resolveRepoDescriptor(workspaceRoot);
  return path.join(resolveStrapRoot(), "repos", `${descriptor.slug}-${descriptor.hash}`);
}

export function resolveSessionDir(workspaceRoot, sessionId) {
  return path.join(resolveRepoStateDir(workspaceRoot), "sessions", sanitizeFragment(sessionId, "session"));
}

export function resolveCheckpointDir(workspaceRoot, sessionId) {
  return path.join(resolveSessionDir(workspaceRoot, sessionId), "checkpoints");
}

export function resolveCheckpointArtifactPath(workspaceRoot, sessionId, checkpointId) {
  return path.join(resolveCheckpointDir(workspaceRoot, sessionId), `${sanitizeFragment(checkpointId)}.json`);
}

export function resolveCheckpointLogPath(workspaceRoot, sessionId, checkpointId) {
  return path.join(resolveCheckpointDir(workspaceRoot, sessionId), `${sanitizeFragment(checkpointId)}.log`);
}

export function resolveDaemonPidFile(workspaceRoot, sessionId) {
  return path.join(resolveSessionDir(workspaceRoot, sessionId), "sidecar.pid");
}

export function resolveTelemetryWorktreeDir(workspaceRoot, sessionId) {
  return path.join(resolveRepoStateDir(workspaceRoot), "telemetry-worktrees", sanitizeFragment(sessionId, "session"));
}

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writePidFile(filePath, pid) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

export function readPidFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function removePidFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
