---
description: Show the current Strap sidecar health, scores, active detectors, task list, and steering suggestions for this Claude session
argument-hint: '[--session-id <id>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" sidecar-status $ARGUMENTS`

Output rules:
- Present the command output to the user.
- Preserve score values, detector ids, claim-check results, telemetry branch information, and steering suggestions exactly as reported.
