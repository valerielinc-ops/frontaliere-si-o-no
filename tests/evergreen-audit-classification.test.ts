import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  auditEvergreen,
  isDatedAnnouncement,
} from '../scripts/audit-evergreen-articles.mjs';

/**
 * Issue #5021.
 *
 * The evergreen audit called an article evergreen if its CATEGORY was one of
 * `fiscale|pratico|pensione`. Category is not that property. `pratico` covers
 * both "how the G permit works" — genuinely evergreen, worth refreshing — and
 * `manutenzione-ustat-servizi-chiusure-31-12-2025`, a service-closure notice
 * for one date that is permanently in the past.
 *
 * The second kind can never leave the stale list. It gets flagged every month
 * forever, and the only way to make it "fresh" is to bump its date without
 * changing a word — the exact freshness manipulation Google penalises, on an
 * article whose subject has not existed for months. So the audit must stop
 * asking for it.
 *
 * Deliberately narrow: a bare trailing YEAR is not a date. Annual editions
 * (`costo-vita-svizzera-2026`) are precisely what the audit exists to catch.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/evergreen-refresh-audit.yml'),
  'utf-8',
);

describe('isDatedAnnouncement', () => {
  it('recognises the slug that started this — an explicit DD-MM-YYYY', () => {
    expect(isDatedAnnouncement('manutenzione-ustat-servizi-chiusure-31-12-2025')).toBe(true);
  });

  it('recognises an ISO-ordered date too', () => {
    expect(isDatedAnnouncement('chiusura-sportelli-2025-12-31')).toBe(true);
  });

  it('leaves annual editions alone — they are the whole point of the audit', () => {
    // Refreshing these every year IS the job. Excluding them would silently
    // turn the audit off for the articles it exists for.
    expect(isDatedAnnouncement('costo-vita-svizzera-2026')).toBe(false);
    expect(isDatedAnnouncement('premi-cassa-malati-svizzera-2026')).toBe(false);
    expect(isDatedAnnouncement('stipendio-netto-2026')).toBe(false);
  });

  it('leaves ordinary evergreen slugs alone', () => {
    expect(isDatedAnnouncement('costo-vita-ticino-vs-lombardia')).toBe(false);
    expect(isDatedAnnouncement('permesso-g-formato-carta-credito-ticino')).toBe(false);
    expect(isDatedAnnouncement('lamal-vs-cmi-frontaliere')).toBe(false);
  });

  it('is not fooled by number runs that are not dates', () => {
    // A version-ish or measurement-ish run must not silently disable the
    // audit for an article: over-matching here is a page that stops being
    // maintained, with nothing to show it happened.
    expect(isDatedAnnouncement('aliquote-1-2-3-confronto')).toBe(false);
    expect(isDatedAnnouncement('articolo-99-13-2025')).toBe(false); // day 99 is not a day
    expect(isDatedAnnouncement('bonus-2025-13-01')).toBe(false); // month 13 is not a month
  });

  it('handles an empty or missing id without throwing', () => {
    expect(isDatedAnnouncement('')).toBe(false);
    expect(isDatedAnnouncement(undefined)).toBe(false);
  });
});

describe('auditEvergreen', () => {
  // Relative to `now`, never a literal — a fixture pinned to a wall-clock date
  // is a test that starts failing on its own (AGENTS.md, test-fixture dates).
  const NOW = new Date('2026-08-05T00:00:00Z');
  const monthsAgo = (n: number) => {
    const d = new Date(NOW);
    d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 10);
  };

  const ARTICLES = [
    { id: 'permesso-g-guida', category: 'pratico', date: monthsAgo(9) },
    { id: 'chiusure-sportelli-31-12-2025', category: 'pratico', date: monthsAgo(8) },
    { id: 'aliquote-fonte', category: 'fiscale', date: monthsAgo(2) },
    { id: 'news-del-giorno', category: 'novita', date: monthsAgo(24) },
    { id: 'riscatto-secondo-pilastro', category: 'pensione', date: monthsAgo(12), updatedAt: monthsAgo(1) },
  ];

  it('drops the dated announcement from the pool and says so', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.datedExcludedCount).toBe(1);
    expect(r.datedExcluded.map((a: { id: string }) => a.id)).toEqual(['chiusure-sportelli-31-12-2025']);
    // Excluded from the denominator too — 5 articles, 4 in evergreen
    // categories, 1 of those dated.
    expect(r.totalEvergreen).toBe(3);
  });

  it('still flags the genuinely stale evergreen article', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.staleCount).toBe(1);
    expect(r.stale[0].id).toBe('permesso-g-guida');
  });

  it('honours updatedAt over date, so a real refresh clears the flag', () => {
    // The pension article is 12 months old by `date` and 1 month old by
    // `updatedAt`. That is the only legitimate way off this list.
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.stale.map((a: { id: string }) => a.id)).not.toContain('riscatto-secondo-pilastro');
  });

  it('never considers a non-evergreen category, however old', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.stale.map((a: { id: string }) => a.id)).not.toContain('news-del-giorno');
  });

  it('importing the module runs no audit and prints nothing', () => {
    // The module used to compute at import time by reading the TypeScript
    // registry; a test could not touch the classifier without that parse.
    expect(typeof auditEvergreen).toBe('function');
    expect(typeof isDatedAnnouncement).toBe('function');
  });
});

describe('auditEvergreen calendar cutoff', () => {
  const year = new Date().getUTCFullYear();

  const article = (id: string, articleYear: number, month: number, day: number) => ({
    id,
    category: 'pratico',
    date: new Date(Date.UTC(articleYear, month - 1, day, 12)).toISOString(),
  });

  const staleIds = (now: Date, articles: ReturnType<typeof article>[]) =>
    auditEvergreen(articles, now).stale.map((item: { id: string }) => item.id);

  it('uses the day within the month and keeps the exact cutoff date fresh', () => {
    const now = new Date(Date.UTC(year, 8, 22, 12));
    const articles = [
      article('one-day-before-cutoff', year, 3, 21),
      article('on-cutoff', year, 3, 22),
      article('one-day-after-cutoff', year, 3, 23),
    ];

    expect(staleIds(now, articles)).toEqual(['one-day-before-cutoff']);
  });

  it('crosses the year boundary using the full calendar date', () => {
    const now = new Date(Date.UTC(year, 2, 5, 12));
    const articles = [
      article('before-previous-year-cutoff', year - 1, 9, 4),
      article('on-previous-year-cutoff', year - 1, 9, 5),
      article('after-previous-year-cutoff', year - 1, 9, 6),
    ];

    expect(staleIds(now, articles)).toEqual(['before-previous-year-cutoff']);
  });

  it('preserves the calendar-month result on the first day of a month', () => {
    const now = new Date(Date.UTC(year, 9, 1, 12));
    const articles = [
      article('last-day-before-cutoff-month', year, 3, 31),
      article('first-day-of-cutoff-month', year, 4, 1),
      article('day-after-cutoff', year, 4, 2),
    ];

    expect(staleIds(now, articles)).toEqual(['last-day-before-cutoff-month']);
  });

  it('clamps a month-end cutoff to the final day of the target month', () => {
    const now = new Date(Date.UTC(year, 7, 31, 12));
    const lastDayOfFebruary = new Date(Date.UTC(year, 2, 0)).getUTCDate();
    const articles = [
      article('before-clamped-cutoff', year, 2, lastDayOfFebruary - 1),
      article('on-clamped-cutoff', year, 2, lastDayOfFebruary),
      article('after-clamped-cutoff', year, 3, 1),
    ];

    expect(staleIds(now, articles)).toEqual(['before-clamped-cutoff']);
  });
});

describe('the audit issue is one issue, with instructions that exist', () => {
  it('uses a STABLE title so the helper dedups instead of opening one a month', () => {
    // The title carried `$(date +"%B %Y")` inside the 60 chars
    // github-issue-creator.mjs dedups on, so every monthly run opened a new
    // issue for a list that barely changes. #5021 was the August instance.
    expect(WORKFLOW).toContain('--title "Evergreen articles past the 6-month freshness window"');
    expect(
      /--title\s+"[^"]*\$\(date/.test(WORKFLOW),
      'the issue title must not interpolate a date — that defeats dedup at source (ISSUES.md)',
    ).toBe(false);
    expect(WORKFLOW).toContain('scripts/lib/github-issue-creator.mjs');
  });

  it('no longer prescribes a command that does not exist', () => {
    // `scripts/create-article.mjs` has neither `--refresh` nor `--id`. The
    // issue told every reader to run it anyway, which is why it sat parked.
    expect(WORKFLOW).not.toContain('--refresh --id=');
    expect(WORKFLOW).not.toContain('create-article.mjs --refresh');
  });

  it('states that a date bump without a content change is not a refresh', () => {
    // The one instruction that has to survive any future edit of this body:
    // the audit must never be closable by moving a date.
    expect(WORKFLOW).toContain('without changing a word is not a refresh');
    expect(WORKFLOW).toContain('leave the date alone');
  });

  it('surfaces the dated-announcement exclusions instead of hiding the drop', () => {
    expect(WORKFLOW).toContain('datedExcludedCount');
  });
});

/**
 * NX-EG-02 (issue 7295). Category says where an article is filed, not whether
 * it is evergreen: half of a hand-checked stale sample was cronaca filed under
 * `pratico`/`fiscale`. The registry now carries `articleType` and `verifiedAt`,
 * and the audit must use them WITHOUT losing anything in silence:
 *   - typed news leaves the pool but is LISTED (`newsExcluded`);
 *   - an untyped article stays in the pool and in `stale`
 *     (`staleByType.unclassified`) — dropping the untyped stock would be an
 *     alarm switched off, not a classification;
 *   - a verified-and-unchanged article leaves the list via `verifiedAt`, never
 *     via a date bump, and a `verifiedAt` from the future clears nothing.
 */
describe('auditEvergreen with articleType and verifiedAt', () => {
  const NOW = new Date('2026-08-05T00:00:00Z');
  const monthsAgo = (n: number) => {
    const d = new Date(NOW);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 10);
  };
  const monthsAhead = (n: number) => monthsAgo(-n);

  type Row = { id: string; [k: string]: unknown };
  const ids = (rows: Row[]) => rows.map((a) => a.id);
  const byId = (rows: Row[], id: string) => rows.find((a) => a.id === id);

  const ARTICLES = [
    { id: 'ristorni-scontro-berna', category: 'pratico', date: monthsAgo(9), articleType: 'news' },
    { id: 'permesso-g-guida', category: 'pratico', date: monthsAgo(10), articleType: 'evergreen' },
    { id: 'lamal-vs-cmi', category: 'fiscale', date: monthsAgo(11) },
    { id: 'aliquote-fonte', category: 'fiscale', date: monthsAgo(12), verifiedAt: monthsAgo(1) },
    { id: 'riscatto-pilastro', category: 'pensione', date: monthsAgo(14), updatedAt: monthsAgo(8) },
    {
      id: 'tredicesima-avs',
      category: 'pensione',
      date: monthsAgo(15),
      updatedAt: monthsAgo(2),
      verifiedAt: monthsAgo(13),
    },
    { id: 'cambio-franco-euro', category: 'fiscale', date: monthsAgo(9), verifiedAt: monthsAhead(2) },
    { id: 'chiusure-sportelli-31-12-2025', category: 'pratico', date: monthsAgo(8), articleType: 'news' },
    { id: 'cronaca-del-giorno', category: 'novita', date: monthsAgo(24), articleType: 'news' },
  ];
  const inEvergreenCategory = ARTICLES.filter((a) =>
    ['fiscale', 'pratico', 'pensione'].includes(a.category),
  ).length;

  it('excludes typed news from the pool but lists it', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(ids(r.stale)).not.toContain('ristorni-scontro-berna');
    expect(ids(r.newsExcluded)).toEqual(['ristorni-scontro-berna']);
    expect(r.newsExcludedCount).toBe(1);
    expect(byId(r.newsExcluded, 'ristorni-scontro-berna')).toMatchObject({
      category: 'pratico',
      date: monthsAgo(9),
    });
  });

  it('keeps a typed evergreen article stale and says it is typed', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(byId(r.stale, 'permesso-g-guida')).toMatchObject({
      articleType: 'evergreen',
      freshnessSource: 'date',
    });
    expect(r.staleByType.evergreen).toBe(1);
  });

  it('keeps an untyped article in stale, counted as unclassified', () => {
    const only = [{ id: 'lamal-vs-cmi', category: 'fiscale', date: monthsAgo(11) }];
    const r = auditEvergreen(only, NOW);
    expect(r.stale).toHaveLength(only.length);
    expect(byId(r.stale, 'lamal-vs-cmi')).toMatchObject({ articleType: null });
    expect(r.staleByType.unclassified).toBe(1);
    expect(r.staleCount).toBe(1);
  });

  it('lets a recent verifiedAt clear an old article that has no updatedAt', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(ids(r.stale)).not.toContain('aliquote-fonte');
  });

  it('reports updatedAt as the freshness source when it is the latest date', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(byId(r.stale, 'riscatto-pilastro')).toMatchObject({
      freshnessSource: 'updatedAt',
      updatedAt: monthsAgo(8),
      ageMonths: 8,
    });
  });

  it('never lets an older verifiedAt regress a newer updatedAt (maximum, not override)', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(ids(r.stale)).not.toContain('tredicesima-avs');
  });

  it('ignores a verifiedAt from the future and reports it', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(byId(r.stale, 'cambio-franco-euro')).toMatchObject({ freshnessSource: 'date' });
    expect(r.invalidVerifiedAt).toEqual(['cambio-franco-euro']);
  });

  it('accounts for every article in an evergreen category exactly once', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    expect(r.totalEvergreen + r.datedExcludedCount + r.newsExcludedCount).toBe(inEvergreenCategory);
    expect(r.staleByType.evergreen + r.staleByType.unclassified).toBe(r.staleCount);
    expect(r.stale).toHaveLength(r.staleCount);
    // A dated slug that is also typed news is counted once, as dated.
    expect(ids(r.datedExcluded)).toContain('chiusure-sportelli-31-12-2025');
    expect(ids(r.newsExcluded)).not.toContain('chiusure-sportelli-31-12-2025');
  });

  it('keeps an article with no usable date on the list instead of calling it fresh', () => {
    const r = auditEvergreen([{ id: 'senza-data', category: 'pratico', date: 'non-una-data' }], NOW);
    expect(byId(r.stale, 'senza-data')).toMatchObject({ freshnessSource: null, ageMonths: null });
  });

  it('keeps the keys that consumers already read on every stale entry', () => {
    const r = auditEvergreen(ARTICLES, NOW);
    for (const entry of r.stale) {
      expect(Object.keys(entry)).toEqual(
        expect.arrayContaining(['id', 'category', 'date', 'updatedAt', 'ageMonths']),
      );
    }
  });
});

describe('the audit issue carries counts, not a checklist to decompose', () => {
  it('reports the typed counts and protects the tracker from age-out', () => {
    expect(WORKFLOW).toContain('newsExcludedCount');
    expect(WORKFLOW).toContain('unclassified');
    expect(WORKFLOW).toContain('--label agent:no-age-out');
    expect(WORKFLOW).toContain('gh label create "agent:no-age-out"');
  });

  it('no longer pastes every stale slug as a checklist', () => {
    expect(WORKFLOW).not.toContain('.stale[] | "- [ ]');
    expect(WORKFLOW).toContain('.[:15]');
    expect(WORKFLOW).toContain('actions/upload-artifact@');
    expect(WORKFLOW).toContain('path: audit-result.json');
  });

  it('points at the corpus refresh path instead of saying there is none', () => {
    expect(WORKFLOW).not.toContain('There is no automated path today');
    expect(WORKFLOW).toContain('data/evergreen-verifications.json');
    expect(WORKFLOW).toContain('label%3Aevergreen-refresh');
  });
});

describe('audit CLI', () => {
  const SCRIPT = resolve(ROOT, 'scripts/audit-evergreen-articles.mjs');
  const NOW_ISO = '2026-08-05T00:00:00Z';
  const old = (months: number) => {
    const d = new Date(NOW_ISO);
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString();
  };
  const REGISTRY = `export const ARTICLES: Article[] = [
  { id: 'guida-permesso', category: 'pratico', date: '${old(9)}', articleType: 'evergreen' },
  { id: 'cronaca', category: 'pratico', date: '${old(9)}', articleType: 'news' },
  { id: 'non-tipizzato', category: 'fiscale', date: '${old(9)}' },
];
`;
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });

  const withRegistry = <T>(fn: (dir: string, file: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'evergreen-audit-'));
    try {
      const file = join(dir, 'registry.ts');
      writeFileSync(file, REGISTRY);
      return fn(dir, file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads --registry and --now and prints the typed counts', () => {
    withRegistry((_dir, file) => {
      const res = run([`--registry=${file}`, `--now=${NOW_ISO}`]);
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.staleByType).toEqual({ evergreen: 1, unclassified: 1 });
      expect(out.newsExcludedCount).toBe(1);
      expect(out.totalEvergreen + out.newsExcludedCount + out.datedExcludedCount).toBe(3);
    });
  });

  it('still prints when run through a symlinked path', () => {
    // argv[1] keeps the symlink, import.meta.url resolves it: compared
    // literally, the script exited 0 with no output (macOS /tmp, /var).
    withRegistry((dir, file) => {
      const link = join(dir, 'audit-link.mjs');
      symlinkSync(SCRIPT, link);
      const res = spawnSync(process.execPath, [link, `--registry=${file}`, `--now=${NOW_ISO}`], {
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout).staleCount).toBe(2);
    });
  });

  it('rejects an invalid --now and a missing --registry', () => {
    withRegistry((dir, file) => {
      const badNow = run([`--registry=${file}`, '--now=non-una-data']);
      expect(badNow.status).not.toBe(0);
      expect(badNow.stderr).toContain('--now');
      const missing = run([`--registry=${join(dir, 'inesistente.ts')}`, `--now=${NOW_ISO}`]);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('--registry');
    });
  });
});
