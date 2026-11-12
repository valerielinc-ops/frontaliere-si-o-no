# Shared path attestation for the Codex article and primary lanes.
# Callers provide realpath(), stat_cmd, readlink_cmd, trusted_roots,
# workspace_root, action_path, runner_temp, temporary_root, and
# TRUSTED_PATH_OWNER_POLICY ("root" or "current"). Before using realpath or
# readlink, callers bootstrap them with bootstrap_path_components_trusted();
# the absolute OS stat command is the sole initial lstat trust anchor because
# Bash has no builtin for lstat owner/mode metadata.
[ "${temporary_root+x}" ] || temporary_root=''

trusted_path_parent() {
  local current="$1" parent
  [ "$current" = '/' ] && { printf '/'; return 0; }
  current="${current%/}"
  case "$current" in
    */*)
      parent="${current%/*}"
      [ -n "$parent" ] || parent='/'
      printf '%s' "$parent"
      ;;
    *) printf '.' ;;
  esac
}

stat_mode() {
  "$stat_cmd" -c '%a' "$1" 2>/dev/null || "$stat_cmd" -f '%Lp' "$1" 2>/dev/null || true
}

stat_owner() {
  # GNU and BSD stat both lstat by default. Do not add -L here: the link's
  # owner is an independent trust check from the target's owner and mode.
  "$stat_cmd" -c '%u' "$1" 2>/dev/null || "$stat_cmd" -f '%u' "$1" 2>/dev/null || true
}

bootstrap_path_prefix() {
  local candidate="$1" trusted_root
  for trusted_root in "${bootstrap_roots[@]}"; do
    case "$candidate" in
      "$trusted_root"|"$trusted_root"/*) return 0 ;;
    esac
  done
  return 1
}

bootstrap_path_components_trusted() {
  local input="$1" current='/' component candidate record owner mode name_field
  local quoted_prefix raw_target target symlink_count=0 processed=0
  local -a pending=() target_parts=() remaining=()
  [[ "$input" = /* ]] || return 1
  case "$input" in *$'\n'*) return 1 ;; esac
  IFS=/ read -r -a pending <<< "$input"

  # Resolve one path component at a time. This gives `..` its filesystem
  # meaning after any preceding symlink has been expanded, without calling the
  # realpath binary that this bootstrap is responsible for attesting.
  local index=0
  while [ "$index" -lt "${#pending[@]}" ]; do
    component="${pending[$index]}"
    index=$((index + 1))
    processed=$((processed + 1))
    [ "$processed" -le 256 ] || return 1
    case "$component" in
      ''|.) continue ;;
      ..)
        current="$(trusted_path_parent "$current")"
        path_forbidden "$current" && return 1
        continue
        ;;
    esac

    candidate="${current%/}/$component"
    [ -e "$candidate" ] || [ -L "$candidate" ] || return 1

    # This bootstrap deliberately invokes only the caller's absolute stat
    # command. On Ubuntu, GNU stat's %N gives the immediate link target; reject
    # quoted/escaped forms we do not understand instead of parsing permissively.
    record="$("$stat_cmd" -c '%u %a %N' "$candidate" 2>/dev/null)" || return 1
    owner="${record%% *}"
    record="${record#* }"
    mode="${record%% *}"
    name_field="${record#* }"

    if [ -L "$candidate" ]; then
      [ "$owner" = '0' ] || return 1
      quoted_prefix="'$candidate' -> '"
      case "$name_field" in
        "$quoted_prefix"*) raw_target="${name_field#"$quoted_prefix"}" ;;
        *) return 1 ;;
      esac
      [ "${raw_target: -1}" = "'" ] || return 1
      target="${raw_target%?}"
      [ -n "$target" ] || return 1
      case "$target" in *\\*|*$'\n'*) return 1 ;; esac
      symlink_count=$((symlink_count + 1))
      [ "$symlink_count" -le 40 ] || return 1
      remaining=()
      if [ "$index" -lt "${#pending[@]}" ]; then
        remaining=("${pending[@]:$index}")
      fi
      IFS=/ read -r -a target_parts <<< "$target"
      pending=()
      if [ "${#target_parts[@]}" -gt 0 ]; then
        pending+=("${target_parts[@]}")
      fi
      if [ "${#remaining[@]}" -gt 0 ]; then
        pending+=("${remaining[@]}")
      fi
      index=0
      case "$target" in /*) current='/' ;; esac
      continue
    fi

    path_owner_and_mode_trusted "$mode" "$owner" || return 1
    current="$candidate"
    path_forbidden "$current" && return 1
  done

  bootstrap_path_prefix "$current" || return 1
  path_forbidden "$current" && return 1
  return 0
}

path_owner_and_mode_trusted() {
  local mode="$1" owner="$2" current_uid="${EUID:-}" octal_mode
  [ -n "$mode" ] && [ -n "$owner" ] || return 1
  octal_mode="${mode: -3}"
  case "$octal_mode" in
    [0-7][0-7][0-7]) ;;
    *) return 1 ;;
  esac
  (( (8#$octal_mode & 022) == 0 )) || return 1
  case "${TRUSTED_PATH_OWNER_POLICY:-root}" in
    root) [ "$owner" = '0' ] ;;
    current)
      [ "$owner" = '0' ] && return 0
      [ -n "$current_uid" ] && [ "$owner" = "$current_uid" ]
      ;;
    *) return 1 ;;
  esac
}

path_components_trusted() {
  local current="$1" depth="${2:-0}" parent mode owner target next_depth
  [[ "$current" = /* ]] || return 1
  case "$current" in *$'\n'*) return 1 ;; esac
  [ "$current" = '/' ] || [ -e "$current" ] || [ -L "$current" ] || return 1
  [ "$depth" -lt 64 ] || return 1
  next_depth=$((depth + 1))

  if [ "$current" != '/' ]; then
    parent="$(trusted_path_parent "$current")"
    path_components_trusted "$parent" "$next_depth" || return 1
  else
    parent='/'
  fi

  if [ -L "$current" ]; then
    # Symlink permission bits are normally 0777 and carry no protection.
    # Require a root-owned link, trusted containing directories, and repeat
    # this check for every link in the chain (including alternatives links).
    owner="$(stat_owner "$current")"
    [ "$owner" = '0' ] || return 1
    target="$("$readlink_cmd" "$current" 2>/dev/null)" || return 1
    [ -n "$target" ] || return 1
    case "$target" in *$'\n'*) return 1 ;; esac
    case "$target" in
      /*) ;;
      *) target="$parent/$target" ;;
    esac
    path_components_trusted "$target" "$next_depth" || return 1
    return 0
  fi

  mode="$(stat_mode "$current")"
  owner="$(stat_owner "$current")"
  path_owner_and_mode_trusted "$mode" "$owner"
}

path_forbidden() {
  local candidate="$1" forbidden_root
  case "$candidate" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/tmp|/var/tmp/*) return 0 ;;
  esac
  for forbidden_root in "$workspace_root" "$action_path" "$runner_temp" "$temporary_root"; do
    [ -n "$forbidden_root" ] || continue
    case "$candidate" in
      "$forbidden_root"|"$forbidden_root"/*) return 0 ;;
    esac
  done
  return 1
}

trusted_prefix() {
  local resolved="$1" trusted_root
  path_forbidden "$resolved" && return 1
  for trusted_root in "${trusted_roots[@]}"; do
    case "$resolved" in
      "$trusted_root"|"$trusted_root"/*) return 0 ;;
    esac
  done
  return 1
}

trusted_path_resolve() {
  local candidate="$1" resolved
  path_forbidden "$candidate" && return 1
  path_components_trusted "$candidate" || return 1
  resolved="$(realpath "$candidate" 2>/dev/null)" || return 1
  case "$resolved" in *$'\n'*) return 1 ;; esac
  trusted_prefix "$resolved" || return 1
  path_components_trusted "$resolved" || return 1
  printf '%s' "$resolved"
}
