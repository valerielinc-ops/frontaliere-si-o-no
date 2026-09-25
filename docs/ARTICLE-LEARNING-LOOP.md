# Article generation — the learning loop

How the article pipeline is supposed to get better at not repeating its own
mistakes, and — the harder half — how it is stopped from getting worse at it.

Related: `docs/CRAWLERS.md`, `docs/SEO-GATES.md`,
`scripts/lib/article-factuality-gates.mjs`, `scripts/lib/article-defect-memory.mjs`,
`scripts/lib/article-defect-history.mjs`.

Two links are live (§4.1 denylist enrichment, §4.2 rejection ledger); three are
specified and unbuilt (§4.3–§4.5), one of them deliberately so (§4.4). §4.0
gives the ordering rule and §5 the stability argument each link has to satisfy
before it ships.

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

| Signal | Produced by | Where it goes | Survives? |
|---|---|---|---|
| Institution acronyms the article introduced | `collectInstitutionAcronyms` | `data/article-defect-memory.json` | **yes** — L1 |
| Whether the run's own source backed those acronyms up | `collectInstitutionAcronyms` | same | **yes** — L1 |
| Which deterministic gate codes rejected a draft | `runFactualityGates` | `data/article-defect-history.jsonl` | **yes** — L2 |
| How many generation attempts the run spent | retry loop | same | **yes** — L2 |
| Whether the run published, deferred, skipped or errored | `finalizeRunReport` | same | **yes** — L2 |
| LLM fact-check rejection categories | `llmFactCheck` | same, **quarantined** (§5.10) | **yes** — L2 |
| Duplicate-rejection reason breakdown | `RUN_REPORT.duplicateReasonBreakdown` | same | **yes** — L2 |
| LLM fact-check *claims and reasons*, per model | `llmFactCheck` | stderr | no — deliberately (§5.10) |
| Consensus issues dropped as source-contradicted | `dropSourceContradictedIssues` | stderr | no |
| Headlines dropped pre-generation, with reason | `RUN_REPORT.discardedHeadlineSamples` | `.tmp/…json` (gitignored) → step summary | no |
| Source scan success/failure by domain | `RUN_REPORT.sources` | same | no |
| Used source URLs, consumed topics, evergreen rejects | `data/article-source-urls.json`, `data/topic-candidates-*.json` | committed to `main` | yes (pre-existing) |

The bottom row is where the pattern came from: the pipeline already knew how to
keep cross-run state, in several places, with FIFO caps and TTLs
(`article-source-urls.json` keeps the last 500; `topic-candidates-consumed.json`
caps at 500 ids; `quota-state.json` caps history at 100). Every one of those
files is about *what has been done*. None of them was about *what went wrong* —
that is what L1 and L2 add.

`RUN_REPORT` is the hook both links use: it is already assembled during the run,
already written to a file, already rendered into the job summary. It terminates
in `.tmp/`, which is gitignored, so a single post-run step folds the two durable
projections out of it before the log dies.

The three rows still marked "no" are not oversights. Verifier *claims and
reasons* are free text produced by the component that failed on 2026-07-28;
persisting them would create a corpus of plausible-looking judgements that a
later link would eventually be tempted to learn from, and the category counts
already carry every aggregate signal the free text does. Headline-drop samples
and per-domain scan results are pre-generation plumbing, not defect signal.

---

## 3. What is persisted, in what shape, where

**Principle: persist observations, not verdicts.** The run records what it saw;
the promotion policy — evidence bars, decay, caps — lives in exactly one place
and runs after the fact. A generator that could write verdicts straight into its
own defences would be grading its own homework, which is precisely the 2026-07-28
failure.

### 3.1 Per-run feed — `RUN_REPORT.factuality` (ephemeral, by design)

```jsonc
"section": "frontaliere",             // which pipeline; the two differ in gates
"status": "generated",                // generated | skipped | deferred | error
"factuality": {
  "institutionObservations": [        // capped at 60/run
    { "acronym": "UFI", "name": "Ufficio federale delle imposte",
      "support": "absent", "attempt": 3 }
  ],
  "attempts": 4,                      // generation attempts across all headlines
  "gateRejectionsByCode": { "tax-exceeds-income": 2, "fabricated-institution": 1 },
  "factCheckRejectionsByCategory": { "unsupported_claim": 3 }   // quarantined
}
```

`attempts` is counted at the top of the retry loop, *before* any early
`continue`. An attempt abandoned on the wall-clock guard still spent the run's
budget, and a cost metric that only counted attempts reaching a gate would show
the pipeline getting cheaper precisely as it started running out of time.

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

### 3.3 Durable ledger — `data/article-defect-history.jsonl`

One row per run, appended by the same step that folds the memory. JSONL rather
than a JSON document because the access pattern is append-once-read-rarely and
because that is what makes `merge=union` the correct resolution — the pattern
`data/quality-alerts-history.jsonl` and `data/quota-history.jsonl` already use.

```jsonc
{ "v": 1, "at": "2026-07-29T…", "runId": "30361707533", "section": "frontaliere",
  "status": "generated", "attempts": 4, "articleId": "…", "sourceDomain": "tio.ch",
  "gateRejections":      { "tax-exceeds-income": 2 },        // deterministic
  "duplicateRejections": { "semantic-near-duplicate": 1 },   // deterministic
  "verifierOpinion":     { "unsupported_claim": 3 },         // QUARANTINED (§5.10)
  "sourceSupport":       { "present": 1, "absent": 2, "unknown": 0 } }
```

Written on **every** run report, including runs that published nothing. "Nothing
shipped" is the most informative row in the file: a defence quietly taking the
pipeline to zero — which is exactly what over-tight gates did to the evergreen
path in issue #2947 — is indistinguishable from a quiet week unless the empty
runs are recorded too.

Three properties, each argued in §5.9–§5.12: it has **no action surface**, the
model-derived column is **quarantined**, and it is **bounded and convergent**
(180 days / 12000 rows, retention applied inside the append, duplicates from a
union merge collapsed on read so no count can be inflated).

Growth: ~48 rows/day at ~300 bytes, so the retention window is the steady state
at ~2.5MB, not a theoretical ceiling. That number is the whole reason retention
exists — `data/dist-size-history.jsonl` is 42MB and is part of why `git push`
from this repo needed its own runbook. Note this is *not* the forbidden
prune-and-recommit of an existing archive: the file is born bounded, and no
compaction ever removes a row a reader was told would be there.

---

## 4. The links, and the order they ship in

### 4.0 The ordering rule

Links are ordered by **what it costs to be wrong**, not by what they deliver
when right. Every one of them has a plausible story about why it will help;
2026-07-28 also had one. So the sequence is decided by two rules, applied in
this order:

1. **A link that only observes ships before any link that acts.** Its worst
   failure is "we learn nothing". An acting link's worst failure is "we learn
   the wrong thing", and this pipeline has already paid for that once.
2. **Among acting links, cheap-to-reverse before cheap-to-get-wrong.** A gate
   that blocks a correct article is visible the same day and is undone by one
   `--clear`. A prompt that teaches the model a defect is invisible until
   somebody counts, and by then it has shipped forty-eight times a day.

| # | Link | Acts on | Cost of being wrong | How it is undone | Status |
|---|---|---|---|---|---|
| **L1** | Denylist enrichment (§4.1) | the gate — blocks publication | a correct article is blocked | one `--clear`, absorbing and permanent | **shipped** |
| **L2** | Rejection ledger (§4.2) | *nothing* | we learn nothing | n/a — no action surface | **shipped** |
| **L3** | Threshold recommendations (§4.3) | a person's attention | a wasted review | ignore the report | next |
| **L4** | Negative few-shots (§4.4) | the generation prompt | **the model learns the defect** | a revert — but only once somebody notices | gated, see §4.4 |
| **L5** | Beyond acronyms (§4.5) | the gate — blocks publication | a correct article is blocked | one `--clear`, but only after a new oracle exists | last |

L1 shipped before L2 and so appears to break rule 1. It does not: the
observation L2 automates had already been produced by hand for L1's domain — the
corpus audit that found 56 invented acronyms across 52 articles is the
measurement, it just was not repeatable. L1 acted on a measurement that existed.
Everything after L2 acts on a measurement L2 produces, which is why nothing
after L2 could honestly have gone first.

Each planned link below is specified in the same five fields, because those are
the five things that were not written down before 2026-07-28: **what feeds it,
what it changes, what stops it degenerating, what must exist first, and how
anyone would know it worked.**

### 4.1 Denylist enrichment — IMPLEMENTED

**Signal.** Institution acronyms an article introduced, each paired with whether
the run's own fetched source names them. **Transformation.** A three-tier gate:
curated denylist, learned `confirmed` (blocks), learned `suspect` (reports).
**Stability criterion.** §5.1–§5.7 in full — the load-bearing ones are the
external oracle (below), asymmetric evidence (§5.2), and the ratchet brakes
(§5.4). **Preconditions.** A fetched source per run; met on the news path,
absent on the evergreen path, which is why `unknown` exists. **Measured by.**
`fabricated-institution` rejections per run and recidivism (§6).

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

### 4.2 Rejection ledger — IMPLEMENTED

**Signal.** Per run: the deterministic gate codes that rejected a draft, the
duplicate-detector's reasons, the LLM verifier's rejection categories, the
attempts spent, the outcome, and the run's own source-support tally.

**Transformation.** *None, and that is the point.* This link converts signal
into a queryable record and stops. Nothing reads it to change anything. It
exists because every metric in §6 is a time series and every input to one was
previously written to stderr — a snapshot of the memory answers "what do we
currently believe", never "is `fabricated-institution` firing more than it did
last week, and did anything ship while it fired".

**Stability criterion.** A ledger cannot converge on the wrong objective if it
cannot act, so the entire argument reduces to proving it cannot: no import edge
to the memory or the gates in either direction (§5.9), the model-derived column
quarantined at every read site (§5.10), bounded and convergent under concurrent
writers (§5.11), and no silent loss or unsupported confidence (§5.12). Four
assertions in `tests/article-defect-history.test.ts` pin the non-edges, so
wiring the ledger into a defence means deleting a test that says why not to.

**Preconditions.** `RUN_REPORT` carrying `section`, `status`, `attempts`,
`gateRejectionsByCode`, `factCheckRejectionsByCategory` — all shipped.

**Measured by.** Its own output: `--trends` prints run counts per window and
refuses to report a direction below `MIN_RUNS_FOR_TREND` (10 runs/window). A
ledger that is not being written shows up as a window with fewer runs than the
cadence implies, which is the failure it most needs to make visible.

### 4.3 Threshold recommendations from data — PLANNED (next)

**Signal.** L2's per-code series, split by section, joined against publish rate
and attempts-per-published over the same window.

**Transformation.** A **report**, not an adjustment. For each eyeballed constant
— `checkTaxPlausibility`'s `implausibleRatio: 0.6`, `checkSourceFidelity`'s
`minRecall: 0.5`, `MAJOR_BLOCK_WEIGHT_THRESHOLD: 3.0` — print its firing rate,
the publish rate of the runs where it fired, and a plain reading: a code that
has not fired in 180 days is decoration; a code that fires on most runs which
then never publish is a candidate false-positive machine.

**Stability criterion.** *A loop allowed to move its own thresholds to raise its
own pass rate is the 2026-07-28 loop with extra steps.* Two mechanisms, and a
third that is really a warning:

1. **No write path.** The constants stay literals in one module, changed by a
   person in a reviewed commit. Enforced the same way as §5.9 — the report
   module must not import the gate module's constants for anything but reading,
   and nothing may import the report.
2. **No direction without movement.** A code with a low, *stable* firing rate is
   a working gate, not decoration, and the report must not recommend loosening
   it. Recommendations attach to codes whose rate moved, never to codes whose
   rate is merely low.
3. **A firing rate is not a false-positive rate.** `fabricated-institution`
   firing on every run could mean the gate is broken or that the generator is
   inventing constantly, and no amount of counting separates those. So the
   report *ranks what to adjudicate*; the adjudication is a person reading
   samples. This is the same reasoning that stops L1 promoting on frequency
   (§4.1) applied one level up.

**Preconditions.** L2 with ≥2 full windows above the trend floor — ~1 day at the
current cadence for a 7-day window to be *computable*, but ≥30 days before a
recommendation is worth acting on, because model routing drifts week to week and
a single week's rate carries that drift.

**Measured by.** Whether recommendations get acted on, and whether the acted-on
ones moved the metric they predicted. Tracked by hand: this link is small enough
that instrumenting its own effectiveness would cost more than reading it.

### 4.4 Negative few-shots in the generation prompt — PLANNED, AND GATED

**Signal.** The memory's `names[]` per `suspect`/`confirmed` entity — the
expanded names the generator actually invented ("Ufficio federale delle
questioni giuridiche (UQJ)", "Agenzia dell'Ambiente della Svizzera Italiana
(AASTI)"). Real rejected outputs, which makes them better negative examples than
anything hand-written, at zero extra model calls: the block rides a prompt that
is being sent anyway.

**Transformation.** A short "these are not real institutions; do not use them"
block in the generation prompt.

**Stability criterion — and why this link is not built.** Showing a model text
it should not produce is a documented way to make it *more* likely to produce
it. Negation is the weakest instruction form there is, and the degraded
free-tier models this pipeline falls back to are the worst at honouring it. The
prompt that lists `UQJ` may be the reason the next article contains `UQJ`.

The problem is not that this risk is large. It is that **I cannot presently tell
the two outcomes apart.** "The block worked" and "the block primed the model"
both show up as a *change* in the suspect-acronym emission rate; only the sign
differs, and the sign is exactly what cannot be predicted from the design.
Shipping a prompt change whose failure mode is "the defect gets more common"
into a pipeline that publishes forty-eight times a day, without the instrument
to see which way it went, is 2026-07-28 in a different costume: an intervention
justified by a plausible story instead of a measurement. So it stays unbuilt,
with a concrete gate rather than an indefinite deferral.

**Preconditions — the go/no-go gate.**

1. **≥30 days of L2 rows** (≈1400 runs), so the baseline `sourceSupport.absent`
   per run has a stable mean *and* a known week-to-week variance. Without the
   variance there is no threshold to compare an effect against.
2. **Ship it as a split, not a flag flip.** Enable the block on `svizzera` only
   and leave `frontaliere` as a simultaneous control. The two sections share the
   writer and the model cascade, run on the same cadence, and already carry
   `section` on every ledger row — so the control is free and *concurrent*,
   which a before/after comparison is not. Before/after would attribute a model
   routing change to the prompt.
3. **Keep it only if `sourceSupport.absent` per run falls on the treated section
   by more than the control's own week-to-week variance, over ≥14 days. Revert
   on any rise, however small.** The asymmetry is deliberate and is the whole
   safeguard: the downside of being wrong here is teaching the pipeline the
   defect the pipeline exists to prevent.
4. **Acronym tokens only — never the invented expansions.** "Ufficio federale
   delle questioni giuridiche" is a fluent, plausible Italian phrase and is
   precisely the shape of text a language model completes from. A bare token is
   much less so. This makes the example weaker; it is the version whose failure
   mode is smallest, and at this risk level that is the correct trade.

**Measured by.** `sourceSupport.absent` per run and `fabricated-institution`
gate rejections per run, treated section vs control, both already in the ledger.

### 4.5 Beyond acronyms — PLANNED (last)

**Signal.** Invented law and decree names ("legge federale sulla retribuzione
dei lavoratori frontalieri (LRF)"), statistics attributed to real bodies, quotes
attributed to real people.

**Transformation.** The same two-axis machinery as L1 — prevalence learned
freely, source support the only thing that promotes — with a different extractor
per class.

**Stability criterion.** The machinery transfers; **the oracle does not**, and
that is what makes this last rather than second. An acronym is a token: the
source contains it or it does not, and that check is a string comparison with no
judgement in it. "The source supports this statistic" is not. A source saying
*«circa 2000 lavoratori»* supports "2000 workers" and does not support "2000
frontalieri italiani", and no string comparison decides which. A link whose
oracle requires judgement **cannot use a model as the judge** — that is the
2026-07-28 rule, without exception — so this link is blocked on finding a
deterministic oracle, not on writing an extractor.

That is also why **norms go first within this link**: a law name is as binary as
an acronym. It can be checked against the run's fetched source exactly as an
acronym is, and additionally against the curated register of real federal acts,
which makes it the one class here that already has both halves.

**Preconditions.** Per class: a deterministic extractor *and* a deterministic
oracle. Norms have both today. Statistics and quotes have neither, and until one
appears they stay out — an approximate oracle is worse than none, because it
promotes with confidence.

**Measured by.** The same shape as L1: confirmed entities, recidivism
(`lastSeen` newer than `statusAt`), and rejections per run for the new gate
code, all already computable from the ledger the moment the code exists.

---

## 5. Loop stability

This is the section that matters. The previous loop degenerated; this one has to
demonstrate it cannot. Each failure mode below is paired with the mechanism that
forecloses it and the test that pins the mechanism.

§5.1–§5.8 belong to L1 (§4.1), the link that acts. §5.9–§5.12 belong to L2
(§4.2), the link that only records — a much shorter argument, because most of it
is "this component cannot do anything" and the work is in making that
structurally true rather than merely intended. Every future link is expected to
produce a section of its own here **before** it ships, not after.

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
The ledger adds one more read and one append — unconditional, because one row
per run *is* the signal and a skipped row is a hole in a denominator.

The four sections below are the ledger's (§4.2) stability argument. It is short
for a reason: almost all of it is "this component cannot do anything", and the
work is in making that structurally true rather than merely intended.

### 5.9 The ledger has no action surface

*The failure the entire design is shaped around.* 2026-07-28 happened because a
measurement was wired back into the thing it measured. A record that nothing
reads cannot repeat that, so the only thing worth proving is that nothing reads
it — and "we intend not to" does not survive the next refactor.

`article-defect-history.mjs` does not import `article-defect-memory.mjs`.
`article-defect-memory.mjs` does not import `article-defect-history.mjs`.
`article-factuality-gates.mjs` does not import the ledger. All three non-edges
are asserted, so connecting them means deleting a test that explains why not.

The reverse direction is the one people underestimate. A promotion policy able
to read rejection counts is one commit away from "block whatever gets rejected
most", which is frequency-as-evidence — the thing §4.1 exists to forbid. USTRA,
EOC and DECS are real *and* frequent.
→ `does not import the defect memory`, `is not imported BY the defect memory`,
`is not read by the gates that decide whether an article ships`

### 5.10 The verifier's opinions are quarantined, not excluded

The LLM fact-checker's category counts are recorded. They are also the one
column that must never be treated as a fact about the world, because they are
one model's opinion about another model's output. Both are true simultaneously,
and dropping the column would be the easy wrong answer: the 2026-07-28 signature
is only visible in the aggregate *through* it (§6), and the incident's own
counts are precisely what would have shown it on day one instead of week two.

So the field is named for what it is at every read site (`verifierOpinion`), the
trend view tags its series `admissible: false` while deterministic series are
`admissible: true`, and the rendered summary prints the two under separate
headings, the second of which states that no defence may be promoted from those
rows. The tag travels with the data rather than living in this document, so a
future link would have to strip it deliberately. The verifier's free-text
*claims and reasons* are not persisted at all (§2): a corpus of plausible-looking
judgements is a temptation with no aggregate value the counts do not already have.
→ `marks deterministic series admissible and the verifier series NOT`,
`never lets a verifier code be counted as a gate code`, `prints the two kinds
under separate headings that state the difference`

### 5.11 Bounded, and convergent under concurrent writers

An unbounded accumulator is a repo problem, not a feature:
`data/dist-size-history.jsonl` reached 42MB and is part of why `git push` from
this repo needed its own runbook. Retention (180 days / 12000 rows) is applied
*inside the append call*, so the file is born bounded and there is never a
separate prune-and-recommit pass over an archive somebody else depends on.

Retention rewrites the file, and a rewrite does not commute with the
`merge=union` driver this path is registered under: a union merge keeps both
sides' lines, so it can resurrect rows a compaction just dropped. That tension
is resolved by **convergence rather than locking** — rows are identified by
`runId|at`, the reader collapses duplicates on that key so a resurrected row can
never be counted twice, and the next append's retention pass drops it again.
Temporary bloat, permanently correct arithmetic, no coordination required. The
alternative (a lock, or abandoning retention) buys nothing the dedup does not.
→ `collapses rows a union merge resurrected`, `heals a file polluted by
union-merge duplicates and stale rows in ONE append`, `never drops the row it
was just handed, even at the ceiling`, `is idempotent`

### 5.12 No silent loss, and no confidence the sample cannot support

Two ways a ledger stops being citable, and neither announces itself.

**Silent loss.** A malformed line — a runner killed mid-append — is dropped
individually rather than blinding the file, *and counted*, and the count is
surfaced to the CI step summary. An unwritable ledger exits non-zero, after the
memory has been saved so the run's verdicts are never the price of a ledger
failure; the step is `continue-on-error`, so it goes red without holding up the
article. A missing file is not degradation, it is the cold start.

**Confidence the sample cannot support.** The fastest way to make a measurement
untrusted is to print a confident "+200%" computed over three runs. Below 10
runs per window the view reports its counts and explicitly refuses to call a
direction. Series are compared as *per-run rates*, not raw counts, so a window
shortened by an outage is not read as the defect halving.
→ `drops one malformed line and COUNTS it`, `refuses to call a direction on a
sample too thin to support one`, `compares per-run rates, so a short window is
not mistaken for a fall`, `treats a missing file as cold start`

---

## 6. Is the loop working?

Five questions. Until L2 all of them were snapshot questions asked of a store
that only knows the present; four are now time series.

```bash
node scripts/update-article-defect-memory.mjs --trends            # 7d vs prior 7d
node scripts/update-article-defect-memory.mjs --trends --window 30
```

**Is the defence catching things?** `gateRejections` per code per run, current
window against the previous one. A healthy learned defence shows
`fabricated-institution` rising as entities are confirmed, then falling as the
generator stops emitting them. Falling *without* having risen means the
generator changed, not the defence.

**Is the same class of error recurring?** Recidivism = confirmed entities with a
`lastSeen` newer than their `statusAt`, i.e. the generator still emitting what it
has already been blocked for. Persistent recidivism means the block is
suppressing publication without changing behaviour, and the fix belongs in the
prompt (§4.4), not in more blocking.

**Is the loop costing more than it saves?** `attemptsPerPublished`, window over
window. A learned rule that pushes it up without a matching fall in shipped
defects is a false-positive machine. Reported as `null`, never `Infinity`, when
nothing published: "nothing shipped" is a fact about the window, not a very
large cost.

**Has the verifier been captured?** The one question that is *only* answerable
from the ledger, and the one whose absence cost this pipeline a day. The
2026-07-28 signature is three things moving together: verifier rejections per
run up, attempts per run up, publish rate down. Any two without the third is
noise — rejections rising while articles still ship is a verifier doing its job
on a worse writer, the opposite diagnosis. All three together is a verifier that
has stopped measuring the world, and the trend view names it and says to
adjudicate verdicts by hand *before* touching any gate. Advisory only: the
warning changes nothing anywhere, a person does.

**Is the learner itself healthy?** `memoryHealth()` — `autoConfirmed` against
the cap, `nearCapacity`, and the `oracleSuspect` / `saturated` flags. Both
saturation flags exit non-zero under `--health --strict`, which is meant for a
separate health check that can go red *without* taking content generation down
with it.

Baseline at seeding (2026-07-29): 224 entities, 153 suspect, 4 confirmed (all
human), 67 cleared, 0 auto-confirmed. The ledger starts empty; at ~48 runs/day
the 7-day window clears its 10-run trend floor within hours, and a 30-day
window is worth acting on after a month.

---

## 7. Status and sequence

**Implemented.**
- `scripts/lib/article-defect-history.mjs` — L2: row builder, reader with dedup
  and malformed-line accounting, bounded append, trend view with the
  verifier-capture detector. 37 tests.
- `scripts/lib/article-defect-memory.mjs` — store, policy, decay, caps, health.
- `article-factuality-gates.mjs` — `collectInstitutionAcronyms()` emits
  observations with the support verdict; `checkFabricatedInstitutionAcronyms()`
  gains the learned tiers and the degradation notice; `runFactualityGates()`
  threads memory in and observations out. Called without a memory it behaves
  byte-identically to before, which is what keeps the corpus retro-audit honest
  and makes the change revertible by deleting one argument.
- `create-article.mjs` — reads the memory once per run; collects observations,
  attempts, gate codes and verifier categories into `RUN_REPORT`. Read-only:
  it records, it never writes a verdict into a defence.
- `scripts/update-article-defect-memory.mjs` — ingest, policy, review queue,
  human `--confirm`/`--clear`, ledger append, `--trends`. Dry-run by default.
- `generate-article.yml` — the fold step, `always()` + `continue-on-error`, now
  also rendering the trend view into the job summary.
- `data/article-defect-memory.json` — seeded from the corpus.
  `data/article-defect-history.jsonl` — cold start, `merge=union`.
- 78 tests; every promotion paired with the near-miss that must not promote,
  every detector paired with the shape that must leave it quiet.

**Next, in order** — see §4.0 for why this order and not another.

1. **L3 — Threshold recommendations** (§4.3). Reported, never auto-applied.
   Precondition: ≥30 days of ledger rows. Acts only on a person's attention, so
   it is the cheapest acting link to be wrong about.
2. **L4 — Negative few-shots** (§4.4). *Gated, not queued*: it ships only if the
   split-by-section trial in §4.4 clears its threshold, and reverts on any rise
   in suspect-acronym emissions. It is third and not second because its failure
   mode — teaching the model the defect — is the only one on this list that gets
   worse the longer it goes unnoticed.
3. **L5 — Beyond acronyms** (§4.5). Invented norms first; they are the second
   most frequent fabricated-entity class *and* the only remaining class with a
   deterministic oracle. Statistics and quotes wait for one.

**Deliberately not done.**

- *Auto-tuning the promotion policy from its own outcomes.* A loop that can move
  its own evidence bar to change its own promotion rate is the 2026-07-28 loop.
  The thresholds are constants in one place, changed by people.
- *Using the LLM verifier's verdicts as learning signal.* They are opinions
  about the world produced by the same class of system being judged. Their
  *counts* are recorded as diagnostics (§5.10) and are inadmissible as evidence;
  their claims and reasons are not persisted at all. The source text is the only
  oracle admitted.
- *Auto-promoting on prevalence.* See §4.1.
- *Letting any link read the ledger.* It is a record, not a control input, and
  §5.9 is the reason the record is safe to accumulate automatically at all. A
  link that needs ledger data needs a person between the two.

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

# Which error classes are growing or shrinking, and at what cost? (§6)
node scripts/update-article-defect-memory.mjs --trends
node scripts/update-article-defect-memory.mjs --trends --window 30 --limit 40
```

**Reading the trend view.** The two blocks are not interchangeable. Anything
under *rigetti deterministici* is reproducible from the article text and may be
acted on. Anything under *verdetti del verificatore LLM* is one model's opinion
about another's output: useful for spotting that something changed, never
evidence that the something is real, and never a reason on its own to change a
gate. A `?` in place of an arrow means the window held fewer than 10 runs and
the tool is declining to call a direction — the counts beside it are still real.

**When the verifier-capture warning fires.** Read a sample of the verifier's
rejections by hand before touching anything. On 2026-07-28 the verdicts were
wrong and the drafts were right; loosening a gate in response would have been
the exact opposite of the fix.

**When an article is wrongly blocked by a learned entity.** Clear it
(`--clear <ACR> --reason …`), which pins it as a human verdict the learner can
never override. Do **not** raise `maxAutoConfirmed`, lower the evidence bar, or
delete the store: the entity is wrong, the policy is not, and the policy
constants are the one thing in this design that must not move to make a symptom
go away.
