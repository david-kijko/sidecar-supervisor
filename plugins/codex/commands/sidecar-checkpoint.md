---
description: Force an immediate Strap checkpoint for this Claude session and publish the latest scores and telemetry commit
argument-hint: '[--session-id <id>] [--reason <reason>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" sidecar-checkpoint $ARGUMENTS`

Output rules:
- Present the command output to the user.
- Do not summarize away the checkpoint id, top detector, or telemetry commit.
