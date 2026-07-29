# Article generation — the learning loop

How the article pipeline is supposed to get better at not repeating its own
mistakes, and — the harder half — how it is stopped from getting worse at it.

Related: `docs/CRAWLERS.md`, `docs/SEO-GATES.md`,
`scripts/lib/article-factuality-gates.mjs`, `scripts/lib/article-defect-memory.mjs`.

---

## 1. Why

`generate-article.yml` runs every 30 minutes (~48 runs/day). Every one of them
is amnesic. A defect committed at run N does not make the same defect less
likely at run N+1, because everything the run learned about itself — which
draft was rejected, by which gate, over what text — is written to a CI log that
is unqueryable within days and gone within ninety.

The only standing defences are static: the 169-entry allowlist and 10-entry
denylist of institution acronyms in `article-factuality-gates.mjs`, and the
`VERIFIED_DOMAIN_FACTS` / `EVERGREEN_FACTS_BRIEF` blocks in
`create-article.mjs`. Each of them exists because a person typed it after an
incident. `UFI` is on the denylist because the owner added it by hand on
2026-07-28 after finding it in a shipped article; the other 55 invented
acronyms in the corpus were found by an agent checking them one at a time. That
work is real, expensive, and currently evaporates the moment the investigation
that produced it ends.

The deterministic audit over the 3574 published articles measured what the
amnesia costs:

| Defect class | Articles affected | Learnable? |
|---|---|---|
| Fabricated institutions (56 distinct invented acronyms) | 52 | **yes — binary, checkable** |
| Truncated text / leaked prompt scaffolding | 41 | partly (already gated) |
| Fabricated arithmetic, invented laws, contradictory dates | scattered | already gated deterministically |
| Wholly fabricated article (`bossi-commemorazione-bagarrata`) | 1 | no — needs source fidelity, already gated |

Fabricated institutions are both the most frequent class and the only one whose
truth value is binary: an entity either exists or it does not. That is why the
first implemented link of the loop targets it.

### 1.1 The precedent that shapes every design decision here

This repo has already shipped an article feedback loop, and it degenerated.

`llmFactCheck` reinjects its own issues into the regeneration prompt as
corrective instructions. The prompt told the verifier that "a false positive is
preferable to a false negative". On run 30350429920 the FIRST draft was
faithful — it opened with the source's literal opening sentence — and both
verifier models flagged that sentence as "not present in the source". Six
iterations later the surviving draft no longer discussed the source at all, and
passed, having invented an institution (UFI), a statistic (2000 workers) and
two contradictory decree dates.

The loop did not fail to select. It selected correctly, for the wrong
objective: it converged on the artefact that satisfied the measurer rather than
the one that matched reality, because the measurer's output was fed back as
ground truth. Two lessons are load-bearing for everything below.

1. **A mis-specified feedback loop is not neutral. It is actively harmful.**
   The pipeline would have been strictly better off with no loop at all.
2. **A system must never treat its own verdicts as evidence about the world.**
   Learning requires an oracle the learner cannot influence.

---

## 2. Signal inventory: what each run produces, and what survives

| Signal | Produced by | Where it goes today | Survives? |
|---|---|---|---|
| Deterministic gate issues (code, severity, evidence, fix) | `runFactualityGates` | stderr | **no** |
| Which gate rejected which attempt, and how many attempts it cost | retry loop | stderr | **no** |
| LLM fact-check verdicts (category, claim, reason), per model | `llmFactCheck` | stderr | **no** |
| Consensus issues dropped as source-contradicted | `dropSourceContradictedIssues` | stderr | **no** |
| Institution acronyms the article introduced | (did not exist) | — | **no** |
| Whether the run's own source backed those acronyms up | (did not exist) | — | **no** |
| Headlines dropped pre-generation, with reason | `RUN_REPORT.discardedHeadlineSamples` | `.tmp/…json` (gitignored) → step summary | **no** |
| Duplicate-rejection reason breakdown | `RUN_REPORT.duplicateReasonBreakdown` | same | **no** |
| Source scan success/failure by domain | `RUN_REPORT.sources` | same | **no** |
| Used source URLs, consumed topics, evergreen rejects | `data/article-source-urls.json`, `data/topic-candidates-*.json` | committed to `main` | **yes** |

The last row is the important one: the pipeline already knows how to keep
cross-run state, and does it in several places, with FIFO caps and TTLs
(`article-source-urls.json` keeps the last 500; `topic-candidates-consumed.json`
caps at 500 ids; `quota-state.json` caps history at 100). Every one of those
files is about *what has been done*. None of them is about *what went wrong*.

`RUN_REPORT` is the natural hook: it is already assembled during the run,
already written to a file, already rendered into the job summary. It just
terminates in `.tmp/`, which is gitignored.

---

## 3. What is persisted, in what shape, where

**Principle: persist observations, not verdicts.** The run records what it saw;
the promotion policy — evidence bars, decay, caps — lives in exactly one place
and runs after the fact. A generator that could write verdicts straight into its
own defences would be grading its own homework, which is precisely the 2026-07-28
failure.

### 3.1 Per-run feed — `RUN_REPORT.factuality` (ephemeral, by design)

```jsonc
"factuality": {
  "institutionObservations": [        // capped at 60/run
    { "acronym": "UFI", "name": "Ufficio federale delle imposte",
      "support": "absent", "attempt": 3 }
  ],
  "gateRejectionsByCode": { "tax-exceeds-income": 2, "fabricated-institution": 1 }
}
```

`support` is the whole point and takes exactly three values:

- `present` — the run's source text names the entity (literally, or spells the
  name out with ≥60% of its distinctive tokens surviving `tokenizeIt`).
- `absent` — a usable source (≥400 chars) exists and does not name it.
- `unknown` — there is no source to check against: the evergreen path, or a
  retro-scan of published bodies whose source pages were never retained.

### 3.2 Durable store — `data/article-defect-memory.json`

Shape follows the repo's established `schemaVersion` + envelope convention
(`data/fb-posted-articles.json`, `data/quota-state.json`), written through the
existing `writeJsonAtomic` helper, keys sorted so a one-entity change produces a
one-entity diff.

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-29T06:26:58.011Z",
  "entities": {
    "UFID": {
      "status": "confirmed",              // suspect | confirmed | cleared
      "statusSource": "human",            // human | auto
      "statusAt": "…", "firstSeen": "…", "lastSeen": "…",
      "seen": 3,                          // PREVALENCE  — every emission
      "unsupportedSightings": 0,          // EVIDENCE    — once per (run, article)
      "unsupportedRuns": [],              // EVIDENCE    — distinct runs
      "supportedSightings": 0,            // COUNTER-EVIDENCE
      "names": ["Ufficio federale delle imposte dirette"],
      "recentKeys": [], "evidence": [ /* capped 8, for human review */ ],
      "note": "…verified by hand during the 2026-07-28 investigation"
    }
  }
}
```

Single producer (`generate-article.yml`, `concurrency: article-generation`,
`cancel-in-progress: false`), so no merge driver is needed in `.gitattributes`
— unlike `data/url-first-seen.json` or the 404-compat shards, this file has no
concurrent writers. If a second producer is ever added, it needs one; the
existing `merge=json-first-seen` driver is the model.

Seeded from the corpus: 224 entities, 153 under watch, 67 auto-cleared by the
allowlist, 4 human-confirmed, **0 auto-promoted to blocking**.

### 3.3 Not yet persisted (see §7)

Gate rejection counts, LLM verdict categories and retry costs are collected into
the run report but not yet accumulated into a history file. That is the second
link, and it is a JSONL append with `merge=union` — the pattern
`data/quality-alerts-history.jsonl` already uses.

---

## 4. From signal to defence

### 4.1 Denylist enrichment — IMPLEMENTED

Three tiers, in descending order of confidence *and of consequence*:

| Tier | Source | Gate severity | Cost of being wrong |
|---|---|---|---|
| curated denylist | human | `critical`, blocks | a correct article is blocked |
| learned `confirmed` | evidence bar + policy | `critical`, blocks | a correct article is blocked |
| learned `suspect` | any prevalence | `major`, reported | a warning line and a prompt hint |

Everything the learner is unsure about lives in the third tier, where being
wrong is nearly free. That is what makes automatic learning affordable at all.

**The oracle.** Promotion is driven by one thing only: the run's own source text
failing to back the entity up. The source is *fetched*, not written by the model
under judgement, so it is external to the loop. Frequency is explicitly *not*
evidence — it measures how often the generator emits a token, never whether the
entity exists. USTRA, EOC and DECS are real and frequent. A frequency-triggered
denylist would block correct articles, and because a blocked article is never
published, the system could never observe the counter-evidence that would clear
its own mistake. That is a self-sealing error, and it is why the corpus scan —
which has no sources — is *structurally incapable* of promoting anything.

### 4.2 Negative few-shots in the generation prompt — PLANNED

The store already holds, per entity, the expanded names the generator invented
("Ufficio federale delle questioni giuridiche (UQJ)", "Agenzia dell'Ambiente
della Svizzera Italiana (AASTI)"). Those are real rejected outputs, which makes
them far better negative examples than anything hand-written. Injecting the top
N `suspect`/`confirmed` names as a short "do not invent institutions like these"
block costs zero extra model calls — it rides the prompt that is being sent
anyway.

Held back deliberately: prompt changes are the highest-variance edit in this
pipeline, and this document's first job is to make the *memory* trustworthy. See
§7 for the ordering argument.

### 4.3 Threshold tuning from data — PLANNED

`checkTaxPlausibility`'s `implausibleRatio: 0.6`, `checkSourceFidelity`'s
`minRecall: 0.5`, `MAJOR_BLOCK_WEIGHT_THRESHOLD: 3.0` are all eyeballed. With
per-code rejection counts accumulating (§3.3), each becomes answerable from
data: a threshold whose code fires constantly while publication rate falls is
too tight; one that never fires is decoration. This must stay a *reported
recommendation*, never an automatic adjustment — a loop allowed to move its own
thresholds to raise its own pass rate is the 2026-07-28 loop with extra steps.

### 4.4 Emergent fabrication patterns — PLANNED

Beyond acronyms: invented law names ("legge federale sulla retribuzione dei
lavoratori frontalieri (LRF)"), invented statistics attributed to real bodies,
quotes attributed to real people. The same two-axis machinery applies; the
extraction differs. Acronyms first because they are the cleanest to extract and
the most frequent.

---

## 5. Loop stability

This is the section that matters. The previous loop degenerated; this one has to
demonstrate it cannot. Each failure mode below is paired with the mechanism that
forecloses it and the test that pins the mechanism.

### 5.1 Measurement capture (Goodhart) — the 2026-07-28 failure

*The system optimises against its own measurement instead of the objective.*

The learner never consumes a model's verdict. It consumes one thing: whether a
*fetched source document* contains a string. `llmFactCheck` output does not
enter the store at all. The corpus is not an oracle either — judging the
generator's output by the generator's other output is the same circularity at a
slower clock — so corpus-scan observations are recorded as `unknown` and can
raise review priority but never confirm anything.
→ `refuses to judge without a usable source instead of assuming fabrication`,
`is unchanged when called without a memory (corpus retro-audit path)`

### 5.2 A false positive that can never be cleared

*The most dangerous failure specific to a blocking defence.* If a wrongly
confirmed entity blocks every article that mentions it, no such article is ever
published, so no evidence contradicting the block can ever arrive through the
publication path. The error seals itself in.

Three mechanisms keep the exit open:

1. **Clearing evidence arrives on an independent channel.** Observations are
   recorded on *every generation attempt*, including attempts the gates go on to
   reject. A blocked draft still reports that its source named the entity. The
   evidence channel does not pass through publication, so blocking cannot
   silence it.
2. **Clearing is absorbing and instantaneous.** One `present` sighting outranks
   any quantity of `absent` sightings, permanently, and clearing evidence is
   never decayed.
3. **Asymmetric burden.** Blocking needs 3 sightings across 2 distinct runs.
   Un-blocking needs 1 sighting. A false positive costs one more article
   mentioning the entity; a false negative costs one more sighting.

→ `clears an entity the moment one real source names it, whatever the pile
against it`, `does NOT decay clearing evidence`

### 5.3 A single bad run confirming its own hallucination

*The retry loop regenerates up to 6 times, and the same invented acronym comes
back every time.*

Two redundant guards. Evidence is deduplicated on `(runId, articleId)` before it
counts, so six retries are one observation; and the bar requires ≥2 **distinct
runs**, so no single run can satisfy it however many articles it produces.
→ `does not let one run manufacture evidence by repeating itself`,
`does NOT promote on sightings alone when they all come from one run`

### 5.4 The ratchet — defences that only ever tighten

*Issue #2947: the evergreen path produced ~0 articles/run because the gates were
too tight.* A learner that can only add blocks is a ratchet, and a ratchet on a
content pipeline eventually stops the pipeline.

Four brakes:

- **Decay.** A `suspect` nobody has emitted for 90 days is forgotten entirely.
- **Amnesty with halving.** An auto-confirmed entity idle for 180 days is
  demoted to `suspect` *and its blocking evidence is halved* — not reset
  (what was observed did happen) and not preserved (then re-blocking would need
  one sighting and the amnesty would be decorative). Re-blocking requires fresh
  evidence.
- **Hard cap with refusal.** At 120 auto-confirmed entities, promotion stops and
  says so. It does not silently keep tightening. The corpus contained 56 invented
  acronyms across 3574 articles; reaching 120 means the classifier is wrong, not
  that the generator got twice as inventive.
- **Population cap.** Above 600 entities the lowest-prevalence *suspects* are
  evicted first. `confirmed`, `cleared` and human verdicts are never evicted —
  losing a clearance would let a false positive return.

→ `amnesties a stale auto-confirmation and HALVES its blocking evidence`,
`makes re-blocking after amnesty require FRESH evidence`, `refuses to promote
past the cap and says so instead of silently blocking more`, `evicts the
least-prevalent suspects … never a clearance`

### 5.5 The oracle itself breaking

*The failure mode that is invisible from inside the store.* If source extraction
degrades — a fetch returning a cookie wall, a paywall stub, an encoding change —
then every acronym in every article reads as `absent` simultaneously, and the
evidence bar is met *legitimately and at once* for a dozen real institutions.

The two explanations are not equally likely: **hallucination rates drift, they
do not step.** So a burst is treated as evidence about the oracle, not about the
entities. If a single policy application would promote more than 5 entities, the
entire batch is refused and the warning names source extraction as the first
thing to check. Clearings still go through during a burst — a broken oracle can
suppress support but cannot manufacture it, and holding clearings back would
trap false positives for no safety gain.
→ `holds the whole batch when too many entities qualify at once`, `still lets
clearings through during a promotion burst`

### 5.6 Human authority

Curated lists and explicit human verdicts outrank the learner unconditionally
and in both directions. An allowlisted acronym can never be promoted, however
much evidence accumulates (belt and braces: both `evaluateEntity` and
`checkFabricatedInstitutionAcronyms` enforce it independently). A
`statusSource: 'human'` entry is never touched by the automatic path. There is
no configuration under which the machine overrules the person.
→ `never promotes an acronym on the curated allowlist`, `never overrides a human
verdict`, `lets the curated allowlist win over a learned confirmation`

### 5.7 Silent fail-open

A defence that cannot be evaluated must say so, loudly. An unreadable or corrupt
store yields an *empty* memory plus a `degraded` reason — never a half-parsed
one — and that reason is surfaced three times: a `🚨` line in the generation
log, a `minor` `defect-memory-unavailable` issue in the gate output, and a
refusal to `--apply` (which would otherwise overwrite the store with an empty
one and destroy every confirmation ever learned). An unknown `schemaVersion` is
refused rather than guessed at. A missing file, by contrast, is *not*
degradation — it is the cold-start state, and the loop must run from empty on
day one.
→ `reports invalid JSON and returns an empty store`, `refuses an unknown schema
version`, `says loudly when the memory could not be read, without blocking on
it`, `drops a single malformed entry without blinding the whole store`

### 5.8 Cost

Zero model calls, zero network. Every operation is a comparison over strings
already in memory: a regex over the article, a token-containment check against
the source, integer counters. Nothing here touches the shared Max quota, and
nothing here can fail open because "the verifier was down". The store adds one
file read per run and one conditional write; the write is skipped when nothing
changed, so the 30-minute cadence does not put ~48 no-op diffs a day into `main`.

---

## 6. Is the loop working?

Four questions, and what answers them.

**Is the defence catching things?** `RUN_REPORT.factuality.gateRejectionsByCode`
— rejections per gate code per run. A healthy learned defence shows
`fabricated-institution` rejections rising as entities are confirmed, then
falling as the generator stops emitting them.

**Is the same class of error recurring?** Recidivism = confirmed entities with a
`lastSeen` newer than their `statusAt`, i.e. the generator still emitting what it
has already been blocked for. Persistent recidivism means the block is
suppressing publication without changing behaviour, and the fix belongs in the
prompt (§4.2), not in more blocking.

**Is the loop costing more than it saves?** Attempts per published article, and
the share of attempts rejected by learned (as opposed to curated) rules. A
learned rule that pushes mean attempts up without a matching fall in shipped
defects is a false-positive machine.

**Is the learner itself healthy?** `memoryHealth()` — `autoConfirmed` against
the cap, `nearCapacity`, and the `oracleSuspect` / `saturated` flags. Both
saturation flags exit non-zero under `--health --strict`, which is meant for a
separate health check that can go red *without* taking content generation down
with it.

Baseline at seeding (2026-07-29): 224 entities, 153 suspect, 4 confirmed (all
human), 67 cleared, 0 auto-confirmed.

---

## 7. Status and plan

**Implemented.**
- `scripts/lib/article-defect-memory.mjs` — store, policy, decay, caps, health.
- `article-factuality-gates.mjs` — `collectInstitutionAcronyms()` emits
  observations with the support verdict; `checkFabricatedInstitutionAcronyms()`
  gains the learned tiers and the degradation notice; `runFactualityGates()`
  threads memory in and observations out. Called without a memory it behaves
  byte-identically to before, which is what keeps the corpus retro-audit honest
  and makes the change revertible by deleting one argument.
- `create-article.mjs` — reads the memory once per run, collects observations
  into `RUN_REPORT`, counts gate rejections by code. Read-only.
- `scripts/update-article-defect-memory.mjs` — ingest, policy, review queue,
  human `--confirm`/`--clear`. Dry-run by default.
- `generate-article.yml` — the fold step, `always()` + `continue-on-error`.
- `data/article-defect-memory.json` — seeded from the corpus.
- 41 tests; every promotion paired with the near-miss that must not promote.

**Next, in order.**

1. **Rejection history** (`data/article-defect-history.jsonl`, `merge=union`) —
   append one row per run: codes that rejected, attempts spent, published or
   not. Unlocks every metric in §6 as a time series rather than a snapshot.
2. **Negative few-shots** (§4.2) — after (1), because (1) is what will show
   whether the prompt block reduced emissions or merely moved them.
3. **Threshold recommendations** (§4.3) — reported, never auto-applied.
4. **Beyond acronyms** (§4.4) — invented norms first; they are the second most
   frequent fabricated-entity class.

**Deliberately not done.**

- *Auto-tuning the promotion policy from its own outcomes.* A loop that can move
  its own evidence bar to change its own promotion rate is the 2026-07-28 loop.
  The thresholds are constants in one place, changed by people.
- *Using the LLM verifier's verdicts as learning signal.* They are opinions
  about the world produced by the same class of system being judged. The source
  text is the only oracle admitted.
- *Auto-promoting on prevalence.* See §4.1.

---

## 8. Operating it

```bash
# What does the loop want a human to adjudicate? (dry run, safe)
node scripts/update-article-defect-memory.mjs --review

# Adjudicate. --reason is not optional in practice: without it the next
# review has no idea why the entity was pinned.
node scripts/update-article-defect-memory.mjs --confirm UQJ \
  --reason "no such federal office; legal questions sit with the UFG/BJ" --apply
node scripts/update-article-defect-memory.mjs --clear UFAC \
  --reason "real — Ufficio federale dell'aviazione civile, FOCA/BAZL" --apply

# Refresh prevalence from the published corpus (cannot promote anything).
node scripts/update-article-defect-memory.mjs --from-corpus --apply

# Health check for a separate monitor; red here must not stop generation.
node scripts/update-article-defect-memory.mjs --health --strict
```

**When an article is wrongly blocked by a learned entity.** Clear it
(`--clear <ACR> --reason …`), which pins it as a human verdict the learner can
never override. Do **not** raise `maxAutoConfirmed`, lower the evidence bar, or
delete the store: the entity is wrong, the policy is not, and the policy
constants are the one thing in this design that must not move to make a symptom
go away.
