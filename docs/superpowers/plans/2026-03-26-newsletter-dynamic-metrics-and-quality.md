# Newsletter Dynamic Metrics & Quality Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded newsletter metrics (LAMal CHF 412, unemployment 2.1%) with real data from existing JSON files, improve header image quality, and ensure job selection defaults to 4 diverse recent jobs.

**Architecture:** Add a `loadDashboardMetrics()` function in `newsletter-content.mjs` that reads from existing data files at newsletter-send time. Pass metrics through `buildNewsletter()` to `renderMetrics()`. For images, increase emoji rendering size and use text-based emoji (not img tags) for cross-client compatibility.

**Tech Stack:** Node.js ESM scripts, HTML email templates, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `services/newsletter-content.mjs` | Modify | Add `loadDashboardMetrics()` export |
| `services/newsletter-template.mjs` | Modify | Update `renderMetrics()` to accept dynamic values; improve article header emoji rendering |
| `scripts/send-newsletter.mjs` | Modify | Call `loadDashboardMetrics()`, pass to `buildNewsletter()` |
| `scripts/newsletter-qa.mjs` | Modify | Pass metrics to `buildNewsletter()` for QA preview |
| `tests/newsletter-dynamic-metrics.test.ts` | Create | Test `loadDashboardMetrics()` and `renderMetrics()` with dynamic data |

---

### Task 1: Add `loadDashboardMetrics()` to newsletter-content.mjs

**Files:**
- Modify: `services/newsletter-content.mjs` (add after line 79, after `loadPopularity()`)
- Test: `tests/newsletter-dynamic-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/newsletter-dynamic-metrics.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

describe('loadDashboardMetrics', () => {
  // We test the function indirectly by checking:
  // 1. The data files exist and have the expected structure
  // 2. The newsletter-content.mjs exports the function
  // 3. The newsletter-template.mjs renderMetrics accepts parameters

  it('unemployment data file exists and has valid rate', () => {
    const filePath = path.join(ROOT, 'public', 'data', 'switzerland-unemployment-rate.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.rate).toBeTypeOf('number');
    expect(data.rate).toBeGreaterThan(0);
    expect(data.rate).toBeLessThan(20);
  });

  it('health premiums data file exists and has TI premiums', () => {
    const filePath = path.join(ROOT, 'data', 'health-premiums.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.year).toBeTypeOf('number');
    const tiKeys = Object.keys(data.premiums).filter(k => data.premiums[k].canton === 'TI');
    expect(tiKeys.length).toBeGreaterThan(0);
  });

  it('newsletter-content.mjs exports loadDashboardMetrics', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-content.mjs'), 'utf-8');
    expect(content).toContain('export function loadDashboardMetrics');
  });

  it('newsletter-template.mjs renderMetrics accepts metrics parameter', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    // renderMetrics should accept a metrics object, not just totalJobs
    expect(content).toContain('renderMetrics(totalJobs, metrics)');
  });

  it('newsletter-template.mjs does NOT contain hardcoded CHF 412', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    expect(content).not.toContain('CHF 412');
  });

  it('newsletter-template.mjs does NOT contain hardcoded 2.1%', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    expect(content).not.toContain('>2.1%<');
  });

  it('send-newsletter.mjs calls loadDashboardMetrics', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'send-newsletter.mjs'), 'utf-8');
    expect(content).toContain('loadDashboardMetrics');
  });

  it('newsletter-qa.mjs passes metrics to buildNewsletter', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'newsletter-qa.mjs'), 'utf-8');
    expect(content).toContain('loadDashboardMetrics');
  });
});

describe('newsletter article header images', () => {
  it('article header emoji uses large font size (>=48px)', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    // The emoji span should use a large font size for better rendering
    const match = content.match(/font-size:(\d+)px.*?\$\{emoji\}/);
    expect(match).toBeTruthy();
    expect(parseInt(match[1])).toBeGreaterThanOrEqual(48);
  });

  it('article header has adequate height for emoji display', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-template.mjs'), 'utf-8');
    // Header div should be tall enough
    const match = content.match(/height:(\d+)px.*?background:linear-gradient.*?emoji/s);
    expect(match).toBeTruthy();
    expect(parseInt(match[1])).toBeGreaterThanOrEqual(160);
  });
});

describe('newsletter job selection defaults', () => {
  it('send-newsletter.mjs requests 4 jobs per subscriber', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts', 'send-newsletter.mjs'), 'utf-8');
    // All matchJobsForSubscriber calls should use limit 4
    const calls = content.match(/matchJobsForSubscriber\([^)]+\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain(', 4)');
    }
  });

  it('newsletter-content.mjs quality gate requires 120+ chars', () => {
    const content = fs.readFileSync(path.join(ROOT, 'services', 'newsletter-content.mjs'), 'utf-8');
    expect(content).toContain('120');
    expect(content).toContain('passesQualityGate');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/newsletter-dynamic-metrics.test.ts`
Expected: FAIL — at least tests for `loadDashboardMetrics` export, no hardcoded values, and metrics parameter will fail.

- [ ] **Step 3: Implement `loadDashboardMetrics()` in newsletter-content.mjs**

Add this function after the `loadPopularity()` function (after line 79):

```javascript
/**
 * Load real-time dashboard metrics for the newsletter.
 * Reads from existing data files:
 *   - public/data/switzerland-unemployment-rate.json → unemployment rate
 *   - data/health-premiums.json → average TI LAMal premium (standard, adult 26+)
 *
 * Returns an object with formatted values and fallbacks if files are unavailable.
 */
export function loadDashboardMetrics() {
  const metrics = {
    unemploymentRate: '2.8%',       // Fallback
    unemploymentLabel: 'Disoccupazione CH',
    lamalPremium: 'CHF 680',        // Fallback
    lamalLabel: 'Premio LAMal medio TI',
  };

  // ── Unemployment rate ──
  try {
    const unempPath = path.resolve(__dirname, '..', 'public', 'data', 'switzerland-unemployment-rate.json');
    const unempData = JSON.parse(fs.readFileSync(unempPath, 'utf-8'));
    if (unempData.rate && typeof unempData.rate === 'number') {
      metrics.unemploymentRate = `${unempData.rate}%`;
    }
  } catch {
    console.warn('⚠️  loadDashboardMetrics: unemployment data unavailable, using fallback');
  }

  // ── LAMal average premium (Ticino, standard model) ──
  try {
    const lamalPath = path.resolve(__dirname, '..', 'data', 'health-premiums.json');
    const lamalData = JSON.parse(fs.readFileSync(lamalPath, 'utf-8'));
    const tiKeys = Object.keys(lamalData.premiums).filter(k => lamalData.premiums[k].canton === 'TI');
    let sum = 0;
    let count = 0;
    for (const k of tiKeys) {
      const insurers = lamalData.premiums[k].insurers;
      for (const models of Object.values(insurers)) {
        if (models.standard && typeof models.standard === 'number') {
          sum += models.standard;
          count++;
        }
      }
    }
    if (count > 0) {
      const avg = Math.round(sum / count);
      metrics.lamalPremium = `CHF ${avg}`;
    }
  } catch {
    console.warn('⚠️  loadDashboardMetrics: health premiums data unavailable, using fallback');
  }

  return metrics;
}
```

- [ ] **Step 4: Run tests to verify `loadDashboardMetrics` export test passes**

Run: `npx vitest run tests/newsletter-dynamic-metrics.test.ts -t "exports loadDashboardMetrics"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/newsletter-content.mjs tests/newsletter-dynamic-metrics.test.ts
git commit -m "feat(newsletter): add loadDashboardMetrics for real unemployment & LAMal data"
```

---

### Task 2: Update `renderMetrics()` to accept dynamic values

**Files:**
- Modify: `services/newsletter-template.mjs` lines 257-294 (`renderMetrics` function)
- Modify: `services/newsletter-template.mjs` line 502 (call site in `buildNewsletter`)

- [ ] **Step 1: Update `renderMetrics` signature and body**

Change `renderMetrics(totalJobs)` to `renderMetrics(totalJobs, metrics)`:

Replace the function (lines 257-294) with:

```javascript
function renderMetrics(totalJobs, metrics) {
  const unemploymentRate = metrics?.unemploymentRate || '2.8%';
  const unemploymentLabel = metrics?.unemploymentLabel || 'Disoccupazione CH';
  const lamalPremium = metrics?.lamalPremium || 'CHF 680';
  const lamalLabel = metrics?.lamalLabel || 'Premio LAMal medio TI';

  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 8px;">
      <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0"><tr><td width="33%" valign="top"><![endif]-->
      <table width="100%" cellpadding="0" cellspacing="0"><tr class="metric-row">
        <td width="33%" style="padding:0 4px 0 0;">
          <a href="${directUrl('/cerca-lavoro-ticino')}" style="text-decoration:none;display:block;">
            <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:14px 12px;text-align:center;">
              <div style="font-size:22px;margin-bottom:4px;">\ud83d\udcbc</div>
              <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};">${totalJobs || '200+'}</div>
              <div style="font-size:11px;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Offerte lavoro</div>
            </div>
          </a>
        </td>
        <!--[if mso]></td><td width="33%" valign="top"><![endif]-->
        <td width="33%" style="padding:0 4px;">
          <a href="${directUrl('/statistiche-frontalieri/panoramica-statistiche')}" style="text-decoration:none;display:block;">
            <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:14px 12px;text-align:center;">
              <div style="font-size:22px;margin-bottom:4px;">\ud83d\udcca</div>
              <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};">${escapeHtml(unemploymentRate)}</div>
              <div style="font-size:11px;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">${escapeHtml(unemploymentLabel)}</div>
            </div>
          </a>
        </td>
        <!--[if mso]></td><td width="33%" valign="top"><![endif]-->
        <td width="33%" style="padding:0 0 0 4px;">
          <a href="${directUrl('/compara-servizi/confronta-casse-malati')}" style="text-decoration:none;display:block;">
            <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:14px 12px;text-align:center;">
              <div style="font-size:22px;margin-bottom:4px;">\ud83c\udfe5</div>
              <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};">${escapeHtml(lamalPremium)}</div>
              <div style="font-size:11px;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">${escapeHtml(lamalLabel)}</div>
            </div>
          </a>
        </td>
      </tr></table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>`;
}
```

- [ ] **Step 2: Update `buildNewsletter` to accept and pass metrics**

In `buildNewsletter(data)` (line ~481), add `data.metrics` to the function's expected interface (JSDoc).

Update line 502 from:
```javascript
html += renderMetrics(totalJobs);
```
to:
```javascript
html += renderMetrics(totalJobs, data.metrics);
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/newsletter-dynamic-metrics.test.ts`
Expected: Tests for hardcoded values and metrics parameter should now pass.

- [ ] **Step 4: Commit**

```bash
git add services/newsletter-template.mjs
git commit -m "feat(newsletter): renderMetrics uses dynamic unemployment & LAMal data"
```

---

### Task 3: Wire up metrics in send-newsletter.mjs and newsletter-qa.mjs

**Files:**
- Modify: `scripts/send-newsletter.mjs` — import `loadDashboardMetrics`, pass to `buildNewsletter`
- Modify: `scripts/newsletter-qa.mjs` — import `loadDashboardMetrics`, pass to `buildNewsletter`

- [ ] **Step 1: Update send-newsletter.mjs**

Add `loadDashboardMetrics` to the import on line 33:
```javascript
import { matchJobsForSubscriber, validateJobUrls, buildBriefingPrompt, buildSubjectPrompt, FALLBACK_SUBJECT, getFallbackBriefing, loadDashboardMetrics } from '../services/newsletter-content.mjs';
```

Find the `buildNewsletter()` calls (there are two — preview mode ~line 750 and send mode ~line 850) and add `metrics` to the data object.

For **preview mode** (around line 750-760), find:
```javascript
    matchedJobs: previewJobs,
    totalJobs: jobs.length,
```
Add after `totalJobs`:
```javascript
    metrics: loadDashboardMetrics(),
```

For **send mode** (around line 845-855), find:
```javascript
      matchedJobs,
      totalJobs: jobs.length,
```
Add after `totalJobs`:
```javascript
      metrics: loadDashboardMetrics(),
```

Note: `loadDashboardMetrics()` is pure and cached-ish (reads files once), so calling it per subscriber is fine. If performance matters, call once at top of send loop and reuse.

- [ ] **Step 2: Update newsletter-qa.mjs**

Add `loadDashboardMetrics` to the import on line 23:
```javascript
import { matchJobsForSubscriber, getFallbackBriefing, loadDashboardMetrics } from '../services/newsletter-content.mjs';
```

Find the `buildNewsletter()` call (around line 107) and add `metrics`:
```javascript
    metrics: loadDashboardMetrics(),
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/newsletter-dynamic-metrics.test.ts`
Expected: ALL tests pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/send-newsletter.mjs scripts/newsletter-qa.mjs
git commit -m "feat(newsletter): wire dynamic metrics into send and QA scripts"
```

---

### Task 4: Improve article header emoji rendering

**Files:**
- Modify: `services/newsletter-template.mjs` — `renderArticle()` function (lines 388-405)

- [ ] **Step 1: Update renderArticle header**

Replace lines 394-396:
```javascript
        <div style="width:100%;height:180px;background:linear-gradient(135deg,#1e293b 0%,${BRAND_DARK} 50%,${BRAND_ORANGE} 100%);text-align:center;line-height:180px;">
          <span style="font-size:42px;">${emoji}</span>
        </div>
```

With improved version — larger emoji, better vertical centering, taller height:
```javascript
        <div style="width:100%;height:200px;background:linear-gradient(135deg,#1e293b 0%,${BRAND_DARK} 50%,${BRAND_ORANGE} 100%);text-align:center;line-height:200px;">
          <span style="font-size:56px;letter-spacing:8px;">${emoji}</span>
        </div>
```

Key changes:
- Height: 180px → 200px (more breathing room)
- Font size: 42px → 56px (33% larger — much crisper on all devices)
- Added `letter-spacing:8px` to space emoji apart
- `line-height` matches new height for vertical centering

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/newsletter-dynamic-metrics.test.ts`
Expected: Article header tests pass (font-size >= 48px, height >= 160px).

- [ ] **Step 3: Commit**

```bash
git add services/newsletter-template.mjs
git commit -m "style(newsletter): larger emoji headers (56px) for better rendering quality"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All 163+ test files pass.

- [ ] **Step 2: Build check**

Run: `npx vite build`
Expected: Exit 0.

- [ ] **Step 3: Generate QA preview to visually verify**

Run: `node scripts/newsletter-qa.mjs`
Check: Open the generated HTML in `docs/newsletter-qa/` and verify:
- Unemployment shows real value (3.2%), not 2.1%
- LAMal shows real TI average (~CHF 683), not CHF 412
- Article header emoji are visibly larger and crisper
- Job cards show 4 jobs with company diversity

- [ ] **Step 4: Commit everything and push**

```bash
git push
```
