import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { addCorrection } from "../plugins/codex/scripts/lib/strap-db.mjs";
import { createCheckpoint, createSidecarSession, getSidecarStatus } from "../plugins/codex/scripts/lib/strap-checkpoints.mjs";
import { loadScoringPolicy } from "../plugins/codex/scripts/lib/strap-policy.mjs";
import { resolveJobLogFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function withStrapRoot(strapRoot, callback) {
  const previous = process.env.STRAP_ROOT;
  process.env.STRAP_ROOT = strapRoot;
  try {
    return callback();
  } finally {
    if (previous == null) {
      delete process.env.STRAP_ROOT;
    } else {
      process.env.STRAP_ROOT = previous;
    }
  }
}

function createCompletedTaskJob(repo, sessionId, id, summary, rawOutput, logBody, updatedAt) {
  const logFile = resolveJobLogFile(repo, id);
  fs.writeFileSync(logFile, logBody, "utf8");
  const job = {
    id,
    kind: "task",
    kindLabel: "rescue",
    title: "Codex Task",
    workspaceRoot: repo,
    jobClass: "task",
    sessionId,
    status: "completed",
    phase: "done",
    summary,
    createdAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
    logFile
  };
  upsertJob(repo, job);
  writeJobFile(repo, id, {
    ...job,
    result: {
      rawOutput
    }
  });
}

test("sidecar start creates a session, checkpoint, and telemetry branch", () =>
  withStrapRoot(makeTempDir("strap-root-"), () => {
    const repo = makeTempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
    run("git", ["add", "README.md", ".gitignore"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    const policy = loadScoringPolicy(PLUGIN_ROOT);
    createSidecarSession({
      workspaceRoot: repo,
      sessionId: "sess-start",
      policy,
      initialTasks: ["Investigate regressions"]
    });
    createCheckpoint({
      workspaceRoot: repo,
      sessionId: "sess-start",
      policy,
      reason: "session-start"
    });

    const status = getSidecarStatus({
      workspaceRoot: repo,
      sessionId: "sess-start",
      policy
    });
    assert.ok(status);
    assert.equal(status.sessionId, "sess-start");
    assert.equal(status.daemonActive, false);
    assert.equal(status.policyId, "strap-default-v1");
    assert.equal(status.tasks[0].title, "Investigate regressions");
    assert.equal(status.latestCheckpoint.reason, "session-start");
    assert.equal(status.latestCheckpoint.telemetry_branch, "sidecar/telemetry/sess-start");
    assert.match(status.latestCheckpoint.telemetry_commit, /^[0-9a-f]{40}$/);
    assert.match(status.dbPath, /strap\.db$/);

    const branchCheck = run("git", ["-C", repo, "show-ref", "--verify", "refs/heads/sidecar/telemetry/sess-start"]);
    assert.equal(branchCheck.status, 0, branchCheck.stderr);
  }));

test("sidecar checkpoint surfaces risky detector findings and claim contradictions", () =>
  withStrapRoot(makeTempDir("strap-root-"), () => {
    const repo = makeTempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=placeholder\n");
    fs.writeFileSync(path.join(repo, "README.md"), "base\nchanged\n");

    const policy = loadScoringPolicy(PLUGIN_ROOT);
    createSidecarSession({
      workspaceRoot: repo,
      sessionId: "sess-risk",
      policy
    });
    addCorrection("sess-risk", "useMemo", "already corrected");

    createCompletedTaskJob(
      repo,
      "sess-risk",
      "task-old-1",
      "Repeated failing loop",
      "done",
      "error: suite failed\n",
      "2026-04-01T10:00:00.000Z"
    );
    createCompletedTaskJob(
      repo,
      "sess-risk",
      "task-old-2",
      "Repeated failing loop",
      "done",
      "error: suite failed\n",
      "2026-04-01T10:01:00.000Z"
    );
    createCompletedTaskJob(
      repo,
      "sess-risk",
      "task-latest",
      "Repeated failing loop",
      "done clean tests pass useMemo sk-abcdefghijklmnopqrstuvwxyz",
      "error: suite failed\n",
      "2026-04-01T10:02:00.000Z"
    );

    const checkpoint = createCheckpoint({
      workspaceRoot: repo,
      sessionId: "sess-risk",
      policy,
      reason: "test"
    });

    const detectorIds = checkpoint.detectors.map((detector) => detector.detector_id).sort();
    assert.deepEqual(detectorIds, [
      "false_claim",
      "premature_stop",
      "repeat_corrected_mistake",
      "secret_exposure",
      "suspicious_file_touch",
      "thrash_loop"
    ]);
    assert.equal(checkpoint.reason, "test");
    assert.equal(checkpoint.telemetry_branch, "sidecar/telemetry/sess-risk");
    assert.ok(checkpoint.composite_score > 0);
    assert.ok(checkpoint.claimVerifications.some((claim) => claim.verdict === "contradicted"));
  }));
