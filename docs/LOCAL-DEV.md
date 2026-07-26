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
