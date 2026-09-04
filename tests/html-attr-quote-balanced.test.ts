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
import { readFileSync } from 'node:fs';
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
import {
  extractDatesFromHtml,
  extractHeadlines,
  extractRssItems,
} from '../scripts/create-article.mjs';
import { extractAlliboConnectorUrl } from '../scripts/update-medacta-jobs.mjs';
import { parseCdsSavogninNewsItems } from '../scripts/lib/cds-savognin-job-parser.mjs';
import { parsePostJobDetail } from '../scripts/lib/postch-job-parser.mjs';
import { parseJobListHtml as parsePsgnJobListHtml } from '../scripts/lib/psgn-job-parser.mjs';
import { parseTzmListing } from '../scripts/lib/therapiezentrum-meggen-job-parser.mjs';
import { parsePostFinanceMetaPage } from '../scripts/update-postfinance-jobs.mjs';
import { parseJobBlocks as parseUsiJobBlocks } from '../scripts/update-usi-jobs.mjs';
import { parseJobLinks as parseZegnaJobLinks } from '../scripts/update-zegna-jobs.mjs';

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

  it('does not read an attribute-shaped string inside another attribute value', () => {
    expect(readAttr(
      `onclick="window.location.href='/jobs/decoy'" href="/jobs/real"`,
      'href',
    )).toBe('/jobs/real');
    expect(readAttr(
      `href='/jobs/real' data-template='href="/jobs/decoy"'`,
      'href',
    )).toBe('/jobs/real');
  });

  it('skips values of framework-style attribute names before reading href', () => {
    expect(readAttr(
      `[action]="href='/jobs/decoy'" href="/jobs/real"`,
      'href',
    )).toBe('/jobs/real');
    expect(readAttr(
      `[action]=href=/jobs/decoy href=/jobs/real`,
      'href',
    )).toBe('/jobs/real');
  });

  it('tries names in order and returns the first hit', () => {
    expect(readAttr(`title="t"`, ['aria-label', 'title'])).toBe('t');
    expect(readAttr(`aria-label="a" title="t"`, ['aria-label', 'title'])).toBe('a');
  });

  it('reads an unquoted value', () => {
    expect(readAttr(`href=/jobs/12 class=x`, 'href')).toBe('/jobs/12');
  });

  it('keeps equals signs in an unquoted query value without consuming the next attribute', () => {
    expect(readAttr(`href=/jobs/search?role=R&D&level=2 class=job`, 'href'))
      .toBe('/jobs/search?role=R&D&level=2');
  });

  it('returns empty string when absent', () => {
    expect(readAttr(`class="x"`, 'title')).toBe('');
  });
});

describe('remaining attribute consumers — quote balanced (#6574)', () => {
  it('keeps apostrophes in article HTML and Atom hrefs', () => {
    const articleUrl = "https://example.ch/notizie/d'oggi";
    const [headline] = extractHeadlines(
      `<a href="${articleUrl}"><time datetime="2026-08-30">30.08.2026</time>Notizia importante per i frontalieri</a>`,
      'https://example.ch/',
    );
    expect(headline.url).toBe(articleUrl);
    expect(extractDatesFromHtml(`<a href="${articleUrl}"><time datetime="2026-08-30"></time></a>`, 'https://example.ch/').get(articleUrl))
      .toEqual(new Date('2026-08-30'));

    const [atom] = extractRssItems(
      `<feed><entry><title>Notizia importante per i frontalieri</title><link rel="self"/><link href="${articleUrl}"/><updated>2026-08-30T08:00:00Z</updated></entry></feed>`,
      'https://example.ch/feed.xml',
    );
    expect(atom.url).toBe(articleUrl);
  });

  it('prefers an Atom alternate article link over an earlier self link', () => {
    const articleUrl = "https://example.ch/notizie/d'oggi?edition=1&lang=it";
    const [atom] = extractRssItems(
      `<feed><entry><title>Notizia importante per i frontalieri</title>`
        + `<link rel="self" href="https://example.ch/feed.xml?entry=42"/>`
        + `<link href="${articleUrl}" rel="alternate"/>`
        + `<updated>2026-08-30T08:00:00Z</updated></entry></feed>`,
      'https://example.ch/feed.xml',
    );
    expect(atom.url).toBe(articleUrl);
  });

  it('skips unrelated Allibo attributes before a quote-balanced connector URL', () => {
    const connectorUrl = "https://joblink.allibo.com/ats3/Connector.AsPx?FT=R&D's";
    expect(extractAlliboConnectorUrl(
      `<div data-allibo="widget-shell"></div><div data-allibo="${connectorUrl.replace('&', '&amp;')}"></div>`,
    )).toBe(connectorUrl);
  });

  it('keeps apostrophes in PostFinance meta and canonical attributes', () => {
    const parsed = parsePostFinanceMetaPage(`
      <meta property="og:title" content="Responsabile dell'economia">
      <meta property="og:description" content="Un'opportunità per guidare il team PostFinance.">
      <link href="https://job.post.ch/PostFinance/job/d'Oggi/42/" rel="canonical">
    `, 'https://fallback.example/');
    expect(parsed.title).toBe("Responsabile dell'economia");
    expect(parsed.description).toBe("Un'opportunità per guidare il team PostFinance.");
    expect(parsed.canonical).toBe("https://job.post.ch/PostFinance/job/d'Oggi/42/");
  });

  it('keeps apostrophes in PostCH meta attributes in either order', () => {
    const parsed = parsePostJobDetail(`
      <meta content="Specialista dell'economia" property="og:title">
      <meta name="description" content="Un'opportunità nella logistica svizzera.">
    `, 'https://job.post.ch/default/job/specialista/12345-it_IT');
    expect(parsed.title).toBe("Specialista dell'economia");
    expect(parsed.description).toBe("Un'opportunità nella logistica svizzera.");
  });

  it('selects CDS and TZM links independently from attribute order', () => {
    const [cds] = parseCdsSavogninNewsItems(`
      <div class="news-item">
        <h4>Responsabile dell'economia</h4><div><p>80-100%</p></div>
        <a href="/DE/aktuelles/42.html?team=O'Brien" data-role="job" class="cta mehrLesen">Apri</a>
      </div>
    `);
    expect(cds.detailUrl).toBe("https://cds-savognin.ch/DE/aktuelles/42.html?team=O'Brien");

    const [tzm] = parseTzmListing(`
      <a title="Psychologische Psychotherapeutin d'équipe (stelle.pdf)"
         data-role="job" href="/app/download/42/stelle.pdf?t=1"><span></span></a>
    `);
    expect(tzm.title).toBe("Psychologische Psychotherapeutin d'équipe");
    expect(tzm.pdfUrl).toBe('https://www.tzm.ch/app/download/42/stelle.pdf?t=1');
  });

  it('selects a PSGN job link independently from attribute order and quote style', () => {
    const href = "https://jobs.psychiatrie-sg.ch/karriere/offene-stellen/pflege/12345678-1234-1234-1234-123456789abc?team=O'Brien";
    const [job] = parsePsgnJobListHtml(`
      <a href="${href}" data-kind="listing" class='featured job'>
        <div class="jobTitle"><span>Pflege</span><h2>Leiterin d'équipe</h2></div>
        <div class="jobArbeitsOrt">Wil SG</div>
      </a>
    `);
    expect(job.detailHref).toBe(href);
    expect(job.title).toBe("Leiterin d'équipe");
  });

  it('keeps apostrophes in USI and Zegna job hrefs', () => {
    const [usi] = parseUsiJobBlocks(`
      <p><strong>Università della Svizzera italiana<br/>Dipartimento ricerca</strong><br/>
      Ricercatore dell'economia<br/>
      <a href="https://content.usi.ch/sites/default/files/storage/attachments/dell'offerta.pdf">Bando</a></p>
    `);
    expect(usi.pdfUrl).toBe("https://content.usi.ch/sites/default/files/storage/attachments/dell'offerta.pdf");

    const [zegna] = parseZegnaJobLinks(
      `<a href="/jobs/job-details?JobID=42&amp;Team=Men's">Sales Associate Stabio, Switzerland</a>`,
    );
    expect(zegna.url).toBe("https://careers.zegnagroup.com/jobs/job-details?JobID=42&Team=Men's");
  });

  it('leaves only the six classified false positives in the ratified file set', () => {
    const files = [
      'scripts/lib/fondation-domus-job-parser.mjs',
      'scripts/lib/laderach-job-parser.mjs',
      'scripts/lib/gemeinde-st-moritz-job-parser.mjs',
      'scripts/lib/cedes-job-parser.mjs',
      'scripts/lib/davos-klosters-bergbahnen-job-parser.mjs',
      'scripts/lib/postch-job-parser.mjs',
      'scripts/lib/cds-savognin-job-parser.mjs',
      'scripts/lib/honegger-job-parser.mjs',
      'scripts/lib/tertianum-job-parser.mjs',
      'scripts/lib/therapiezentrum-meggen-job-parser.mjs',
      'scripts/import-swiss-hospitals.mjs',
      'scripts/update-medacta-jobs.mjs',
      'scripts/create-article.mjs',
      'scripts/crawl-insurer-logos.mjs',
      'build-plugins/shared/bridgeThinShell.ts',
      'build-plugins/shared/softLandingThinShell.ts',
    ];
    const residualCounts = Object.fromEntries(
      files
        .map((file) => [
          file,
          readFileSync(file, 'utf8').split(`=["']([^"']`).length - 1,
        ] as const)
        .filter(([, count]) => count > 0),
    );
    expect(residualCounts).toEqual({
      'scripts/lib/tertianum-job-parser.mjs': 1, // explanatory comment; code already uses readAllAttr
      'scripts/import-swiss-hospitals.mjs': 1, // accepted href grammar is [a-z0-9-] or numeric hid
      'scripts/create-article.mjs': 1, // datetime is ISO, not free text
      'scripts/crawl-insurer-logos.mjs': 1, // rel is an HTML link-type token list
      'build-plugins/shared/bridgeThinShell.ts': 1, // canonical path comes from slugify
      'build-plugins/shared/softLandingThinShell.ts': 1, // canonical path comes from slugify
    });
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

  it('matches either name or property when a meta tag declares both', () => {
    expect(readMetaContent(
      `<meta name="description" property="og:title" content="shared">`,
      'description',
    )).toBe('shared');
    expect(readMetaContent(
      `<meta property="og:title" name="description" content="shared">`,
      'description',
    )).toBe('shared');
  });

  it('ignores property-shaped text inside another meta attribute value', () => {
    const html = `<meta data-template="property='og:title' content='decoy'" property="og:description" content="wrong">`
      + `<meta content="Titolo reale" property="OG:TITLE">`;
    expect(readMetaContent(html, 'og:title')).toBe('Titolo reale');
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

  it('prefers the authored casing over an all-caps rendering of the same title', () => {
    expect(joinAnchorParts('INFERMIERE SSS BELLINZONA', 'Infermiere SSS Bellinzona')).toBe(
      'Infermiere SSS Bellinzona',
    );
    // Symmetric: an all-caps attribute does not win over authored anchor text.
    expect(joinAnchorParts('Infermiere SSS Bellinzona', 'INFERMIERE SSS BELLINZONA')).toBe(
      'Infermiere SSS Bellinzona',
    );
  });

  it('leaves an acronym inside mixed-case text alone', () => {
    // `SSS` is uppercase but the string as a whole is not, so nothing is "shouted".
    expect(joinAnchorParts('Infermiere SSS', 'Infermiere SSS')).toBe('Infermiere SSS');
    expect(joinAnchorParts('Infermiere SSS', '')).toBe('Infermiere SSS');
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

  it('preserves case-insensitive value matching while ignoring nested decoys', () => {
    const html = `<meta data-template="itemprop='title'" itemprop="other" content="wrong">`
      + `<meta content="right" ITEMPROP="TITLE">`;
    expect(readAttr(readTagByAttr(html, 'itemprop', 'title'), 'content')).toBe('right');
  });

  it('collects every href, apostrophes intact, so filtering happens in JS', () => {
    const html = `<a href="/x/d'impiego/1">a</a><a href="/sfcareer/jobreqcareer?n=O'Brien">b</a>`;
    const hrefs = readAllAttr(html, 'href');
    expect(hrefs).toEqual(["/x/d'impiego/1", "/sfcareer/jobreqcareer?n=O'Brien"]);
    expect(hrefs.find((h) => h.includes('sfcareer/jobreqcareer'))).toBe(
      "/sfcareer/jobreqcareer?n=O'Brien",
    );
  });

  it('collects only real href attributes, not href-shaped strings nested in values', () => {
    const html = `<a onclick="location.href='/decoy-1'" href="/real-1">a</a>`
      + `<a href='/real-2' data-template='href="/decoy-2"'>b</a>`;
    expect(readAllAttr(html, 'href')).toEqual(['/real-1', '/real-2']);
  });

  it('an unterminated attribute cannot swallow the rest of the document', () => {
    const html = `<a title="unterminated><span>next card title</span></a><a href="/b">b</a>`;
    // Bounded by `[^<]`: the runaway value stops at the first `<`, so it can
    // never reach into the following elements.
    expect(readAttr(html, 'title')).not.toContain('next card title');
  });

  it('keeps scanning a start tag after > inside a quoted attribute', () => {
    const html = '<meta data-label="A > B" itemprop="title" content="Quote-aware Engineer">';
    const tag = readTagByAttr(html, 'itemprop', 'title');
    expect(tag).toBe(html);
    expect(readAttr(tag, 'content')).toBe('Quote-aware Engineer');
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

  it('flags a cut point that is a curly-quote as a numeric entity (#6575)', () => {
    expect(
      detectQuoteTruncatedTitle('Collaboratrice-ore dell&#8217;economia Collaboratrice-ore dell')
        ?.clean,
    ).toBe('Collaboratrice-ore dell&#8217;economia');
    expect(
      detectQuoteTruncatedTitle('Jack&#x2019;s Brasserie Jack')?.clean,
    ).toBe('Jack&#x2019;s Brasserie');
    expect(detectQuoteTruncatedTitle('Foo&#8220;Bar Foo')?.clean).toBe('Foo&#8220;Bar');
    expect(detectQuoteTruncatedTitle('Foo&#x201C;Bar Foo')?.clean).toBe('Foo&#x201C;Bar');
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
