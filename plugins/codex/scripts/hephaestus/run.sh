#!/usr/bin/env bash
set -euo pipefail

model="${HEPHAESTUS_MODEL:-gpt-5.4}"
reasoning_effort="${HEPHAESTUS_REASONING_EFFORT:-xhigh}"
sandbox="dangerous"
workdir="$PWD"
prompt_file=""
use_stdin=0

usage() {
  cat <<'EOF'
hephaestus [PROMPT]
hephaestus --file <brief.md> [--dir <path>] [--full-auto|--dangerous]
hephaestus -   # read prompt from stdin

Options:
  --file <path>           Read prompt from file
  --dir <path>            Working directory for codex exec
  --full-auto             Use workspace-write sandbox
  --dangerous             Use danger-full-access sandbox
  --reasoning-effort <v>  Override model reasoning effort
  -h, --help              Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      prompt_file="${2:?missing value for --file}"
      shift 2
      ;;
    --dir)
      workdir="${2:?missing value for --dir}"
      shift 2
      ;;
    --full-auto)
      sandbox="workspace-write"
      shift
      ;;
    --dangerous)
      sandbox="dangerous"
      shift
      ;;
    --reasoning-effort)
      reasoning_effort="${2:?missing value for --reasoning-effort}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -)
      use_stdin=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

mkdir -p "$HOME/.hephaestus/outputs"

timestamp="$(date +%Y%m%d-%H%M%S)"
output_file="$HOME/.hephaestus/outputs/hephaestus-$timestamp.md"

codex_cmd=(
  codex exec
  -m "$model"
  -c "model_reasoning_effort=\"$reasoning_effort\""
  -c "model_instructions_file=\"$HOME/.codex/AGENTS.md\""
  -c "features.use_linux_sandbox_bwrap=false"
  --dangerously-bypass-approvals-and-sandbox
  -C "$workdir"
  -o "$output_file"
)

echo "[Hephaestus] Model: $model | Sandbox: $sandbox | Dir: $workdir"
echo "[Hephaestus] Output: $output_file"

if [[ -n "$prompt_file" ]]; then
  echo "[Hephaestus] Task: $(head -n 1 "$prompt_file" 2>/dev/null || echo "...")"
  cat "$prompt_file" | "${codex_cmd[@]}" -
elif [[ "$use_stdin" -eq 1 ]]; then
  echo "[Hephaestus] Task: stdin"
  "${codex_cmd[@]}" -
elif [[ $# -gt 0 ]]; then
  echo "[Hephaestus] Task: $1"
  "${codex_cmd[@]}" "$*"
else
  echo "No prompt provided." >&2
  usage >&2
  exit 2
fi
