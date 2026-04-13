#!/usr/bin/env bash
set -euo pipefail

MODEL="gpt-5.4"
REASONING_EFFORT="xhigh"
AGENTS_FILE="/home/david/.codex/AGENTS.md"
HEPHAESTUS_HOME="${HOME}/.hephaestus"
OUTPUT_DIR="${HEPHAESTUS_HOME}/outputs"
STATUS_FILE="${HEPHAESTUS_HOME}/status.json"

declare -a LANE_IDS=()
declare -a BRIEFS=()
declare -a WORKDIRS=()
declare -a OUTPUT_FILES=()
declare -a PIDS=()
declare -a LANE_STATUS=()
declare -a STARTED_AT=()
declare -a COMPLETED_AT=()
declare -a EXIT_CODES=()

overall_status="running"
project_dir=""
manifest_path=""
run_id=""
run_started=""

usage() {
  cat <<'USAGE'
Usage:
  lane-runner.sh --dir <project-dir> --brief <brief.md> [--brief <brief.md> ...]
  lane-runner.sh --manifest <lanes.json>

Options:
  --dir <path>        Project directory used as the source for isolated lane workdirs
  --brief <path>      Brief file for one lane (repeat up to 5 times)
  --manifest <path>   JSON manifest describing project_dir and lanes
  -h, --help          Show this help
USAGE
}

die() {
  echo "lane-runner: $*" >&2
  exit 1
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

new_uuid() {
  uuidgen | tr '[:upper:]' '[:lower:]'
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

abs_path() {
  local target="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$target"
    return
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "$target"
    return
  fi
  (
    cd "$(dirname "$target")" >/dev/null 2>&1
    printf '%s/%s\n' "$(pwd -P)" "$(basename "$target")"
  )
}

dir_is_empty() {
  local target="$1"
  [[ -d "$target" ]] || return 0
  [[ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

extract_json_string() {
  local object="$1"
  local key="$2"
  printf '%s' "$object" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

project_is_git_repo() {
  git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

write_status() {
  local lane_count completed_count running_count failed_count summary tmp_file
  local i

  lane_count=${#LANE_IDS[@]}
  completed_count=0
  running_count=0
  failed_count=0

  for ((i = 0; i < lane_count; i++)); do
    case "${LANE_STATUS[i]}" in
      completed)
        ((completed_count += 1))
        ;;
      failed)
        ((failed_count += 1))
        ;;
      *)
        ((running_count += 1))
        ;;
    esac
  done

  summary="${completed_count}/${lane_count} completed, ${running_count}/${lane_count} running, ${failed_count}/${lane_count} failed"
  mkdir -p "$HEPHAESTUS_HOME"
  tmp_file="$(mktemp "${HEPHAESTUS_HOME}/status.json.tmp.XXXXXX")"

  {
    printf '{\n'
    printf '  "run_id": "%s",\n' "$(json_escape "$run_id")"
    printf '  "started": "%s",\n' "$(json_escape "$run_started")"
    printf '  "project_dir": "%s",\n' "$(json_escape "$project_dir")"
    printf '  "lanes": [\n'
    for ((i = 0; i < lane_count; i++)); do
      printf '    {\n'
      printf '      "id": "%s",\n' "$(json_escape "${LANE_IDS[i]}")"
      printf '      "pid": %s,\n' "${PIDS[i]}"
      printf '      "status": "%s",\n' "$(json_escape "${LANE_STATUS[i]}")"
      printf '      "workdir": "%s",\n' "$(json_escape "${WORKDIRS[i]}")"
      printf '      "output": "%s",\n' "$(json_escape "${OUTPUT_FILES[i]}")"
      printf '      "brief": "%s",\n' "$(json_escape "${BRIEFS[i]}")"
      printf '      "started": "%s",\n' "$(json_escape "${STARTED_AT[i]}")"
      if [[ -n "${COMPLETED_AT[i]}" ]]; then
        printf '      "completed": "%s",\n' "$(json_escape "${COMPLETED_AT[i]}")"
        printf '      "exit_code": %s\n' "${EXIT_CODES[i]}"
      else
        printf '      "completed": null\n'
      fi
      printf '    }'
      if (( i < lane_count - 1 )); then
        printf ','
      fi
      printf '\n'
    done
    printf '  ],\n'
    printf '  "summary": "%s",\n' "$(json_escape "$summary")"
    printf '  "overall_status": "%s"\n' "$(json_escape "$overall_status")"
    printf '}\n'
  } > "$tmp_file"

  mv "$tmp_file" "$STATUS_FILE"
}

parse_manifest() {
  local raw project lane_object lane_id lane_brief lane_workdir
  mapfile -t LANE_IDS < <(printf '')
  mapfile -t BRIEFS < <(printf '')
  mapfile -t WORKDIRS < <(printf '')
  LANE_IDS=()
  BRIEFS=()
  WORKDIRS=()

  [[ -f "$manifest_path" ]] || die "manifest not found: $manifest_path"
  raw="$(tr '\r\n' '  ' < "$manifest_path")"
  project="$(printf '%s' "$raw" | sed -n 's/.*"project_dir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [[ -n "$project" ]] || die "manifest is missing project_dir"
  project_dir="$project"

  while IFS= read -r lane_object; do
    [[ -n "$lane_object" ]] || continue
    lane_id="$(extract_json_string "$lane_object" "id")"
    lane_brief="$(extract_json_string "$lane_object" "brief")"
    lane_workdir="$(extract_json_string "$lane_object" "workdir")"
    [[ -n "$lane_brief" ]] || die "each manifest lane requires a brief"
    LANE_IDS+=("$lane_id")
    BRIEFS+=("$lane_brief")
    WORKDIRS+=("$lane_workdir")
  done < <(printf '%s' "$raw" | grep -o '{[^{}]*}' || true)

  ((${#BRIEFS[@]} > 0)) || die "manifest does not contain any lanes"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)
        [[ $# -ge 2 ]] || die "missing value for --dir"
        project_dir="$2"
        shift 2
        ;;
      --brief)
        [[ $# -ge 2 ]] || die "missing value for --brief"
        BRIEFS+=("$2")
        shift 2
        ;;
      --manifest)
        [[ $# -ge 2 ]] || die "missing value for --manifest"
        manifest_path="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  if [[ -n "$manifest_path" ]]; then
    ((${#BRIEFS[@]} == 0)) || die "--manifest cannot be combined with --brief"
    [[ -z "$project_dir" ]] || die "--manifest cannot be combined with --dir"
    parse_manifest
  fi

  [[ -n "$project_dir" ]] || die "project directory is required"
  ((${#BRIEFS[@]} > 0)) || die "at least one --brief is required"
  ((${#BRIEFS[@]} <= 5)) || die "lane-runner supports between 1 and 5 lanes"
}

prepare_paths() {
  local i
  [[ -d "$project_dir" ]] || die "project directory not found: $project_dir"
  project_dir="$(abs_path "$project_dir")"
  mkdir -p "$OUTPUT_DIR"

  for ((i = 0; i < ${#BRIEFS[@]}; i++)); do
    [[ -f "${BRIEFS[i]}" ]] || die "brief not found: ${BRIEFS[i]}"
    BRIEFS[i]="$(abs_path "${BRIEFS[i]}")"
  done
}

prepare_lane_identity() {
  local i lane_uuid
  declare -A seen_ids=()
  for ((i = 0; i < ${#BRIEFS[@]}; i++)); do
    if [[ -z "${LANE_IDS[i]:-}" ]]; then
      lane_uuid="$(new_uuid)"
      LANE_IDS[i]="lane-${lane_uuid}"
    fi
    [[ -z "${seen_ids[${LANE_IDS[i]}]:-}" ]] || die "duplicate lane id: ${LANE_IDS[i]}"
    seen_ids[${LANE_IDS[i]}]=1
  done
}

prepare_workdir() {
  local i workdir project_head
  local generated_workdir
  declare -A seen_workdirs=()

  if project_is_git_repo; then
    project_head="$(git -C "$project_dir" rev-parse HEAD)"
  else
    project_head=""
  fi

  for ((i = 0; i < ${#BRIEFS[@]}; i++)); do
    workdir="${WORKDIRS[i]:-}"
    if [[ -z "$workdir" ]]; then
      generated_workdir="/tmp/hephaestus-lane-$(new_uuid)"
      workdir="$generated_workdir"
    fi

    if [[ -e "$workdir" && ! -d "$workdir" ]]; then
      die "workdir path is not a directory: $workdir"
    fi

    if [[ -d "$workdir" ]] && ! dir_is_empty "$workdir"; then
      :
    elif project_is_git_repo; then
      mkdir -p "$(dirname "$workdir")"
      if [[ -d "$workdir" ]] && dir_is_empty "$workdir"; then
        rmdir "$workdir" 2>/dev/null || true
      fi
      git -C "$project_dir" worktree add --detach "$workdir" "$project_head" >/dev/null
    else
      mkdir -p "$workdir"
      cp -a "$project_dir"/. "$workdir"/
    fi

    workdir="$(abs_path "$workdir")"
    [[ -z "${seen_workdirs[$workdir]:-}" ]] || die "duplicate workdir detected: $workdir"
    seen_workdirs[$workdir]=1
    WORKDIRS[i]="$workdir"
  done
}

prepare_outputs() {
  local i output_file
  for ((i = 0; i < ${#BRIEFS[@]}; i++)); do
    output_file="${OUTPUT_DIR}/lane-$(new_uuid).md"
    OUTPUT_FILES[i]="$output_file"
    COMPLETED_AT[i]=""
    EXIT_CODES[i]=""
  done
}

spawn_lane() {
  local i="$1"
  local -a cmd

  cmd=(
    codex exec
    -m "$MODEL"
    -c "model_reasoning_effort=\"$REASONING_EFFORT\""
    -c "model_instructions_file=\"$AGENTS_FILE\""
    --dangerously-bypass-approvals-and-sandbox
    --ephemeral
    -C "${WORKDIRS[i]}"
    -o "${OUTPUT_FILES[i]}"
  )

  if ! git -C "${WORKDIRS[i]}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    cmd+=(--skip-git-repo-check)
  fi

  cmd+=(-)

  STARTED_AT[i]="$(iso_now)"
  LANE_STATUS[i]="running"
  "${cmd[@]}" < "${BRIEFS[i]}" &
  PIDS[i]=$!
}

spawn_all_lanes() {
  local i
  for ((i = 0; i < ${#BRIEFS[@]}; i++)); do
    spawn_lane "$i"
  done
}

monitor_lanes() {
  local lane_count finished_count i exit_code
  lane_count=${#BRIEFS[@]}
  finished_count=0

  write_status

  while ((finished_count < lane_count)); do
    for ((i = 0; i < lane_count; i++)); do
      if [[ "${LANE_STATUS[i]}" == "running" ]] && ! kill -0 "${PIDS[i]}" 2>/dev/null; then
        set +e
        wait "${PIDS[i]}"
        exit_code=$?
        set -e

        if ((exit_code == 0)); then
          LANE_STATUS[i]="completed"
        else
          LANE_STATUS[i]="failed"
        fi

        EXIT_CODES[i]="$exit_code"
        COMPLETED_AT[i]="$(iso_now)"
        ((finished_count += 1))
        write_status
      fi
    done

    if ((finished_count < lane_count)); then
      sleep 1
    fi
  done

  overall_status="done"
  write_status
}

print_final_summary() {
  local completed_count failed_count i
  completed_count=0
  failed_count=0

  for ((i = 0; i < ${#LANE_STATUS[@]}; i++)); do
    case "${LANE_STATUS[i]}" in
      completed)
        ((completed_count += 1))
        ;;
      failed)
        ((failed_count += 1))
        ;;
    esac
  done

  printf 'All lanes complete: %d completed, %d failed\n' "$completed_count" "$failed_count"
  printf 'Status file: %s\n' "$STATUS_FILE"

  if ((failed_count > 0)); then
    return 1
  fi
}

main() {
  command -v codex >/dev/null 2>&1 || die "codex is not installed or not on PATH"
  command -v uuidgen >/dev/null 2>&1 || die "uuidgen is not installed or not on PATH"
  [[ -f "$AGENTS_FILE" ]] || die "instructions file not found: $AGENTS_FILE"

  parse_args "$@"
  prepare_paths
  prepare_lane_identity
  prepare_workdir
  prepare_outputs

  run_id="$(new_uuid)"
  run_started="$(iso_now)"

  spawn_all_lanes
  monitor_lanes
  print_final_summary
}

main "$@"
