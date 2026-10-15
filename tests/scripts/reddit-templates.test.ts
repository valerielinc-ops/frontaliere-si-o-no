import { describe, expect, it } from 'vitest';

// Pure-ESM module; side-effect-free to import.
import * as templates from '../../scripts/lib/reddit-templates.mjs';

interface JobLike {
  id?: string;
  title?: string;
  titleByLocale?: Record<string, string>;
  hiringOrganization?: { name?: string };
  company?: string;
  location?: string;
  jobLocation?: { address?: { addressLocality?: string } };
  description?: string;
  descriptionByLocale?: Record<string, string>;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number };
  };
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  slug?: string;
  slugByLocale?: Record<string, string>;
}

interface JobPost {
  title: string;
  kind: 'self';
  text: string;
  topic: 'jobs';
}

interface ArticlePost {
  title: string;
  kind: 'link';
  url: string;
  topic: 'articles';
}

const {
  buildJobTitle,
  buildJobBody,
  buildJobPost,
  buildArticleTitle,
  buildArticlePost,
} = templates as unknown as {
  buildJobTitle: (job: JobLike) => string;
  buildJobBody: (job: JobLike) => string;
  buildJobPost: (job: JobLike) => JobPost;
  buildArticleTitle: (ogTitle: string) => string;
  buildArticlePost: (opts: {
    id?: string;
    url: string;
    ogTitle: string;
    ogDescription?: string;
    category?: string;
  }) => ArticlePost;
};

const REDDIT_TITLE_MAX = 300;

// ── buildJobTitle ─────────────────────────────────────────

describe('buildJobTitle', () => {
  const fullJob: JobLike = {
    id: 'job-1',
    title: 'Sviluppatore Frontend',
    titleByLocale: { it: 'Sviluppatore Frontend IT', en: 'Frontend Developer' },
    hiringOrganization: { name: 'Acme SA' },
    jobLocation: { address: { addressLocality: 'Lugano' } },
    baseSalary: { currency: 'CHF', value: { minValue: 90000, maxValue: 110000 } },
  };

  it('includes IT title, company and city', () => {
    const t = buildJobTitle(fullJob);
    expect(t).toContain('Sviluppatore Frontend IT');
    expect(t).toContain('Acme SA');
    expect(t).toContain('Lugano');
  });

  it('prefers titleByLocale.it over title', () => {
    const t = buildJobTitle(fullJob);
    expect(t).toContain('Sviluppatore Frontend IT');
    // The plain `title` would have been "Sviluppatore Frontend" (no "IT" suffix).
    expect(t).not.toMatch(/Sviluppatore Frontend ·/);
  });

  it('falls back to title when titleByLocale.it is missing', () => {
    const j: JobLike = { ...fullJob, titleByLocale: undefined };
    const t = buildJobTitle(j);
    expect(t).toContain('Sviluppatore Frontend');
  });

  it('respects the ≤300 char limit and ellipsizes a very long title', () => {
    const j: JobLike = {
      id: 'huge',
      title: 'X'.repeat(500),
      hiringOrganization: { name: 'Acme SA' },
      jobLocation: { address: { addressLocality: 'Lugano' } },
    };
    const t = buildJobTitle(j);
    expect(t.length).toBeLessThanOrEqual(REDDIT_TITLE_MAX);
    // Long title gets truncated, so company/city suffix is cut off.
    expect(t).not.toContain('Acme SA');
  });
});

// ── buildJobBody ──────────────────────────────────────────

describe('buildJobBody', () => {
  const fullJob: JobLike = {
    id: 'job-1',
    title: 'Sviluppatore Frontend',
    slugByLocale: { it: 'sviluppatore-frontend-lugano' },
    jobLocation: { address: { addressLocality: 'Lugano' } },
    baseSalary: { currency: 'CHF', value: { minValue: 90000, maxValue: 110000 } },
    employmentType: 'FULL_TIME',
    descriptionByLocale: {
      it: '<p>Cerchiamo uno <strong>sviluppatore</strong> per progetto a Lugano.</p>',
    },
  };

  it('is Italian markdown that contains the apply link with trailing slash', () => {
    const body = buildJobBody(fullJob);
    expect(body).toContain(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/sviluppatore-frontend-lugano/',
    );
    // Italian markdown CTA.
    expect(body).toContain("Vedi l'offerta e candidati");
  });

  it('strips HTML from the description', () => {
    const body = buildJobBody(fullJob);
    expect(body).not.toContain('<p>');
    expect(body).not.toContain('<strong>');
    expect(body).toContain('sviluppatore');
  });

  it('includes the automated-listing disclosure line', () => {
    const body = buildJobBody(fullJob);
    expect(body).toContain('Annuncio pubblicato automaticamente da Frontaliere Ticino');
  });
});

// ── buildJobPost ──────────────────────────────────────────

describe('buildJobPost', () => {
  const job: JobLike = {
    id: 'job-1',
    title: 'Sviluppatore Frontend',
    slugByLocale: { it: 'sviluppatore-frontend-lugano' },
    jobLocation: { address: { addressLocality: 'Lugano' } },
    descriptionByLocale: { it: 'Cerchiamo uno sviluppatore.' },
  };

  it('returns a self post for the jobs topic with non-empty title and text', () => {
    const post = buildJobPost(job);
    expect(post.kind).toBe('self');
    expect(post.topic).toBe('jobs');
    expect(post.title.length).toBeGreaterThan(0);
    expect(post.text.length).toBeGreaterThan(0);
    expect(post.title.length).toBeLessThanOrEqual(REDDIT_TITLE_MAX);
  });
});

// ── buildArticleTitle / buildArticlePost ──────────────────

describe('buildArticleTitle', () => {
  it('trims and preserves a short title', () => {
    expect(buildArticleTitle('  Permesso G: guida 2026  ')).toBe('Permesso G: guida 2026');
  });

  it('clamps a very long title to the 300-char limit', () => {
    // A no-break run still respects the hard cap: truncateBody reserves one
    // char for the appended '…' so the result never exceeds maxLen.
    expect(buildArticleTitle('A'.repeat(500)).length).toBeLessThanOrEqual(REDDIT_TITLE_MAX);
  });
});

describe('buildArticlePost', () => {
  it('returns a link post for the articles topic with url preserved and title ≤300', () => {
    const url = 'https://frontaliereticino.ch/blog/permesso-g-2026/';
    const post = buildArticlePost({
      id: 'art-1',
      url,
      ogTitle: 'Richiesta Permesso G Step by Step 2026',
      ogDescription: 'Guida completa.',
      category: 'permessi',
    });
    expect(post.kind).toBe('link');
    expect(post.topic).toBe('articles');
    expect(post.url).toBe(url);
    expect(post.title).toBe('Richiesta Permesso G Step by Step 2026');
    expect(post.title.length).toBeLessThanOrEqual(REDDIT_TITLE_MAX);
  });

  it('clamps a long og:title in the link post', () => {
    const post = buildArticlePost({
      url: 'https://frontaliereticino.ch/blog/x/',
      ogTitle: 'B'.repeat(400),
    });
    expect(post.title.length).toBeLessThanOrEqual(REDDIT_TITLE_MAX);
  });
});
