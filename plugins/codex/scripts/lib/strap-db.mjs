import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveStrapDbPath } from "./strap-paths.mjs";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  repo_hash TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  daemon_pid INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  phase TEXT,
  reason TEXT NOT NULL,
  manifestation_score REAL NOT NULL,
  severity_score REAL NOT NULL,
  scope_score REAL NOT NULL,
  composite_score REAL NOT NULL,
  confidence REAL NOT NULL,
  top_detector TEXT,
  artifact_path TEXT NOT NULL,
  log_path TEXT NOT NULL,
  telemetry_branch TEXT,
  telemetry_commit TEXT,
  summary TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS detector_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id TEXT NOT NULL,
  detector_id TEXT NOT NULL,
  manifestation_score REAL NOT NULL,
  severity_score REAL NOT NULL,
  scope_score REAL NOT NULL,
  confidence REAL NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claim_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  verdict TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE
);
`;

function nowIso() {
  return new Date().toISOString();
}

export function openStrapDb() {
  const dbPath = resolveStrapDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

export function withStrapDb(callback) {
  const db = openStrapDb();
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

export function ensureStrapSession({ sessionId, workspaceRoot, repoHash, policyId }) {
  return withStrapDb((db) => {
    const timestamp = nowIso();
    db.prepare(
      `
        INSERT INTO sessions (session_id, workspace_root, repo_hash, policy_id, started_at, updated_at, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(session_id) DO UPDATE SET
          workspace_root = excluded.workspace_root,
          repo_hash = excluded.repo_hash,
          policy_id = excluded.policy_id,
          updated_at = excluded.updated_at,
          active = 1
      `
    ).run(sessionId, workspaceRoot, repoHash, policyId, timestamp, timestamp);

    return db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
  });
}

export function setSessionDaemonPid(sessionId, pid) {
  return withStrapDb((db) => {
    db.prepare(`UPDATE sessions SET daemon_pid = ?, updated_at = ? WHERE session_id = ?`).run(pid, nowIso(), sessionId);
  });
}

export function markSessionInactive(sessionId) {
  return withStrapDb((db) => {
    db.prepare(`UPDATE sessions SET active = 0, updated_at = ? WHERE session_id = ?`).run(nowIso(), sessionId);
  });
}

export function getStrapSession(sessionId) {
  return withStrapDb((db) => db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) ?? null);
}

export function addTask(sessionId, title) {
  return withStrapDb((db) => {
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO tasks (session_id, title, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)`
    ).run(sessionId, title, timestamp, timestamp);
  });
}

export function listTasks(sessionId) {
  return withStrapDb((db) =>
    db
      .prepare(`SELECT id, title, status, created_at, updated_at FROM tasks WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionId)
  );
}

export function addCorrection(sessionId, pattern, note = "") {
  return withStrapDb((db) => {
    db.prepare(`INSERT INTO corrections (session_id, pattern, note, created_at) VALUES (?, ?, ?, ?)`).run(
      sessionId,
      pattern,
      note,
      nowIso()
    );
  });
}

export function listCorrections(sessionId) {
  return withStrapDb((db) =>
    db.prepare(`SELECT id, pattern, note, created_at FROM corrections WHERE session_id = ? ORDER BY id ASC`).all(sessionId)
  );
}

export function getLatestCheckpoint(sessionId) {
  return withStrapDb((db) =>
    db
      .prepare(
        `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY sequence_number DESC LIMIT 1`
      )
      .get(sessionId) ?? null
  );
}

export function listRecentCheckpoints(sessionId, limit = 5) {
  return withStrapDb((db) =>
    db
      .prepare(
        `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY sequence_number DESC LIMIT ?`
      )
      .all(sessionId, limit)
  );
}

export function insertCheckpoint({ checkpoint, detectorEvents, claimVerifications }) {
  return withStrapDb((db) => {
    const sequenceNumber =
      db
        .prepare(`SELECT COALESCE(MAX(sequence_number), 0) AS value FROM checkpoints WHERE session_id = ?`)
        .get(checkpoint.session_id).value + 1;

    db.prepare(
      `
        INSERT INTO checkpoints (
          checkpoint_id, session_id, sequence_number, created_at, phase, reason,
          manifestation_score, severity_score, scope_score, composite_score,
          confidence, top_detector, artifact_path, log_path, telemetry_branch,
          telemetry_commit, summary
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      checkpoint.checkpoint_id,
      checkpoint.session_id,
      sequenceNumber,
      checkpoint.created_at,
      checkpoint.phase,
      checkpoint.reason,
      checkpoint.manifestation_score,
      checkpoint.severity_score,
      checkpoint.scope_score,
      checkpoint.composite_score,
      checkpoint.confidence,
      checkpoint.top_detector,
      checkpoint.artifact_path,
      checkpoint.log_path,
      checkpoint.telemetry_branch,
      checkpoint.telemetry_commit,
      checkpoint.summary
    );

    const insertDetector = db.prepare(
      `
        INSERT INTO detector_events (
          checkpoint_id, detector_id, manifestation_score, severity_score,
          scope_score, confidence, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    for (const detectorEvent of detectorEvents) {
      insertDetector.run(
        checkpoint.checkpoint_id,
        detectorEvent.detector_id,
        detectorEvent.manifestation_score,
        detectorEvent.severity_score,
        detectorEvent.scope_score,
        detectorEvent.confidence,
        JSON.stringify(detectorEvent.details ?? {}),
        checkpoint.created_at
      );
    }

    const insertClaim = db.prepare(
      `
        INSERT INTO claim_verifications (
          checkpoint_id, claim_type, claim_text, verdict, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `
    );
    for (const claim of claimVerifications) {
      insertClaim.run(
        checkpoint.checkpoint_id,
        claim.claim_type,
        claim.claim_text,
        claim.verdict,
        JSON.stringify(claim.details ?? {}),
        checkpoint.created_at
      );
    }

    return db.prepare(`SELECT * FROM checkpoints WHERE checkpoint_id = ?`).get(checkpoint.checkpoint_id);
  });
}
