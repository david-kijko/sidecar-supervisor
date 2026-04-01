---
description: Stop the Strap sidecar for this Claude session after writing a final checkpoint
argument-hint: '[--session-id <id>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" sidecar-stop $ARGUMENTS`

Output rules:
- Present the command output to the user.
- Do not omit the final checkpoint or shutdown confirmation if the command reports them.
