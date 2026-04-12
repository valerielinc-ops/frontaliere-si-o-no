# Crawler Boilerplate Guard — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Trigger:** Afry crawler silently produced boilerplate for 14 jobs because the detail page parser had a wrong CSS selector. No alarm fired. Problem only found by manual inspection.

---

## Problem

70 of 103 crawlers fetch detail pages to extract job descriptions. When the parser fails silently (site changed HTML structure, selector mismatch, JS-rendered content), the crawler falls back to generic boilerplate descriptions. The crawler reports success, the slice is written, and the boilerplate propagates to production.

There is no guard that detects this. The only way to catch it today is manually clicking through individual job pages and comparing with the source.

## Goal

Add a deploy-blocking guard that runs inside `writeJobsCrawlerSlice()` for every crawler. When the guard detects that too many jobs have boilerplate-only descriptions, it:

1. **Fails the crawler** (exit 1, blocks the workflow)
2. **Creates a GitHub Issue** with details for investigation

## Design

### 1. Boilerplate Detection Function

```
detectBoilerplateDescriptions(jobs: Job[], crawlerKey: string): BoilerplateReport
```

**Returns:**
```typescript
interface BoilerplateReport {
  boilerplateJobs: Array<{
    slug: string;
    title: string;
    reason: string;       // 'marker_phrases' | 'low_unique_words'
    totalWords: number;
    uniqueWords: number;   // words after removing marker phrases
  }>;
  totalJobs: number;
  boilerplateCount: number;
  ratio: number;          // boilerplateCount / totalJobs
}
```

**Detection logic (a description is boilerplate if EITHER condition is true):**

**Condition A — Marker phrases:** Description contains >=2 of these known fallback markers AND does NOT contain content headings (COMPITI, PROFILO, Responsabilita, Requisiti, Qualifiche, Tasks, Requirements, Aufgaben, Anforderungen):

| Marker phrase | Language |
|---|---|
| `"è un'azienda internazionale leader"` | IT |
| `"collaboratori in tutto il mondo"` | IT/multi |
| `"Candidati online su"` | IT |
| `"transizione energetica e industriale"` | IT |
| `"offre servizi di ingegneria"` | IT |
| `"is an international company"` | EN |
| `"Apply online at"` | EN |
| `"ist ein internationales Unternehmen"` | DE |
| `"Bewerben Sie sich online"` | DE |

This list targets the specific boilerplate patterns used by `buildXxxLocalizedContent` functions. It will be extended as new patterns are discovered.

**Condition B — Low unique content:** After removing all marker phrase sentences from the description, the remaining content has <30 words. This catches fallback patterns not covered by the marker list.

**Exclusions:**
- Jobs with `needsRetranslation: true` are excluded from the count (they are in the translation pipeline)
- The `description` field is checked (primary locale), not all `descriptionByLocale` variants

### 2. Guard Gate in writeJobsCrawlerSlice

**Location:** `scripts/assemble-jobs-dataset.mjs`, inside `writeJobsCrawlerSlice()`, after the existing wrong-language quality gate and before the slice write.

**Threshold:** 50% of jobs per crawler.

**Behavior below threshold (ratio < 50%):**
- Log a warning for each boilerplate job: `"[boilerplate-guard] {slug}: {reason} ({uniqueWords} unique words)"`
- Continue normally (write slice)

**Behavior at or above threshold (ratio >= 50%):**

1. Log a detailed report table to stdout
2. Create or update a GitHub Issue (see Section 3)
3. `throw new Error(...)` — crashes the crawler, exit 1

**Opt-out:** `SKIP_BOILERPLATE_GUARD=1` environment variable skips the guard entirely. For use during initial crawler development or known-thin-content companies.

### 3. GitHub Issue Creation

**Command:** `gh issue create` via child_process.execSync

**Dedup:** Before creating, check for existing open issues:
```
gh issue list --label parser-broken --state open --search "{crawlerKey}" --json number,title --limit 5
```
If an issue with `[parser-health] {crawlerKey}` in the title already exists, add a comment instead of creating a new issue.

**New issue format:**
```
Title: [parser-health] {COMPANY_LABEL}: {count}/{total} jobs have boilerplate-only descriptions
Labels: parser-broken, automated
```

**Body:**
```markdown
## Parser Health Alert

**Crawler:** {crawlerKey}
**Boilerplate ratio:** {ratio}% ({count}/{total} jobs)
**Threshold:** 50%
**Run:** {date ISO}

### Affected jobs

| # | Job title | Slug | Unique words | Reason |
|---|-----------|------|-------------|--------|
| 1 | {title} | {slug} | {uniqueWords} | {reason} |

### Investigation checklist

- [ ] Check if the source site changed its HTML structure
- [ ] Fetch a detail page manually: `curl -s '{exampleUrl}' | head -200`
- [ ] Review the parser at `scripts/lib/{crawlerKey}-job-parser.mjs`
- [ ] Compare parser selectors with current page structure
- [ ] Fix the parser and re-run: `node scripts/update-{crawlerKey}-jobs.mjs`
```

**Comment on existing issue:**
```
Updated: {date} — still detecting {count}/{total} boilerplate jobs.
```

### 4. Error Handling

- If `gh` CLI is not available or the issue creation fails, the guard still throws (hard fail). The issue creation failure is logged as a warning but does not suppress the guard error.
- The guard runs synchronously. No async operations except the `gh` CLI call (execSync).

### 5. Testing

**Unit test in `tests/boilerplate-guard.test.ts`:**
- Test boilerplate detection with known marker phrases
- Test detection with low unique word count
- Test that real descriptions (with headings + content) pass
- Test threshold: 49% passes, 50% fails
- Test `needsRetranslation` jobs are excluded
- Test `SKIP_BOILERPLATE_GUARD=1` opt-out

**Integration verification:**
- Run Afry crawler with the old broken parser code (revert selector temporarily) and verify the guard catches it
- Verify the guard passes with the fixed parser

---

## Files Changed

| File | Change |
|---|---|
| `scripts/assemble-jobs-dataset.mjs` | Add `detectBoilerplateDescriptions()` function and guard gate in `writeJobsCrawlerSlice()` |
| `tests/boilerplate-guard.test.ts` | New test file for the guard |

## Not In Scope

- Per-crawler custom boilerplate patterns (the marker list is universal)
- Retroactive scanning of existing slices (guard only runs on fresh crawl output)
- Slack/email notifications (GitHub Issues are sufficient)
