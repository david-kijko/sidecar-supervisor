import fs from "node:fs";
import path from "node:path";

import { generateJobId } from "./state.mjs";
import {
  addTask,
  ensureStrapSession,
  getLatestCheckpoint,
  getStrapSession,
  insertCheckpoint,
  listCorrections,
  listTasks,
  markSessionInactive,
  setSessionDaemonPid
} from "./strap-db.mjs";
import { analyzeSidecarSession } from "./strap-detectors.mjs";
import { commitTelemetryCheckpoint } from "./strap-git.mjs";
import {
  ensureParentDir,
  readPidFile,
  removePidFile,
  resolveCheckpointArtifactPath,
  resolveCheckpointLogPath,
  resolveDaemonPidFile,
  resolveRepoDescriptor,
  resolveStrapDbPath
} from "./strap-paths.mjs";
import { buildSteeringSuggestions } from "./strap-render.mjs";

function nowIso() {
  return new Date().toISOString();
}

function scoresFromDetectors(policy, detectors) {
  if (detectors.length === 0) {
    return {
      manifestation_score: 0,
      severity_score: 0,
      scope_score: 0,
      composite_score: 0,
      confidence: 0,
      top_detector: null
    };
  }

  const manifestation = Math.max(...detectors.map((detector) => detector.manifestation_score));
  const severity = Math.max(...detectors.map((detector) => detector.severity_score));
  const scope = Math.max(...detectors.map((detector) => detector.scope_score));
  const confidence = Math.max(...detectors.map((detector) => detector.confidence));
  const composite =
    manifestation * policy.weights.manifestation +
    severity * policy.weights.severity +
    scope * policy.weights.scope;
  const topDetector = [...detectors].sort((left, right) => right.severity_score - left.severity_score)[0]?.detector_id ?? null;

  return {
    manifestation_score: manifestation,
    severity_score: severity,
    scope_score: scope,
    composite_score: composite,
    confidence,
    top_detector: topDetector
  };
}

function buildCheckpointLog({ checkpointId, reason, phase, tasks, detectors, claimVerifications, changedPaths }) {
  const lines = [
    `checkpoint=${checkpointId}`,
    `reason=${reason}`,
    `phase=${phase || "unknown"}`,
    `created_at=${nowIso()}`,
    ""
  ];

  if (tasks.length > 0) {
    lines.push("tasks:");
    for (const task of tasks) {
      lines.push(`- [${task.status}] ${task.title}`);
    }
    lines.push("");
  }

  if (changedPaths.length > 0) {
    lines.push("changed_paths:");
    for (const changedPath of changedPaths) {
      lines.push(`- ${changedPath}`);
    }
    lines.push("");
  }

  if (detectors.length > 0) {
    lines.push("detectors:");
    for (const detector of detectors) {
      lines.push(
        `- ${detector.detector_id} manifestation=${detector.manifestation_score} severity=${detector.severity_score} scope=${detector.scope_score} confidence=${detector.confidence}`
      );
    }
    lines.push("");
  }

  if (claimVerifications.length > 0) {
    lines.push("claim_verifications:");
    for (const claim of claimVerifications) {
      lines.push(`- ${claim.claim_type} ${claim.verdict} ${claim.claim_text}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function createSidecarSession({ workspaceRoot, sessionId, policy, initialTasks = [] }) {
  const repoDescriptor = resolveRepoDescriptor(workspaceRoot);
  ensureStrapSession({
    sessionId,
    workspaceRoot,
    repoHash: repoDescriptor.hash,
    policyId: policy.policy_id
  });
  for (const initialTask of initialTasks) {
    if (initialTask && initialTask.trim()) {
      addTask(sessionId, initialTask.trim());
    }
  }
  return getSidecarStatus({ workspaceRoot, sessionId, policy });
}

export function getSidecarStatus({ workspaceRoot, sessionId, policy }) {
  const session = getStrapSession(sessionId);
  if (!session) {
    return null;
  }
  const corrections = listCorrections(sessionId);
  const analysis = analyzeSidecarSession({
    workspaceRoot,
    sessionId,
    policy,
    corrections
  });
  const latestCheckpoint = getLatestCheckpoint(sessionId);
  const daemonPid = session?.daemon_pid ?? readPidFile(resolveDaemonPidFile(workspaceRoot, sessionId));
  let daemonActive = false;
  if (Number.isFinite(daemonPid)) {
    try {
      process.kill(daemonPid, 0);
      daemonActive = true;
    } catch {
      daemonActive = false;
    }
  }

  return {
    sessionId,
    policyId: policy.policy_id,
    dbPath: resolveStrapDbPath(),
    daemonPid,
    daemonActive,
    tasks: listTasks(sessionId),
    latestCheckpoint,
    detectors: analysis.detectors,
    claimVerifications: analysis.claimVerifications,
    steeringSuggestions: buildSteeringSuggestions(policy, analysis.detectors)
  };
}

export function maybeCreateAutomaticCheckpoint({ workspaceRoot, sessionId, policy }) {
  if (!getStrapSession(sessionId)) {
    return null;
  }
  const latestCheckpoint = getLatestCheckpoint(sessionId);
  const corrections = listCorrections(sessionId);
  const analysis = analyzeSidecarSession({
    workspaceRoot,
    sessionId,
    policy,
    corrections
  });
  const currentPhase = analysis.sessionJobs[0]?.phase ?? analysis.sessionJobs[0]?.status ?? null;
  const latestCreatedAt = latestCheckpoint ? Date.parse(latestCheckpoint.created_at) : null;
  const dueByTime = !latestCreatedAt || Date.now() - latestCreatedAt >= 300_000;
  const dueByPhase = currentPhase && latestCheckpoint?.phase && currentPhase !== latestCheckpoint.phase;

  if (!dueByTime && !dueByPhase && latestCheckpoint) {
    return null;
  }

  return createCheckpoint({
    workspaceRoot,
    sessionId,
    policy,
    reason: dueByPhase ? "phase-transition" : "interval",
    precomputedAnalysis: analysis
  });
}

export function createCheckpoint({ workspaceRoot, sessionId, policy, reason = "manual", precomputedAnalysis = null }) {
  const session = getStrapSession(sessionId);
  if (!session) {
    throw new Error(`No Strap sidecar session found for ${sessionId}. Start it first.`);
  }
  const analysis =
    precomputedAnalysis ??
    analyzeSidecarSession({
      workspaceRoot,
      sessionId,
      policy,
      corrections: listCorrections(sessionId)
    });
  const checkpointId = generateJobId("chk");
  const createdAt = nowIso();
  const phase = analysis.sessionJobs[0]?.phase ?? analysis.sessionJobs[0]?.status ?? null;
  const scoreSummary = scoresFromDetectors(policy, analysis.detectors);
  const tasks = listTasks(sessionId);
  const checkpointArtifactPath = resolveCheckpointArtifactPath(workspaceRoot, sessionId, checkpointId);
  const checkpointLogPath = resolveCheckpointLogPath(workspaceRoot, sessionId, checkpointId);
  const checkpointArtifact = {
    checkpoint_id: checkpointId,
    session_id: sessionId,
    created_at: createdAt,
    reason,
    phase,
    policy_id: policy.policy_id,
    scores: scoreSummary,
    detectors: analysis.detectors,
    claim_verifications: analysis.claimVerifications,
    tasks,
    changed_paths: analysis.changedPaths
  };
  const checkpointLog = buildCheckpointLog({
    checkpointId,
    reason,
    phase,
    tasks,
    detectors: analysis.detectors,
    claimVerifications: analysis.claimVerifications,
    changedPaths: analysis.changedPaths
  });

  ensureParentDir(checkpointArtifactPath);
  fs.writeFileSync(checkpointArtifactPath, `${JSON.stringify(checkpointArtifact, null, 2)}\n`, "utf8");
  fs.writeFileSync(checkpointLogPath, checkpointLog, "utf8");

  let telemetryBranch = null;
  let telemetryCommit = null;
  try {
    const telemetry = commitTelemetryCheckpoint({
      workspaceRoot,
      sessionId,
      checkpointId,
      artifactJson: checkpointArtifact,
      artifactLog: checkpointLog
    });
    telemetryBranch = telemetry.branch;
    telemetryCommit = telemetry.commit;
  } catch (error) {
    checkpointArtifact.telemetry_error = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(checkpointArtifactPath, `${JSON.stringify(checkpointArtifact, null, 2)}\n`, "utf8");
  }

  const summary = buildSteeringSuggestions(policy, analysis.detectors).slice(0, 2).join(" ");
  const inserted = insertCheckpoint({
    checkpoint: {
      checkpoint_id: checkpointId,
      session_id: sessionId,
      created_at: createdAt,
      phase,
      reason,
      manifestation_score: scoreSummary.manifestation_score,
      severity_score: scoreSummary.severity_score,
      scope_score: scoreSummary.scope_score,
      composite_score: scoreSummary.composite_score,
      confidence: scoreSummary.confidence,
      top_detector: scoreSummary.top_detector,
      artifact_path: checkpointArtifactPath,
      log_path: checkpointLogPath,
      telemetry_branch: telemetryBranch,
      telemetry_commit: telemetryCommit,
      summary
    },
    detectorEvents: analysis.detectors,
    claimVerifications: analysis.claimVerifications
  });

  return {
    ...inserted,
    tasks,
    detectors: analysis.detectors,
    claimVerifications: analysis.claimVerifications,
    steeringSuggestions: buildSteeringSuggestions(policy, analysis.detectors)
  };
}

export function setSidecarDaemonPid({ workspaceRoot, sessionId, pid }) {
  if (!getStrapSession(sessionId)) {
    return;
  }
  const pidFile = resolveDaemonPidFile(workspaceRoot, sessionId);
  if (Number.isFinite(pid)) {
    setSessionDaemonPid(sessionId, pid);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${pid}\n`, "utf8");
    return;
  }
  removePidFile(pidFile);
  setSessionDaemonPid(sessionId, null);
}

export function stopSidecarSession({ workspaceRoot, sessionId, finalReason = "session-end" }) {
  const session = getStrapSession(sessionId);
  const pidFile = resolveDaemonPidFile(workspaceRoot, sessionId);
  const pid = session?.daemon_pid ?? readPidFile(pidFile);
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore if the daemon already exited.
    }
  }
  removePidFile(pidFile);
  markSessionInactive(sessionId);
  return finalReason;
}
