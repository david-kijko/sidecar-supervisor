import fs from "node:fs";

import { getWorkingTreeState } from "./git.mjs";
import { sortJobsNewestFirst, readStoredJob } from "./job-control.mjs";
import { listJobs } from "./state.mjs";

function compileRegexes(patterns = []) {
  return patterns.map((pattern) => new RegExp(pattern, "i"));
}

function detectorScore(policy, detectorId) {
  return policy.detector_scores[detectorId] ?? {
    manifestation: 50,
    severity: 50,
    scope: 50,
    confidence: 0.5
  };
}

function makeDetector(policy, detectorId, details) {
  const score = detectorScore(policy, detectorId);
  return {
    detector_id: detectorId,
    manifestation_score: score.manifestation,
    severity_score: score.severity,
    scope_score: score.scope,
    confidence: score.confidence,
    details
  };
}

function getChangedPaths(workspaceRoot) {
  const state = getWorkingTreeState(workspaceRoot);
  return [...new Set([...state.staged, ...state.unstaged, ...state.untracked])].sort();
}

function getSessionJobs(workspaceRoot, sessionId) {
  return sortJobsNewestFirst(listJobs(workspaceRoot).filter((job) => !sessionId || job.sessionId === sessionId));
}

function getLatestTaskSnapshot(workspaceRoot, sessionJobs) {
  const latestTask = sessionJobs.find((job) => job.jobClass === "task") ?? null;
  if (!latestTask) {
    return { latestTask: null, storedJob: null, outputText: "", logText: "" };
  }
  const storedJob = readStoredJob(workspaceRoot, latestTask.id);
  const outputText = storedJob?.result?.rawOutput ?? storedJob?.result?.stdout ?? "";
  const logText = latestTask.logFile && fs.existsSync(latestTask.logFile) ? fs.readFileSync(latestTask.logFile, "utf8") : "";
  return { latestTask, storedJob, outputText, logText };
}

function detectSuspiciousFileTouch(policy, changedPaths) {
  if (changedPaths.length === 0) {
    return null;
  }
  const patterns = compileRegexes(policy.protected_path_patterns);
  const matchedPaths = changedPaths.filter((filePath) => patterns.some((pattern) => pattern.test(filePath)));
  if (matchedPaths.length === 0) {
    return null;
  }
  return makeDetector(policy, "suspicious_file_touch", {
    matched_paths: matchedPaths
  });
}

function detectSecretExposure(policy, texts, changedPaths) {
  const patterns = compileRegexes(policy.secret_patterns);
  const hits = [];
  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        hits.push(match[0].slice(0, 24));
      }
    }
  }
  if (hits.length === 0) {
    return null;
  }
  return makeDetector(policy, "secret_exposure", {
    matched_tokens: [...new Set(hits)],
    changed_paths: changedPaths
  });
}

function detectThrashLoop(policy, sessionJobs) {
  const recentTasks = sessionJobs.filter((job) => job.jobClass === "task").slice(0, 4);
  if (recentTasks.length < 3) {
    return null;
  }
  const recentSummaries = recentTasks.map((job) => String(job.summary ?? "").trim()).filter(Boolean);
  const repeatedSummary = recentSummaries.find((summary) => recentSummaries.filter((candidate) => candidate === summary).length >= 3);
  if (!repeatedSummary) {
    return null;
  }
  const allUnsuccessful = recentTasks.every((job) => job.status === "failed" || job.status === "cancelled" || job.status === "completed");
  if (!allUnsuccessful) {
    return null;
  }
  return makeDetector(policy, "thrash_loop", {
    repeated_summary: repeatedSummary,
    job_ids: recentTasks.map((job) => job.id)
  });
}

function buildClaimVerifications(policy, latestTask, outputText, logText, changedPaths) {
  if (!latestTask || !outputText) {
    return [];
  }

  const verifications = [];
  const claimPatterns = Object.fromEntries(
    Object.entries(policy.claim_patterns ?? {}).map(([claimType, patterns]) => [claimType, compileRegexes(patterns)])
  );

  const maybeAdd = (claimType, claimText, verdict, details) => {
    verifications.push({
      claim_type: claimType,
      claim_text: claimText,
      verdict,
      details
    });
  };

  for (const [claimType, patterns] of Object.entries(claimPatterns)) {
    for (const pattern of patterns) {
      const match = outputText.match(pattern);
      if (!match) {
        continue;
      }
      if (claimType === "clean" && changedPaths.length > 0) {
        maybeAdd(claimType, match[0], "contradicted", { changed_paths: changedPaths });
      } else if (claimType === "tests_pass" && /fail|failing|error:/i.test(logText)) {
        maybeAdd(claimType, match[0], "contradicted", { evidence: "failing-test-output" });
      } else if (claimType === "done" && changedPaths.length > 0 && !/\b(pytest|test|build|lint|verify|validated|checked)\b/i.test(logText)) {
        maybeAdd(claimType, match[0], "contradicted", { reason: "completion-claim-without-verification", changed_paths: changedPaths });
      } else {
        maybeAdd(claimType, match[0], "verified", {});
      }
    }
  }

  return verifications;
}

function detectFalseClaim(policy, claimVerifications) {
  const contradicted = claimVerifications.filter((claim) => claim.verdict === "contradicted");
  if (contradicted.length === 0) {
    return null;
  }
  return makeDetector(policy, "false_claim", {
    contradicted_claims: contradicted.map((claim) => ({
      claim_type: claim.claim_type,
      claim_text: claim.claim_text
    }))
  });
}

function detectPrematureStop(policy, latestTask, claimVerifications) {
  if (!latestTask || latestTask.status !== "completed") {
    return null;
  }
  const contradictedCompletion = claimVerifications.some(
    (claim) => claim.claim_type === "done" && claim.verdict === "contradicted"
  );
  if (!contradictedCompletion) {
    return null;
  }
  return makeDetector(policy, "premature_stop", {
    job_id: latestTask.id
  });
}

function detectRepeatCorrectedMistake(policy, corrections, outputText, logText) {
  if (!corrections.length) {
    return null;
  }
  const matchedCorrections = corrections
    .filter((correction) => {
      const pattern = correction.pattern.trim();
      if (!pattern) {
        return false;
      }
      try {
        const regex = new RegExp(pattern, "i");
        return regex.test(outputText) || regex.test(logText);
      } catch {
        return outputText.includes(pattern) || logText.includes(pattern);
      }
    })
    .map((correction) => ({
      id: correction.id,
      pattern: correction.pattern,
      note: correction.note
    }));

  if (matchedCorrections.length === 0) {
    return null;
  }

  return makeDetector(policy, "repeat_corrected_mistake", {
    matched_corrections: matchedCorrections
  });
}

export function analyzeSidecarSession({ workspaceRoot, sessionId, policy, corrections = [] }) {
  const changedPaths = getChangedPaths(workspaceRoot);
  const sessionJobs = getSessionJobs(workspaceRoot, sessionId);
  const { latestTask, outputText, logText } = getLatestTaskSnapshot(workspaceRoot, sessionJobs);
  const claimVerifications = buildClaimVerifications(policy, latestTask, outputText, logText, changedPaths);

  const detectors = [
    detectSuspiciousFileTouch(policy, changedPaths),
    detectSecretExposure(policy, [outputText, logText], changedPaths),
    detectThrashLoop(policy, sessionJobs),
    detectFalseClaim(policy, claimVerifications),
    detectPrematureStop(policy, latestTask, claimVerifications),
    detectRepeatCorrectedMistake(policy, corrections, outputText, logText)
  ].filter(Boolean);

  return {
    changedPaths,
    sessionJobs,
    latestTask,
    claimVerifications,
    detectors
  };
}
