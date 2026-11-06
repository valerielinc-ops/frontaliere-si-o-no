/**
 * article-fabrication-guard.test.ts
 *
 * Scans ALL blog body files (blog-body + blog-body-ch, all 4 locales) for
 * known hallucination patterns:
 * - Fabricated Swiss/Italian laws and legal references
 * - Fabricated institutions and acronyms
 * - Known incorrect facts (fake tax rates, the wrong Convention date)
 * - Fabricated statistics (unsourced precise percentages)
 *
 * This test acts as a permanent safety net: any article containing
 * fabricated content will fail the test suite and block deployment.
 *
 * IT ONLY RUNS IN THE FULL SUITE (`npm test`), which never sees article
 * bodies landing through `sync-articles-sitemaps.yml` — that job commits
 * straight to `main` with no PR (verified 2026-08-11: zero `push` check-runs
 * on a sync commit). Issue #5671: two fabricated-institution incidents shipped
 * through exactly that gap in one day and only surfaced as `main` going red on
 * unrelated PRs, hours later. The patterns below now also run at sync time,
 * scoped to the delta, via scripts/ci/report-synced-article-fabrication.mjs —
 * both import scripts/lib/article-fabrication-patterns.mjs so there is one
 * definition, not two that can drift apart (AGENTS.md #6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FABRICATED_INSTITUTIONS,
  FABRICATED_ACRONYMS,
  INCORRECT_FACTS,
  VAGUE_SOURCING,
  FABRICATED_LABOR_OFFICE,
  WRONG_CONVENTION_DATE,
  extractTextContentFromSource,
} from '../scripts/lib/article-fabrication-patterns.mjs';
import {
  FABRICATED_INSTITUTION_ACRONYMS,
  checkFabricatedInstitutionAcronyms,
} from '../scripts/lib/article-factuality-gates.mjs';

const BODY_ROOTS = ['blog-body', 'blog-body-ch'];
const LOCALES = ['it', 'de', 'en', 'fr'];

interface ArticleFile {
  id: string;
  path: string;
  locale: string;
}

function getArticleFiles(): ArticleFile[] {
  const results: ArticleFile[] = [];
  for (const root of BODY_ROOTS) {
    for (const locale of LOCALES) {
      const dir = path.resolve(__dirname, '..', 'services', 'locales', root, locale);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
        results.push({
          id: `${root}/${locale}/${path.basename(f, '.ts')}`,
          path: path.join(dir, f),
          locale,
        });
      }
    }
  }
  return results;
}

function extractTextContent(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Extract string values from the TS export (body1, body2, body3, faq content).
  // Must treat a backslash-escaped quote (`\'`) as part of the string content,
  // not a terminator — `/'[^']*'/g` (the prior version) stopped at the FIRST
  // `\'` it saw (e.g. "dell\'Ufficio..."), silently truncating the extracted
  // text and losing everything after it. That's exactly where Italian/French/
  // German elisions put an apostrophe right before a fabricated institution
  // name ("dell\'Ufficio federale...", "l\'Office fédéral...") — this safety
  // net had a blind spot for the single most common surrounding grammar
  // pattern of the exact fabrication it exists to catch (confirmed live: 2
  // articles with the fabricated institution sitting immediately after an
  // escaped apostrophe passed this test undetected until this fix).
  return extractTextContentFromSource(raw);
}

function unescapeTsString(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
}

const FABRICATED_INSTITUTION_NAME_PATTERNS = [
  {
    pattern: /\bUfficio federale per la politica estera(?:\s*\(UPEP\))?(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Ufficio federale per la politica estera (UPEP)',
  },
  {
    pattern: /\bIstituto federale di statistica\s*\(IFS\)(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Istituto federale di statistica (IFS)',
  },
  {
    pattern: /\bMinistero dell[’']agricoltura,\s*dell[’']ambiente e dello spazio\b/i,
    label: 'Ministero dell’agricoltura, dell’ambiente e dello spazio',
  },
  {
    pattern: /\bFederal Office for Foreign Policy(?:\s*\(UPEP\))?(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Federal Office for Foreign Policy (UPEP)',
  },
  {
    pattern: /\b(?:Swiss )?Federal Statistical Office\s*\(IFS\)(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Federal Statistical Office (IFS)',
  },
  {
    pattern: /\bBundesamt für (?:Außen|Aussen)politik(?:\s*\(UPEP\))?(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Bundesamt für Außenpolitik (UPEP)',
  },
  {
    pattern: /\bBundesamt für Statistik\s*\(IFS\)(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Bundesamt für Statistik (IFS)',
  },
  {
    pattern: /\bOffice fédéral de la politique étrangère(?:\s*\(UPEP\))?(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Office fédéral de la politique étrangère (UPEP)',
  },
  {
    pattern: /\bOffice fédéral de la statistique\s*\(IFS\)(?=$|[^\p{L}\p{N}_])/iu,
    label: 'Office fédéral de la statistique (IFS)',
  },
];

function checkConfirmedFabricatedInstitutionNames(text: string): string[] {
  return FABRICATED_INSTITUTION_NAME_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
}

const MAX_REPORTED_FABRICATED_INSTITUTIONS = 20;

interface ConfirmedFabricatedInstitutionOffender {
  articleId: string;
  locale: string;
  name: string;
}

function formatConfirmedFabricatedInstitutionOffenders(
  total: number,
  offenders: readonly ConfirmedFabricatedInstitutionOffender[],
): string {
  const reported = offenders.slice(0, MAX_REPORTED_FABRICATED_INSTITUTIONS);
  return [
    `Found ${total} confirmed fabricated institution name(s).`,
    `First ${reported.length} of ${total}:`,
    ...reported.map(
      ({ articleId, locale, name }) =>
        ` - article=${articleId}; locale=${locale}; name=${name}`,
    ),
  ].join('\n');
}

const LOCALE_INSTITUTION_NOUN: Record<string, string> = {
  en: String.raw`(?:Office|Offices|Agency|Department|Commission|Institute|Authority|Secretariat|Directorate|Administration|Observatory|Bureau)`,
  de: String.raw`(?:[A-Za-zÄÖÜäöüß]*(?:amt|amtes|amts)|Departement|Departements|Kommission|Institut|Instituts|Behörde|Sekretariat|Sekretariats|Direktion|Verwaltung|Agentur)`,
  fr: String.raw`(?:Office|Offices|Agence|Département|Commission|Institut|Autorité|Secrétariat|Direction|Administration|Observatoire|Bureau)`,
};

function localeFabricatedInstitutions(locale: string, text: string): string[] {
  const noun = LOCALE_INSTITUTION_NOUN[locale];
  if (!noun) return [];
  const re = new RegExp(String.raw`(?<!\p{L})${noun}(?!\p{L})[^().\n]{0,80}?\(([A-Z]{2,8})\)`, 'gu');
  const hits: string[] = [];
  for (const match of text.matchAll(re)) {
    if (FABRICATED_INSTITUTION_ACRONYMS.has(match[1])) hits.push(match[0].trim());
  }
  return hits;
}

function normalizeObserverText(text: string): string {
  return text
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('it-CH');
}

const SWISS_FEDERAL_OFFICE_NAMES = [
  "Ufficio federale dell'agricoltura",
  "Ufficio federale dell'ambiente",
  "Ufficio federale dell'armamento",
  "Ufficio federale dell'aviazione civile",
  "Ufficio federale dell'energia",
  "Ufficio federale dell'informatica e della telecomunicazione",
  'Ufficio federale della cibersicurezza',
  'Ufficio federale della comunicazione',
  'Ufficio federale della cultura',
  'Ufficio federale della dogana e della sicurezza dei confini',
  'Ufficio federale della formazione professionale e della tecnologia',
  'Ufficio federale della migrazione',
  'Ufficio federale della proprietà intellettuale',
  'Ufficio federale della protezione della popolazione',
  'Ufficio federale della sanità pubblica',
  'Ufficio federale della sicurezza alimentare e di veterinaria',
  'Ufficio federale della statistica',
  'Ufficio federale delle abitazioni',
  'Ufficio federale delle assicurazioni sociali',
  'Ufficio federale delle comunicazioni',
  'Ufficio federale delle costruzioni e della logistica',
  'Ufficio federale delle dogane',
  'Ufficio federale delle migrazioni',
  'Ufficio federale delle strade',
  'Ufficio federale dei trasporti',
  'Ufficio federale di giustizia',
  'Ufficio federale di meteorologia',
  'Ufficio federale di meteorologia e climatologia',
  'Ufficio federale di polizia',
  'Ufficio federale di statistica',
  'Ufficio federale di topografia',
  'Ufficio federale del personale',
  'Ufficio federale del servizio civile',
  'Ufficio federale dello sport',
  "Ufficio federale per l'approvvigionamento economico",
  "Ufficio federale per l'armamento",
  'Ufficio federale per la formazione professionale e la tecnologia',
  'Ufficio federale per la migrazione',
  'Ufficio federale per la parità fra donna e uomo',
  'Ufficio federale per la protezione dei dati e la trasparenza',
  'Ufficio federale per la protezione della popolazione',
  'Ufficio federale per la sicurezza alimentare e di veterinaria',
  'Ufficio federale per la sicurezza informatica',
  'Ufficio federale per le pari opportunità',
  'Ufficio federale per le questioni spaziali',
  'Ufficio federale per lo sviluppo territoriale',
  "Ufficio federale per l'uguaglianza fra donna e uomo",
].map(normalizeObserverText);

const FOREIGN_MINISTRY_MARKER = /\b(?:italian[oa]|frances[ei]|francese|tedesc[oa]|austriac[oa]|europe[oa]|spagnol[oa]|britannic[oa]|belg[ia]|olandese|portoghes[ei]|statunitens[ei]|american[oa])\b/i;

interface InstitutionObserverEntry {
  id: string;
  text: string;
}

function scanSwissInstitutionCandidates(entries: InstitutionObserverEntry[]) {
  const unlistedOfficeIds = new Set<string>();
  const unlistedMinistryIds = new Set<string>();
  const officeRe = /\bUfficio federale\b[^.!?;\n]{0,100}/gi;
  const ministryRe = /\bMinistero\b[^.!?;\n]{0,100}/gi;

  for (const entry of entries) {
    const text = unescapeTsString(entry.text);
    for (const match of text.matchAll(officeRe)) {
      const candidate = normalizeObserverText(match[0])
        .replace(/\s+\([^)]*\).*/, '')
        .trim();
      if (!SWISS_FEDERAL_OFFICE_NAMES.some(name => candidate.startsWith(name))) {
        unlistedOfficeIds.add(entry.id);
      }
    }
    for (const match of text.matchAll(ministryRe)) {
      const candidate = normalizeObserverText(match[0]);
      if (
        !/^ministero pubblico della confederazione\b/i.test(candidate)
        && !FOREIGN_MINISTRY_MARKER.test(candidate)
      ) {
        unlistedMinistryIds.add(entry.id);
      }
    }
  }

  const overlap = [...unlistedOfficeIds].filter(id => unlistedMinistryIds.has(id)).length;
  return {
    filesScanned: entries.length,
    unlistedOfficeArticles: unlistedOfficeIds.size,
    unlistedSwissMinistryArticles: unlistedMinistryIds.size,
    candidateArticles: new Set([...unlistedOfficeIds, ...unlistedMinistryIds]).size,
    overlap,
  };
}

const SWISS_INSTITUTION_OBSERVER_BASELINE = Object.freeze({
  filesScanned: 2641,
  unlistedOfficeArticles: 98,
  unlistedSwissMinistryArticles: 70,
  candidateArticles: 164,
  overlap: 4,
});

describe('article fabrication guard', () => {
  const files = getArticleFiles();
  const fileTexts = files.map(file => ({ ...file, text: extractTextContent(file.path) }));
  const itFiles = files.filter(file => file.locale === 'it');
  const itTexts = fileTexts.filter(file => file.locale === 'it');
  const swissChItTexts = fileTexts.filter(file => file.id.startsWith('blog-body-ch/it/'));

  it('should have blog body files to check (a sparse checkout must not pass vacuously)', () => {
    expect(itFiles.length).toBeGreaterThan(3000);
  });

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no fabricated institutions',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of FABRICATED_INSTITUTIONS) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Fabricated institutions found in ${_id}`).toEqual([]);
    }
  );

  it('rejects curated fabricated institution acronyms in every Italian body', () => {
    const offenders: string[] = [];
    for (const { id, text } of itTexts) {
      for (const issue of checkFabricatedInstitutionAcronyms(unescapeTsString(text))) {
        if (issue.code === 'fabricated-institution') offenders.push(`${id}: ${issue.evidence}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('rejects confirmed fabricated institution names in every locale', () => {
    let offenderCount = 0;
    const offenders: ConfirmedFabricatedInstitutionOffender[] = [];
    for (const file of fileTexts) {
      for (const evidence of checkConfirmedFabricatedInstitutionNames(unescapeTsString(file.text))) {
        offenderCount += 1;
        if (offenders.length < MAX_REPORTED_FABRICATED_INSTITUTIONS) {
          offenders.push({ articleId: file.id, locale: file.locale, name: evidence });
        }
      }
    }
    expect(
      offenderCount,
      formatConfirmedFabricatedInstitutionOffenders(offenderCount, offenders),
    ).toBe(0);
  }, 60_000);

  it('bounds confirmed-fabrication failure diagnostics', () => {
    const offenders = Array.from(
      { length: MAX_REPORTED_FABRICATED_INSTITUTIONS + 1 },
      (_, index) => ({
        articleId: `blog-body/it/article-${index}`,
        locale: 'it',
        name: `Fabricated Institution ${index}`,
      }),
    );
    const report = formatConfirmedFabricatedInstitutionOffenders(21, offenders);

    expect(report).toContain('Found 21 confirmed fabricated institution name(s).');
    expect(report).toContain('article=blog-body/it/article-19; locale=it; name=Fabricated Institution 19');
    expect(report).not.toContain('article=blog-body/it/article-20');
  });

  it('recognises each translated confirmed-fabrication fixture', () => {
    const fixtures = [
      'Ufficio federale per la politica estera (UPEP), Istituto federale di statistica (IFS), Ministero dell’agricoltura, dell’ambiente e dello spazio',
      'Federal Office for Foreign Policy (UPEP) and Swiss Federal Statistical Office (IFS)',
      'Bundesamt für Außenpolitik (UPEP) und Bundesamt für Statistik (IFS)',
      'Office fédéral de la politique étrangère (UPEP) et Office fédéral de la statistique (IFS)',
    ];
    for (const fixture of fixtures) {
      expect(checkConfirmedFabricatedInstitutionNames(fixture).length).toBeGreaterThan(0);
    }
  });

  it('rejects curated fabricated institution acronyms in translated bodies', () => {
    const offenders: string[] = [];
    for (const file of fileTexts) {
      if (file.locale === 'it') continue;
      for (const evidence of localeFabricatedInstitutions(file.locale, unescapeTsString(file.text))) {
        offenders.push(`${file.id}: ${evidence}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises translated denylist matches without rejecting real institutions', () => {
    expect(localeFabricatedInstitutions('en', 'established by the Federal Office of Switzerland (OFOS) and')).toEqual(['Office of Switzerland (OFOS)']);
    expect(localeFabricatedInstitutions('de', 'die Website des Bundesamtes für Rechtsangelegenheiten (UJF) zu')).toEqual(['Bundesamtes für Rechtsangelegenheiten (UJF)']);
    expect(localeFabricatedInstitutions('fr', "établie par l'Office fédéral de la Suisse (OFOS) et")).toEqual(['Office fédéral de la Suisse (OFOS)']);
    expect(localeFabricatedInstitutions('en', 'the Federal Tax Administration (AFC) publishes')).toEqual([]);
    expect(localeFabricatedInstitutions('de', 'das Bundesamt für Gesundheit (BAG) publiziert')).toEqual([]);
  });

  it('distinguishes allowlisted and suspicious Swiss institution names', () => {
    const report = scanSwissInstitutionCandidates([
      {
        id: 'invented',
        text: 'Ufficio federale per la politica estera (UPEP). Ministero dell’agricoltura, dell’ambiente e dello spazio.',
      },
      {
        id: 'real',
        text: 'Ufficio federale di statistica (UST). Ministero pubblico della Confederazione.',
      },
      {
        id: 'foreign',
        text: 'Ministero della Salute italiana.',
      },
    ]);
    expect(report.unlistedOfficeArticles).toBe(1);
    expect(report.unlistedSwissMinistryArticles).toBe(1);
  });

  it('measures suspicious Swiss institution candidates without allowing class growth', () => {
    const report = scanSwissInstitutionCandidates(swissChItTexts);
    expect(report.filesScanned).toBeGreaterThan(2600);
    expect(report.unlistedOfficeArticles).toBeLessThanOrEqual(SWISS_INSTITUTION_OBSERVER_BASELINE.unlistedOfficeArticles);
    expect(report.unlistedSwissMinistryArticles).toBeLessThanOrEqual(SWISS_INSTITUTION_OBSERVER_BASELINE.unlistedSwissMinistryArticles);
    expect(report.candidateArticles).toBeLessThanOrEqual(SWISS_INSTITUTION_OBSERVER_BASELINE.candidateArticles);
    expect(report.overlap).toBeLessThanOrEqual(SWISS_INSTITUTION_OBSERVER_BASELINE.overlap);
  });

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no fabricated acronyms',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of FABRICATED_ACRONYMS) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Fabricated acronyms found in ${_id}`).toEqual([]);
    }
  );

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no known incorrect facts',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of INCORRECT_FACTS) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Incorrect facts found in ${_id}`).toEqual([]);
    }
  );

  it.each(files.map(f => [f.id, f.path, f.locale]))(
    '%s — no fabricated "federal labour office" institution (real: SECO)',
    (_id, filePath, locale) => {
      const pattern = FABRICATED_LABOR_OFFICE[locale as string];
      if (!pattern) return;
      const text = extractTextContent(filePath as string);
      expect(pattern.test(text), `Fabricated "federal labour office" (real: SECO) found in ${_id}`).toBe(false);
    }
  );

  it.each(files.map(f => [f.id, f.path, f.locale]))(
    '%s — dates the Italy-Switzerland Convention 9 March 1976, not 9 December',
    (_id, filePath, locale) => {
      const pattern = WRONG_CONVENTION_DATE[locale as string];
      if (!pattern) return;
      const text = extractTextContent(filePath as string);
      expect(pattern.test(text), `Convention dated 9 December 1976 (it is 9 March 1976) in ${_id}`).toBe(false);
    }
  );

  it.each(itFiles.map(f => [f.id, f.path]))(
    '%s — no vague sourcing with precise statistics',
    (_id, filePath) => {
      const text = extractTextContent(filePath as string);
      const violations: string[] = [];
      for (const { pattern, desc } of VAGUE_SOURCING) {
        if (pattern.test(text)) violations.push(desc);
      }
      expect(violations, `Vague sourcing found in ${_id}`).toEqual([]);
    }
  );
});
