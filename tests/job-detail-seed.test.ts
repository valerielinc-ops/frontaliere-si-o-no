import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SLIM_INDEX_FIELDS, buildLocaleJob, buildSlimSeed } from '../build-plugins/shared/slimJobIndex';
import { inlineScriptJson } from '../build-plugins/shared/inlineJsonScript';
import { readBuildPluginSource } from './helpers/buildPluginSource';

const root = path.resolve(__dirname, '..');

/**
 * Per-job seed (2026-06-05): active job-detail pages inject window.__JOB_SEED__
 * (a slim job record) so the SPA resolves `selectedJob` on the first paint and
 * fetches only /data/job-detail/<id>.json (~2-4 KB gzip) for the body — instead
 * of blocking the detail render on the ~1.2 MB (gzip) slim index.
 *
 * The seed MUST be byte-shape-identical to a jobs-<locale>-index.json entry, so
 * both are built from one shared module (build-plugins/shared/slimJobIndex).
 */
describe('Per-job detail seed (window.__JOB_SEED__)', () => {
  const sampleJob = {
    id: 'kulm-675',
    slug: 'assistant-front-office-it',
    slugByLocale: { it: 'assistant-front-office-it', de: 'assistant-front-office-de' },
    titleByLocale: { it: 'Assistant IT', de: 'Assistant DE' },
    title: 'Assistant base',
    company: 'Kulm Hotel',
    location: 'St. Moritz',
    canton: 'GR',
    category: 'hospitality',
    salaryMin: 50000,
    salaryMax: 60000,
    currency: 'CHF',
    // detail-only — must NOT leak into the slim seed:
    description: 'A very long description that belongs in the per-job file only.',
    descriptionByLocale: { it: 'descrizione lunga', de: 'lange Beschreibung' },
    requirements: ['a', 'b', 'c'],
    baseSalary: { value: { minValue: 50000, maxValue: 60000, currency: 'CHF' } },
    streetAddress: 'Via Maistra 1',
    postalCode: '7500',
  };

  describe('shared slimJobIndex.buildSlimSeed', () => {
    it('flattens *ByLocale into the requested locale', () => {
      const seed = buildSlimSeed(sampleJob, 'de');
      expect(seed.title).toBe('Assistant DE');
      expect(seed.slug).toBe('assistant-front-office-de');
    });

    it('falls back to base fields when the locale is missing', () => {
      const seed = buildSlimSeed({ id: 'x', slug: 's', title: 'Base only', company: 'C' }, 'fr');
      expect(seed.title).toBe('Base only');
      expect(seed.slug).toBe('s');
    });

    it('keeps only SLIM_INDEX_FIELDS — never detail-only payload', () => {
      const seed = buildSlimSeed(sampleJob, 'it');
      for (const key of Object.keys(seed)) {
        expect(SLIM_INDEX_FIELDS.has(key)).toBe(true);
      }
      // Detail-only fields that would bloat the inline <script> must be absent.
      expect(seed).not.toHaveProperty('description');
      expect(seed).not.toHaveProperty('descriptionByLocale');
      expect(seed).not.toHaveProperty('requirements');
      expect(seed).not.toHaveProperty('baseSalary');
      expect(seed).not.toHaveProperty('streetAddress');
      expect(seed).not.toHaveProperty('postalCode');
    });

    it('carries the header/JSON-LD identification fields the detail view reads', () => {
      const seed = buildSlimSeed(sampleJob, 'it');
      for (const key of ['id', 'company', 'location', 'canton', 'category', 'salaryMin', 'salaryMax', 'currency']) {
        expect(seed).toHaveProperty(key);
      }
    });

    it('buildLocaleJob and buildSlimSeed agree on the slim subset', () => {
      const full = buildLocaleJob(sampleJob, 'it');
      const seed = buildSlimSeed(sampleJob, 'it');
      for (const key of Object.keys(seed)) {
        expect(seed[key]).toEqual(full[key]);
      }
    });
  });

  describe('single source of truth (no drift)', () => {
    it('localeJobsSplitPlugin imports the field set from shared, does not redefine it', () => {
      const src = fs.readFileSync(path.resolve(root, 'build-plugins/localeJobsSplitPlugin.ts'), 'utf-8');
      expect(src).toMatch(/from '\.\/shared\/slimJobIndex'/);
      // The local copy must be gone — only one SLIM_INDEX_FIELDS definition in the repo (the shared one).
      expect(src).not.toMatch(/const SLIM_INDEX_FIELDS\s*=/);
    });

    it('jobsSeoPagesPlugin builds the seed via the shared helper', () => {
      const src = fs.readFileSync(path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');
      expect(src).toMatch(/import \{ buildSlimSeed \} from '\.\/shared\/slimJobIndex'/);
      expect(src).toMatch(/buildSlimSeed\(job, locale\)/);
    });
  });

  describe('inline <script> JSON escaping (class fix)', () => {
    // Single source of truth for the raw-JSON-LD scanner — used both by the
    // whole-class build-plugin scan and by its own non-leakiness proof. Returns
    // the banned shapes present in one source string. A shape is "raw" when
    // arbitrary content reaches a `<script type="application/ld+json">` tag via
    // `JSON.stringify` (does NOT escape `<`) instead of inlineScriptJson /
    // escapeInlineScript. Hardened in #1672 to cover the `.map(…).join(…)` `sd`
    // builder and non-`Ld`-suffixed direct-emit vars (`ldJsonStr`/`sd`).
    const rawJsonLdShapes = (src: string): string[] => {
      const shapes: string[] = [];
      // 1. inline  `application/ld+json">${JSON.stringify(...)}`
      if (/application\/ld\+json">\$\{JSON\.stringify/.test(src)) shapes.push('inline-stringify');
      // 2. a var   `const *Ld / *JsonLd = JSON.stringify(...)` (adjacent assign)
      if (/const\s+[A-Za-z]*(?:Ld|JsonLd) = JSON\.stringify\(/.test(src)) shapes.push('var-ld-stringify');
      // 3. multi-block `.map(x => JSON.stringify(x)).join('…ld+json…')`. `[^;]`
      //    keeps the match inside ONE statement so the translate-then-`.join(sep)`
      //    path (a separate `.map` and `.join` statement) is not a false positive.
      if (/\.map\([^;]*?JSON\.stringify[^;]*?\)\.join\([^;]*?ld\+json/.test(src)) shapes.push('map-join-stringify');
      // 4. any var emitted DIRECTLY into `application/ld+json">${X}</script>` (a
      //    hand-rolled tag bypassing htmlTemplate's escapeInlineScript choke
      //    point) MUST be escape-built — regardless of name suffix. Catches
      //    `ldJsonStr`/`sd`-style names shape (2) misses. Vars only `.push`ed onto
      //    `jsonLdScripts` are NOT direct-emitted, so their raw JSON.stringify
      //    (escaped centrally) is correctly ignored.
      const EMIT = /application\/ld\+json">\$\{([A-Za-z_$][\w$]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = EMIT.exec(src)) !== null) {
        const ident = m[1];
        const assign = new RegExp(`(?:const|let)\\s+${ident}\\s*=\\s*(?![^;]*inlineScriptJson)[^;]*?JSON\\.stringify\\(`);
        if (assign.test(src)) shapes.push(`direct-emit-raw:${ident}`);
      }
      // 5. member-expression emit `${seoData.sd}` (#1672 escalation). Shape 4's
      //    EMIT captured only a bare `${ident}`, never `${obj.prop}`, so a member
      //    field emitted directly into a hand-rolled tag was invisible. The non-IT
      //    `sd`-translation path rebuilds `locSeo.sd` via split(sep) → map(part =>
      //    translate + re-serialize) → join(sep): shape 3 also misses it because the
      //    map body is multi-statement and the join separator is a variable (not a
      //    literal `ld+json`). Flag a member-expr ld+json emit when the file ALSO
      //    re-serializes inside a map callback with a RAW JSON.stringify (the escape
      //    downgrade). The escaped form (`return inlineScriptJson(obj)`) leaves no
      //    `return JSON.stringify` in a map → silent. A safe member-expr emit whose
      //    field is escape-built does not false-positive (no raw map re-stringify).
      const memberLdEmit = /application\/ld\+json">\$\{[A-Za-z_$][\w$]*\.[\w$.]+\}/.test(src);
      const mapReturnsRawStringify = /\.map\(\s*\(?[\w$,\s]*\)?\s*=>\s*\{[\s\S]{0,600}?return\s+JSON\.stringify\(/.test(src);
      if (memberLdEmit && mapReturnsRawStringify) shapes.push('member-emit-map-raw-stringify');
      return shapes;
    };

    it('inlineScriptJson neutralises "<" so a "</script>" in the payload cannot break out', () => {
      const payload = { title: 'Dev </script><img src=x>', desc: 'a < b' };
      const out = inlineScriptJson(payload);
      expect(out).not.toContain('</script>');
      expect(out).not.toMatch(/<(?!\\u003c)/); // no raw '<' survives
      expect(JSON.parse(out.replace(/\\u003c/g, '<'))).toEqual(payload); // still valid JSON
    });

    it('no inline window.__*__ emit anywhere uses a raw JSON.stringify (non-leaky: scans every build-plugin + the offload script)', () => {
      // A raw emit = `window.__X__=${JSON.stringify(ident)}` closed immediately
      // (no `.replace(/</g,…)` and not via inlineScriptJson). This catches the
      // whole class repo-wide — the previous guard only read one file, so the
      // og/bridge/cdn siblings stayed raw while it passed.
      const RAW = /window\.__[A-Z_]+__=\$\{JSON\.stringify\([\w.[\]]+\)\}/;
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...walk(full));
          else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
        }
        return out;
      };
      const files = [
        ...walk(path.resolve(root, 'build-plugins')),
        path.resolve(root, 'scripts/offload-generated-images-cdn.mjs'),
      ];
      const offenders = files.filter((f) => RAW.test(fs.readFileSync(f, 'utf-8')));
      expect(offenders).toEqual([]);
      // And the three arbitrary-content sites specifically go through the escape.
      const og = readBuildPluginSource(path.resolve(root, 'build-plugins/ogPagesPlugin.ts'));
      expect(og).toMatch(/window\.__ARTICLE_TITLE__=\$\{inlineScriptJson\(localizedTitle\)\}/);
      const jp = fs.readFileSync(path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');
      expect(jp).toMatch(/const expiredWindowData = inlineScriptJson\(expiredDataObj\)/);
      expect(jp).toMatch(/window\.__JOB_SEED__=\$\{inlineScriptJson\(/);
    });

    it('jobsSeoPagesPlugin emits NO raw JSON-LD: every <script type="application/ld+json"> payload is escaped', () => {
      // The job-detail page carries the most arbitrary JSON-LD payload (title/
      // company). Both forms must be neutralised: inline `${JSON.stringify(...)}`
      // in the tag, and `const *Ld = JSON.stringify(...)` vars emitted into one.
      const jp = fs.readFileSync(path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');
      expect(jp).not.toMatch(/application\/ld\+json">\$\{JSON\.stringify/);
      expect(jp).not.toMatch(/const [A-Za-z]*Ld = JSON\.stringify\(/);
    });

    it('the shared HTML shell escapes JSON-LD centrally (covers seoPageShell consumers)', () => {
      const tpl = fs.readFileSync(path.resolve(root, 'build-plugins/htmlTemplate.ts'), 'utf-8');
      expect(tpl).toMatch(/jsonLdScripts\.map\(ld =>[\s\S]{0,80}escapeInlineScript\(ld\)/);
    });

    it('NO build-plugin emits raw JSON-LD into a <script> tag (whole-class scan, #1515 + #1672)', () => {
      // Class fix for #1515: any `<script type="application/ld+json">${X}</script>`
      // where X is data-controlled (job title/company/desc, GSC queries, article
      // prose) can break out of the script context if the JSON contains a literal
      // `</script`. JSON.stringify does NOT escape `<`; inlineScriptJson /
      // escapeInlineScript (`<`→`<`, valid JSON, Google-parsed) do.
      //
      // Scanned across EVERY build-plugin (not one file — the previous guard read
      // only jobsSeoPagesPlugin, so ~8 sibling plugins stayed raw while it passed).
      // The banned shapes live in `rawJsonLdShapes` (shared with the
      // non-leakiness proof below). Detector hardened in #1672 to also cover the
      // `.map(…JSON.stringify…).join(…ld+json…)` `sd` builder and non-`Ld`-suffixed
      // vars (`ldJsonStr`/`sd`) emitted directly into a tag.
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...walk(full));
          else if (/\.ts$/.test(e.name)) out.push(full);
        }
        return out;
      };
      const files = walk(path.resolve(root, 'build-plugins'));
      const offenders = files
        .map((f) => ({ file: path.relative(root, f), shapes: rawJsonLdShapes(fs.readFileSync(f, 'utf-8')) }))
        .filter((o) => o.shapes.length > 0);
      expect(offenders).toEqual([]);
    });

    it('the raw-JSON-LD scanner is itself non-leaky (#1672): it fires on every banned shape and stays silent on the escaped form', () => {
      // The previous guard was shape-specific — it would have stayed GREEN on a
      // future emit using `.map(…).join(…)` or a non-`Ld`-suffixed var. Prove the
      // hardened detector catches each offender shape AND does not false-positive
      // on its correctly-escaped sibling. Without this, a leaky regex passes on the
      // regression it is supposed to block (the exact failure mode of #1672).

      // (1) inline ${JSON.stringify}
      expect(rawJsonLdShapes('x = `<script type="application/ld+json">${JSON.stringify(jobLd)}</script>`'))
        .toContain('inline-stringify');
      expect(rawJsonLdShapes('x = `<script type="application/ld+json">${inlineScriptJson(jobLd)}</script>`'))
        .toEqual([]);

      // (2) `const *Ld = JSON.stringify(...)`
      expect(rawJsonLdShapes('const jobLd = JSON.stringify(obj);')).toContain('var-ld-stringify');
      expect(rawJsonLdShapes('const jobLd = inlineScriptJson(obj);')).toEqual([]);

      // (3) `.map(x => JSON.stringify(x)).join('…ld+json…')` — the multi-block `sd`
      // builder. The real code maps through inlineScriptJson; a swap to
      // JSON.stringify must be caught.
      const SEP = '</scr' + 'ipt>\\n <script type="application/ld+json">';
      expect(rawJsonLdShapes(
        `sd = parsed.map((item) => JSON.stringify(item)).join('${SEP}');`,
      )).toContain('map-join-stringify');
      expect(rawJsonLdShapes(
        `sd = parsed.map((item) => inlineScriptJson(item)).join('${SEP}');`,
      )).toEqual([]);
      // The translate-then-join path (separate `.map` and `.join` statements) is
      // intentionally NOT a false positive — the join target is a `sdSeparator`
      // variable on its own statement, not an inline `ld+json` literal.
      expect(rawJsonLdShapes(
        'const t = parts.map((p) => JSON.stringify(p));\nsd = t.join(sdSeparator);',
      )).toEqual([]);

      // (3b) the real `sd`-translation path (#1672 escalation): split → map(part =>
      // multi-statement translate + re-serialize) → join(variableSep), emitted via a
      // member-expr `${seoData.sd}`. A RAW re-stringify inside the map MUST fire;
      // swapping it for inlineScriptJson MUST go silent; and a safe member-expr emit
      // with no raw map re-stringify MUST NOT false-positive.
      const sdMap = (serialize: string) =>
        `const translated = sdParts.map((part) => {\n  const obj = JSON.parse(part);\n  translateSchema(obj, lang);\n  return ${serialize}(obj);\n});\n locSeo.sd = translated.join(sdSeparator);\n h = \`<script type="application/ld+json">\${seoData.sd}</script>\`;`;
      expect(rawJsonLdShapes(sdMap('JSON.stringify'))).toContain('member-emit-map-raw-stringify');
      expect(rawJsonLdShapes(sdMap('inlineScriptJson'))).toEqual([]);
      expect(
        rawJsonLdShapes('h = `<script type="application/ld+json">${seoData.sd}</script>`;'),
      ).toEqual([]);

      // (4) a non-`Ld`-suffixed var emitted DIRECTLY into a tag must be escaped.
      // `ldJsonStr` / `sd` end in neither `Ld` nor `JsonLd`, so shape (2) misses
      // them — the direct-emit taint check catches them by emission site instead.
      expect(rawJsonLdShapes(
        'const ldJsonStr = JSON.stringify(ldObj);\nh = `<script type="application/ld+json">${ldJsonStr}</script>`;',
      )).toContain('direct-emit-raw:ldJsonStr');
      expect(rawJsonLdShapes(
        'const ldJsonStr = inlineScriptJson(ldObj);\nh = `<script type="application/ld+json">${ldJsonStr}</script>`;',
      )).toEqual([]);
      // A raw `JSON.stringify` var that is NOT direct-emitted but pushed onto the
      // `jsonLdScripts` choke point (escaped centrally in htmlTemplate) is correct
      // and must stay silent — mirrors nursing/orphanQuery `itemListLd`, whose
      // real (ternary, non-adjacent-assign) shape evades the name-based shape (2)
      // and is not direct-emitted, so shape (4) is silent too.
      expect(rawJsonLdShapes(
        'const itemListLd = jobs.length > 0\n  ? JSON.stringify(obj)\n  : null;\njsonLdScripts.push(itemListLd);',
      )).toEqual([]);
    });
  });

  describe('jobsSeoPagesPlugin emit', () => {
    const src = fs.readFileSync(path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');

    it('injects window.__JOB_SEED__ as an inline script', () => {
      expect(src).toMatch(/window\.__JOB_SEED__=/);
    });

    it('forces the seed slug to the canonical per-locale slug (bridge-safe)', () => {
      expect(src).toMatch(/__jobSeed\.slug = perLocaleSlug\[locale\]/);
    });

    it('places the seed before the SPA action-redirect script', () => {
      const seedIdx = src.indexOf('${seedScript}');
      const spaIdx = src.indexOf('${SPA_ACTION_REDIRECT_SCRIPT}');
      expect(seedIdx).toBeGreaterThan(0);
      expect(spaIdx).toBeGreaterThan(0);
      expect(seedIdx).toBeLessThan(spaIdx);
    });
  });

  describe('JobBoard consumption', () => {
    const src = fs.readFileSync(path.resolve(root, 'components/community/JobBoard.tsx'), 'utf-8');

    it('reads window.__JOB_SEED__ via readSeededJob (memoised, keyed on the route)', () => {
      expect(src).toMatch(/window as unknown as Record<string, unknown>\)\.__JOB_SEED__/);
      // Memoised — the global must NOT be re-read on every render. That was and
      // remains the point of this assertion.
      expect(src).toMatch(/const seededJob = useMemo\(\(\) => readSeededJob\(\), \[[^\]]*\]\)/);
      // ...but NOT with an empty dep list (PR #5328). __JOB_SEED__ is an inline
      // script belonging to ONE job-detail document and is never cleared by SPA
      // navigation, so a `[]` memo pinned the seed for the whole session: the
      // previous job got prepended to a later listing via `finalize`, and the
      // load effect took the requestIdleCallback branch on pages where the index
      // is the above-the-fold content. Keyed on the route, the pathname guard in
      // readSeededJob can actually fire.
      expect(src).not.toMatch(/const seededJob = useMemo\(\(\) => readSeededJob\(\), \[\]\)/);
      expect(src).toMatch(/const seededJob = useMemo\(\(\) => readSeededJob\(\), \[initialJobSlug\]\)/);
    });

    it('seeds the initial jobs state with the build-injected record', () => {
      // The job-detail seed keeps PRECEDENCE in the initializer: this is what
      // makes `selectedJob` resolve on the first frame of a detail page.
      expect(src).toMatch(/useState<JobListing\[\]>\(\(\) => \(seededJob \? \[seededJob\] : /);
      // The else-branch is no longer `[]`: a related-search cluster landing
      // carries its own build seed (window.__SEARCH_SEED__, see
      // services/clusterSearchSeed.ts) and seeds the array with the result set
      // the page was emitted with. The two never collide — a document carries
      // one or the other — and the order above states which wins if one ever
      // did. Pinned so replacing it is a decision, not a diff nobody read.
      expect(src).toMatch(/useState<JobListing\[\]>\(\(\) => \(seededJob \? \[seededJob\] : clusterSeedJobs\)\)/);
    });

    it('re-applies fetched detail in finalize so the full-index load does not clobber it', () => {
      expect(src).toMatch(/resolvedJobDetail\.get\(j\.id\)/);
    });

    it('keeps the seed in finalize when the loaded shard lacks it (no orphan flash at jobsLoading===false)', () => {
      expect(src).toMatch(/seededJob\?\.id && !reEnriched\.some\(\(j\) => j\.id === seededJob\.id\)/);
      expect(src).toMatch(/setJobs\(finalJobs\)/);
    });

    it('renders a seeded active detail immediately instead of the jobsLoading loader', () => {
      // Without this the unconditional `if (jobsLoading) return <loader>` masks
      // the seed until the full index lands — the seed would be dead weight.
      // The loader/skeleton returns must be gated behind `!seededActiveDetail`
      // so a seeded active detail falls through to the real render.
      expect(src).toMatch(/const seededActiveDetail = selectedJob && initialJobSlug/);
      const guardIdx = src.indexOf('if (!seededActiveDetail) {');
      // Generic listing fallback (<SkeletonJobBoard /> — replaced the old
      // centered Loader2 spinner) must stay gated behind !seededActiveDetail.
      const loaderIdx = src.indexOf('<SkeletonJobBoard />');
      expect(guardIdx).toBeGreaterThan(0);
      expect(loaderIdx).toBeGreaterThan(guardIdx);
    });

    it('falls back to slug→live-id resolution when the baked seed id 404s (stale __JOB_SEED__ id drift)', () => {
      // A crawled job whose source URL rotates gets a fresh buildStableId, so the
      // already-deployed page's window.__JOB_SEED__ carries an id that no longer
      // exists in the regenerated /data/job-detail/<id>.json → 404 → empty body →
      // the detail view shows the generic "scovato nel monitoraggio" placeholder
      // behind the unlock gate. The resilient fetch must retry with the CURRENT id
      // resolved from the live slug map (slug → id) before giving up.
      expect(src).toMatch(/async function fetchJobDetailResilient\(jobId: string, slug\?: string \| null\)/);
      // On a miss it loads the slug's shard (#3526: per-slug, not the full
      // monolith) and resolves the live id from the slug.
      expect(src).toMatch(/await ensureJobSlugEntriesLoaded\(\[slug\]\)/);
      expect(src).toMatch(/const liveId = getJobMetaForSlug\(slug\)\?\.id/);
      // Only retries when the resolved id actually differs (avoids a redundant 404).
      expect(src).toMatch(/if \(!liveId \|\| liveId === jobId\) return primary/);
      expect(src).toMatch(/return fetchJobDetail\(liveId\)/);
    });

    it('the detail-enrichment effect uses the resilient fetch with the slug (not the bare seed id)', () => {
      expect(src).toMatch(/const selectedJobSlug = selectedJob\?\.slug \?\? null/);
      expect(src).toMatch(/fetchJobDetailResilient\(selectedJobId, selectedJobSlug\)/);
      // slug must be in the effect deps so a slug change re-runs resolution.
      expect(src).toMatch(/\}, \[selectedJobId, selectedJobSlug\]\)/);
    });
  });
});
