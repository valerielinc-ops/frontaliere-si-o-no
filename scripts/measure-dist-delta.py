#!/usr/bin/env python3
"""Measure the real per-deploy delta between two GitHub Pages artifacts.

Each artifact is the whole site as a single uncompressed tar (`artifact.tar`,
~1.4GB — deploy.yml builds it with `tar -cf`, as upload-pages-artifact expects).
We stream-hash every member WITHOUT extracting to disk, build a per-file
manifest (path -> sha1,size) for each build, then diff them to answer:

  - how many files / bytes would an incremental sync actually PUSH per deploy
  - which top-level directories churn the most

CI-only measurement tool. Uses python3 stdlib only (tarfile) — zero deps. The
real win is streaming each member's bytes without extracting the whole tree to
disk (~14GB/build); `r:*` transparently handles gzip too if that ever changes.

Usage:
  measure-dist-delta.py <olderArtifact.tar> <newerArtifact.tar> <report.md>
"""
import sys
import tarfile
import hashlib
import difflib


def manifest(path):
    """Stream every regular file in the tar -> {name: (sha1, size)}."""
    out = {}
    # r:* auto-detects gzip/plain
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile():
                continue
            name = m.name
            if name.startswith("./"):
                name = name[2:]
            f = tf.extractfile(m)
            if f is None:
                continue
            h = hashlib.sha1()
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
            out[name] = (h.hexdigest(), m.size)
    return out


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


def topdir(name, depth=2):
    parts = name.split("/")
    if len(parts) <= depth:
        return parts[0] if parts else "(root)"
    return "/".join(parts[:depth])


def extract_members(path, names):
    """One streaming pass: return {name: bytes} for the requested members."""
    want = set(names)
    out = {}
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if not m.isfile():
                continue
            nm = m.name[2:] if m.name.startswith("./") else m.name
            if nm in want:
                f = tf.extractfile(m)
                if f is not None:
                    out[nm] = f.read()
                if len(out) == len(want):
                    break
    return out


def fragment_diffs(a_text, b_text, max_frags=6, ctx=45):
    """Return the differing fragments (old -> new) with a little context.
    HTML pages are usually one long line, so a line diff is useless — we diff
    the raw character stream and report each changed span."""
    sm = difflib.SequenceMatcher(None, a_text, b_text, autojunk=False)
    frags = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        old = a_text[max(0, i1 - ctx):i2 + ctx]
        new = b_text[max(0, j1 - ctx):j2 + ctx]
        frags.append((old.replace("\n", "⏎"), new.replace("\n", "⏎")))
        if len(frags) >= max_frags:
            break
    return frags


def pick_samples(changed, B, per_dir=2, max_total=12):
    """Spread sample changed files across the top churn directories."""
    by_dir = {}
    for k in changed:
        by_dir.setdefault(topdir(k), []).append(k)
    ranked = sorted(by_dir.items(),
                    key=lambda kv: sum(B[x][1] for x in kv[1]), reverse=True)
    out = []
    for _, files in ranked:
        for k in sorted(files)[:per_dir]:
            out.append(k)
            if len(out) >= max_total:
                return out
    return out


def main():
    a_path, b_path, report_path = sys.argv[1], sys.argv[2], sys.argv[3]
    n_samples = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    print(f"[delta] hashing OLDER: {a_path}", flush=True)
    A = manifest(a_path)
    print(f"[delta] hashing NEWER: {b_path}", flush=True)
    B = manifest(b_path)

    a_keys, b_keys = set(A), set(B)
    added = b_keys - a_keys
    removed = a_keys - b_keys
    common = a_keys & b_keys
    changed = {k for k in common if A[k][0] != B[k][0]}
    unchanged = common - changed

    total_b_bytes = sum(sz for _, sz in B.values())
    # bytes an incremental sync would upload = new + changed files (their NEW size)
    push_files = added | changed
    push_bytes = sum(B[k][1] for k in push_files)
    delete_count = len(removed)

    nb = len(b_keys)
    pct = lambda n: (n / nb * 100) if nb else 0.0
    pct_count = pct(len(push_files))
    pct_bytes = (push_bytes / total_b_bytes * 100) if total_b_bytes else 0.0

    # churn breakdown by top dir (added+changed)
    bucket = {}
    for k in push_files:
        d = topdir(k)
        c, by = bucket.get(d, (0, 0))
        bucket[d] = (c + 1, by + B[k][1])
    top = sorted(bucket.items(), key=lambda kv: kv[1][1], reverse=True)[:25]

    lines = []
    lines.append("# Deploy delta measurement\n")
    lines.append(f"- **Older build:** `{a_path}` — {len(A):,} files\n")
    lines.append(f"- **Newer build:** `{b_path}` — {len(B):,} files, {human(total_b_bytes)} total (uncompressed)\n")
    lines.append("\n## What an incremental sync would push this deploy\n")
    lines.append("| metric | count | % of site |\n|---|--:|--:|\n")
    lines.append(f"| changed files | {len(changed):,} | {pct(len(changed)):.2f}% |\n")
    lines.append(f"| added files | {len(added):,} | {pct(len(added)):.2f}% |\n")
    lines.append(f"| **push (changed+added)** | **{len(push_files):,}** | **{pct_count:.2f}%** |\n")
    lines.append(f"| deleted files | {delete_count:,} | — |\n")
    lines.append(f"| unchanged (skipped) | {len(unchanged):,} | {pct(len(unchanged)):.2f}% |\n")
    lines.append("\n")
    lines.append(f"- **Upload bytes (delta):** {human(push_bytes)} of {human(total_b_bytes)} = **{pct_bytes:.2f}%**\n")
    lines.append(f"- vs GitHub Pages today: re-uploads/re-publishes **100%** every deploy.\n")
    lines.append("\n## Churn by directory (changed+added, top 25 by bytes)\n")
    lines.append("| dir | files | bytes |\n|---|--:|--:|\n")
    for d, (c, by) in top:
        lines.append(f"| `{d}` | {c:,} | {human(by)} |\n")

    if n_samples > 0 and changed:
        samples = pick_samples(changed, B, max_total=n_samples)
        print(f"[delta] extracting {len(samples)} sample changed files for diff...", flush=True)
        a_bytes = extract_members(a_path, samples)
        b_bytes = extract_members(b_path, samples)
        lines.append("\n## Sample diffs of changed files (what actually churns)\n")
        for nm in samples:
            if nm not in a_bytes or nm not in b_bytes:
                continue
            at = a_bytes[nm].decode("utf-8", "replace")
            bt = b_bytes[nm].decode("utf-8", "replace")
            frags = fragment_diffs(at, bt)
            lines.append(f"\n### `{nm}`\n")
            lines.append(f"_{len(at):,}B → {len(bt):,}B, {len(frags)}+ changed fragment(s)_\n\n")
            for old, new in frags:
                lines.append("```diff\n")
                lines.append(f"- {old}\n")
                lines.append(f"+ {new}\n")
                lines.append("```\n")

    report = "".join(lines)
    with open(report_path, "w") as f:
        f.write(report)
    print(report)
    print(f"[delta] SUMMARY: push {len(push_files):,} files ({pct_count:.2f}%), "
          f"{human(push_bytes)} ({pct_bytes:.2f}%); deleted {delete_count:,}")


if __name__ == "__main__":
    main()
