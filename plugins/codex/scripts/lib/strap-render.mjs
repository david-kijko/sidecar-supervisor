function roundScore(value) {
  return Math.round(Number(value ?? 0));
}

function formatPercent(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

export function buildSteeringSuggestions(policy, detectors) {
  const suggestions = [];
  for (const detector of detectors) {
    const suggestion = policy.steering_guidance?.[detector.detector_id];
    if (suggestion && !suggestions.includes(suggestion)) {
      suggestions.push(suggestion);
    }
  }
  return suggestions;
}

export function renderSidecarStartReport(payload) {
  const lines = [
    "# Codex Sidecar",
    "",
    `Session: ${payload.sessionId}`,
    `Policy: ${payload.policyId}`,
    `Daemon: ${payload.daemonActive ? "running" : "not running"}`,
    `DB: ${payload.dbPath}`,
    ""
  ];

  if (payload.tasks.length > 0) {
    lines.push("Tasks:");
    for (const task of payload.tasks) {
      lines.push(`- [${task.status}] ${task.title}`);
    }
    lines.push("");
  }

  if (payload.latestCheckpoint) {
    lines.push(`Latest checkpoint: ${payload.latestCheckpoint.checkpoint_id}`);
    lines.push(`- Composite: ${roundScore(payload.latestCheckpoint.composite_score)}`);
    lines.push(`- Manifestation: ${roundScore(payload.latestCheckpoint.manifestation_score)}`);
    lines.push(`- Severity: ${roundScore(payload.latestCheckpoint.severity_score)}`);
    lines.push(`- Scope: ${roundScore(payload.latestCheckpoint.scope_score)}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSidecarStatusReport(payload) {
  const lines = [
    "# Sidecar Status",
    "",
    `Session: ${payload.sessionId}`,
    `Policy: ${payload.policyId}`,
    `Daemon: ${payload.daemonActive ? "running" : "stopped"}`,
    ""
  ];

  if (payload.tasks.length > 0) {
    lines.push("Task list:");
    for (const task of payload.tasks) {
      lines.push(`- [${task.status}] ${task.title}`);
    }
    lines.push("");
  }

  if (payload.latestCheckpoint) {
    lines.push(`Current checkpoint: ${payload.latestCheckpoint.checkpoint_id}`);
    lines.push(`- Composite: ${roundScore(payload.latestCheckpoint.composite_score)}`);
    lines.push(`- Manifestation: ${roundScore(payload.latestCheckpoint.manifestation_score)}`);
    lines.push(`- Severity: ${roundScore(payload.latestCheckpoint.severity_score)}`);
    lines.push(`- Scope: ${roundScore(payload.latestCheckpoint.scope_score)}`);
    lines.push(`- Confidence: ${formatPercent(payload.latestCheckpoint.confidence)}`);
    if (payload.latestCheckpoint.top_detector) {
      lines.push(`- Top detector: ${payload.latestCheckpoint.top_detector}`);
    }
    if (payload.latestCheckpoint.telemetry_branch) {
      lines.push(`- Telemetry branch: ${payload.latestCheckpoint.telemetry_branch}`);
    }
    if (payload.latestCheckpoint.telemetry_commit) {
      lines.push(`- Telemetry commit: ${payload.latestCheckpoint.telemetry_commit}`);
    }
    lines.push("");
  }

  if (payload.detectors.length > 0) {
    lines.push("Active detectors:");
    for (const detector of payload.detectors) {
      lines.push(
        `- ${detector.detector_id}: M ${roundScore(detector.manifestation_score)}, S ${roundScore(detector.severity_score)}, B ${roundScore(detector.scope_score)}, C ${formatPercent(detector.confidence)}`
      );
    }
    lines.push("");
  }

  if (payload.claimVerifications.length > 0) {
    lines.push("Claim checks:");
    for (const claim of payload.claimVerifications) {
      lines.push(`- ${claim.claim_type}: ${claim.verdict} (${claim.claim_text})`);
    }
    lines.push("");
  }

  if (payload.steeringSuggestions.length > 0) {
    lines.push("Steering suggestions:");
    for (const suggestion of payload.steeringSuggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSidecarCheckpointReport(payload) {
  const lines = [
    "# Sidecar Checkpoint",
    "",
    `Session: ${payload.session_id}`,
    `Checkpoint: ${payload.checkpoint_id}`,
    `Reason: ${payload.reason}`,
    `Composite: ${roundScore(payload.composite_score)}`,
    `Manifestation: ${roundScore(payload.manifestation_score)}`,
    `Severity: ${roundScore(payload.severity_score)}`,
    `Scope: ${roundScore(payload.scope_score)}`,
    `Confidence: ${formatPercent(payload.confidence)}`
  ];

  if (payload.top_detector) {
    lines.push(`Top detector: ${payload.top_detector}`);
  }
  if (payload.telemetry_branch) {
    lines.push(`Telemetry branch: ${payload.telemetry_branch}`);
  }
  if (payload.telemetry_commit) {
    lines.push(`Telemetry commit: ${payload.telemetry_commit}`);
  }
  if (payload.summary) {
    lines.push("");
    lines.push(`Summary: ${payload.summary}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSidecarMutationReport(payload) {
  const lines = [
    "# Sidecar Update",
    "",
    `Session: ${payload.sessionId}`,
    payload.message
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
