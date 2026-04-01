---
description: Start or attach the Strap sidecar for this Claude session so it can checkpoint Codex progress, score risky behavior, and keep a task list
argument-hint: '[--session-id <id>] [--no-daemon] [initial task]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" sidecar-start $ARGUMENTS`

Output rules:
- Present the command output to the user.
- Do not paraphrase or suppress the session id, checkpoint, detector, score, or database details.
- If the user did not pass an initial task, do not invent one.
