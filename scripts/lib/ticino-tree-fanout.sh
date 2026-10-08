#!/usr/bin/env bash
# Keep the physical tree of the Ticino section below GitHub's 50 MiB tree
# object limit. The public URL remains <section>/<entry>/...; only the Pages
# shard storage path is fanned out into small first-two-character buckets.

TICINO_TREE_FANOUT_DIR="_tree"

# ticino_tree_fanout_stage <section> <section-root>
#
# The source build stays canonical. This mutates only the temporary checkout
# that will be force-pushed to frontaliere-ticino-<locale>.git.
ticino_tree_fanout_stage() {
  local section_name="$1"
  local root="$2"
  local fanout_root name src bucket first second
  local created_buckets=''

  [ "$section_name" = ticino ] || return 0
  if [ ! -d "$root" ]; then
    echo "::error::Ticino fan-out root is not a directory: $root" >&2
    return 1
  fi

  fanout_root="$root/$TICINO_TREE_FANOUT_DIR"
  if [ -e "$fanout_root" ]; then
    echo "::error::Ticino fan-out destination already exists: $fanout_root" >&2
    return 1
  fi
  mkdir "$fanout_root"

  # Root index.html is the canonical section shell and must remain at the
  # public section root. Every other first-level entry can move below _tree.
  while IFS= read -r -d '' src; do
    name="${src##*/}"
    [ "$name" = index.html ] && continue
    first="${name:0:1}"
    second="${name:1:1}"
    case "$first" in
      A) first=a ;; B) first=b ;; C) first=c ;; D) first=d ;; E) first=e ;;
      F) first=f ;; G) first=g ;; H) first=h ;; I) first=i ;; J) first=j ;;
      K) first=k ;; L) first=l ;; M) first=m ;; N) first=n ;; O) first=o ;;
      P) first=p ;; Q) first=q ;; R) first=r ;; S) first=s ;; T) first=t ;;
      U) first=u ;; V) first=v ;; W) first=w ;; X) first=x ;; Y) first=y ;;
      Z) first=z ;;
    esac
    case "$second" in
      A) second=a ;; B) second=b ;; C) second=c ;; D) second=d ;; E) second=e ;;
      F) second=f ;; G) second=g ;; H) second=h ;; I) second=i ;; J) second=j ;;
      K) second=k ;; L) second=l ;; M) second=m ;; N) second=n ;; O) second=o ;;
      P) second=p ;; Q) second=q ;; R) second=r ;; S) second=s ;; T) second=t ;;
      U) second=u ;; V) second=v ;; W) second=w ;; X) second=x ;; Y) second=y ;;
      Z) second=z ;;
    esac
    bucket="${first}${second}"
    [ -n "$bucket" ] || bucket="__"
    case " $created_buckets " in
      *" $bucket "*) ;;
      *)
      mkdir -p "$fanout_root/$bucket"
      created_buckets="$created_buckets $bucket"
      ;;
    esac
    mv "$src" "$fanout_root/$bucket/$name"
  done < <(find "$root" -mindepth 1 -maxdepth 1 ! -name "$TICINO_TREE_FANOUT_DIR" -print0)
}

# ticino_tree_unfanout_stage <section> <section-root>
#
# Rehydrate the physical Pages representation back to the canonical dist tree.
# Tar artifacts are made from the canonical build and do not need this; the
# clone fallback in rehydrate-section-shards.sh does.
ticino_tree_unfanout_stage() {
  local section_name="$1"
  local root="$2"
  local fanout_root bucket src name

  [ "$section_name" = ticino ] || return 0
  fanout_root="$root/$TICINO_TREE_FANOUT_DIR"
  [ -d "$fanout_root" ] || return 0

  while IFS= read -r -d '' bucket; do
    while IFS= read -r -d '' src; do
      name="${src##*/}"
      if [ -e "$root/$name" ]; then
        echo "::error::Ticino unfan-out would overwrite an existing entry: $root/$name" >&2
        return 1
      fi
      mv "$src" "$root/$name"
    done < <(find "$bucket" -mindepth 1 -maxdepth 1 -print0)
    rmdir "$bucket" || return 1
  done < <(find "$fanout_root" -mindepth 1 -maxdepth 1 -type d -print0)
  rmdir "$fanout_root" || return 1
}
