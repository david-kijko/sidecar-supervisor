---
description: Add a task to the Strap sidecar task list for this Claude session
argument-hint: '[--session-id <id>] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" sidecar-task $ARGUMENTS`

Output rules:
- Present the command output to the user.
- If the user omitted the task text, ask them for it instead of guessing.
