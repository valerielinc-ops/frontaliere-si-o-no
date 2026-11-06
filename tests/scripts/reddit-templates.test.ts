import { describe, expect, it } from 'vitest';

// Pure-ESM module; side-effect-free to import.
import * as templates from '../../scripts/lib/reddit-templates.mjs';
import * as redditPoster from '../../scripts/post-to-reddit.mjs';

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
  kind: 'link' | 'self';
  url?: string;
  text?: string;
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
  buildJobBody: (job: JobLike, opts?: { socialCopy?: Record<string, string> }) => string;
  buildJobPost: (job: JobLike, opts?: { socialCopy?: Record<string, string> }) => JobPost;
  buildArticleTitle: (ogTitle: string) => string;
  buildArticlePost: (opts: {
    id?: string;
    url: string;
    ogTitle: string;
    ogDescription?: string;
    category?: string;
    socialCopy?: Record<string, string>;
    destinationUrl?: string;
  }) => ArticlePost;
};
const { articleHasPostedReceipt } = redditPoster as unknown as {
  articleHasPostedReceipt: (articleId: string, ledger: { posted?: Array<Record<string, unknown>> }) => boolean;
};

const REDDIT_TITLE_MAX = 300;

describe('Reddit article copy assignment receipts', () => {
  it('keeps an already-exposed copy arm when a later subreddit attempt fails', () => {
    expect(articleHasPostedReceipt('article-a', {
      posted: [{ id: 'article-a', subreddit: 'frontaliere', redditPostId: 't3_1' }],
    })).toBe(true);
    expect(articleHasPostedReceipt('article-b', {
      posted: [{ id: 'article-a', subreddit: 'frontaliere', redditPostId: 't3_1' }],
    })).toBe(false);
  });
});

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

  it('uses generated hook and CTA while preserving the tagged apply destination', () => {
    const body = buildJobBody(fullJob, {
      socialCopy: {
        copyMode: 'codex',
        copyAssignmentMode: 'firebase-balanced',
        copyPackId: '0123456789abcdef',
        copySlot: 'job',
        id: 'reddit-job-one',
        hook: 'Una selezione utile per chi cerca un nuovo percorso',
        cta: 'Candidati attraverso l’annuncio',
      },
    });

    expect(body.startsWith('Una selezione utile per chi cerca un nuovo percorso')).toBe(true);
    expect(body).toContain('**[Candidati attraverso l’annuncio →]');
    expect(body).toContain('utm_source=reddit');
    expect(body).toContain('--cp0123456789abcdef-job.reddit-job-one.b');
    expect(body).toContain('Annuncio pubblicato automaticamente');
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

  it('uses a self post with generated hook and linked CTA when the copy pack is active', () => {
    const destinationUrl = 'https://frontaliereticino.ch/blog/permesso-g/?utm_source=reddit';
    const post = buildArticlePost({
      url: 'https://frontaliereticino.ch/blog/permesso-g/',
      destinationUrl,
      ogTitle: 'Permesso G: guida pratica',
      ogDescription: 'Una guida basata su fonti ufficiali.',
      socialCopy: {
        copyMode: 'codex',
        hook: 'Un percorso concreto per orientarsi',
        cta: 'Leggi la guida completa',
      },
    });

    expect(post).toMatchObject({ kind: 'self', title: 'Permesso G: guida pratica' });
    expect(post.text).toContain('Un percorso concreto per orientarsi');
    expect(post.text).toContain('[Leggi la guida completa →]');
    expect(post.text).toContain(destinationUrl);
    expect(post.text).toContain('Articolo pubblicato da Frontaliere Ticino');
  });
});
