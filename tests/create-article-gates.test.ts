import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenizeIt, jaccardSim, containmentSim, normalizeItWord } from '../scripts/lib/it-text-similarity.mjs';
import { filterDistinctive } from '../scripts/lib/dup-stoplist.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');

const googleBlock = src.match(/function isGoogleNewsRssUrl\(rawUrl\) \{[\s\S]*?\n\}\n\n\/\*\* Extract slug words/);
if (!googleBlock) throw new Error('Google News RSS helper block not found');

const googleRunner = new Function(
  'tokenizeIt',
  'jaccardSim',
  'containmentSim',
  'filterDistinctive',
  `${googleBlock[0].replace(/\n\n\/\*\* Extract slug words[\s\S]*$/, '')}
return { isGoogleNewsRssUrl, resolveGoogleNewsHeadline };`,
);

const { isGoogleNewsRssUrl, resolveGoogleNewsHeadline } = googleRunner(
  tokenizeIt,
  jaccardSim,
  containmentSim,
  filterDistinctive,
) as {
  isGoogleNewsRssUrl: (url: string) => boolean;
  resolveGoogleNewsHeadline: (candidate: any, provenHeadlines: any[]) => any | null;
};

const evergreenBlock = src.match(/function evergreenTopicFamily\(text\) \{[\s\S]*?\n\}\n\n\/\/ ── Pre-flight news headline check/);
if (!evergreenBlock) throw new Error('Evergreen pre-flight helper block not found');

const evergreenRunner = new Function(
  'read',
  'tokenizeIt',
  'jaccardSim',
  'containmentSim',
  'filterDistinctive',
  'normalizeItWord',
  `${evergreenBlock[0].replace(/\n\n\/\/ ── Pre-flight news headline check[\s\S]*$/, '')}
return { evergreenTopicFamily, preFlightEvergreenTopicCheck };`,
);

const { evergreenTopicFamily, preFlightEvergreenTopicCheck } = evergreenRunner(
  () => '',
  tokenizeIt,
  jaccardSim,
  containmentSim,
  filterDistinctive,
  normalizeItWord,
) as {
  evergreenTopicFamily: (text: string) => string | null;
  preFlightEvergreenTopicCheck: (candidate: any, existingArticles: any[]) => any;
};

const factBlock = src.match(/function issueLooksAffirmative\(issue\) \{[\s\S]*?\n\}\n\nasync function _runSingleFactCheck/);
if (!factBlock) throw new Error('Fact-check normalization helper block not found');

const factRunner = new Function(
  `${factBlock[0].replace(/\n\nasync function _runSingleFactCheck[\s\S]*$/, '')}
return { normalizeFactCheckIssues };`,
);

const { normalizeFactCheckIssues } = factRunner() as {
  normalizeFactCheckIssues: (issues: any[], opts?: { isEvergreen?: boolean }) => any[];
};

const dupReasonBlock = src.match(/function addDuplicateReason\(key\) \{[\s\S]*?\n\}\n\nfunction finalizeRunReport/);
if (!dupReasonBlock) throw new Error('Duplicate-reason classifier block not found');

const dupReasonRunner = new Function(
  'RUN_REPORT',
  `${dupReasonBlock[0].replace(/\n\nfunction finalizeRunReport[\s\S]*$/, '')}
return { captureDuplicateReasons, duplicateReasonTag };`,
);

describe('create-article gate helpers', () => {
  it('resolves Google News RSS wrappers to a direct proven-source headline', () => {
    const resolved = resolveGoogleNewsHeadline(
      {
        headline: 'Disoccupazione dei frontalieri, Quadri: un’altra batosta per il Ticino - Ticinonline',
        url: 'https://news.google.com/rss/articles/abc?oc=5',
        source: 'news',
      },
      [
        {
          headline: 'Disoccupazione dei frontalieri, Quadri: un’altra batosta per il Ticino',
          url: 'https://www.tio.ch/ticino/politica/123456/disoccupazione-frontalieri-quadri',
          source: 'tio.ch',
        },
      ],
    );

    expect(isGoogleNewsRssUrl('https://news.google.com/rss/articles/abc?oc=5')).toBe(true);
    expect(resolved?.url).toContain('tio.ch');
    expect(resolved?._resolvedFromGoogleNewsRss).toContain('news.google.com');
  });

  it('drops unresolved Google News RSS wrappers before article generation', () => {
    const resolved = resolveGoogleNewsHeadline(
      {
        headline: 'Permesso G frontalieri: notizia non presente nelle fonti dirette',
        url: 'https://news.google.com/rss/articles/abc?oc=5',
        source: 'news',
      },
      [{ headline: 'Sciopero treni regionali in Lombardia', url: 'https://example.com/a', source: 'example' }],
    );

    expect(resolved).toBeNull();
  });

  it('blocks evergreen variants in an already-covered canonical family before LLM spend', () => {
    const check = preFlightEvergreenTopicCheck(
      {
        keyword: 'permesso g vs b frontalieri 2026 famiglia con figli',
        angle: 'Confronto tecnico tra Permesso G e B nel 2026 per famiglie',
      },
      [
        {
          id: 'permesso-g-vs-b-frontalieri-2026',
          title: 'Permesso G vs B nel 2026: quando conviene cambiare status',
          excerpt: 'Confronto tra permesso G e B per frontalieri con fiscalità, residenza e sanità.',
        },
      ],
    );

    expect(evergreenTopicFamily('Permesso G vs B frontalieri 2026')).toBe('permesso-g-b');
    expect(check.duplicate).toBe(true);
    expect(check.signal).toContain('evergreen_family');
  });

  it('does not count affirmative fact-check notes as blocking issues', () => {
    const normalized = normalizeFactCheckIssues(
      [
        {
          claim: 'AVS 5.3%',
          reason: 'La percentuale AVS del 5.3% è corretta e confermata dai fatti verificati.',
          severity: 'major',
          category: 'aliquote',
        },
        {
          claim: 'Nuovo accordo fiscale 2026',
          reason: 'Non esiste un nuovo accordo fiscale entrato in vigore nel 2026.',
          severity: 'critical',
          category: 'date',
        },
      ],
      { isEvergreen: true },
    );

    expect(normalized).toHaveLength(1);
    expect(normalized[0].category).toBe('date');
  });
});

// #3138 follow-up: checkSemanticNearDuplicate() rejections were thrown with
// full detail (Cosine: X ≥ threshold) but captureDuplicateReasons() only
// recognized the lexical checkForDuplicates() "Segnali:" format, so a
// semantic rejection fell into the generic 'other' bucket — making the
// actual dominant blocker on frontaliere invisible in the run's own
// duplicate-reason summary. These tests pin the classifier + its log tag.
describe('captureDuplicateReasons / duplicateReasonTag (#3138)', () => {
  function freshRunReport() {
    return { duplicateReasonBreakdown: {} as Record<string, number> };
  }

  it('classifies a semantic cosine rejection as semantic_cosine, not other', () => {
    const RUN_REPORT = freshRunReport();
    const { captureDuplicateReasons } = dupReasonRunner(RUN_REPORT) as {
      captureDuplicateReasons: (msg: string) => void;
    };
    captureDuplicateReasons(
      '❌ DUPLICATO SEMANTICO RILEVATO:\n'
      + '   Nuovo:     "X" [id]\n'
      + '   Esistente: [other-slug]\n'
      + '   Cosine:    0.887 ≥ 0.86 (near-duplicate)\n'
      + '   Stessa notizia con parole diverse.',
    );
    expect(RUN_REPORT.duplicateReasonBreakdown).toEqual({ semantic_cosine: 1 });
  });

  it('still classifies a lexical multi-signal rejection as before', () => {
    const RUN_REPORT = freshRunReport();
    const { captureDuplicateReasons } = dupReasonRunner(RUN_REPORT) as {
      captureDuplicateReasons: (msg: string) => void;
    };
    captureDuplicateReasons('❌ DUPLICATO RILEVATO:\n   Segnali:   titolo: 0.80 | excerpt: 0.65');
    expect(RUN_REPORT.duplicateReasonBreakdown).toEqual({
      multi_signal: 1,
      signal_title: 1,
      signal_excerpt: 1,
    });
  });

  it('is a no-op for a non-duplicate error message', () => {
    const RUN_REPORT = freshRunReport();
    const { captureDuplicateReasons } = dupReasonRunner(RUN_REPORT) as {
      captureDuplicateReasons: (msg: string) => void;
    };
    captureDuplicateReasons('some unrelated infrastructure error');
    expect(RUN_REPORT.duplicateReasonBreakdown).toEqual({});
  });

  it('duplicateReasonTag surfaces the cosine value for semantic rejections', () => {
    const { duplicateReasonTag } = dupReasonRunner(freshRunReport()) as {
      duplicateReasonTag: (msg: string) => string;
    };
    const tag = duplicateReasonTag('❌ DUPLICATO SEMANTICO RILEVATO:\n   Cosine:    0.887 ≥ 0.86 (near-duplicate)');
    expect(tag).toBe('semantico, cosine=0.887 ≥ 0.86');
  });

  it('duplicateReasonTag surfaces the signal line for lexical rejections', () => {
    const { duplicateReasonTag } = dupReasonRunner(freshRunReport()) as {
      duplicateReasonTag: (msg: string) => string;
    };
    const tag = duplicateReasonTag('❌ DUPLICATO RILEVATO:\n   Segnali:   titolo: 0.80');
    expect(tag).toBe('lessicale (titolo: 0.80)');
  });
});
