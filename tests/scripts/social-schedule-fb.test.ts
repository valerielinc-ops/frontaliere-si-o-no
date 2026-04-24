import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pure-ESM .mjs script. JSDoc-inferred types are fine for our tests, but we
// coerce at the import boundary to keep the suite framework-agnostic. The
// script's direct-invocation block is gated on `import.meta.url ===
// file://${process.argv[1]}`, so importing is side-effect-free.
import * as fb from '../../scripts/social-schedule-fb.mjs';

type Variant = 'topJob' | 'article' | 'calcolatore';

interface JobStatsLike {
  companyCount: number;
  topCompany: string | null;
  topRole: string | null;
  jobBoardUrl: string;
}

interface ArticleLike {
  articleTitle: string | null;
  articleUrl: string;
}

const {
  CANONICAL_ORIGIN,
  pickVariant,
  buildPost,
  loadJobStats,
  loadLatestArticle,
  run,
} = fb as unknown as {
  CANONICAL_ORIGIN: string;
  pickVariant: (weekday: number) => Variant;
  buildPost: (
    variant: Variant,
    data: Partial<JobStatsLike & ArticleLike & { calcolatoreUrl: string }>,
  ) => { variant: Variant; message: string; link: string };
  loadJobStats: (repoRoot?: string) => JobStatsLike;
  loadLatestArticle: (repoRoot?: string) => ArticleLike;
  run: (opts: {
    now?: Date;
    env?: Record<string, string | undefined>;
    repoRoot?: string;
    log?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    fetchImpl?: typeof fetch;
  }) => Promise<{
    ok: boolean;
    dryRun?: boolean;
    post: { variant: Variant; message: string; link: string };
  }>;
};

describe('pickVariant', () => {
  it('returns topJob on Monday (weekday 1)', () => {
    expect(pickVariant(1)).toBe('topJob');
  });

  it('returns article on Wednesday (weekday 3)', () => {
    expect(pickVariant(3)).toBe('article');
  });

  it('returns calcolatore on Friday (weekday 5)', () => {
    expect(pickVariant(5)).toBe('calcolatore');
  });

  it('falls back to calcolatore on off-cron days', () => {
    expect(pickVariant(0)).toBe('calcolatore'); // Sunday
    expect(pickVariant(2)).toBe('calcolatore'); // Tuesday
    expect(pickVariant(6)).toBe('calcolatore'); // Saturday
  });
});

describe('buildPost', () => {
  it('renders the Monday top-job variant with all placeholders filled', () => {
    const p = buildPost('topJob', {
      companyCount: 42,
      topCompany: 'Reboot Monkey',
      topRole: 'Data Center Technician',
      jobBoardUrl: `${CANONICAL_ORIGIN}/cerca-lavoro-ticino`,
    });
    expect(p.message).toContain('42 aziende');
    expect(p.message).toContain('Reboot Monkey');
    expect(p.message).toContain('Data Center Technician');
    expect(p.link).toBe(`${CANONICAL_ORIGIN}/cerca-lavoro-ticino`);
  });

  it('renders the Wednesday article variant with the article title', () => {
    const p = buildPost('article', {
      articleTitle: 'Stipendio netto frontaliere 2026',
      articleUrl: `${CANONICAL_ORIGIN}/blog/stipendio-netto-2026`,
    });
    expect(p.message).toContain('Stipendio netto frontaliere 2026');
    expect(p.message).toContain(`${CANONICAL_ORIGIN}/blog/stipendio-netto-2026`);
    expect(p.link).toBe(`${CANONICAL_ORIGIN}/blog/stipendio-netto-2026`);
  });

  it('renders the Friday calcolatore variant with the fixed CTA + canonical link', () => {
    const p = buildPost('calcolatore', {
      calcolatoreUrl: `${CANONICAL_ORIGIN}/`,
    });
    expect(p.message).toContain('Quanto guadagneresti netto');
    expect(p.message).toContain('2026');
    expect(p.link).toBe(`${CANONICAL_ORIGIN}/`);
  });

  it('uses canonical domain (no www, no trailing /blog slash abuse) for every variant', () => {
    for (const v of ['topJob', 'article', 'calcolatore'] as Variant[]) {
      const p = buildPost(v, {});
      expect(p.link.startsWith('https://frontaliereticino.ch')).toBe(true);
      expect(p.link.includes('www.')).toBe(false);
    }
  });

  it('falls back to safe defaults when no data is provided', () => {
    const p = buildPost('topJob', {});
    // companyCount falls back to 0, topCompany/topRole to Italian generic strings.
    expect(p.message).toMatch(/0 aziende/);
    expect(p.link).toBe(`${CANONICAL_ORIGIN}/cerca-lavoro-ticino`);
  });
});

describe('loadJobStats', () => {
  it('returns safe fallback when the history file is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-social-test-'));
    const stats = loadJobStats(tmp);
    expect(stats.companyCount).toBe(0);
    expect(stats.topCompany).toBeNull();
    expect(stats.topRole).toBeNull();
    expect(stats.jobBoardUrl).toBe(`${CANONICAL_ORIGIN}/cerca-lavoro-ticino`);
  });

  it('extracts top company + role from the most recent entry, weighted by added+updated', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-social-test-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    const fixture = {
      version: 1,
      entries: [
        {
          date: '2026-04-23',
          companyStats: [],
          titleStats: [],
        },
        {
          date: '2026-04-24',
          companyStats: [
            { key: 'a', name: 'Company A', addedKeys: ['x'], updatedKeys: [] },
            {
              key: 'b',
              name: 'Company B',
              addedKeys: ['x', 'y'],
              updatedKeys: ['z'],
            },
          ],
          titleStats: [
            { key: 't1', name: 'Role 1', addedKeys: ['x'], updatedKeys: ['y'] },
            { key: 't2', name: 'Role 2', addedKeys: [], updatedKeys: [] },
          ],
        },
      ],
    };
    writeFileSync(
      join(tmp, 'data/jobs-stats-history.json'),
      JSON.stringify(fixture),
    );
    const stats = loadJobStats(tmp);
    expect(stats.companyCount).toBe(2);
    expect(stats.topCompany).toBe('Company B');
    expect(stats.topRole).toBe('Role 1');
  });
});

describe('loadLatestArticle', () => {
  it('returns the newest article (by date) with its Italian title', () => {
    const tmp = mkdtempSync(join(tmp_prefix(), 'fb-social-test-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    mkdirSync(join(tmp, 'services/locales'), { recursive: true });
    const articles = `
export const ARTICLES = [
  { id: 'old-one', category: 'pratico', date: '2025-01-01', image: 'x', hasCalculator: false },
  { id: 'new-one', category: 'fiscale', date: '2026-03-01', image: 'x', hasCalculator: false },
  { id: 'mid-one', category: 'pratico', date: '2025-06-01', image: 'x', hasCalculator: false },
];
`;
    const meta = `
const blogMetaIt = {
  'blog.article.new-one.title': 'Articolo Nuovo sui Frontalieri',
  'blog.article.old-one.title': 'Vecchio articolo',
};
`;
    writeFileSync(join(tmp, 'data/blog-articles-data.ts'), articles);
    writeFileSync(join(tmp, 'services/locales/blog-meta-it.ts'), meta);
    const a = loadLatestArticle(tmp);
    expect(a.articleTitle).toBe('Articolo Nuovo sui Frontalieri');
    expect(a.articleUrl).toBe(`${CANONICAL_ORIGIN}/blog/new-one`);
  });
});

describe('run() — dry-run mode', () => {
  it('does NOT call fetch when DRY_RUN=1 is set', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const logs: string[] = [];
    const result = await run({
      now: new Date(Date.UTC(2026, 3, 27)), // Monday 2026-04-27
      env: { DRY_RUN: '1', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      log: (...args) => logs.push(args.join(' ')),
      warn: () => {},
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.post.variant).toBe('topJob');
    expect(logs.some((l) => l.includes('DRY_RUN=1'))).toBe(true);
  });

  it('skips the HTTP call and reports missing credentials when envs are absent', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const warnings: string[] = [];
    const result = await run({
      now: new Date(Date.UTC(2026, 3, 24)), // Friday 2026-04-24
      env: {}, // no creds, no dry-run
      log: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(warnings.some((w) => w.includes('missing'))).toBe(true);
  });
});

// Small helper to keep the fixture-heavy test readable.
function tmp_prefix(): string {
  return tmpdir();
}
