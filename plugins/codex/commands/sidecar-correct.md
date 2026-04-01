---
description: Record a corrected mistake pattern so the Strap sidecar can flag repeat regressions in later Codex runs
argument-hint: '[--session-id <id>] [--note <text>] <pattern>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" sidecar-correct $ARGUMENTS`

Output rules:
- Present the command output to the user.
- Preserve the stored pattern and note exactly as confirmed by the companion command.
