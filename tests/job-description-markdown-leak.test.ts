/**
 * The job-detail GATE teaser prints its input verbatim into a
 * `whitespace-pre-line` paragraph, so any markdown left in a crawled
 * description reaches the reader as literal characters. Measured on the live
 * corpus (2026-08-21, `cdn.frontaliereticino.ch/data/job-detail/<id>.json`):
 * 22.1% of a 407-description sample carried a heading marker, and on a
 * 200-description sample 30.5% carried a heading and 19.0% a `**` pair.
 *
 * These tests pin the RULE, not the sample: what must be removed, and — the
 * half that is easy to lose in a later "simplification" — what must survive.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  stripMarkdownMarkers,
  MARKDOWN_CHUNK_HEADING_RE,
} from '../services/jobs/plainTextMarkdown';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('stripMarkdownMarkers — what must go', () => {
  it('drops heading markers at the start of any line', () => {
    const observed = "## addetti/e pulizie presso l'Amministrazione comunale";
    expect(stripMarkdownMarkers(observed)).toBe("addetti/e pulizie presso l'Amministrazione comunale");
    expect(stripMarkdownMarkers('Intro\n### Mansioni\ntesto')).toBe('Intro\nMansioni\ntesto');
    expect(stripMarkdownMarkers('   #  Titolo')).toBe('Titolo');
  });

  it('unwraps ** pairs, the second most common marker', () => {
    expect(stripMarkdownMarkers('**Mansioni**')).toBe('Mansioni');
    expect(stripMarkdownMarkers('Cerchiamo un **profilo senior** subito')).toBe(
      'Cerchiamo un profilo senior subito',
    );
  });

  it('unwraps a markdown link to its text', () => {
    expect(stripMarkdownMarkers('Vedi [il bando](https://example.com/x) online')).toBe(
      'Vedi il bando online',
    );
  });
});

describe('stripMarkdownMarkers — what must SURVIVE', () => {
  it('never touches a single asterisk inside a word', () => {
    // This corpus writes gender-inclusive titles with a lone asterisk. A rule
    // that unwrapped single-asterisk emphasis would corrupt the job titles the
    // page is built around — `Collaborateur*trice Relations Clients-80%` is a
    // real, live ad.
    for (const title of ['Collaborateur*trice Relations Clients-80%', 'Verkäufer*in Kassen', 'Mitarbeiter*innen']) {
      expect(stripMarkdownMarkers(title)).toBe(title);
    }
  });

  it('keeps bullets, which already render as what they mean', () => {
    const list = '- primo punto\n- secondo punto';
    expect(stripMarkdownMarkers(list)).toBe(list);
  });

  it('leaves a hash that is not a heading alone', () => {
    expect(stripMarkdownMarkers('#1 in Ticino')).toBe('#1 in Ticino');
    expect(stripMarkdownMarkers('Rif. #4821')).toBe('Rif. #4821');
  });

  it('cannot swallow the description when a ** pair is left open', () => {
    const open = '**Mansioni\nsegue tutto il resto del testo';
    expect(stripMarkdownMarkers(open)).toBe(open);
  });

  it('is a no-op on text with no markdown, and tolerates empty input', () => {
    expect(stripMarkdownMarkers('Testo normale, con (parentesi) e [parentesi quadre].')).toBe(
      'Testo normale, con (parentesi) e [parentesi quadre].',
    );
    expect(stripMarkdownMarkers('')).toBe('');
    expect(stripMarkdownMarkers(null as unknown as string)).toBe('');
  });
});

describe('the surfaces that print a description verbatim use the shared rule', () => {
  it('the gate teaser strips markdown BEFORE it strips HTML', () => {
    // JobBoard is not mountable in a test (10k lines, network, i18n, router),
    // so this asserts on the source — the same technique the neighbouring
    // job-detail guards use. Order matters and is the reason this is pinned:
    // the HTML strip below removes `<[^>]+>`, which would already have eaten
    // the `(url)` half of a markdown link and stranded its brackets.
    const src = read('components/community/JobBoard.tsx');
    expect(src).toContain("from '@/services/jobs/plainTextMarkdown'");
    const teaser = src.slice(src.indexOf('const descriptionPreview'));
    const call = teaser.indexOf('stripMarkdownMarkers(');
    const htmlStrip = teaser.indexOf('.replace(/<br');
    expect(call, 'the teaser must call stripMarkdownMarkers').toBeGreaterThan(-1);
    expect(call).toBeLessThan(htmlStrip);
  });

  it('the expired-job teaser, a byte-identical twin, strips markdown too', () => {
    // JobExpiredView carried the same `.replace` chain as the gate teaser,
    // copied literally. The sibling gate surfaced it; fixing one and not the
    // other is how the two would have drifted.
    const src = read('components/community/JobExpiredView.tsx');
    expect(src).toContain("from '@/services/jobs/plainTextMarkdown'");
    const chain = src.slice(src.indexOf('const descriptionPlain'));
    expect(chain.indexOf('stripMarkdownMarkers(')).toBeLessThan(chain.indexOf('.replace(/<br'));
  });

  it('no file retypes the chunk heading literal', () => {
    // The rule lived as the same literal in four files. `.mjs` scripts stay
    // out: they cannot import a `.ts` module, which is a module-system limit,
    // not a decision to duplicate.
    for (const rel of [
      'services/jobs/canonicalFallback.ts',
      'services/relatedSearchClusters.ts',
      'build-plugins/shared/jobDetailHtml/highlightsChips.ts',
    ]) {
      expect(read(rel), `${rel} must import the shared rule`).toContain('MARKDOWN_CHUNK_HEADING_RE');
      expect(read(rel), `${rel} still retypes the literal`).not.toMatch(/\.replace\(\/\^#\+\\s\*\//);
    }
  });

  it('canonicalFallback shares the chunk rule instead of retyping it', () => {
    // AGENTS.md #6: a regex duplicated literally in two files is drift waiting
    // to happen. The two shapes are deliberately different (line-oriented vs
    // already-split chunk) but they live in one module.
    const src = read('services/jobs/canonicalFallback.ts');
    expect(src).toContain('MARKDOWN_CHUNK_HEADING_RE');
    expect(src).not.toMatch(/\.replace\(\/\^#\+\\s\*\//);
    expect(MARKDOWN_CHUNK_HEADING_RE.test('##Mansioni')).toBe(true);
  });
});
