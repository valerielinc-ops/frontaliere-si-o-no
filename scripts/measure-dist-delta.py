#!/usr/bin/env python3
"""Measure the real per-deploy delta between two GitHub Pages artifacts.

Each artifact is the whole site as a single gzip'd tar (`artifact.tar`, ~1.4GB).
We stream-hash every member WITHOUT extracting to disk, build a per-file
manifest (path -> sha1,size) for each build, then diff them to answer:

  - how many files / bytes would an incremental sync actually PUSH per deploy
  - which top-level directories churn the most

CI-only measurement tool. Uses python3 stdlib only (tarfile) — zero deps, and
tarfile streams gzip members natively, which node lacks built-in.

Usage:
  measure-dist-delta.py <olderArtifact.tar> <newerArtifact.tar> <report.md>
"""
import sys
import tarfile
import hashlib


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


def main():
    a_path, b_path, report_path = sys.argv[1], sys.argv[2], sys.argv[3]
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

    pct_count = (len(push_files) / len(b_keys) * 100) if b_keys else 0
    pct_bytes = (push_bytes / total_b_bytes * 100) if total_b_bytes else 0

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
    lines.append(f"| changed files | {len(changed):,} | {len(changed)/len(b_keys)*100:.2f}% |\n")
    lines.append(f"| added files | {len(added):,} | {len(added)/len(b_keys)*100:.2f}% |\n")
    lines.append(f"| **push (changed+added)** | **{len(push_files):,}** | **{pct_count:.2f}%** |\n")
    lines.append(f"| deleted files | {delete_count:,} | — |\n")
    lines.append(f"| unchanged (skipped) | {len(unchanged):,} | {len(unchanged)/len(b_keys)*100:.2f}% |\n")
    lines.append("\n")
    lines.append(f"- **Upload bytes (delta):** {human(push_bytes)} of {human(total_b_bytes)} = **{pct_bytes:.2f}%**\n")
    lines.append(f"- vs GitHub Pages today: re-uploads/re-publishes **100%** every deploy.\n")
    lines.append("\n## Churn by directory (changed+added, top 25 by bytes)\n")
    lines.append("| dir | files | bytes |\n|---|--:|--:|\n")
    for d, (c, by) in top:
        lines.append(f"| `{d}` | {c:,} | {human(by)} |\n")

    report = "".join(lines)
    with open(report_path, "w") as f:
        f.write(report)
    print(report)
    print(f"[delta] SUMMARY: push {len(push_files):,} files ({pct_count:.2f}%), "
          f"{human(push_bytes)} ({pct_bytes:.2f}%); deleted {delete_count:,}")


if __name__ == "__main__":
    main()
