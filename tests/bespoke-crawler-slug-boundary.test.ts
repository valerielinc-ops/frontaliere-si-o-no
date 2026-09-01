import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { captureLostSlugs } from '../scripts/lib/dedicated-crawler-common.mjs';
import { slugify as slugifyAlpiq } from '../scripts/lib/alpiq-job-parser.mjs';
import { slugify as slugifyCasale } from '../scripts/lib/casale-job-parser.mjs';
import { slugify as slugifyBellinzona } from '../scripts/lib/citta-di-bellinzona-job-parser.mjs';
import { slugify as slugifyLocarno } from '../scripts/lib/citta-di-locarno-job-parser.mjs';
import { normalizeGreenhouseJob } from '../scripts/lib/ats-clients/greenhouse-client.mjs';
import { extractSuccessFactorsJobIdentity } from '../scripts/lib/ats-clients/successfactors-client.mjs';
import { extractWorkdayJobIdentity } from '../scripts/lib/ats-clients/workday-client.mjs';
import { repairBurkhalterBoundarySlugs } from '../scripts/lib/burkhalter-slug-boundary-repair.mjs';
import { truncateSlugAtWordBoundary } from '../scripts/lib/slug-truncate.mjs';

const SCRIPTS_DIR = path.resolve(process.cwd(), 'scripts');
const PARSER_DIR = path.join(SCRIPTS_DIR, 'lib');
const UPDATE_SCRIPT_RE = /^update-.*-jobs\.mjs$/;
const LOCAL_SLUG_FUNCTION_RE = /^slugify/i;

type LocalSlugFunction = {
  file: string;
  source: string;
  text: string;
};

function localSlugFunctions(): LocalSlugFunction[] {
  const functions: LocalSlugFunction[] = [];

  for (const file of fs.readdirSync(SCRIPTS_DIR).filter((name) => UPDATE_SCRIPT_RE.test(name))) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    const visit = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node)
        && node.name
        && LOCAL_SLUG_FUNCTION_RE.test(node.name.text)
      ) {
        functions.push({ file, source, text: node.getText(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return functions;
}

function namedFunctionSource(file: string, name: string): { source: string; text: string } {
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let text = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(sourceFile);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { source, text };
}

function dedicatedParserSlugFunctions(): LocalSlugFunction[] {
  const functions: LocalSlugFunction[] = [];

  for (const file of fs.readdirSync(PARSER_DIR).filter((name) => name.endsWith('-job-parser.mjs'))) {
    const source = fs.readFileSync(path.join(PARSER_DIR, file), 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && LOCAL_SLUG_FUNCTION_RE.test(node.name.text)) {
        functions.push({ file: `lib/${file}`, source, text: node.getText(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return functions;
}

describe('bespoke crawler slug boundary fan-out (#6786)', () => {
  it('routes all 43 capped bespoke slug functions through the shared boundary helper', () => {
    const functions = localSlugFunctions();
    const lastminute = functions.filter(({ file }) => file === 'update-lastminute-jobs.mjs');
    const capped = functions.filter(({ file }) => file !== 'update-lastminute-jobs.mjs');

    // The original inventory was 44 local slug functions. Lastminute is the
    // single false positive: it never imposed a hard length cap.
    expect(functions).toHaveLength(44);
    expect(lastminute).toHaveLength(1);
    expect(lastminute[0].text).not.toMatch(/\.(?:slice|substring)\s*\(/);

    expect(capped).toHaveLength(43);
    for (const entry of capped) {
      expect(entry.source, entry.file).toContain(
        "import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';",
      );
      expect(entry.text, entry.file).toContain('truncateSlugAtWordBoundary(');
      expect(entry.text, entry.file).not.toMatch(/\.(?:slice|substring)\s*\(/);
    }
  });

  it('also removes raw truncation from the AXA stable-suffix builder', () => {
    const file = 'update-axa-jobs.mjs';
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let builder = '';

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildAxaRegeneratedSlug') {
        builder = node.getText(sourceFile);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(builder).toContain('truncateSlugAtWordBoundary(baseSlug, baseMaxLen)');
    expect(builder).not.toMatch(/baseSlug\.(?:slice|substring)\s*\(/);
  });

  it('routes every genuine pre-push sibling through the same helper', () => {
    const siblings = [
      ['cleanup-jobs.mjs', 'disambiguateDedupLoser'],
      ['update-eoc-jobs.mjs', 'buildEocRegeneratedSlug'],
      ['update-swisscom-jobs.mjs', 'buildSwisscomRegeneratedSlug'],
      ['lib/ats-clients/workday-client.mjs', 'slugifyTitle'],
      ['lib/helsinn-job-parser.mjs', 'slugify'],
      ['lib/interroll-job-parser.mjs', 'slugify'],
      ['lib/julius-baer-job-parser.mjs', 'slugify'],
      ['lib/linnea-job-parser.mjs', 'slugify'],
      ['lib/lonza-job-parser.mjs', 'slugify'],
      ['lib/mikron-job-parser.mjs', 'slugify'],
      ['lib/sintetica-job-parser.mjs', 'slugify'],
      ['lib/swiss-medical-network-job-parser.mjs', 'slugify'],
      ['lib/vir-biotechnology-job-parser.mjs', 'slugify'],
      ['lib/zambon-job-parser.mjs', 'slugify'],
    ];

    expect(siblings).toHaveLength(14);
    for (const [file, functionName] of siblings) {
      const entry = namedFunctionSource(file, functionName);
      expect(entry.text, `${file}:${functionName}`).toContain('truncateSlugAtWordBoundary(');
      expect(entry.text, `${file}:${functionName}`).not.toMatch(/\.(?:slice|substring)\s*\(\s*0\s*,/);
      expect(entry.source, file).toContain('slug-truncate.mjs');
    }
  });

  it('routes every capped dedicated parser slug writer through the shared helper', () => {
    const functions = dedicatedParserSlugFunctions();
    const capped = functions.filter(({ text }) => text.includes('truncateSlugAtWordBoundary('));
    const rawPrefixCuts = functions.filter(({ text }) => /\.(?:slice|substring)\s*\(\s*0\s*,/.test(text));

    // 67 writers migrated here plus PWC, which already used the invariant.
    expect(capped).toHaveLength(68);
    expect(rawPrefixCuts.map(({ file }) => file)).toEqual([]);
    for (const entry of capped) {
      expect(entry.source, entry.file).toContain("from './slug-truncate.mjs'");
    }
  });

  it('keeps representative dedicated normalization, custom suffixes and caps compatible', () => {
    expect(slugifyAlpiq('Ingénieur R&D – Zürich')).toBe('ingenieur-r-d-zurich');
    expect(slugifyCasale('Senior Energy Engineer', 'R-42')).toBe('senior-energy-engineer-R-42');

    const long = `${'enterprise platform engineering '.repeat(10)}architect`;
    const normalized = long.toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    expect(slugifyAlpiq(long)).toBe(truncateSlugAtWordBoundary(normalized, 180));
    expect(slugifyCasale(long, 'R-42')).toBe(
      truncateSlugAtWordBoundary(`${normalized}-R-42`, 180),
    );
  });

  it('preserves municipal stable suffixes while enforcing the 90-character cap', () => {
    const title = `${'responsabile infrastrutture digitali '.repeat(5)}senior`;
    const suffix = 'concorso-2026-0042';
    const expected = `${truncateSlugAtWordBoundary(
      title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      90 - suffix.length - 1,
    )}-${suffix}`;

    for (const slugify of [slugifyBellinzona, slugifyLocarno]) {
      expect(slugify(title, suffix)).toBe(expected);
      expect(slugify(title, suffix)).toBe(slugify(title, suffix));
      expect(slugify(title, suffix).length).toBeLessThanOrEqual(90);
      expect(slugify(title, suffix)).toMatch(/-concorso-2026-0042$/);
    }
  });

  it('keeps ABB fallback URL slugs deterministic and capped at a token boundary', () => {
    const entry = namedFunctionSource('update-abb-jobs.mjs', 'deriveAbbDetailSlug');
    const deriveAbbDetailSlug = new Function(
      'truncateSlugAtWordBoundary',
      'normalize',
      `${entry.text}; return deriveAbbDetailSlug;`,
    )(
      truncateSlugAtWordBoundary,
      (value: string) => String(value || '').trim().toLowerCase(),
    ) as (job: { title?: string; applyUrl?: string }) => string;
    const title = `${'Global R&D Engineering Platform '.repeat(8)}Architect`;
    const first = deriveAbbDetailSlug({ title });

    expect(first).toBe(truncateSlugAtWordBoundary(
      title.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      140,
    ));
    expect(first.length).toBeLessThanOrEqual(140);
    expect(deriveAbbDetailSlug({ title })).toBe(first);
    expect(deriveAbbDetailSlug({
      title: 'Renamed title',
      applyUrl: 'https://careers.abb/global/en/job/123/Stable-Route_R12345/apply',
    })).toBe('Stable-Route');
  });

  it('routes Greenhouse and SuccessFactors normalization through the same boundary policy', () => {
    const title = `${'enterprise platform engineering '.repeat(10)}architect`;
    const greenhouse = normalizeGreenhouseJob({
      id: 42,
      title,
      location: { name: 'Zürich' },
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/42',
    }, { companyName: 'ACME' });
    const successFactors = extractSuccessFactorsJobIdentity({
      jobReqId: 'R-42',
      title,
      location: 'Zürich',
      applyUrl: 'https://jobs.example/jobs/42',
    }, { company: 'ACME' });

    expect(greenhouse).toMatchObject({
      jobReqId: '42',
      company: 'ACME',
      location: 'Zürich',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/42',
    });
    expect(successFactors).toMatchObject({
      jobReqId: 'R-42',
      company: 'ACME',
      location: 'Zürich',
      applyUrl: 'https://jobs.example/jobs/42',
    });
    expect(greenhouse.slug).toBe(truncateSlugAtWordBoundary(
      title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      200,
    ));
    expect(successFactors.slug).toBe(truncateSlugAtWordBoundary(
      `${title} ACME Zürich`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-'),
      180,
    ));
  });

  it('ratchets the complete 118-file crawler writer inventory to zero raw prefix cuts', () => {
    const localCapped = localSlugFunctions()
      .filter(({ file }) => file !== 'update-lastminute-jobs.mjs');
    const dedicatedMigrated = dedicatedParserSlugFunctions()
      .filter(({ file, text }) => file !== 'lib/pwc-job-parser.mjs'
        && text.includes('truncateSlugAtWordBoundary('));
    const sharedAndNonConstant = [
      ['cleanup-jobs.mjs', 'disambiguateDedupLoser'],
      ['update-eoc-jobs.mjs', 'buildEocRegeneratedSlug'],
      ['update-swisscom-jobs.mjs', 'buildSwisscomRegeneratedSlug'],
      ['lib/ats-clients/workday-client.mjs', 'slugifyTitle'],
      ['lib/ats-clients/greenhouse-client.mjs', 'inlineSlugify'],
      ['lib/ats-clients/successfactors-client.mjs', 'slugify'],
      ['update-abb-jobs.mjs', 'deriveAbbDetailSlug'],
      ['update-fust-jobs.mjs', 'appendStableSlugSuffix'],
    ].map(([file, name]) => ({ file, ...namedFunctionSource(file, name) }));
    const inventory = [...localCapped, ...dedicatedMigrated, ...sharedAndNonConstant];

    expect(localCapped).toHaveLength(43);
    expect(dedicatedMigrated).toHaveLength(67);
    expect(sharedAndNonConstant).toHaveLength(8);
    expect(new Set(inventory.map(({ file }) => file)).size).toBe(118);
    expect(inventory.filter(({ text }) => /\.(?:slice|substring)\s*\(\s*0\s*,/.test(text)))
      .toEqual([]);
  });
});

describe('Workday shared client compatibility', () => {
  it('keeps all 17 direct parser consumers on the shared 19-call identity boundary', () => {
    const consumers = fs.readdirSync(PARSER_DIR)
      .filter((file) => file.endsWith('-job-parser.mjs'))
      .map((file) => ({ file, source: fs.readFileSync(path.join(PARSER_DIR, file), 'utf8') }))
      .filter(({ source }) => source.includes("from './ats-clients/workday-client.mjs'"));
    const callCount = consumers.reduce((total, { source }) => (
      total + (source.match(/extractWorkdayJobIdentity\s*\(/g)?.length || 0)
    ), 0);

    expect(consumers).toHaveLength(17);
    expect(callCount).toBe(19);
    for (const { file, source } of consumers) {
      expect(source, file).toMatch(/import\s*\{[\s\S]*extractWorkdayJobIdentity[\s\S]*\}\s*from '\.\/ats-clients\/workday-client\.mjs'/);
    }
  });

  it('preserves normalization and identity fields for the shared fan-out', () => {
    const identity = extractWorkdayJobIdentity({
      title: 'Ingénieur R&D – Zürich',
      externalPath: '/job/Zurich/123',
      locationsText: 'Zürich - ZH, Switzerland',
      bulletFields: ['R-123'],
    }, {
      apiBase: 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers',
      company: 'ACME',
      slugSuffix: 'acme-ch',
    });

    expect(identity).toMatchObject({
      jobReqId: 'R-123',
      slug: 'ingenieur-r-d-zurich-acme-ch',
      title: 'Ingénieur R&D – Zürich',
      location: 'Zürich',
      company: 'ACME',
      externalPath: '/job/Zurich/123',
    });
    expect(identity.applyUrl).toBe('https://acme.wd3.myworkdayjobs.com/en/Careers/job/Zurich/123');
  });

  it('caps long shared output at a deterministic token boundary', () => {
    const posting = {
      title: `${'enterprise platform engineering '.repeat(12)}architect`,
      externalPath: '/job/Zurich/long-role',
      location: 'Zürich',
      jobReqId: 'R-LONG',
    };
    const first = extractWorkdayJobIdentity(posting, { slugSuffix: 'shared-workday' });
    const second = extractWorkdayJobIdentity(posting, { slugSuffix: 'shared-workday' });

    expect(first.slug.length).toBeLessThanOrEqual(200);
    expect(first.slug).toBe(second.slug);
    expect(first.slug).toMatch(/[a-z0-9]$/);
    expect(first.slug).not.toMatch(/(?:enterp|platf|enginee|archit)$/);
  });
});

describe('Burkhalter live regression (#6786)', () => {
  const normalizeSlug = (value: string) => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const liveInputs = [
    'Chef de chantier / Cheffe de chantier – Installations électriques (100%)-Sedelec Yverdon, succursale de Sedelec SA Lausanne-Yverdon-Les-Bains',
    'monteur-automaticien CFC / monteuse-automaticienne CFC (80 - 100%)-C2B Electrotechnique, succursale de Grichting & Valterio Electro SA-Martigny',
    'Bauleitende Elektroinstallateure/innen (80 - 100%)-Elektro Christoffel, ZNL der Caviezel AG-Davos Platz',
  ].map(normalizeSlug);

  it('eliminates all three reported mid-token endings', () => {
    const results = liveInputs.map((value) => truncateSlugAtWordBoundary(value, 120));

    expect(results).toEqual([
      'chef-de-chantier-cheffe-de-chantier-installations-electriques-100-sedelec-yverdon-succursale-de-sedelec-sa-lausanne',
      'monteur-automaticien-cfc-monteuse-automaticienne-cfc-80-100-c2b-electrotechnique-succursale-de-grichting-valterio',
      'bauleitende-elektroinstallateure-innen-80-100-elektro-christoffel-znl-der-caviezel-ag-davos-platz',
    ]);
    expect(results.some((slug) => /(?:yverd|electr|davos-pl)$/.test(slug))).toBe(false);
  });

  it('removes the observed hard-cut collision deterministically', () => {
    const variants = [
      "Dépanneur installateur électricien avec CFC / Dépanneuse installatrice électricienne avec CFC (100%)-Mérinat S.A., succursale de Lausanne-Lausanne",
      "Dépanneur installateur électricien avec CFC / Dépanneuse installatrice électricienne avec CFC (100%)-Mérinat S.A., succursale d'Attalens-Attalens",
    ].map(normalizeSlug);

    expect(new Set(variants.map((value) => value.slice(0, 120))).size).toBe(1);
    const firstRun = variants.map((value) => truncateSlugAtWordBoundary(value, 120));
    const secondRun = variants.map((value) => truncateSlugAtWordBoundary(value, 120));
    expect(new Set(firstRun).size).toBe(2);
    expect(secondRun).toEqual(firstRun);
  });

  it('preserves the replaced active route once across repeated merges', () => {
    const legacySlug = liveInputs[0].slice(0, 120);
    const currentSlug = truncateSlugAtWordBoundary(liveInputs[0], 120);
    const job = {
      id: 'burkhalter-group-95b7122a1cc3',
      url: 'https://www.burkhalter.ch/en/jobs-and-careers/moechten-sie-bei-uns-arbeiten/detail/chef-de-chantier-cheffe-de-chantier-installations-electriques-1663',
      slug: currentSlug,
      slugByLocale: { it: currentSlug },
      previousSlugs: [] as string[],
    };

    captureLostSlugs(job, { it: legacySlug }, legacySlug, 20);
    captureLostSlugs(job, { it: legacySlug }, legacySlug, 20);

    expect(job.id).toBe('burkhalter-group-95b7122a1cc3');
    expect(job.url).toContain('installations-electriques-1663');
    expect(job.previousSlugs.filter((slug) => slug === legacySlug)).toHaveLength(1);
    expect(job.previousSlugs).not.toContain(currentSlug);
  });

  it('migrates persisted localized prefixes without changing identity and is idempotent', () => {
    const title = 'Construction manager / Construction manager impianti elettrici (100%)';
    const full = normalizeSlug(`${title}-Sedelec Yverdon, succursale de Sedelec SA Lausanne-Yverdon-Les-Bains`);
    const legacySlug = full.slice(0, 120);
    const job = {
      id: 'burkhalter-group-95b7122a1cc3',
      url: 'https://www.burkhalter.ch/jobs/detail/1663',
      title: 'Chef de chantier / Cheffe de chantier – Installations électriques (100%)',
      titleByLocale: { it: title },
      company: 'Sedelec Yverdon, succursale de Sedelec SA Lausanne',
      location: 'Yverdon-Les-Bains',
      addressLocality: 'Yverdon-Les-Bains',
      sourceLang: 'fr',
      slug: legacySlug,
      slugByLocale: { it: legacySlug },
      previousSlugs: [] as string[],
      previousSlugsByLocale: {} as Record<string, string[]>,
    };

    expect(repairBurkhalterBoundarySlugs(job)).toBe(2);
    expect(job.id).toBe('burkhalter-group-95b7122a1cc3');
    expect(job.url).toBe('https://www.burkhalter.ch/jobs/detail/1663');
    expect(job.slug).toBe(truncateSlugAtWordBoundary(full, 120));
    expect(job.slugByLocale.it).toBe(job.slug);
    expect(job.previousSlugsByLocale.it).toContain(legacySlug);
    expect(repairBurkhalterBoundarySlugs(job)).toBe(0);
    expect(job.previousSlugsByLocale.it.filter((slug) => slug === legacySlug)).toHaveLength(1);
  });

  it('does not rewrite an unrelated stable slug or a complete token at the cap', () => {
    const title = `${'complete-'.repeat(20)}ending`;
    const unrelated = {
      title,
      titleByLocale: { it: title },
      company: 'Burkhalter Group',
      location: 'Zürich',
      slug: 'published-stable-route',
      slugByLocale: { it: 'published-stable-route' },
    };
    const completeToken = `${'a'.repeat(119)}b`;
    const alreadyValid = {
      ...unrelated,
      title: completeToken,
      titleByLocale: { it: completeToken },
      company: 'next',
      location: '',
      slug: completeToken,
      slugByLocale: { it: completeToken },
    };

    expect(repairBurkhalterBoundarySlugs(unrelated)).toBe(0);
    expect(unrelated.slug).toBe('published-stable-route');
    expect(repairBurkhalterBoundarySlugs(alreadyValid)).toBe(0);
    expect(alreadyValid.slug).toBe(completeToken);
  });
});
