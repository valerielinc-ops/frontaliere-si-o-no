#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/parallel-tar.sh — pack a tree into N tar parts in parallel, and
# extract any set of such parts in parallel. Sourced, not executed.
#
# WHY. The non-IT build legs hand their locale subtree to deploy-publish.yml as
# one tar (deploy.yml «Pack non-IT locale shard source artifact»). A single
# `tar -cf` over ~1M one-directory-per-page files issues every open/read/close
# in series and is bound by the disk's per-request latency, not by bandwidth:
# 23.3 min on the fr leg, 13.2 on de, 10.7 on en of deploy 39917633944 — then
# `tar -tf` read the whole archive back to list it, and the tail spent another
# 2.8-4.5 min in a single `tar -xf`. N tar processes over N contiguous slices
# of the same file list keep N requests in flight.
#
# CONTENT IS UNCHANGED. The parts together hold exactly the entries a single
# `tar -C <root> -cf - <members>` would hold (every directory and every file
# under the members, found by `find`, archived with --no-recursion), and an
# extraction of all parts recreates the same tree with the same bytes. Only
# the archive framing differs: N files instead of one. With N <= 1 (the
# default) ptar_create runs the historical single `tar -cf` + `tar -tf`
# verbatim, so the off path is byte-identical in its artifact too.
#
# Compression (PTAR_ZSTD=1): each part is piped through `zstd -1 -T1`, so the
# N parts compress on N cores while the upload can use compression-level 0.
# ptar_extract recognises *.tar.zst and *.tar.
# ─────────────────────────────────────────────────────────────────────────────

# ptar_create <root> <out_dir> <base_name> <parts> <member>...
#   Writes <out_dir>/<base_name>.tar (parts <= 1) or
#   <out_dir>/<base_name>.part-<i>.tar[.zst] (i = 0..parts-1) and the member
#   list <out_dir>/<base_name>.members (one path per line, `tar -tf` style:
#   directories carry a trailing slash). Returns non-zero on any failure.
ptar_create() {
  local root="$1" out_dir="$2" base="$3" parts="$4"
  shift 4
  [ "$#" -gt 0 ] || { echo "ptar_create: no members" >&2; return 1; }
  mkdir -p "$out_dir" || return 1
  case "$parts" in ''|*[!0-9]*) parts=1 ;; esac
  if [ "$parts" -le 1 ]; then
    tar -C "$root" -cf "$out_dir/$base.tar" "$@" || return 1
    tar -tf "$out_dir/$base.tar" > "$out_dir/$base.members" || return 1
    return 0
  fi

  local list="$out_dir/$base.list" i pids=() rc=0 ext=tar
  [ "${PTAR_ZSTD:-}" = 1 ] && ext=tar.zst
  ( cd "$root" && find "$@" -print0 ) > "$list" || return 1
  # Contiguous slices of the preorder list (directories precede their files
  # within a slice; an extraction creates any parent a slice lacks).
  perl -e '
    use strict; use warnings;
    my ($list, $prefix, $n) = @ARGV;
    local $/ = "\0";
    open my $in, "<:raw", $list or die "open $list: $!";
    my @all = <$in>; close $in;
    my $per = int((@all + $n - 1) / $n) || 1;
    for my $i (0 .. $n - 1) {
      open my $o, ">:raw", "$prefix.$i" or die "open $prefix.$i: $!";
      my $from = $i * $per; my $to = $from + $per - 1; $to = $#all if $to > $#all;
      print {$o} @all[$from .. $to] if $from <= $#all;
      close $o or die "close: $!";
    }
  ' "$list" "$out_dir/$base.slice" "$parts" || return 1
  for ((i = 0; i < parts; i++)); do
    if [ "$ext" = tar.zst ]; then
      ( set -o pipefail
        tar -C "$root" --no-recursion --null -T "$out_dir/$base.slice.$i" -cf - \
          | zstd -q -1 -T1 -o "$out_dir/$base.part-$i.tar.zst" ) &
    else
      tar -C "$root" --no-recursion --null -T "$out_dir/$base.slice.$i" \
        -cf "$out_dir/$base.part-$i.tar" &
    fi
    pids+=("$!")
  done
  for i in "${pids[@]}"; do wait "$i" || rc=1; done
  # The members list in `tar -tf` form, from the same list the parts were cut
  # from (no second read of the archives).
  if [ "$rc" -eq 0 ]; then
    perl -e '
      use strict; use warnings;
      my ($list, $root) = @ARGV;
      local $/ = "\0";
      open my $in, "<:raw", $list or die "open $list: $!";
      while (defined(my $p = <$in>)) {
        chomp $p;
        print -d "$root/$p" && ! -l "$root/$p" ? "$p/\n" : "$p\n";
      }
    ' "$list" "$root" > "$out_dir/$base.members" || rc=1
  fi
  rm -f "$list" "$out_dir/$base.slice."*
  return "$rc"
}

# ptar_extract <dest> <archive>...
#   Extracts every archive into <dest> concurrently (*.tar or *.tar.zst).
ptar_extract() {
  local dest="$1" a pids=() rc=0
  shift
  [ "$#" -gt 0 ] || { echo "ptar_extract: no archives" >&2; return 1; }
  mkdir -p "$dest" || return 1
  for a in "$@"; do
    case "$a" in
      *.tar.zst) ( set -o pipefail; zstd -q -dc -- "$a" | tar -C "$dest" -xf - ) & ;;
      *) tar -C "$dest" -xf "$a" & ;;
    esac
    pids+=("$!")
  done
  for a in "${pids[@]}"; do wait "$a" || rc=1; done
  return "$rc"
}
