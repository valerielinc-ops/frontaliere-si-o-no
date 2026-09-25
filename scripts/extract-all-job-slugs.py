#!/usr/bin/env python3
"""Extract all historical job slugs from git history to build the canonical slug registry."""
import subprocess, json, sys, os

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Get all commits that touched jobs.json
result = subprocess.run(['git', 'log', '--all', '--format=%H', '--', 'data/jobs.json'], capture_output=True, text=True)
commits = result.stdout.strip().split('\n')
print(f"Found {len(commits)} commits touching jobs.json")

all_jobs = {}  # slug -> {slugByLocale, title, company}
for i, commit in enumerate(commits):
    try:
        blob = subprocess.run(['git', 'show', f'{commit}:data/jobs.json'], capture_output=True, text=True, timeout=10)
        if blob.returncode != 0:
            continue
        jobs = json.loads(blob.stdout)
        for job in jobs:
            slug = job.get('slug', '')
            if slug and slug not in all_jobs:
                all_jobs[slug] = {
                    'slugByLocale': job.get('slugByLocale', {}),
                    'title': job.get('title', ''),
                    'company': job.get('company', ''),
                }
    except Exception as e:
        continue
    if (i + 1) % 20 == 0:
        print(f"  Processed {i+1}/{len(commits)} commits, found {len(all_jobs)} unique slugs so far")

print(f"\nTotal unique slugs across all history: {len(all_jobs)}")

# Current slugs
with open('data/jobs.json') as f:
    current = json.loads(f.read())
current_slugs = {j['slug'] for j in current if j.get('slug')}
print(f"Current active slugs: {len(current_slugs)}")

expired_slugs = {s for s in all_jobs if s not in current_slugs}
print(f"Expired slugs: {len(expired_slugs)}")

# Build the tracking structure: map of slug -> locale slugs
# This will be used by the build plugin to generate redirect pages
locale_prefixes = {'it': '', 'en': '/en', 'de': '/de', 'fr': '/fr'}
section_by_locale = {'it': 'cerca-lavoro-ticino', 'en': 'find-jobs-ticino', 'de': 'jobs-im-tessin', 'fr': 'trouver-emploi-tessin'} # cathedral-allow: hand-kept Python port of SECTION_LEGACY_TI (no JS import possible) — pinned by tests/job-board-prefix-parity.test.ts

tracking = {}
for slug, info in all_jobs.items():
    locale_slugs = info.get('slugByLocale', {})
    paths = {}
    for locale in ['it', 'en', 'de', 'fr']:
        loc_slug = locale_slugs.get(locale, slug)
        if not loc_slug:
            loc_slug = slug
        prefix = locale_prefixes[locale]
        section = section_by_locale[locale]
        path = f"{prefix}/{section}/{loc_slug}"
        paths[locale] = path
    tracking[slug] = paths

# Write the tracking registry.
#
# The registry is SHARDED under data/all-known-job-slugs/ since issue #4248 (the
# single monolith crossed GitHub's hard 100 MB per-file push limit and wedged
# sync-gsc-orphans for three weeks). scripts/lib/all-known-job-slugs-store.mjs
# owns the shard layout — the deterministic slug->shard hash, the sorted key
# order and the manifest — and is the ONLY writer (AGENTS.md #6). Re-implementing
# that here in Python would be a second, silently-drifting copy, so this script
# hands the finished map over to the store instead.
staging_path = 'data/.all-known-job-slugs.bootstrap.json'
with open(staging_path, 'w') as f:
    json.dump(tracking, f, ensure_ascii=False)

subprocess.run(
    [
        'node',
        '--input-type=module',
        '-e',
        (
            "import fs from 'node:fs';\n"
            "const { writeAllKnownJobSlugs } = await import('./scripts/lib/all-known-job-slugs-store.mjs');\n"
            "const staging = process.argv[1];\n"
            "writeAllKnownJobSlugs(JSON.parse(fs.readFileSync(staging, 'utf8')));\n"
            "fs.rmSync(staging);\n"
        ),
        staging_path,
    ],
    check=True,
)

print(f"\nWrote {len(tracking)} entries to data/all-known-job-slugs/")
print(f"Sample expired entry: {list(expired_slugs)[:3] if expired_slugs else 'none'}")
for s in list(expired_slugs)[:2]:
    print(f"  {s}: {json.dumps(tracking[s], indent=4)}")
