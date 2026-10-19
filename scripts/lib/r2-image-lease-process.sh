#!/usr/bin/env bash
# Shared lifecycle for timeout-bounded R2 image writers that hold a namespace
# lease. Callers set _R2_IMAGE_LEASE_ACTIVE=1 and install a signal handler that
# stops the tracked command before releasing any lease they own.

_r2_image_lease_timeout_pgid() {
  local timeout_pid="$1" pgid
  pgid="$(ps -o pgid= -p "$timeout_pid" 2>/dev/null)" || return 1
  pgid="$(printf '%s' "$pgid" | tr -d '[:space:]')"
  [ "$pgid" = "$timeout_pid" ] || return 1
  printf '%s\n' "$pgid"
}

_r2_image_lease_timeout_alive() {
  local timeout_pid="$1" pid_state group_snapshot pgid="${_R2_IMAGE_LEASE_TIMEOUT_PGID:-}"
  if kill -0 "$timeout_pid" 2>/dev/null; then
    if ! pid_state="$(ps -o stat= -p "$timeout_pid" 2>/dev/null)"; then
      return 0
    fi
    pid_state="$(printf '%s' "$pid_state" | tr -d '[:space:]')"
    case "$pid_state" in ''|Z*) ;; *) return 0 ;; esac
  fi

  if [ -z "$pgid" ]; then
    if pgid="$(_r2_image_lease_timeout_pgid "$timeout_pid")"; then
      _R2_IMAGE_LEASE_TIMEOUT_PGID="$pgid"
    else
      # A live but unclassified leader is still work in progress. If it has
      # exited, query its expected group id only to distinguish an empty group
      # from unknown descendants; never signal that unverified group.
      if kill -0 "$timeout_pid" 2>/dev/null; then return 0; fi
      if ! group_snapshot="$(ps -axo pgid=,stat= 2>/dev/null)"; then return 0; fi
      printf '%s\n' "$group_snapshot" \
        | awk -v pgid="$timeout_pid" '$1 == pgid && $2 !~ /^Z/ { live = 1 } END { exit (live ? 0 : 1) }' \
        && return 0
      return 1
    fi
  fi

  if ! group_snapshot="$(ps -axo pgid=,stat= 2>/dev/null)"; then
    return 0
  fi
  printf '%s\n' "$group_snapshot" \
    | awk -v pgid="$pgid" '$1 == pgid && $2 !~ /^Z/ { live = 1 } END { exit (live ? 0 : 1) }'
}

_r2_image_lease_signal_timeout() {
  local timeout_pid="$1" signal="$2" pgid
  pgid="${_R2_IMAGE_LEASE_TIMEOUT_PGID:-}"
  if [ "$pgid" = "$timeout_pid" ]; then
    kill -"$signal" -- "-$pgid" 2>/dev/null || true
  elif pgid="$(_r2_image_lease_timeout_pgid "$timeout_pid")"; then
    _R2_IMAGE_LEASE_TIMEOUT_PGID="$pgid"
    kill -"$signal" -- "-$pgid" 2>/dev/null || true
  else
    # GNU timeout may be between fork and setpgid. During that short window,
    # signal only the process this shell started; timeout forwards the signal
    # once its command group is established.
    kill -"$signal" "$timeout_pid" 2>/dev/null || true
  fi
}

_r2_image_lease_stop_timeout() {
  local timeout_pid="${_R2_IMAGE_LEASE_TIMEOUT_PID:-}" attempt
  [ -n "$timeout_pid" ] || return 0

  # Check first: if the timeout leader already exited, its PID may have been
  # reused. Only signal a cached process group while it still has a verified
  # live member; never send a group signal based on a stale PID alone.
  if ! _r2_image_lease_timeout_alive "$timeout_pid"; then
    wait "$timeout_pid" 2>/dev/null || true
    _R2_IMAGE_LEASE_TIMEOUT_PID=
    _R2_IMAGE_LEASE_TIMEOUT_PGID=
    return 0
  fi

  _r2_image_lease_signal_timeout "$timeout_pid" TERM
  for ((attempt = 0; attempt < 20; attempt += 1)); do
    if ! _r2_image_lease_timeout_alive "$timeout_pid"; then
      wait "$timeout_pid" 2>/dev/null || true
      _R2_IMAGE_LEASE_TIMEOUT_PID=
      _R2_IMAGE_LEASE_TIMEOUT_PGID=
      return 0
    fi
    sleep 0.05
  done

  # A writer that ignores TERM must not outlive the lease cleanup. Escalate
  # only against this timeout's confirmed process group (or its own PID before
  # setpgid) and keep the confirmation window below the Actions TERM grace.
  _r2_image_lease_signal_timeout "$timeout_pid" KILL
  for ((attempt = 0; attempt < 10; attempt += 1)); do
    if ! _r2_image_lease_timeout_alive "$timeout_pid"; then
      wait "$timeout_pid" 2>/dev/null || true
      _R2_IMAGE_LEASE_TIMEOUT_PID=
      _R2_IMAGE_LEASE_TIMEOUT_PGID=
      return 0
    fi
    sleep 0.05
  done

  # If shutdown cannot be confirmed, keep the lease until expiry rather than
  # admitting a concurrent writer while this command might still be active.
  _R2_IMAGE_LEASE_RELEASE_ALLOWED=0
  echo "::error::[r2] could not confirm the image writer stopped; keeping its lease until expiry" >&2
  return 1
}

_r2_image_lease_dispatch_signal() {
  local exit_status="$1" handler="${_R2_IMAGE_LEASE_SIGNAL_HANDLER:-}"
  if [ -n "$handler" ]; then
    "$handler" "$exit_status"
  fi
  exit "$exit_status"
}

_r2_image_lease_wait_timeout() {
  if [ "${_R2_IMAGE_LEASE_ACTIVE:-0}" != 1 ]; then
    "$@"
    return $?
  fi

  local _R2_IMAGE_LEASE_PENDING_SIGNAL= prior_int_trap prior_term_trap
  local timeout_pid timeout_status=0 timeout_pgid attempt
  if [ -n "${_R2_IMAGE_LEASE_TIMEOUT_PID:-}" ]; then
    _r2_image_lease_stop_timeout || return 1
  fi
  prior_int_trap="$(trap -p INT)"
  prior_term_trap="$(trap -p TERM)"

  # Capture TERM/INT during the tiny fork→$! assignment window. Once the PID
  # is recorded, restore the caller's traps and perform the owned stop before
  # invoking its release-aware signal handler.
  trap '_R2_IMAGE_LEASE_PENDING_SIGNAL=130' INT
  trap '_R2_IMAGE_LEASE_PENDING_SIGNAL=143' TERM
  "$@" &
  timeout_pid=$!
  _R2_IMAGE_LEASE_TIMEOUT_PID="$timeout_pid"
  _R2_IMAGE_LEASE_TIMEOUT_PGID=
  for ((attempt = 0; attempt < 20; attempt += 1)); do
    if timeout_pgid="$(_r2_image_lease_timeout_pgid "$timeout_pid")"; then
      _R2_IMAGE_LEASE_TIMEOUT_PGID="$timeout_pgid"
      break
    fi
    kill -0 "$timeout_pid" 2>/dev/null || break
    sleep 0.005
  done
  trap - INT TERM
  [ -n "$prior_int_trap" ] && eval "$prior_int_trap"
  [ -n "$prior_term_trap" ] && eval "$prior_term_trap"

  if [ -n "$_R2_IMAGE_LEASE_PENDING_SIGNAL" ]; then
    _r2_image_lease_stop_timeout || _R2_IMAGE_LEASE_RELEASE_ALLOWED=0
    _r2_image_lease_dispatch_signal "$_R2_IMAGE_LEASE_PENDING_SIGNAL"
  fi

  wait "$timeout_pid" || timeout_status=$?
  # The child has been reaped normally. Do not leave its PID or process-group
  # snapshot armed for the next upload: a later child may reuse either value,
  # and EXIT cleanup must never signal an unrelated process group.
  _R2_IMAGE_LEASE_TIMEOUT_PID=
  _R2_IMAGE_LEASE_TIMEOUT_PGID=
  return "$timeout_status"
}
