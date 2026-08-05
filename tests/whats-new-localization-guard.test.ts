import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { classifyCommit, INFRA_SCOPES } from '../scripts/lib/whats-new-classify.mjs';
import {
  findLocalizationViolations,
  scanCommittedLocales,
  looksLikeCommitText,
  LOCALES,
} from '../scripts/lib/whats-new-localization-guard.mjs';

/**
 * The What's New modal is read by site visitors in four languages.
 *
 * Two defects let build-system vocabulary reach it. `.githooks/post-commit`
 * filtered on the conventional-commit TYPE only, so `fix(seo-gates): stop
 * rebuilding dist in cathedral-seo-gates-check` counted as user-facing. And
 * `generate-whats-new.mjs` fell back to copying the raw commit subject into all
 * four locales whenever the translator was unavailable or failed — so the
 * default outcome of a missing API key was an English fragment of CI jargon in
 * the French modal.
 *
 * Both are now structural: the classifier knows about scope, and the generator
 * cannot write a set that is not demonstrably translated.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

// ── 1. Classification: scope is the missing signal ──────────────────────────

describe("What's New classification — machinery never reaches the modal", () => {
  it('rejects the exact commit that leaked (fix + infra scope)', () => {
    const c = classifyCommit(
      'fix(seo-gates): stop rebuilding dist in cathedral-seo-gates-check, and make the gates actually evaluate (#5169)',
    );
    expect(c.userFacing).toBe(false);
    expect(c.reason).toMatch(/scope "seo-gates"/);
    // The type is still reported — the decision is about scope, not type.
    expect(c.type).toBe('fix');
  });

  it.each([...INFRA_SCOPES])('rejects fix(%s) — development machinery', (scope) => {
    expect(classifyCommit(`fix(${scope}): something`).userFacing).toBe(false);
    expect(classifyCommit(`feat(${scope}): something`).userFacing).toBe(false);
  });

  it('keeps genuinely user-facing changes, including infrastructural-SOUNDING scopes', () => {
    // A CDN 5xx is a visitor-visible outage; a crawler fix changes what the job
    // board shows; an seo fix changes emitted pages. These must NOT be filtered.
    for (const subject of [
      'fix: pagina bianca sul blog',
      'feat(calculator): simulatore tredicesima',
      'fix(cdn): serve stale on 5xx',
      'fix(crawler): dedupe duplicate postings',
      'feat(seo): canton landing pages',
      'improve(job-board): faster filters',
    ]) {
      expect(classifyCommit(subject).userFacing, subject).toBe(true);
    }
  });

  it('rejects the non-product types and automated content pushes', () => {
    for (const subject of [
      'chore(deps): bump',
      'refactor: extract helper',
      'docs: readme',
      'test: add case',
      'style: format',
      'build: vite config',
      'perf(build): faster',
      'ci: pin action',
      'revert: undo',
      'wip(issue-5159): checkpoint',
      '📰 Auto-generated article',
      '💼 Auto-update jobs',
      '🤖 Auto-sync',
      'Merge branch main',
      'not a conventional commit at all',
      '',
    ]) {
      expect(classifyCommit(subject).userFacing, subject).toBe(false);
    }
  });

  it('parses scope, description and the breaking-change marker', () => {
    const c = classifyCommit('feat(calculator)!: nuovo motore');
    expect(c).toMatchObject({ userFacing: true, type: 'feature', scope: 'calculator', description: 'nuovo motore' });
    const noScope = classifyCommit('fix: qualcosa');
    expect(noScope).toMatchObject({ scope: null, description: 'qualcosa' });
  });

  it('the hook delegates to this module rather than re-implementing the rules', () => {
    const hook = fs.readFileSync(path.join(REPO_ROOT, '.githooks/post-commit'), 'utf8');
    expect(hook).toMatch(/whats-new-classify\.mjs/);
    // The old shell `case` lists are gone — two sources of truth is how the
    // scope rule went missing from one of them.
    expect(hook).not.toMatch(/chore\*\|chore/);
    expect(hook).not.toMatch(/RELEASE_TYPE="feature"/);
  });
});

// ── 2. The localization property ────────────────────────────────────────────

const ITEMS = [
  {
    id: 'seo-gates',
    description: 'stop rebuilding dist in cathedral-seo-gates-check, and make the gates actually evaluate',
    titleKeyBase: 'whatsNew.v3911.seo-gates.title',
    descKeyBase: 'whatsNew.v3911.seo-gates.desc',
  },
];
const VERSION_KEY = 'v3911';

/** A properly written four-language set. */
function goodTranslations() {
  const t: Record<string, Record<string, string>> = {};
  const copy = {
    it: ['Aggiornamenti del sito', 'Ricerca lavoro più rapida', 'Le pagine di ricerca si aprono più in fretta.'],
    en: ['Site updates', 'Faster job search', 'Search pages now open more quickly.'],
    de: ['Website-Updates', 'Schnellere Jobsuche', 'Suchseiten öffnen sich jetzt schneller.'],
    fr: ['Mises à jour du site', 'Recherche d’emploi plus rapide', 'Les pages de recherche s’ouvrent plus vite.'],
  };
  for (const l of LOCALES) {
    t[l] = {
      [`whatsNew.${VERSION_KEY}.title`]: copy[l][0],
      [ITEMS[0].titleKeyBase]: copy[l][1],
      [ITEMS[0].descKeyBase]: copy[l][2],
    };
  }
  return t;
}

describe("What's New localization guard — untranslated cannot be published", () => {
  it('passes a real four-language set', () => {
    expect(
      findLocalizationViolations({ translations: goodTranslations(), items: ITEMS, versionKey: VERSION_KEY }),
    ).toEqual([]);
  });

  it('rejects the exact historical leak: commit text copied into all four locales', () => {
    // This is verbatim what the removed `__fallback` produced.
    const t: Record<string, Record<string, string>> = {};
    for (const l of LOCALES) {
      t[l] = {
        [`whatsNew.${VERSION_KEY}.title`]: 'Aggiornamenti',
        [ITEMS[0].titleKeyBase]: ITEMS[0].description.slice(0, 50),
        [ITEMS[0].descKeyBase]: ITEMS[0].description,
      };
    }
    const v = findLocalizationViolations({ translations: t, items: ITEMS, versionKey: VERSION_KEY });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join('\n')).toMatch(/identical in all four locales/);
    expect(v.join('\n')).toMatch(/is the commit text, not a release note/);
  });

  it('rejects an Italian release title shown to en/de/fr (the `|| releaseTitle.it` fallback)', () => {
    const t = goodTranslations();
    for (const l of LOCALES) t[l][`whatsNew.${VERSION_KEY}.title`] = 'Aggiornamenti';
    const v = findLocalizationViolations({ translations: t, items: ITEMS, versionKey: VERSION_KEY });
    expect(v.join('\n')).toMatch(/whatsNew\.v3911\.title: identical in all four locales/);
  });

  it('rejects a key the model simply did not return, instead of substituting for it', () => {
    const t = goodTranslations();
    delete t.de[ITEMS[0].descKeyBase];
    const v = findLocalizationViolations({ translations: t, items: ITEMS, versionKey: VERSION_KEY });
    expect(v.join('\n')).toMatch(/missing or empty in de/);
  });

  it('rejects a raw conventional-commit subject in any locale', () => {
    const t = goodTranslations();
    t.fr[ITEMS[0].titleKeyBase] = 'fix(seo-gates): stop rebuilding dist';
    const v = findLocalizationViolations({ translations: t, items: ITEMS, versionKey: VERSION_KEY });
    expect(v.join('\n')).toMatch(/raw conventional-commit subject/);
  });

  it('rejects a whole locale that produced nothing', () => {
    const t = goodTranslations();
    delete (t as Record<string, unknown>).fr;
    expect(
      findLocalizationViolations({ translations: t, items: ITEMS, versionKey: VERSION_KEY }).join('\n'),
    ).toMatch(/locale "fr" has no translations at all/);
  });

  it('looksLikeCommitText catches truncations without flagging short genuine titles', () => {
    const d = 'stop rebuilding dist in cathedral-seo-gates-check, and make the gates actually evaluate';
    expect(looksLikeCommitText(d, d)).toBe(true);
    expect(looksLikeCommitText(d.slice(0, 50), d)).toBe(true);
    expect(looksLikeCommitText('Ricerca lavoro più rapida', d)).toBe(false);
    // A short shared prefix is not enough to call it commit text.
    expect(looksLikeCommitText('stop', d)).toBe(false);
  });
});

// ── 3. Standing net over what is already committed ──────────────────────────

describe("What's New — the committed locale files carry no untranslated entry", () => {
  it('scans it/en/de/fr and finds no leak', () => {
    const sources: Record<string, string> = {};
    for (const l of LOCALES) {
      sources[l] = fs.readFileSync(path.join(REPO_ROOT, `services/locales/${l}-core.ts`), 'utf8');
    }
    const violations = scanCommittedLocales(sources);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the scanner would actually catch one (it is not vacuous)', () => {
    const leaked = "  'whatsNew.v999.x.title': 'stop rebuilding dist in cathedral-seo-gates-check,',\n";
    const sources: Record<string, string> = {};
    for (const l of LOCALES) sources[l] = leaked;
    expect(scanCommittedLocales(sources).join('\n')).toMatch(/identical in all four locales/);
  });
});

// ── 4. The generator cannot regrow the fallback ─────────────────────────────

describe("generate-whats-new.mjs — no path writes commit text", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/generate-whats-new.mjs'), 'utf8');
  /** Source minus `//` comments, so the prose explaining the removal is not a hit. */
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('never substitutes item.description for a missing translation', () => {
    expect(code).not.toMatch(/\|\|\s*item\.description/);
    expect(code).not.toMatch(/item\.description\.slice\(/);
    expect(code).not.toMatch(/__fallback/);
  });

  it('never falls back to the Italian release title for other locales', () => {
    expect(code).not.toMatch(/data\.releaseTitle\?\.it/);
  });

  it('runs the guard, and does so BEFORE any file write', () => {
    expect(code).toMatch(/findLocalizationViolations/);
    const guardAt = code.indexOf('findLocalizationViolations({');
    const firstWrite = code.indexOf('writeFileSync(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstWrite);
  });

  it('leaves pending entries in place when it refuses to publish', () => {
    // Otherwise a translator outage would silently DROP the release notes.
    expect(code).toMatch(/pending entr/);
    expect(code).toMatch(/process\.exit\(strictMode \? 1 : 0\)/);
  });
});
