#!/usr/bin/env bash

# Feed one ZIP member to both tar's completeness listing and its extractor
# without decompressing the member twice.  The two readers receive identical
# bytes through FIFOs, so the caller can keep the existing exact file-count and
# unzip CRC checks without materialising the uncompressed tar beside dist/.
#
# Results are exported as shell variables for the caller:
#   STREAM_TAR_EXPECTED_N, STREAM_TAR_LIST_RC, STREAM_TAR_UNZIP_RC,
#   STREAM_TAR_TEE_RC, STREAM_TAR_EXTRACT_RC
stream_tar_member() {
  local zip_path="$1"
  local member="$2"
  local extract_dir="$3"
  local work list_fifo extract_fifo
  local list_pid extract_pid stream_pid
  local list_rc extract_rc unzip_rc tee_rc

  STREAM_TAR_EXPECTED_N=0
  STREAM_TAR_LIST_RC=2
  STREAM_TAR_UNZIP_RC=2
  STREAM_TAR_TEE_RC=2
  STREAM_TAR_EXTRACT_RC=2

  work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/rehydrate-tar-member.XXXXXX")" || return 1
  list_fifo="$work/list.tar"
  extract_fifo="$work/extract.tar"
  if ! mkfifo "$list_fifo" "$extract_fifo"; then
    rm -rf -- "$work"
    return 1
  fi

  (
    set +e
    tar -tf "$list_fifo" 2>/dev/null | { grep -vc '/$' || true; } > "$work/expected"
    list_rc="${PIPESTATUS[0]:-2}"
    printf '%s\n' "$list_rc" > "$work/list.rc"
  ) &
  list_pid=$!

  tar -C "$extract_dir" -xf "$extract_fifo" 2>/dev/null &
  extract_pid=$!

  (
    set +e
    unzip -p "$zip_path" "$member" 2>/dev/null | tee "$list_fifo" > "$extract_fifo"
    pipeline_statuses=("${PIPESTATUS[@]}")
    unzip_rc="${pipeline_statuses[0]:-2}"
    tee_rc="${pipeline_statuses[1]:-2}"
    printf '%s\n%s\n' "$unzip_rc" "$tee_rc" > "$work/stream.rc"
  ) &
  stream_pid=$!

  wait "$stream_pid" || true
  wait "$list_pid" || true
  if wait "$extract_pid"; then
    extract_rc=0
  else
    extract_rc=$?
  fi

  if [ -s "$work/expected" ]; then
    IFS= read -r STREAM_TAR_EXPECTED_N < "$work/expected" || true
  fi
  if [ -s "$work/list.rc" ]; then
    IFS= read -r STREAM_TAR_LIST_RC < "$work/list.rc" || true
  fi
  if [ -s "$work/stream.rc" ]; then
    {
      IFS= read -r STREAM_TAR_UNZIP_RC || true
      IFS= read -r STREAM_TAR_TEE_RC || true
    } < "$work/stream.rc"
  fi
  STREAM_TAR_EXTRACT_RC="$extract_rc"

  rm -rf -- "$work"
  return 0
}
