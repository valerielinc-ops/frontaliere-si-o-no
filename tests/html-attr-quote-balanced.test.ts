/**
 * Guard for issue #6480 — the run-on job title that reached production in a slug.
 *
 * The defect was NOT "two adjacent job-cards concatenated", as the issue
 * hypothesised. It was a single card whose `title=` attribute was read with an
 * unbalanced-quote regex (`["']([^"']+)["']`) and therefore truncated at the
 * apostrophe of `dell'`, with the truncated fragment then appended to the anchor
 * text:
 *
 *   title="Collaboratrice-ore dell'economia domestica a ore"
 *   → attribute read as "Collaboratrice-ore dell"
 *   → anchor text "Collaboratrice-ore dell'economia domestica a ore Collaboratrice-ore dell"
 *
 * Two invariants are pinned here because the fix has two independent halves and
 * either one alone would let a variant of the bug back in:
 *   1. attribute values are read quote-balanced (readAttr / readMetaContent);
 *   2. a redundant aria-label/title is not concatenated onto the anchor text.
 *
 * The negative cases matter as much as the positive ones: the measurement in
 * #6480 was abandoned because a "repeated prefix" heuristic flagged 367 titles
 * and was dominated by German double-gender forms. Those forms are asserted
 * here to survive untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  readAllAttr,
  readAttr,
  readMetaContent,
  readTagByAttr,
} from '../scripts/lib/html-attr.mjs';
import { extractJsonLd, scoreVacancyPage } from '../scripts/lib/prospector/extract.mjs';
import {
  cleanAnchorText,
  extractLinks,
  joinAnchorParts,
} from '../scripts/lib/prospector/careers-trail.mjs';
import { detectQuoteTruncatedTitle } from '../scripts/repair-quote-truncated-titles.mjs';

describe('readAttr — quote balanced', () => {
  it('keeps an apostrophe inside a double-quoted value (the #6480 root cause)', () => {
    const attrs = ` href="/vacancy/2762" title="Collaboratrice-ore dell'economia domestica a ore"`;
    expect(readAttr(attrs, 'title')).toBe("Collaboratrice-ore dell'economia domestica a ore");
  });

  it('keeps a double quote inside a single-quoted value', () => {
    expect(readAttr(`alt='Hotel "Bellevue" Lugano'`, 'alt')).toBe('Hotel "Bellevue" Lugano');
  });

  it('does not match an attribute whose name merely ends with the target', () => {
    expect(readAttr(`data-title="wrong" title="right"`, 'title')).toBe('right');
    expect(readAttr(`data-title="wrong"`, 'title')).toBe('');
  });

  it('tries names in order and returns the first hit', () => {
    expect(readAttr(`title="t"`, ['aria-label', 'title'])).toBe('t');
    expect(readAttr(`aria-label="a" title="t"`, ['aria-label', 'title'])).toBe('a');
  });

  it('reads an unquoted value', () => {
    expect(readAttr(`href=/jobs/12 class=x`, 'href')).toBe('/jobs/12');
  });

  it('returns empty string when absent', () => {
    expect(readAttr(`class="x"`, 'title')).toBe('');
  });
});

describe('readMetaContent — quote balanced', () => {
  it("does not truncate an og:title at an Italian apostrophe", () => {
    const html = `<meta property="og:title" content="Operatrice dell'infanzia 80% - LIS"/>`;
    expect(readMetaContent(html, 'og:title')).toBe("Operatrice dell'infanzia 80% - LIS");
  });

  it('reads name= as well as property=', () => {
    const html = `<meta name="og:title" content="Chef de Partie - Jack's Brasserie"/>`;
    expect(readMetaContent(html, 'og:title')).toBe("Chef de Partie - Jack's Brasserie");
  });

  it('returns empty string for a missing key', () => {
    expect(readMetaContent(`<meta property="og:image" content="x">`, 'og:title')).toBe('');
  });
});

describe('joinAnchorParts', () => {
  it('drops an attribute already contained in the anchor text', () => {
    expect(joinAnchorParts('Collaboratrice-ore dell’economia', 'Collaboratrice-ore')).toBe(
      'Collaboratrice-ore dell’economia',
    );
  });

  it('drops anchor text already contained in the attribute', () => {
    expect(joinAnchorParts('Chef de Partie', 'Chef de Partie 100% (m/w/d)')).toBe(
      'Chef de Partie 100% (m/w/d)',
    );
  });

  it('keeps genuinely complementary parts', () => {
    expect(joinAnchorParts('Apply', 'Infermiere SSS Bellinzona')).toBe(
      'Apply Infermiere SSS Bellinzona',
    );
  });

  it('leaves a German double-gender title untouched (the #6480 false-positive class)', () => {
    const t = 'Ernährungsberaterin / Ernährungsberater';
    expect(joinAnchorParts(t, '')).toBe(t);
    expect(cleanAnchorText(t)).toBe(t);
    expect(cleanAnchorText('Dipl. Pflegefachfrau / Dipl. Pflegefachmann')).toBe(
      'Dipl. Pflegefachfrau / Dipl. Pflegefachmann',
    );
  });
});

describe('readTagByAttr / readAllAttr — the two-attribute shapes', () => {
  it('finds an itemprop tag and reads its content past an apostrophe', () => {
    const block = `<meta itemprop="title" content="Operatore dell'infanzia 80%"><span>x</span>`;
    const tag = readTagByAttr(block, 'itemprop', 'title');
    expect(readAttr(tag, 'content')).toBe("Operatore dell'infanzia 80%");
  });

  it('does not confuse itemprop=name with itemprop=nameOfSomething', () => {
    const block = `<meta itemprop="nameExtra" content="wrong"><meta itemprop="name" content="right">`;
    expect(readAttr(readTagByAttr(block, 'itemprop', 'name'), 'content')).toBe('right');
  });

  it('collects every href, apostrophes intact, so filtering happens in JS', () => {
    const html = `<a href="/x/d'impiego/1">a</a><a href="/sfcareer/jobreqcareer?n=O'Brien">b</a>`;
    const hrefs = readAllAttr(html, 'href');
    expect(hrefs).toEqual(["/x/d'impiego/1", "/sfcareer/jobreqcareer?n=O'Brien"]);
    expect(hrefs.find((h) => h.includes('sfcareer/jobreqcareer'))).toBe(
      "/sfcareer/jobreqcareer?n=O'Brien",
    );
  });

  it('an unterminated attribute cannot swallow the rest of the document', () => {
    const html = `<a title="unterminated><span>next card title</span></a><a href="/b">b</a>`;
    // Bounded by `[^<]`: the runaway value stops at the first `<`, so it can
    // never reach into the following elements.
    expect(readAttr(html, 'title')).not.toContain('next card title');
  });
});

describe('extractMicrodata — same defect, same library (#6480 review)', () => {
  const REAL = "Collaboratrice-ore dell'economia domestica a ore";

  it('does not truncate a microdata title at an apostrophe', () => {
    const html = `<div itemscope itemtype="http://schema.org/JobPosting">`
      + `<meta itemprop="title" content="${REAL}">`
      + `<a href="/vacancy/2762">apri</a></div>`;
    const { vacancies } = scoreVacancyPage(html, 'https://www.eoc.ch/posizioni');
    expect(vacancies.some((v) => v.title === REAL)).toBe(true);
  });

  it('keeps a microdata href containing an apostrophe', () => {
    const html = `<div itemscope itemtype="http://schema.org/JobPosting">`
      + `<meta itemprop="title" content="Posto">`
      + `<a href="/offerte/d'impiego/12">apri</a></div>`;
    const { vacancies } = scoreVacancyPage(html, 'https://example.ch/');
    expect(vacancies.some((v) => v.url === "https://example.ch/offerte/d'impiego/12")).toBe(true);
  });

  it('extractJsonLd is unaffected (it parses JSON, never attributes)', () => {
    const html = `<script type="application/ld+json">`
      + `{"@type":"JobPosting","title":"${REAL}","url":"https://x.ch/1"}</script>`;
    expect(extractJsonLd(html, 'https://x.ch/').some((v) => v.title === REAL)).toBe(true);
  });
});

describe('detectQuoteTruncatedTitle — the discriminant #6480 was missing', () => {
  it('flags both titles that actually shipped corrupted', () => {
    expect(
      detectQuoteTruncatedTitle(
        "Collaboratrice-ore dell'economia domestica a ore Collaboratrice-ore dell",
      )?.clean,
    ).toBe("Collaboratrice-ore dell'economia domestica a ore");
    expect(
      detectQuoteTruncatedTitle(
        "Chef de Partie - Jack's Brasserie 100% (m/w/d) Chef de Partie - Jack",
      )?.clean,
    ).toBe("Chef de Partie - Jack's Brasserie 100% (m/w/d)");
  });

  it('does NOT flag German double-gender titles (the 367 false positives)', () => {
    for (const t of [
      'Dipl. Pflegefachfrau / Dipl. Pflegefachmann',
      'Ernährungsberaterin / Ernährungsberater',
      'Sachbearbeiterin Sachbearbeiter',
      'Mitarbeiterin Mitarbeiter Logistik',
    ]) {
      expect(detectQuoteTruncatedTitle(t)).toBeNull();
    }
  });

  it('does not flag a repeated prefix with no quote at the cut point', () => {
    expect(detectQuoteTruncatedTitle('Project Manager Project')).toBeNull();
  });

  it('flags a cut point that is an undecoded HTML entity, not a raw quote', () => {
    // Entities do survive into stored titles (one live title carries `&#34;`),
    // so a truncation at `&#39;` must not be invisible.
    expect(
      detectQuoteTruncatedTitle('Collaboratrice-ore dell&#39;economia Collaboratrice-ore dell')
        ?.clean,
    ).toBe('Collaboratrice-ore dell&#39;economia');
    expect(
      detectQuoteTruncatedTitle('Jack&rsquo;s Brasserie Jack')?.clean,
    ).toBe('Jack&rsquo;s Brasserie');
  });

  it('leaves the one real entity-bearing title alone (it is not truncated)', () => {
    expect(
      detectQuoteTruncatedTitle(
        'Pflegepraktikant:in während Medizinstudium &#34;Häfelipraktikum&#34;',
      ),
    ).toBeNull();
  });

  it('returns null for a clean title', () => {
    expect(detectQuoteTruncatedTitle("Collaboratrice-ore dell'economia domestica a ore")).toBeNull();
    expect(detectQuoteTruncatedTitle('')).toBeNull();
  });
});

describe('extractLinks — the #6480 regression, end to end', () => {
  const REAL = "Collaboratrice-ore dell'economia domestica a ore";

  it('does not concatenate a truncated title attribute onto the anchor text', () => {
    const html =
      `<li><a href="/vacancy/2762" title="${REAL}"><span>${REAL}</span></a></li>`;
    const [link] = extractLinks(html, 'https://www.eoc.ch/posizioni');
    expect(link.text).toBe(REAL);
    expect(link.text).not.toMatch(/Collaboratrice-ore dell$/);
  });

  it('reproduces the burgenstock shape without corruption', () => {
    const t = "Chef de Partie - Jack's Brasserie 100% (m/w/d)";
    const html = `<a href="/de/jobs/42" title="${t}"><div>${t}</div></a>`;
    const [link] = extractLinks(html, 'https://www.buergenstock.ch/jobs');
    expect(link.text).toBe(t);
  });

  it('keeps an href containing an apostrophe intact', () => {
    const html = `<a href="/offerte/d'impiego/12">Posto</a>`;
    const [link] = extractLinks(html, 'https://example.ch/');
    expect(link.url).toBe("https://example.ch/offerte/d'impiego/12");
  });

  it('still uses the title attribute when the anchor has no inner text', () => {
    const html = `<a href="/jobs/9" title="${REAL}"><img src="x.png"></a>`;
    const [link] = extractLinks(html, 'https://example.ch/');
    expect(link.text).toBe(REAL);
  });
});
