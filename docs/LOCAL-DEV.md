# Local dev hygiene

Things that make working on this repo locally less noisy. Per-machine
conveniences only — none of this affects CI, deploy, or other developers.

---

## Hide cron-generated diffs from `git status`

### The problem

~30 GitHub Actions cron workflows commit ~600 generated files: job-crawler
output, fuel-price snapshots, health-premium tables, GSC orphan-query
clusters, weekly-employers deltas, border-wait history, etc.

Every `git pull` brings new cron diffs into your working tree. Every local
run of a crawler script (e.g. `node scripts/update-hes-so-valais-jobs.mjs`)
rewrites the same files. Result: `git status` is a wall of unrelated
changes, `git add -A` becomes dangerous, and reviewing your own diff means
visually filtering out cron noise on every commit.

These files **cannot be `.gitignore`d** — they are tracked, and CI relies on
them being present in the repo.

### The fix

`scripts/dev/local-ignore-cron.sh` flips
[`git update-index --skip-worktree`](https://git-scm.com/docs/git-update-index#_skip_worktree_bit)
on each cron-managed file. That tells git to pretend your local copy is
unchanged. State lives in `.git/info/`, so it's per-clone — invisible to
remote, CI, and other contributors.

```bash
scripts/dev/local-ignore-cron.sh apply     # mark all cron paths skip-worktree
scripts/dev/local-ignore-cron.sh status    # show which paths are currently skipped
scripts/dev/local-ignore-cron.sh unapply   # restore normal git behavior
scripts/dev/local-ignore-cron.sh pull      # un-skip → stash dirty → pull --rebase → unstash → re-skip
```

Run `apply` once after cloning. From then on, `git status` only shows your
real work.

### Important: don't use plain `git pull`

When `--skip-worktree` is active and the remote updates one of those files
(which happens on almost every pull, because cron commits land on `main`
constantly), plain `git pull` fails with:

```
error: Your local changes to the following files would be overwritten by merge
```

**Always use `scripts/dev/local-ignore-cron.sh pull`** instead of `git pull`.
The wrapper handles the un-skip → stash → rebase → pop → re-skip dance for
you. If you'd rather not memorize that, alias it:

```bash
# ~/.zshrc — only when working in this repo
alias gpull="scripts/dev/local-ignore-cron.sh pull"
```

### Adding more paths

Edit the `PATHS` array in `scripts/dev/local-ignore-cron.sh` when a new
cron workflow lands that commits generated files, then run `apply` again.
The script is idempotent — re-applying is safe.

Globs (`data/jobs/by-crawler/*`) are expanded via `git ls-files`, so
directories pick up new files automatically without touching the script.

### Undoing it

`scripts/dev/local-ignore-cron.sh unapply` restores normal git behavior on
every previously-skipped file. Use this if you actually want to edit one of
the cron-managed files (rare — usually those edits should come from the
script that owns the file, not from manual editing).

### Why not a sparse checkout / partial clone?

Both work for *not having* the files, but we need them locally — `npm test`
loads `data/all-known-job-slugs.json`, the Vite build reads
`data/health-premiums.json`, etc. `--skip-worktree` is the right tool: keep
the files, hide the noise.

## Syncing a stale+dirty local `main` (explicit user request only)

Only run this when the user explicitly asks to sync a stale/dirty local
`main` — otherwise never touch it (see AGENTS.md, local `main` is
shared/read-only and any dirty files on it are foreign work-in-progress).

1. `git stash push -u` — backs up the foreign dirty work instead of
   discarding it.
2. `git reset --hard origin/main`.
3. If step 2 fails with `Entry '...' not uptodate` but `git status` reports
   clean — that's a racy index (repo has ~19k tracked files, a known
   false-positive pattern at this scale). Canonical fix:
   `rm -f .git/index && git reset --hard HEAD`.

Never commit the dirty state you find on `main` — it isn't yours.

## `git push` timeout / huge pack for a tiny diff

Symptom: `git rev-list --objects origin/main..HEAD` shows only a handful of
objects the branch actually needs, but the push transfers hundreds of MB
and stalls (`RPC failed; curl 28 Operation too slow`). This is **not** a
network problem — the local repo is unmaintained.

1. Diagnose: `git count-objects -vH` (a high `prune-packable` count means
   disjoint packs) and `git multi-pack-index write --bitmap` (fails with
   `Packfile doesn't have full closure` when a pack has cross-pack delta
   references that never got closed by a repack).
2. Fix: `git repack -a -d -b` (needs roughly 2× the current pack size in
   free disk headroom), then `git maintenance start` so it doesn't
   recur.
3. The object store is shared by every worktree of this clone
   (`git worktree add` points at the same `.git`) — one repack fixes it
   for all of them.

Why this happens and how it was found: `docs/AGENTS-HISTORY.md#git-repo-maintenance`.

### Variant: `garbage` from aborted fetches (not `prune-packable`)

Same fetch/push slowness, different line in `git count-objects -vH`:

```
packs: 125          size-pack: 15.77 GiB
garbage: 89         size-garbage: 38.81 GiB   <-- this one
```

`garbage` counts `.git/objects/pack/tmp_pack_*` — the temp pack a `git fetch`
writes while transferring. A fetch that is **killed or dies mid-transfer**
leaves its temp pack behind, and **no git command ever reclaims it**: not
`gc`, not `maintenance`, not `prune`. They only accumulate.

1. Confirm nothing is fetching right now
   (`ps -Ao pid,etime,command | grep '[g]it fetch'`), then delete them:
   `rm -f .git/objects/pack/tmp_pack_*`. A live fetch keeps writing, so its
   temp pack has a fresh mtime — never delete one under an hour old.
2. Then consolidate. If free disk is less than ~2× the pack total,
   `git repack -a -d -b` will not fit; use geometric repacking instead — it
   coalesces packs in bounded steps and reaches the same end state:
   `git repack --geometric=2 -d --write-midx`.
3. `git maintenance start` must actually be registered — check
   `ls ~/Library/LaunchAgents | grep git` (macOS). `maintenance.repo` present
   in `~/.gitconfig` with **no launchd agent** means maintenance never runs:
   that is how 125 packs accumulate. Also drop `maintenance.repo` entries
   pointing at worktrees that no longer exist.
4. Check for a stale lock while you are here:
   `.git/objects/info/commit-graphs/commit-graph-chain.lock` (or any
   `*.lock`) left by a crashed git process silently disables that
   maintenance task and makes every later run fail with *"Another git
   process seems to be running"*. Delete it once no git process is live.

Measured on this repo (2026-08-17): 38.8 GB of `tmp_pack_*` reclaimed by
step 1, then 126 packs → 1 and `.git` 24 GB → 14 GB by step 2; a `git fetch`
that had been timing out went to **2.9 seconds**.

Root cause of the accumulation — unguarded concurrent fetches from session
hooks: `docs/AGENTS-HISTORY.md#hook-fetch-pileup`.

## `git push` hangs on a shallow clone (thin-pack delta search)

Symptom: `git push` hangs for tens of minutes even on a fresh, small diff
(a handful of files), and each hung `pack-objects` process holds ~1.8-1.9GB
of RSS. This looks like the section above but has a different cause:
`git count-objects -vH` is clean, no disjoint packs.

The distinguishing factor: the clone/checkout is **shallow** (limited
history) — true for every CI checkout (`actions/checkout@v5` default) and
for any local clone made with `--depth`. On a shallow clone,
`git push` runs `pack-objects --thin --shallow`, which tries to build a
thin pack (only the objects the remote doesn't have) against the shallow
boundary. With no full history available locally to negotiate a base
against, it falls back to scanning the delta window across every reachable
object instead of just the new ones. `public/` and `data/` alone are
~3.5GB tracked, so even a 6-file diff triggers a full-tree delta search.

Fix — skip the thin-pack negotiation and push full objects instead (the
diff itself is small, so the extra bytes are cheap; the broken negotiation
was the actual cost):

```bash
git -c pack.window=0 -c pack.threads=1 push --no-thin origin <branch>
```

Measured on the same stuck push in issue #5258: >85 minutes without the
flags, ~1 second with them. `--no-thin` alone does not require
`--no-verify` or `--force` — only add those if you separately need to skip
the pre-push hook or rewrite a branch you solely own.

Why this happens and how it was found: `docs/AGENTS-HISTORY.md#shallow-clone-thin-pack`.

## Sparse worktrees for agent / multiagent sessions

A plain `git worktree add` materializes **all 41'707 tracked files, 6.7GB**
— because `public/images` (14'017 files, 4.4GB) and
`packages/articles/content` (18'012 files) are tracked. Run four agents in
parallel and that is ~27GB of duplicated checkout for work that usually
touches `scripts/` and `build-plugins/`. Note this is a **checkout** cost, not a history cost:
every worktree already shares the one `.git` object store.

Sparse checkout removes it. Same branch, same index, same commits and pushes —
only the working-tree files you asked for land on disk. One command:

```bash
scripts/dev/fast-worktree.sh <name> [--base origin/main] [--add <path>]...
```

Measured 2026-08-19: **214MB / 6'978 files in 2 seconds**, against
6.7GB / 41'707 files for the full worktree — 31× less disk.

The excluded paths come from `scripts/ci/checkout-buckets.json` — the *same*
table the CI workflows exclude (`docs/REPO-WEIGHT-STRATEGY.md#sparse-checkout-in-ci-2026-08-19`).
One source of truth: regenerate that table and both sides follow.

The script **verifies** the result instead of trusting it. A `--no-checkout`
that materialized the whole tree anyway has happened here (2026-08-15, twice),
and without the check you find out from a full disk. It exits non-zero if
`public/images`, `data/jobs` or `packages/articles/content` landed on disk.

By hand, if you need something the script does not cover:

```bash
git worktree add --no-checkout -b <branch> <path> origin/main
cd <path>
printf '/*\n!/public/\n!/data/\n' | git sparse-checkout set --no-cone --stdin
git checkout
```

Use `--no-cone` when you need negations or a single re-included file
(`/data/article-redirects.json` on its own line); cone mode only takes
directory allow-lists.

- `git ls-files` still reports all 40'745 paths: the **index** stays
  complete, so `git commit`/`git push`/`git diff origin/main` behave
  exactly as in a full worktree, and nothing you left out can be
  accidentally deleted in a commit.
- Need a path you skipped? `git sparse-checkout add data/jobs` — additive,
  seconds, no re-clone; never recreate the worktree for this. Tests that read `data/` fixtures need their
  fixture dirs added; when in doubt add the dir rather than debug a
  missing-file error.
- Do **not** reach for `--depth`/`--filter` instead: shallow clones break
  push on this repo (see the section above), and a blobless clone re-fetches
  blobs lazily during `pack-objects`, reintroducing the same stall.

## `git maintenance` can be registered against a path that no longer exists

Symptom: packs pile up, `count-objects -vH` grows a `garbage:` line, and every
`git fetch` is a multi-GB catch-up again — while `~/.gitconfig` still lists a
`maintenance.repo` entry and `launchctl list` shows the three
`org.git-scm.git.*` agents. It looks registered. It is not running *here*.

`git maintenance register` writes an **absolute path**. Move or re-clone the
repo — as in the 2026-08-15 laptop migration, which moved the clone from
`~/Projects/frontaliere-si-o-no` to `~/Projects/frontaliere/frontaliere-si-o-no`
— and the entry keeps pointing at the old location. The hourly agent still
fires, fails with `fatal: not a git repository`, and the real clone gets no
prefetch, no commit-graph, no incremental repack. Measured 2026-08-19 on this
machine: 24 packs, 96.5MB of abandoned `tmp_pack_*`, 406 prune-packable.

The launchd agent's exit status is the tell — the middle column of
`launchctl list | grep git-scm` is `1`, not `0`:

```bash
git config --global --get-all maintenance.repo   # does each path still exist?
launchctl list | grep git-scm                    # middle column: last exit status
git config --global --unset-all maintenance.repo
git -C <the real clone> maintenance register
```

Check this after any move, re-clone, or machine migration. Nothing else
reports it.

## Do not let session hooks fetch concurrently

`scripts/prune-merged-worktrees.mjs` (SessionStart hook) is the only local
hook that touches the network. Its fetch is wrapped in a single-flight lock
(`.git/frontaliere-prune-fetch.lock`, `scripts/lib/single-flight-lock.mjs`)
with a 25-minute timeout, and it sweeps abandoned `tmp_pack_*` on the way out.

The timeout is a **hang guard, not a work budget** — the lock is what prevents
pile-up. Keep it above the slowest catch-up fetch you have measured (~20 min
for 24k commits of arrears) and below `STALE_LOCK_MS`: too short and a
far-behind repo has every recovery attempt killed mid-transfer, staying stale
forever and leaking a temp pack per attempt; above the lock expiry and a second
session declares the still-working holder abandoned. Both invariants are
asserted in `tests/prune-fetch-single-flight.test.ts`.

Any new hook or script that runs unattended and hits the network must reuse
that lock. Unguarded, N sessions produce N concurrent fetches on one `.git`;
they contend, none finishes, and each leaks a multi-GB temp pack — the
`docs/AGENTS-HISTORY.md#hook-fetch-pileup` incident (39GB).
