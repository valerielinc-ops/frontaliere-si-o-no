/**
 * Generate static HTML landing pages for every URL in the sitemaps.
 *
 * For each Italian URL in sitemap-pages.xml / sitemap-glossario.xml, creates
 * a full static HTML page with SEO metadata, structured data, hreflang
 * alternates, and the SPA entry bundle for client-side hydration.
 * Also generates locale variants (en/de/fr) from hreflang data.
 */

import type { Plugin } from 'vite';
import { BASE_URL, buildFlatRedirect } from './constants';
import { buildArticleSeoSections, cleanupArticleBodySections } from './articleSeoFallback';
import { SECTION_EDITORIAL, SECTION_EDITORIAL_KEYS } from './editorialContent';
import { translateFaqPage } from '../services/seo/faq-translations';

const HOME_CRITICAL_STATIC_PATHS = new Set([
  '/',
  '/en/',
  '/de/',
  '/fr/',
  '/calcola-stipendio/',
  '/calculate-salary/',
  '/gehalt-berechnen/',
  '/calculer-salaire/',
  '/cerca-lavoro-ticino/',
  '/en/find-jobs-ticino/',
  '/de/jobs-im-tessin/',
  '/fr/trouver-emploi-tessin/',
]);

function isHomeCriticalStaticPath(urlPath: string): boolean {
  return HOME_CRITICAL_STATIC_PATHS.has(urlPath);
}

export function staticPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'static-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const fs = await import('node:fs');
      const np = await import('node:path');

      const distDir  = np.resolve(rootDir, 'dist');

      /* ── Buffered write system ── */
      const _pw: { p: string; c: string }[] = [];
      const _dirs = new Set<string>();
      function _qw(filePath: string, content: string) {
        const dir = np.dirname(filePath);
        if (!_dirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); _dirs.add(dir); }
        _pw.push({ p: filePath, c: content });
      }
      async function _flush() {
        const B = 300;
        for (let i = 0; i < _pw.length; i += B) {
          await Promise.all(_pw.slice(i, i + B).map(w => fs.promises.writeFile(w.p, w.c, 'utf-8')));
        }
      }

      /* ── 0. Find entry JS/CSS bundle + Italian locale chunk ────── */
      // IMPORTANT: Extract from Vite-generated index.html to get the correct entry
      // (multiple index-*.js chunks exist; find() would pick the wrong one)
      const assetsDir = np.join(distDir, 'assets');
      let entryJs = '', entryCss = '', vendorReactChunk = '';
      try {
        const builtHtml = fs.readFileSync(np.join(distDir, 'index.html'), 'utf-8');
        entryJs = builtHtml.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)?.[1] ?? '';
        entryCss = builtHtml.match(/href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/)?.[1] ?? '';
      } catch { /* index.html missing */ }
      let itCriticalChunks: string[] = [];
      try {
        const assetFiles = fs.readdirSync(assetsDir);
        itCriticalChunks = assetFiles.filter((f: string) =>
          /^it-(core|calculator)-[A-Za-z0-9_-]+\.js$/.test(f) && !f.endsWith('.js.map')
        );
        vendorReactChunk = assetFiles.find((f: string) => f.startsWith('vendor-react-') && f.endsWith('.js') && !f.endsWith('.js.map')) ?? '';
      } catch { /* assets dir missing — will fall back to redirect */ }

      const hasSpaBundle = !!(entryJs && entryCss);
      if (!hasSpaBundle) console.warn('[static-pages] Could not find entry JS/CSS bundles — falling back to redirect');
      const corePreloads = [
        vendorReactChunk ? `<link rel="modulepreload" crossorigin href="/assets/${vendorReactChunk}">` : '',
        ...itCriticalChunks.map(c => `<link rel="modulepreload" href="/assets/${c}">`),
      ].filter(Boolean).join('\n    ');
      const preloadTag = corePreloads ? '\n    ' + corePreloads : '';

      /* ── 0b. Build page-component modulepreload map ────────────── */
      // Maps URL path prefixes → component chunk filename prefixes so static HTML
      // can add <link rel="modulepreload"> for the lazy chunk the page will need.
      // This eliminates the sequential waterfall: critical JS → discover lazy → load lazy
      // and instead downloads the page chunk in parallel with the entry bundle.
      type ChunkMap = Record<string, string[]>;
      const sectionChunks: ChunkMap = {
        'compara-servizi': ['CurrencyExchange', 'HealthInsurance', 'BankComparison'],
        'compare-services': ['CurrencyExchange', 'HealthInsurance', 'BankComparison'],
        'dienste-vergleichen': ['CurrencyExchange', 'HealthInsurance', 'BankComparison'],
        'comparer-services': ['CurrencyExchange', 'HealthInsurance', 'BankComparison'],
        'guida-frontaliere': ['FrontierGuide'],
        'frontier-guide': ['FrontierGuide'],
        'grenzgaenger-leitfaden': ['FrontierGuide'],
        'guide-frontalier': ['FrontierGuide'],
        'glossario-frontaliere': ['Glossary'],
        'domande-frequenti-frontalieri': ['FaqSection'],
        'tasse-e-pensione': ['PensionPlanner', 'TaxCalendar'],
        'taxes-and-pension': ['PensionPlanner', 'TaxCalendar'],
        'steuern-und-rente': ['PensionPlanner', 'TaxCalendar'],
        'impots-et-retraite': ['PensionPlanner', 'TaxCalendar'],
        'calcola-stipendio': ['InputCard'],
        'calculate-salary': ['InputCard'],
        'gehalt-berechnen': ['InputCard'],
        'calculer-salaire': ['InputCard'],
        'statistiche': ['StatsView'],
        'statistics': ['StatsView'],
        'statistiken': ['StatsView'],
        'statistiques': ['StatsView'],
        'vivere-in-ticino': ['CostOfLiving'],
        'living-in-ticino': ['CostOfLiving'],
        'leben-im-tessin': ['CostOfLiving'],
        'vivre-au-tessin': ['CostOfLiving'],
        'articoli-frontaliere': ['BlogArticles'],
        'cross-border-articles': ['BlogArticles'],
        'frontier-articles': ['BlogArticles'],
        'grenzgaenger-artikel': ['BlogArticles'],
        'articles-frontalier': ['BlogArticles'],
        'mappa-del-sito': ['SiteMapPage'],
        'cerca-lavoro-ticino': ['JobBoard'],
        'find-jobs-ticino': ['JobBoard'],
        'jobs-im-tessin': ['JobBoard'],
        'trouver-emploi-tessin': ['JobBoard'],
      };
      // Also map locale-specific translation chunks per section
      const sectionLocaleChunks: Record<string, string> = {
        'compara-servizi': 'comparatori', 'compare-services': 'comparatori',
        'dienste-vergleichen': 'comparatori', 'comparer-services': 'comparatori',
        'guida-frontaliere': 'guide', 'frontier-guide': 'guide',
        'grenzgaenger-leitfaden': 'guide', 'guide-frontalier': 'guide',
        'glossario-frontaliere': 'guide', 'domande-frequenti-frontalieri': 'guide',
        'tasse-e-pensione': 'fisco', 'taxes-and-pension': 'fisco',
        'steuern-und-rente': 'fisco', 'impots-et-retraite': 'fisco',
        'calcola-stipendio': 'calculator', 'calculate-salary': 'calculator',
        'gehalt-berechnen': 'calculator', 'calculer-salaire': 'calculator',
        'statistiche': 'stats', 'statistics': 'stats',
        'statistiken': 'stats', 'statistiques': 'stats',
        'vivere-in-ticino': 'vita', 'living-in-ticino': 'vita',
        'leben-im-tessin': 'vita', 'vivre-au-tessin': 'vita',
        'articoli-frontaliere': 'stats', 'cross-border-articles': 'stats', 'frontier-articles': 'stats',
        'grenzgaenger-artikel': 'stats', 'articles-frontalier': 'stats',
        'cerca-lavoro-ticino': 'stats', 'find-jobs-ticino': 'stats',
        'jobs-im-tessin': 'stats', 'trouver-emploi-tessin': 'stats',
      };

      let assetFiles: string[] = [];
      try { assetFiles = fs.readdirSync(assetsDir); } catch { /* ignore */ }

      // Resolve a component name prefix to its hashed chunk filename
      const resolveChunk = (prefix: string): string | undefined =>
        assetFiles.find((f: string) => f.startsWith(prefix + '-') && f.endsWith('.js') && !f.endsWith('.js.map'));

      // Build modulepreload tags for a given URL path
      // FRO-330: Extract blog article data from blog-articles-data.ts for hero image + SSG article cards
      let blogHeroImageStatic = '';
      interface StaticArticle { id: string; category: string; date: string; image: string }
      let blogArticlesStatic: StaticArticle[] = [];
      try {
        const blogDataSrc = fs.readFileSync(np.resolve(rootDir, 'data', 'blog-articles-data.ts'), 'utf-8');
        const articleBlocks = [...blogDataSrc.matchAll(/\{\s*id:\s*'([^']+)',\s*category:\s*'([^']+)',\s*date:\s*'([^']+)',\s*image:\s*'([^']+)'/gs)];
        blogArticlesStatic = articleBlocks.map(m => ({ id: m[1], category: m[2], date: m[3], image: m[4] }));
        blogArticlesStatic.sort((a, b) => b.date.localeCompare(a.date));
        if (blogArticlesStatic.length) {
          blogHeroImageStatic = blogArticlesStatic[0].image;
        }
      } catch { /* non-fatal */ }

      const blogSlugs = new Set(['articoli-frontaliere', 'cross-border-articles', 'frontier-articles', 'grenzgaenger-artikel', 'articles-frontalier']);
      const blogArticleIdByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = {
        it: {},
        en: {},
        de: {},
        fr: {},
      };

      try {
        const routerBlogDataSrc = fs.readFileSync(np.resolve(rootDir, 'services/routerBlogData.ts'), 'utf-8');
        const rx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
        let match: RegExpExecArray | null;
        while ((match = rx.exec(routerBlogDataSrc)) !== null) {
          blogArticleIdByLocale.it[match[2]] = match[1];
          blogArticleIdByLocale.en[match[3]] = match[1];
          blogArticleIdByLocale.de[match[4]] = match[1];
          blogArticleIdByLocale.fr[match[5]] = match[1];
        }
      } catch { /* non-fatal */ }

      // FRO-330: Build reverse map article_id → locale_slug for SSG article cards
      const articleIdToSlug: Record<string, Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        for (const [slug, id] of Object.entries(blogArticleIdByLocale[locale])) {
          articleIdToSlug[locale][id] = slug;
        }
      }

      const parseBlogBodyLocale = (locale: 'it' | 'en' | 'de' | 'fr') => {
        const out: Record<string, { body1?: string; body2?: string; body3?: string }> = {};
        const dir = np.resolve(rootDir, 'services', 'locales', 'blog-body', locale);
        let files: string[] = [];
        try { files = fs.readdirSync(dir); } catch { return out; }
        const rx = /'blog\.article\.([^']+)\.(body1|body2|body3)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
        const unescapeTsString = (value: string): string =>
          value
            .replace(/\\'/g, '\'')
            .replace(/\\"/g, '"')
            .replace(/\\n/g, ' ')
            .replace(/\\r/g, '')
            .replace(/\\t/g, ' ')
            .replace(/\\\\/g, '\\');
        for (const file of files) {
          if (!file.endsWith('.ts')) continue;
          let src = '';
          try { src = fs.readFileSync(np.join(dir, file), 'utf-8'); } catch { continue; }
          let match: RegExpExecArray | null;
          while ((match = rx.exec(src)) !== null) {
            const articleId = match[1];
            const field = match[2] as 'body1' | 'body2' | 'body3';
            if (!out[articleId]) out[articleId] = {};
            out[articleId][field] = unescapeTsString(match[3]);
          }
        }
        return out;
      };

      const blogBodyByLocale = {
        it: parseBlogBodyLocale('it'),
        en: parseBlogBodyLocale('en'),
        de: parseBlogBodyLocale('de'),
        fr: parseBlogBodyLocale('fr'),
      } as const;

      const getPagePreloads = (urlPath: string, locale: string): string => {
        const segs = urlPath.split('/').filter(Boolean);
        const localePrefixes = ['en', 'de', 'fr'];
        const firstSeg = (segs.length > 0 && localePrefixes.includes(segs[0])) ? (segs[1] ?? '') : (segs[0] ?? '');
        if (!firstSeg) return '';

        const tags: string[] = [];
        const componentPrefixes = sectionChunks[firstSeg];
        if (componentPrefixes) {
          for (const prefix of componentPrefixes) {
            const chunk = resolveChunk(prefix);
            if (chunk) tags.push(`<link rel="modulepreload" href="/assets/${chunk}">`);
          }
        }
        // Add locale-specific translation chunk (e.g., it-guide-xxx.js)
        const localeChunkKey = sectionLocaleChunks[firstSeg];
        if (localeChunkKey) {
          const localeChunk = assetFiles.find((f: string) =>
            f.startsWith(`${locale}-${localeChunkKey}-`) && f.endsWith('.js') && !f.endsWith('.js.map')
          );
          if (localeChunk) tags.push(`<link rel="modulepreload" href="/assets/${localeChunk}">`);
        }
        // Preload blog hero image on article listing pages
        if (blogHeroImageStatic && blogSlugs.has(firstSeg)) {
          tags.push(`<link rel="preload" as="image" fetchpriority="high" href="${blogHeroImageStatic}">`);
        }
        return tags.length ? '\n    ' + tags.join('\n    ') : '';
      };

      // Critical CSS (same as asyncCssPlugin) for non-render-blocking loading
      const criticalCSS = '@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/inter-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}*,::after,::before{box-sizing:border-box;border:0 solid #e5e7eb}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}.bg-slate-50{background-color:#f8fafc}.dark .dark\\:bg-slate-950,.dark.bg-slate-950{background-color:#020617}.text-slate-900{color:#0f172a}.dark .dark\\:text-slate-100{color:#f1f5f9}#root{min-height:100vh}';

      /* ── 1. Parse sitemap sub-files for all URLs with hreflang ── */
      let sitemapSrc: string;
      try {
        // sitemap.xml is now an index — read all sub-sitemaps
        const sitemapFiles = ['sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-glossario.xml'];
        sitemapSrc = sitemapFiles.map(f => {
          try { return fs.readFileSync(np.resolve(rootDir, 'public', f), 'utf-8'); }
          catch { return ''; }
        }).join('\n');
      } catch {
        console.warn('[static-pages] Could not read sitemap files — skipping');
        return;
      }

      // Extract all <url> blocks
      interface SitemapUrl {
        loc: string;
        path: string;   // normalized path without trailing slash
        canonicalPath: string; // normalized path with trailing slash
        hreflangs: { lang: string; href: string }[];
        priority: string;
      }

      const urls: SitemapUrl[] = [];
      const urlBlockRx = /<url>([\s\S]*?)<\/url>/g;
      let um: RegExpExecArray | null;
      while ((um = urlBlockRx.exec(sitemapSrc)) !== null) {
        const block = um[1];
        const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
        if (!loc || !loc.startsWith(BASE_URL)) continue;

        const rawPath = loc.replace(BASE_URL, '') || '/';
        const pathNoSlash = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '');
        const canonicalPath = pathNoSlash === '/' ? '/' : `${pathNoSlash}/`;
        const hreflangs: { lang: string; href: string }[] = [];
        const hlRx = /hreflang="([^"]+)"\s+href="([^"]+)"/g;
        let hm: RegExpExecArray | null;
        while ((hm = hlRx.exec(block)) !== null) {
          hreflangs.push({ lang: hm[1], href: hm[2] });
        }
        const priority = block.match(/<priority>([^<]+)<\/priority>/)?.[1] ?? '0.5';

        urls.push({ loc, path: pathNoSlash, canonicalPath, hreflangs, priority });
      }

      /* ── 2. Parse SEO metadata from seoService.ts + chunk files ─ */
      // After code-splitting, SEO entries live across multiple files:
      // - services/seoService.ts (core ~90 entries)
      // - services/seo/seo-blog.ts (blog ~270 entries)
      // - services/seo/seo-landing.ts (landing ~23 entries)
      const seoFiles = [
        np.resolve(rootDir, 'services/seoService.ts'),
        np.resolve(rootDir, 'services/seo/seo-pages.ts'),
        np.resolve(rootDir, 'services/seo/seo-blog.ts'),
        np.resolve(rootDir, 'services/seo/seo-blog-2.ts'),
        np.resolve(rootDir, 'services/seo/seo-landing.ts'),
      ];
      let seoSrc = '';
      for (const sf of seoFiles) {
        try {
          seoSrc += fs.readFileSync(sf, 'utf-8') + '\n';
        } catch {
          console.warn(`[static-pages] Could not read ${np.basename(sf)} — skipping`);
        }
      }
      if (!seoSrc) {
        console.warn('[static-pages] No SEO source files found — skipping');
        return;
      }

      // Build a map: canonicalPath → { title, desc, ogTitle, ogDesc, structuredData }
      interface SeoEntry { title: string; desc: string; ogT: string; ogD: string; sd?: string }
      const seoMap = new Map<string, SeoEntry>();

      // Helper: extract balanced braces/brackets from a string starting at `pos`
      const extractBalanced = (src: string, pos: number): string | null => {
        const open = src[pos];
        const close = open === '{' ? '}' : open === '[' ? ']' : null;
        if (!close) return null;
        let depth = 0;
        let inStr = false;
        let strChar = '';
        for (let j = pos; j < src.length; j++) {
          const c = src[j];
          if (inStr) {
            if (c === '\\') { j++; continue; }
            if (c === strChar) inStr = false;
            continue;
          }
          if (c === "'" || c === '"' || c === '`') { inStr = true; strChar = c; continue; }
          if (c === open) depth++;
          else if (c === close) { depth--; if (depth === 0) return src.substring(pos, j + 1); }
        }
        return null;
      };

      // Helper: convert JS object literal to JSON (handles unquoted keys, single quotes, trailing commas, template literals)
      // Dynamic build date for dateModified freshness signals
      const BUILD_DATE_ISO = new Date().toISOString();

      const jsToJson = (js: string): string => {
        let s = js;
        // Replace BUILD_DATE_ISO variable reference with current build timestamp
        s = s.replace(/\bBUILD_DATE_ISO\b/g, `"${BUILD_DATE_ISO}"`);
        // Replace ${BASE_URL} template literals AND bare BASE_URL variable references
        s = s.replace(/\$\{BASE_URL\}/g, BASE_URL);
        s = s.replace(/\bBASE_URL\b/g, `"${BASE_URL}"`);
        // Replace backtick strings with double-quoted strings
        s = s.replace(/`([^`]*)`/g, (_, content: string) => JSON.stringify(content));
        // Single-pass scanner: convert single-quoted strings to double-quoted,
        // quote unquoted keys, and skip double-quoted string regions.
        // This avoids the apostrophe-in-Italian-text problem where a naive regex
        // would misinterpret l'imposta as a string boundary.
        {
          let out = '';
          let i = 0;
          while (i < s.length) {
            // Skip double-quoted strings verbatim
            if (s[i] === '"') {
              let j = i + 1;
              while (j < s.length) {
                if (s[j] === '\\') { j += 2; continue; }
                if (s[j] === '"') { j++; break; }
                j++;
              }
              out += s.substring(i, j);
              i = j;
              continue;
            }
            // Convert single-quoted strings to double-quoted (only at value positions)
            if (s[i] === "'") {
              let j = i + 1;
              let content = '';
              while (j < s.length) {
                if (s[j] === '\\' && j + 1 < s.length) {
                  const next = s[j + 1];
                  if (next === "'") { content += "'"; j += 2; continue; }
                  content += s[j] + next; j += 2; continue;
                }
                if (s[j] === "'") { j++; break; }
                content += s[j]; j++;
              }
              // Escape double quotes inside the converted string
              const escaped = content.replace(/"/g, '\\"');
              out += `"${escaped}"`;
              i = j;
              continue;
            }
            // Try to match an unquoted key (word followed by :)
            const prev = i > 0 ? s[i - 1] : '\n';
            if (/[{,[\s]/.test(prev)) {
              const m = s.substring(i).match(/^([a-zA-Z_$][\w$]*)(\s*:\s*)/);
              if (m) {
                out += `"${m[1]}"${m[2]}`;
                i += m[0].length;
                continue;
              }
            }
            out += s[i];
            i++;
          }
          s = out;
        }
        // Remove trailing commas before } or ]
        s = s.replace(/,(\s*[}\]])/g, '$1');
        return s;
      };

      // ── Resolve top-level const references in structuredData arrays ──
      // Some entries use e.g. `SALARY_LANDING_FAQ_SCHEMA` variable references
      // instead of inline objects. We extract const definitions here and
      // substitute them later in individual rawSd values (NOT globally in
      // seoSrc, which would corrupt entry parsing).
      const constDefs = new Map<string, string>();
      const constRefRx = /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*/gm;
      let cMatch: RegExpExecArray | null;
      while ((cMatch = constRefRx.exec(seoSrc)) !== null) {
        const constName = cMatch[1];
        const valStart = cMatch.index + cMatch[0].length;
        const constVal = extractBalanced(seoSrc, valStart);
        if (constVal) constDefs.set(constName, constVal);
      }

      // Match entries like: 'key': { ... title: '...', ... canonicalPath: '...' ... }
      // Parse entries by finding top-level keys and their blocks
      // Entry keys can be quoted ('key': {) or unquoted (key: {)
      // Skip known non-entry property names that happen to match the pattern
      const NON_ENTRY_KEYS = new Set([
        'structuredData', 'acceptedAnswer', 'areaServed', 'potentialAction',
        'target', 'offers', 'logo', 'creator', 'spatialCoverage', 'step',
        'itemListElement', 'mainEntity', 'author', 'publisher', 'image',
      ]);
      const entryStartRx = /^\s{2,8}(?:'([^']+)'|([a-zA-Z_]\w*)):\s*\{/gm;
      const entryStarts: { key: string; pos: number }[] = [];
      let esm: RegExpExecArray | null;
      while ((esm = entryStartRx.exec(seoSrc)) !== null) {
        const key = esm[1] ?? esm[2];
        if (NON_ENTRY_KEYS.has(key)) continue;
        entryStarts.push({ key, pos: esm.index });
      }

      // For each entry, extract the block text up to the next entry
      for (let i = 0; i < entryStarts.length; i++) {
        const start = entryStarts[i].pos;
        const end = i + 1 < entryStarts.length ? entryStarts[i + 1].pos : seoSrc.length;
        const block = seoSrc.substring(start, end);

        const cp = block.match(/canonicalPath:\s*'([^']+)'/)?.[1];
        if (!cp) continue;

        // Match title/desc allowing escaped quotes inside single-quoted strings
        const matchStr = (key: string): string => {
          const rx = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
          return block.match(rx)?.[1]?.replace(/\\(.)/g, (_: string, c: string) => c === 'n' ? ' ' : c === 'r' ? '' : c === 't' ? ' ' : c) ?? '';
        };

        const title = matchStr('title');
        const desc  = matchStr('description');
        const ogT   = matchStr('ogTitle') || title;
        const ogD   = matchStr('ogDescription') || desc;

        if (title) {
          // Extract structuredData if present in this entry block
          let sd: string | undefined;
          const sdMatch = block.match(/structuredData:\s*/);
          if (sdMatch && sdMatch.index != null) {
            const sdStart = sdMatch.index + sdMatch[0].length;
            // Find the first { or [ after "structuredData:"
            const firstChar = block.substring(sdStart).match(/[{\[]/);
            if (firstChar && firstChar.index != null) {
              const absPos = sdStart + firstChar.index;
              const rawSd = extractBalanced(block, absPos);
              if (rawSd) {
                // Resolve const references (e.g. SALARY_LANDING_FAQ_SCHEMA) inside rawSd
                let resolvedSd = rawSd;
                for (const [name, value] of constDefs) {
                  resolvedSd = resolvedSd.replace(new RegExp(`(?<=[\\[,\\s])${name}(?=[\\],\\s,;])`, 'g'), value);
                }
                try {
                  const jsonStr = jsToJson(resolvedSd);
                  const parsed = JSON.parse(jsonStr);
                  // Serialize as compact JSON for injection into HTML
                  sd = Array.isArray(parsed)
                    ? parsed.map((item: Record<string, unknown>) => JSON.stringify(item)).join('</script>\n    <script type="application/ld+json">')
                    : JSON.stringify(parsed);
                } catch { /* structured data parse failed — skip SD for this entry */ }
              }
            }
          }
          seoMap.set(cp, { title, desc, ogT, ogD, sd });
        }
      }

      /* ── 2b. Generate dynamic SEO entries for glossary + border crossings ── */
      // These are computed at runtime in seoService.ts via buildPath() — the regex
      // above can't find them.  Replicate the slug logic here.
      let routerSrc = '';
      try {
        routerSrc = fs.readFileSync(np.resolve(rootDir, 'services/router.ts'), 'utf-8');
      } catch { /* ignore */ }

      if (routerSrc) {
        // ─ Glossary terms ─
        const glossaryIdsMatch = routerSrc.match(/ALL_GLOSSARY_TERM_IDS[^=]*=\s*\[([\s\S]*?)\]/);
        if (glossaryIdsMatch) {
          const glossaryIds = glossaryIdsMatch[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) ?? [];

          // Parse IT slug overrides
          const itOverrides: Record<string, string> = {};
          const overrideBlock = routerSrc.match(/GLOSSARY_TERM_SLUG_OVERRIDES[^{]*\{[^{]*it:\s*\{([^}]+)\}/s);
          if (overrideBlock) {
            const pairs = overrideBlock[1].matchAll(/(\w+):\s*'([^']+)'/g);
            for (const p of pairs) itOverrides[p[1]] = p[2];
          }

          // defaultGlossaryTermSlug logic
          const defaultSlug = (id: string) => id
            .replace(/_/g, '-')
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .replace(/([a-zA-Z])(\d)/g, '$1-$2')
            .replace(/(\d)([a-zA-Z])/g, '$1-$2')
            .toLowerCase()
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');

          // titleize logic
          const titleize = (id: string) => {
            let base = id.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/(\d+)/g, ' $1 ').replace(/\s+/g, ' ').trim();
            const acronyms: [RegExp, string][] = [[/\bavs\b/gi,'AVS'],[/\blpp\b/gi,'LPP'],[/\bcu\b/gi,'CU'],[/\bral\b/gi,'RAL'],[/\bssn\b/gi,'SSN'],[/\bsepa\b/gi,'SEPA'],[/\bccnl\b/gi,'CCNL'],[/\bipg\b/gi,'IPG'],[/\bac\b/gi,'AC'],[/\bcmu\b/gi,'CMU'],[/\blamal\b/gi,'LAMal'],[/\bnaspi\b/gi,'NASpI']];
            for (const [rx, rep] of acronyms) base = base.replace(rx, rep);
            return base;
          };

          for (const termId of glossaryIds) {
            const slug = itOverrides[termId] || defaultSlug(termId);
            const cp = `/glossario-frontaliere/${slug}`;
            if (seoMap.has(cp)) continue;  // hand-written entry wins
            const label = titleize(termId);
            seoMap.set(cp, {
              title: `${label} (Glossario) | Frontaliere Ticino`,
              desc: `Definizione e spiegazione di ${label} per frontalieri (Svizzera–Italia): significato, contesto e impatto pratico.`,
              ogT: `${label} (Glossario) | Frontaliere Ticino`,
              ogD: `Definizione e spiegazione di ${label} per frontalieri (Svizzera–Italia): significato, contesto e impatto pratico.`,
            });
          }
        }

        // ─ Border crossings ─
        const crossingIdsMatch = routerSrc.match(/ALL_BORDER_CROSSING_IDS[^=]*=\s*\[([\s\S]*?)\]/);
        if (crossingIdsMatch) {
          const crossingIds = crossingIdsMatch[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) ?? [];
          for (const crossingId of crossingIds) {
            const cp = `/guida-frontaliere/tempi-attesa-dogana/${crossingId}`;
            if (seoMap.has(cp)) continue;
            const label = crossingId.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
            seoMap.set(cp, {
              title: `Traffico valico ${label} | Tempi attesa dogana`,
              desc: `Tempi di attesa e informazioni utili per il valico ${label}: orari, livello traffico tipico e consigli pratici per frontalieri.`,
              ogT: `Traffico valico ${label} | Tempi attesa dogana`,
              ogD: `Tempi di attesa e informazioni utili per il valico ${label}: orari e consigli pratici per frontalieri.`,
            });
          }
        }
      }

      /* ── 3. Generate static pages ──────────────────────────────── */
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
         .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const LOC_TAG: Record<string, string> = { it: 'it_IT', en: 'en_US', de: 'de_DE', fr: 'fr_FR' };

      // ── Locale-aware SEO fallback ─────────────────────────────
      // When no explicit locale SEO entry exists (which is the case for nearly all
      // EN/DE/FR pages), derive locale-appropriate title + description from the
      // URL slug instead of falling back to Italian metadata.
      const LOCALE_HOME: Record<string, { title: string; desc: string }> = {
        en: {
          title: 'Cross-Border Worker Tax Simulator 2026 | Frontaliere Ticino',
          desc: 'Free tax simulation for cross-border workers Switzerland-Italy 2026: calculate net salary, Swiss withholding tax, Italian IRPEF, AVS/LPP pensions.',
        },
        de: {
          title: 'Grenzgänger Steuersimulator 2026 | Frontaliere Ticino',
          desc: 'Kostenlose Steuersimulation für Grenzgänger Schweiz-Italien 2026: Nettolohn berechnen, Quellensteuer Tessin, IRPEF Italien, AHV/BVG.',
        },
        fr: {
          title: 'Simulateur Fiscal Frontalier 2026 | Frontaliere Ticino',
          desc: 'Simulation fiscale gratuite pour frontaliers Suisse-Italie 2026 : calcul salaire net, impôt à la source Tessin, IRPEF Italie, AVS/LPP.',
        },
      };

      const LOCALE_SECTION_TITLES: Record<string, Record<string, string>> = {
        en: {
          'calculate-salary': 'Salary Calculator', 'compare-services': 'Compare Services',
          'taxes-and-pension': 'Taxes & Pensions', 'frontier-guide': 'Cross-Border Guide',
          'living-in-ticino': 'Living in Ticino', 'statistics': 'Statistics',
          'frontier-articles': 'Articles', 'glossary': 'Glossary',
          'cross-border-faq': 'FAQ', 'find-jobs-ticino': 'Jobs in Ticino',
          'site-map': 'Site Map', 'privacy-policy': 'Privacy Policy',
          'weekly-digest': 'Weekly Digest', 'net-salary-simulator': 'Net Salary Simulator',
          'what-if-simulator': 'What-If Simulator', 'currency-exchange': 'Currency Exchange',
          'health-insurance': 'Health Insurance', 'bank-comparison': 'Bank Comparison',
          'pension-planner': 'Pension Planner', 'tax-calendar': 'Tax Calendar',
          'border-waiting-times': 'Border Waiting Times', 'first-day-at-work': 'First Day at Work',
          'work-permits': 'Work Permits', 'permit-b-or-g-quiz': 'Permit B or G Quiz',
          'cost-of-living': 'Cost of Living', 'salary-comparison': 'Salary Comparison',
          'car-cost-calculator': 'Car Cost Calculator', 'salary-quiz': 'Salary Quiz',
          'tax-quiz': 'Tax Quiz', 'third-pillar': 'Third Pillar Simulator',
          'tax-credits': 'Tax Credits', 'income-tax-return': 'Income Tax Return',
          'ticino-holidays': 'Ticino Holidays', 'tax-rebates': 'Tax Rebates',
          'phone-plans': 'Phone Plans', 'shopping-calculator': 'Shopping Calculator',
          'nurseries': 'Nurseries', 'renovations': 'Renovations',
          'border-traffic-history': 'Border Traffic History',
          'good-morning': 'Good Morning',
          'compare-permit-g-vs-b': 'Permit G vs B Comparison',
          'data-deletion': 'Data Deletion', 'api-status': 'API Status',
        },
        de: {
          'gehalt-berechnen': 'Gehaltsrechner', 'dienste-vergleichen': 'Dienste Vergleichen',
          'steuern-und-rente': 'Steuern & Vorsorge', 'grenzgaenger-leitfaden': 'Grenzgänger-Leitfaden',
          'leben-im-tessin': 'Leben im Tessin', 'statistiken': 'Statistiken',
          'grenzgaenger-artikel': 'Artikel', 'glossar': 'Glossar',
          'grenzgaenger-faq': 'FAQ', 'jobs-im-tessin': 'Jobs im Tessin',
          'seitenplan': 'Seitenplan', 'datenschutz': 'Datenschutz',
          'woechentlicher-digest': 'Wöchentlicher Digest', 'nettolohn-simulator': 'Nettolohn-Simulator',
          'was-waere-wenn': 'Was-Wäre-Wenn', 'waehrungsrechner': 'Währungsrechner',
          'krankenversicherung': 'Krankenversicherung', 'bankenvergleich': 'Bankenvergleich',
          'vorsorgerechner': 'Vorsorgerechner', 'steuerkalender': 'Steuerkalender',
          'wartezeiten-grenze': 'Wartezeiten Grenze', 'erster-arbeitstag': 'Erster Arbeitstag',
          'arbeitsbewilligungen': 'Arbeitsbewilligungen', 'bewilligung-b-oder-g-quiz': 'Bewilligung B oder G Quiz',
          'lebenshaltungskosten': 'Lebenshaltungskosten', 'gehaltsvergleich': 'Gehaltsvergleich',
          'autokosten-rechner': 'Autokosten-Rechner', 'gehaltsquiz': 'Gehaltsquiz',
          'steuerquiz': 'Steuerquiz', 'dritte-saeule': 'Dritte Säule',
          'steuergutschriften': 'Steuergutschriften', 'steuererklaerung': 'Steuererklärung',
          'tessiner-feiertage': 'Tessiner Feiertage', 'steuerrueckverguetungen': 'Steuerrückvergütungen',
          'mobilfunktarife': 'Mobilfunktarife', 'einkaufsrechner': 'Einkaufsrechner',
          'kindertagesstaetten': 'Kindertagesstätten', 'renovierungen': 'Renovierungen',
          'grenzverkehr-historie': 'Grenzverkehr-Historie',
          'guten-morgen': 'Guten Morgen',
          'vergleich-bewilligung-g-vs-b': 'Bewilligung G vs B Vergleich',
          'datenloeschung': 'Datenlöschung', 'api-status': 'API-Status',
        },
        fr: {
          'calculer-salaire': 'Calculateur de Salaire', 'comparer-services': 'Comparer les Services',
          'impots-et-retraite': 'Impôts & Retraite', 'guide-frontalier': 'Guide Frontalier',
          'vivre-au-tessin': 'Vivre au Tessin', 'statistiques': 'Statistiques',
          'articles-frontalier': 'Articles', 'glossaire': 'Glossaire',
          'faq-frontaliers': 'FAQ', 'trouver-emploi-tessin': 'Emploi au Tessin',
          'plan-du-site': 'Plan du Site', 'politique-de-confidentialite': 'Politique de Confidentialité',
          'digest-hebdomadaire': 'Digest Hebdomadaire', 'simulateur-salaire-net': 'Simulateur Salaire Net',
          'simulateur-hypothetique': 'Simulateur Hypothétique', 'change-devises': 'Change de Devises',
          'assurance-maladie': 'Assurance Maladie', 'comparaison-banques': 'Comparaison Banques',
          'planificateur-retraite': 'Planificateur Retraite', 'calendrier-fiscal': 'Calendrier Fiscal',
          'temps-attente-douane': 'Temps d\'Attente Douane', 'premier-jour-travail': 'Premier Jour de Travail',
          'permis-de-travail': 'Permis de Travail', 'quiz-permis-b-ou-g': 'Quiz Permis B ou G',
          'cout-de-la-vie': 'Coût de la Vie', 'comparaison-salaires': 'Comparaison Salaires',
          'calculateur-cout-auto': 'Calculateur Coût Auto', 'quiz-salaire': 'Quiz Salaire',
          'quiz-fiscal': 'Quiz Fiscal', 'troisieme-pilier': 'Troisième Pilier',
          'credits-impot': 'Crédits d\'Impôt', 'declaration-revenus': 'Déclaration de Revenus',
          'jours-feries-tessin': 'Jours Fériés Tessin', 'remboursements-fiscaux': 'Remboursements Fiscaux',
          'forfaits-telephoniques': 'Forfaits Téléphoniques', 'calculateur-courses': 'Calculateur Courses',
          'creches': 'Crèches', 'renovations': 'Rénovations',
          'historique-trafic-frontiere': 'Historique Trafic Frontière',
          'bonjour': 'Bonjour',
          'comparaison-permis-g-vs-b': 'Comparaison Permis G vs B',
          'suppression-donnees': 'Suppression des Données', 'etat-api': 'État API',
        },
      };

      const deriveLocaleSeo = (locPath: string, locale: string, italianSeo: SeoEntry): SeoEntry => {
        const segs = locPath.split('/').filter(Boolean);
        const pathSegs = ['en', 'de', 'fr'].includes(segs[0]) ? segs.slice(1) : segs;

        // Homepage
        if (pathSegs.length === 0) {
          const h = LOCALE_HOME[locale];
          if (h) return { title: h.title, desc: h.desc, ogT: h.title, ogD: h.desc, sd: italianSeo.sd };
        }

        // ── Glossary entries: extract proper term from Italian SEO title ────
        // Italian titles have correct casing: "AC (Glossario) | Frontaliere Ticino"
        // or "AVS | Glossario Frontalieri". We reuse the term + add locale qualifier.
        const GLOSSARY_SECTIONS = ['cross-border-glossary', 'grenzgaenger-glossar', 'glossaire-frontalier'];
        const isGlossary = pathSegs.some(s => GLOSSARY_SECTIONS.includes(s)) && pathSegs.length >= 2;
        if (isGlossary) {
          const italianTerm = italianSeo.title
            .replace(/\s*\|\s*(Frontaliere Ticino|Glossario Frontalieri)$/i, '')
            .replace(/\s*\(Glossario\)\s*$/i, '')
            .trim();
          const GLOSSARY_LABEL: Record<string, string> = { en: 'Glossary', de: 'Glossar', fr: 'Glossaire' };
          const qualifier = GLOSSARY_LABEL[locale] || 'Glossary';
          const title = `${italianTerm} (${qualifier}) | Frontaliere Ticino`;
          const GLOSSARY_DESC: Record<string, (t: string) => string> = {
            en: (t) => `Definition and explanation of ${t} for cross-border workers (Switzerland–Italy): meaning, context, and practical impact.`,
            de: (t) => `Definition und Erklärung von ${t} für Grenzgänger (Schweiz–Italien): Bedeutung, Kontext und praktische Auswirkung.`,
            fr: (t) => `Définition et explication de ${t} pour travailleurs frontaliers (Suisse–Italie) : signification, contexte et impact pratique.`,
          };
          const desc = GLOSSARY_DESC[locale]?.(italianTerm) || italianSeo.desc;
          return { title, desc, ogT: title, ogD: desc, sd: italianSeo.sd };
        }

        const sectionTitles = LOCALE_SECTION_TITLES[locale] ?? {};

        // Build readable title from slug segments
        const titleParts = pathSegs.map(seg =>
          sectionTitles[seg] || seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        );
        // Fix common abbreviations in slug-derived text
        const fixAbbr = (s: string) => s
          .replace(/\bChf\b/g, 'CHF').replace(/\bEur\b/g, 'EUR')
          .replace(/\bAvs\b/g, 'AVS').replace(/\bLpp\b/g, 'LPP')
          .replace(/\bFaq\b/g, 'FAQ').replace(/\bVs\b/g, 'vs')
          .replace(/\bIrpef\b/g, 'IRPEF').replace(/\bLamal\b/g, 'LAMal')
          .replace(/\b(\d+)\b/g, '$1');
        const readableTitle = fixAbbr(titleParts[titleParts.length - 1]);
        const title = `${readableTitle} | Frontaliere Ticino`;

        const GENERIC_DESC: Record<string, (t: string) => string> = {
          en: (t: string) => `${t} — tools and information for cross-border workers Switzerland-Italy. Updated 2026.`,
          de: (t: string) => `${t} — Tools und Informationen für Grenzgänger Schweiz-Italien. Aktualisiert 2026.`,
          fr: (t: string) => `${t} — outils et informations pour travailleurs frontaliers Suisse-Italie. Mis à jour 2026.`,
        };
        const desc = (GENERIC_DESC[locale]?.(readableTitle)) || italianSeo.desc;

        return { title, desc, ogT: title, ogD: desc, sd: italianSeo.sd };
      };

      // ── Locale-aware nav labels ───────────────────────────────
      const NAV_LABELS: Record<string, { href: string; label: string }[]> = {
        it: [
          { href: '/', label: 'Simulatore Fiscale' },
          { href: '/compara-servizi', label: 'Confronta Servizi' },
          { href: '/tasse-e-pensione', label: 'Tasse e Pensione' },
          { href: '/guida-frontaliere', label: 'Guida Frontaliere' },
          { href: '/domande-frequenti-frontalieri', label: 'FAQ' },
          { href: '/glossario-frontaliere', label: 'Glossario' },
          { href: '/articoli-frontaliere', label: 'Articoli' },
          { href: '/mappa-del-sito', label: 'Mappa del Sito' },
        ],
        en: [
          { href: '/en/', label: 'Tax Simulator' },
          { href: '/en/compare-services', label: 'Compare Services' },
          { href: '/en/taxes-and-pension', label: 'Taxes & Pensions' },
          { href: '/en/frontier-guide', label: 'Cross-Border Guide' },
          { href: '/en/cross-border-faq', label: 'FAQ' },
          { href: '/en/glossary', label: 'Glossary' },
          { href: '/en/frontier-articles', label: 'Articles' },
          { href: '/en/site-map', label: 'Site Map' },
        ],
        de: [
          { href: '/de/', label: 'Steuersimulator' },
          { href: '/de/dienste-vergleichen', label: 'Dienste Vergleichen' },
          { href: '/de/steuern-und-rente', label: 'Steuern & Vorsorge' },
          { href: '/de/grenzgaenger-leitfaden', label: 'Grenzgänger-Leitfaden' },
          { href: '/de/grenzgaenger-faq', label: 'FAQ' },
          { href: '/de/glossar', label: 'Glossar' },
          { href: '/de/grenzgaenger-artikel', label: 'Artikel' },
          { href: '/de/seitenplan', label: 'Seitenplan' },
        ],
        fr: [
          { href: '/fr/', label: 'Simulateur Fiscal' },
          { href: '/fr/comparer-services', label: 'Comparer les Services' },
          { href: '/fr/impots-et-retraite', label: 'Impôts & Retraite' },
          { href: '/fr/guide-frontalier', label: 'Guide Frontalier' },
          { href: '/fr/faq-frontaliers', label: 'FAQ' },
          { href: '/fr/glossaire', label: 'Glossaire' },
          { href: '/fr/articles-frontalier', label: 'Articles' },
          { href: '/fr/plan-du-site', label: 'Plan du Site' },
        ],
      };

      // ── Locale-aware editorial fallback ───────────────────────
      const LOCALE_EDITORIAL: Record<string, string[]> = {
        en: [
          'This page is part of Frontaliere Ticino, the reference platform for cross-border workers between Switzerland (Canton Ticino) and Italy. Find practical tools, updated data, and verified information.',
          'Content is designed to help cross-border workers make informed decisions about taxation, pensions, transportation, cost of living, and administrative procedures.',
          'All tools and data are updated for the 2026 fiscal year, reflecting the New Bilateral Tax Agreement between Switzerland and Italy, current AVS/LPP contribution rates, and Canton Ticino withholding tax tables.',
        ],
        de: [
          'Diese Seite ist Teil von Frontaliere Ticino, der Referenzplattform für Grenzgänger zwischen der Schweiz (Kanton Tessin) und Italien. Hier finden Sie praktische Tools, aktuelle Daten und verifizierte Informationen.',
          'Die Inhalte helfen Grenzgängern, fundierte Entscheidungen zu Besteuerung, Vorsorge, Transport, Lebenshaltungskosten und Verwaltungsverfahren zu treffen.',
          'Alle Tools und Daten sind für das Steuerjahr 2026 aktualisiert und berücksichtigen das Neue Bilaterale Steuerabkommen zwischen der Schweiz und Italien, aktuelle AHV/BVG-Beitragssätze und Tessiner Quellensteuertabellen.',
        ],
        fr: [
          'Cette page fait partie de Frontaliere Ticino, la plateforme de référence pour les travailleurs frontaliers entre la Suisse (Canton du Tessin) et l\'Italie. Trouvez des outils pratiques, des données actualisées et des informations vérifiées.',
          'Le contenu aide les frontaliers à prendre des décisions éclairées sur la fiscalité, la prévoyance, les transports, le coût de la vie et les procédures administratives.',
          'Tous les outils et données sont mis à jour pour l\'année fiscale 2026, reflétant le Nouvel Accord Fiscal Bilatéral entre la Suisse et l\'Italie, les taux de cotisation AVS/LPP actuels et les barèmes d\'impôt à la source du Canton du Tessin.',
        ],
      };

      // ── Locale-aware "related" heading ────────────────────────
      const RELATED_HEADING: Record<string, string> = {
        it: 'Approfondimenti correlati',
        en: 'Related topics',
        de: 'Verwandte Themen',
        fr: 'Sujets connexes',
      };

      let count = 0;
      let skipped = 0;

      // Only process Italian URLs (no /en/, /de/, /fr/ prefix) to avoid duplicates —
      // locale variants are generated from the hreflang data
      const italianUrls = urls.filter(u => {
        const p = u.path;
        return !p.startsWith('/en/') && !p.startsWith('/de/') && !p.startsWith('/fr/') && !p.startsWith('/en') && !p.startsWith('/de') && !p.startsWith('/fr');
      });

      for (const url of italianUrls) {
        // Skip if file already exists (e.g., from ogPagesPlugin for blog articles)
        const filePath = np.join(distDir, url.path, 'index.html');
        const italianPageExists = fs.existsSync(filePath);

        // Look up SEO data — fall back to URL-derived title if no explicit entry
        let seo = seoMap.get(url.path);
        if (!seo) {
          // Derive a basic page from URL path so every sitemap URL gets a static HTML file
          const pathLabel = url.path.split('/').filter(Boolean).pop() || url.path;
          const readableTitle = pathLabel.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          seo = {
            title: `${readableTitle} | Frontaliere Ticino`,
            desc: `Informazioni utili per frontalieri Svizzera-Italia: ${readableTitle.toLowerCase()}.`,
            ogT: `${readableTitle} | Frontaliere Ticino`,
            ogD: `Informazioni utili per frontalieri: ${readableTitle.toLowerCase()}.`,
          };
        }

        // Detect locale from path
        const detectLocale = (p: string): string => {
          if (p.startsWith('/en/') || p === '/en') return 'en';
          if (p.startsWith('/de/') || p === '/de') return 'de';
          if (p.startsWith('/fr/') || p === '/fr') return 'fr';
          return 'it';
        };

        const withTrailingSlash = (path: string): string => {
          if (!path || path === '/') return '/';
          const clean = path.replace(/\/+$/, '');
          return clean ? `${clean}/` : '/';
        };

        const buildPage = (locale: string, urlPath: string, seoData: SeoEntry, hreflangs: { lang: string; href: string }[]) => {
          const canonicalPath = withTrailingSlash(urlPath);
          const fullUrl = `${BASE_URL}${canonicalPath}`;
          const pp = canonicalPath.slice(1).replace(/&/g, '~and~');
          const hrefTags = hreflangs
            .map(h => `    <link rel="alternate" hreflang="${h.lang}" href="${BASE_URL}${withTrailingSlash(h.href.replace(BASE_URL, '') || '/')}">`)
            .join('\n');

          // Build BreadcrumbList JSON-LD from URL path segments
          // Use human-readable names for known sections instead of slug-derived text
          const BREADCRUMB_NAMES: Record<string, string> = {
            'calcola-stipendio': 'Calcolatore Stipendio',
            'compara-servizi': 'Confronta Servizi',
            'tasse-e-pensione': 'Tasse e Pensione',
            'guida-frontaliere': 'Guida Frontaliere',
            'vita-in-ticino': 'Vita in Ticino',
            'statistiche': 'Statistiche',
            'articoli-frontaliere': 'Articoli',
            'glossario-frontaliere': 'Glossario',
            'domande-frequenti-frontalieri': 'FAQ',
            'cerca-lavoro-ticino': 'Lavoro in Ticino',
            'mappa-del-sito': 'Mappa del Sito',
            'privacy-policy': 'Privacy Policy',
            'cancellazione-dati': 'Cancellazione Dati',
            'stato-api': 'Stato API',
            'simula-busta-paga': 'Simula Busta Paga',
            'cosa-cambia-se': 'What-If Simulator',
            'confronta-permesso-g-vs-b': 'Confronto Permesso G vs B',
            'cambio-franco-euro': 'Cambio Valuta',
            'confronta-casse-malati': 'Assicurazioni Salute',
            'confronta-banche': 'Confronto Banche',
            'costo-vita-ticino': 'Costo della Vita',
            'dichiarazione-redditi-italia': 'Dichiarazione Redditi',
            'calcola-previdenza': 'Pensione e Previdenza',
            'tempi-attesa-dogana': 'Tempi Attesa Dogana',
            'primo-giorno-frontaliere': 'Primo Giorno',
            'buongiorno-frontaliere': 'Buongiorno',
            'chi-siamo': 'Chi Siamo',
            'community': 'Community',
            'contattaci': 'Contatti',
            'supporto': 'Supporto',
            'consulenza': 'Consulenza',
            'servizi-partner': 'Servizi Partner',
          };
          const segments = canonicalPath.split('/').filter(Boolean);
          const breadcrumbs = [{ name: 'Home', url: BASE_URL + '/' }];
          let accumPath = '';
          for (const seg of segments) {
            accumPath += '/' + seg;
            const readableName = BREADCRUMB_NAMES[seg] || LOCALE_SECTION_TITLES[locale]?.[seg] || seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            breadcrumbs.push({ name: readableName, url: BASE_URL + withTrailingSlash(accumPath) });
          }
          const breadcrumbJsonLd = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: breadcrumbs.map((b, i) => ({
              '@type': 'ListItem', position: i + 1, name: b.name, item: b.url
            }))
          });

          // Navigation links for crawlers (top-level sections + contextual)
          const navLinks = NAV_LABELS[locale] ?? NAV_LABELS['it'];
          // Add contextual siblings: link to related pages in the same section
          const contextualLinks: { href: string; label: string }[] = [];
          if (canonicalPath.startsWith('/glossario-frontaliere/')) {
            // Add a few sibling glossary terms for internal linking
            const siblings = italianUrls
              .filter(u => u.path.startsWith('/glossario-frontaliere/') && u.path !== url.path)
              .slice(0, 6);
            for (const s of siblings) {
              const lbl = s.path.split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? '';
              if (lbl) contextualLinks.push({ href: withTrailingSlash(s.path), label: lbl });
            }
          } else if (canonicalPath.startsWith('/guida-frontaliere/tempi-attesa-dogana/')) {
            // Add sibling border crossings
            const siblings = italianUrls
              .filter(u => u.path.startsWith('/guida-frontaliere/tempi-attesa-dogana/') && u.path !== url.path)
              .slice(0, 6);
            for (const s of siblings) {
              const lbl = s.path.split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? '';
              if (lbl) contextualLinks.push({ href: withTrailingSlash(s.path), label: lbl });
            }
          } else if (canonicalPath.startsWith('/compara-servizi/')) {
            contextualLinks.push(
              { href: '/compara-servizi/cambio-franco-euro/', label: 'Cambio Valuta' },
              { href: '/compara-servizi/confronta-casse-malati/', label: 'Assicurazioni Salute' },
              { href: '/compara-servizi/confronta-banche/', label: 'Confronto Banche' },
            );
          } else if (canonicalPath.startsWith('/calcola-stipendio/')) {
            contextualLinks.push(
              { href: '/calcola-stipendio/simula-busta-paga/', label: 'Simula Busta Paga' },
              { href: '/calcola-stipendio/cosa-cambia-se/', label: 'What-If Simulator' },
              { href: '/tasse-e-pensione/calcola-previdenza/', label: 'Pensioni' },
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/')) {
            contextualLinks.push(
              { href: '/tasse-e-pensione/calcola-previdenza/', label: 'Pensioni' },
              { href: '/tasse-e-pensione/scadenze-fiscali/', label: 'Calendario Fiscale' },
              { href: '/tasse-e-pensione/simula-terzo-pilastro/', label: 'Terzo Pilastro' },
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/')) {
            contextualLinks.push(
              { href: '/guida-frontaliere/primo-giorno-lavoro/', label: 'Primo Giorno' },
              { href: '/guida-frontaliere/permessi-di-lavoro/', label: 'Permessi Lavoro' },
              { href: '/guida-frontaliere/tempi-attesa-dogana/', label: 'Tempi Dogana' },
            );
          }
          // Deduplicate (don't repeat links already in main nav or pointing to self)
          const allHrefs = new Set(navLinks.map(l => l.href));
          allHrefs.add(canonicalPath);
          const filteredContextual = contextualLinks.filter(l => !allHrefs.has(l.href));
          const allLinks = [...navLinks, ...filteredContextual];
          const navHtml = allLinks.map(l => `<a href="${l.href}">${l.label}</a>`).join(' | ');
          const relatedHtml = filteredContextual.length
            ? `<h2 style="font-size:1rem;font-weight:600;margin:1rem 0 .5rem">${RELATED_HEADING[locale] ?? RELATED_HEADING['it']}</h2><ul style="margin:0 0 1rem 1.25rem;padding:0">${filteredContextual.map((l) => `<li style="margin:.25rem 0"><a href="${l.href}">${l.label}</a></li>`).join('')}</ul>`
            : '';
          const isHomePage = canonicalPath === '/';
          const isJobsIndex = /\/(cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin)\/?$/.test(canonicalPath);
          const isArticlesIndex = /\/(articoli-frontaliere|frontier-articles|grenzgaenger-artikel|articles-frontalier)\/?$/.test(canonicalPath);
          // Don't seed editorialBlocks with seoData.desc — it's already rendered
          // in the gray subtitle <p> above the editorial div. Duplicating it wastes
          // the most valuable content slot and signals thin/boilerplate to crawlers.
          const editorialBlocks: string[] = [];

          // ── Section-specific editorial content ────────────────────
          // Each section gets UNIQUE, topically-relevant paragraphs so that
          // Google sees original content on every static page, not boilerplate.
          // Non-IT locales: section-specific editorial from editorialContent.ts
          // Italian: inline path-based editorial below
          // Use the Italian path (from outer loop) for editorial lookup since
          // SECTION_EDITORIAL_KEYS use Italian slugs, not locale-specific ones
          const italianPath = url.path; // e.g. '/tasse-e-pensione/credito-imposta'
          if (locale !== 'it') {
            const sectionKey = SECTION_EDITORIAL_KEYS
              .find(prefix => italianPath.startsWith(prefix));
            if (sectionKey && SECTION_EDITORIAL[sectionKey]?.[locale]) {
              editorialBlocks.push(...SECTION_EDITORIAL[sectionKey][locale]);
            } else {
              const locEditorial = LOCALE_EDITORIAL[locale];
              if (locEditorial) editorialBlocks.push(...locEditorial);
            }
          } else if (canonicalPath.startsWith('/calcola-stipendio/simula-busta-paga')) {
            editorialBlocks.push(
              `Il simulatore di busta paga ricostruisce voce per voce lo stipendio netto partendo dal lordo annuo in franchi svizzeri: AVS/AI/IPG (5,3 %), assicurazione contro la disoccupazione (1,1 %), infortunio non professionale e indennità giornaliera di malattia vengono sottratti prima del calcolo dell'imposta alla fonte.`,
              `L'imposta alla fonte è calcolata secondo le tabelle A/B/C/H del Canton Ticino, aggiornate al 2026, e tiene conto di stato civile, numero di figli e appartenenza religiosa. Il risultato viene convertito in euro al tasso di cambio selezionato per quantificare il potere d'acquisto reale in Italia.`,
              `Dopo la simulazione puoi confrontare il netto ottenuto con i costi effettivi della vita da frontaliere: trasporto, cassa malati LAMal o CMU, pranzi, parcheggio e assicurazione auto con targhe svizzere. Questo permette di stimare il risparmio mensile effettivo.`,
            );
          } else if (canonicalPath.startsWith('/calcola-stipendio/cosa-cambia-se')) {
            editorialBlocks.push(
              `Il simulatore "Cosa cambia se" permette di variare un parametro alla volta — stato civile, distanza dal confine, numero figli, percentuale di lavoro, cantone — e vedere immediatamente l'impatto sul netto mensile e annuale, così da valutare decisioni concrete prima di attuarle.`,
              `Ogni scenario viene calcolato con le stesse regole del simulatore principale: deduzioni sociali svizzere, imposta alla fonte cantonale, e conversione CHF-EUR. Le differenze vengono evidenziate in modo visivo per facilitare il confronto rapido.`,
              `Questo strumento è particolarmente utile quando si valuta un cambio di residenza, un matrimonio, la nascita di un figlio o il passaggio al tempo parziale: tutte situazioni che modificano significativamente la tassazione del frontaliere.`,
            );
          } else if (canonicalPath.startsWith('/calcola-stipendio/confronta-stipendi')) {
            editorialBlocks.push(
              `Il comparatore di stipendi mette a confronto la retribuzione netta dello stesso ruolo in Ticino (CHF) e in Lombardia/Piemonte (EUR), considerando tassazione, contributi e costo della vita in entrambi i paesi.`,
              `I dati di riferimento provengono da statistiche salariali reali per settore e livello di esperienza, integrati con le aliquote fiscali e contributive vigenti in Svizzera e Italia per il 2026.`,
              `Il confronto include costi indiretti tipici del frontaliere (trasporto, cassa malati, cambio valuta) per dare un quadro completo del vantaggio economico netto di lavorare in Svizzera rispetto a un impiego equivalente in Italia.`,
            );
          } else if (canonicalPath.startsWith('/calcola-stipendio/quiz-stipendio')) {
            editorialBlocks.push(
              `Il quiz sullo stipendio ti permette di testare la tua conoscenza sulle regole fiscali e contributive che determinano il netto di un frontaliere: deduzioni sociali, imposta alla fonte, franchigia e Nuovo Accordo fiscale 2026.`,
              `Ogni domanda è accompagnata da una spiegazione dettagliata che chiarisce il meccanismo sottostante, così il quiz diventa anche uno strumento formativo per chi si avvicina per la prima volta al lavoro transfrontaliero.`,
            );
          } else if (canonicalPath.startsWith('/calcola-stipendio/nuovi-frontalieri-oltre-20-km')) {
            editorialBlocks.push(
              `Questa pagina e pensata per chi ha iniziato a lavorare in Svizzera dal 17 luglio 2023 in poi e vive in un comune italiano oltre 20 km dalla frontiera. In questo scenario l'imposta alla fonte resta interamente trattenuta in Svizzera, senza il meccanismo dell'80 % / 20 % tipico dei comuni entro 20 km.`,
              `Per aiutare il confronto, l'hub raccoglie casi pratici su tre fasce di reddito e mette a fianco uno scenario identico entro 20 km. In questo modo puoi capire subito se la differenza reale riguarda il netto mensile, il saldo fiscale in Italia o la semplicita operativa della dichiarazione dei redditi.`,
              `La landing collega anche i tool gia presenti nel sito: simulatore del netto, confronto 2025 vs 2026, guida alla dichiarazione dei redditi e aliquote dell'imposta alla fonte Ticino 2026. L'obiettivo e trasformare una regola fiscale astratta in una decisione concreta sulla tua situazione personale.`,
            );
          } else if (canonicalPath.startsWith('/calcola-stipendio/')) {
            editorialBlocks.push(
              `Lo strumento di calcolo utilizza i parametri fiscali e previdenziali aggiornati al 2026 per la Svizzera e l'Italia, applicando le regole del Nuovo Accordo sulla tassazione dei frontalieri entrato in vigore nel 2024.`,
              `I risultati tengono conto delle specificità del Canton Ticino: aliquote dell'imposta alla fonte, tabelle di classificazione A/B/C/H, deduzioni per figli e conversione automatica CHF-EUR ai tassi di mercato.`,
              `Per ottenere una stima affidabile, inserisci lo stipendio lordo annuo in franchi svizzeri: il sistema applica automaticamente contributi AVS/AI/IPG, AC, LAA, IJM e LPP secondo le fasce d'età previste dalla legge federale.`,
            );
          } else if (canonicalPath.startsWith('/compara-servizi/cambio-franco-euro')) {
            editorialBlocks.push(
              `Il convertitore di valuta CHF-EUR utilizza i tassi di cambio aggiornati in tempo reale dalla fonte TwelveData, con cache Firestore per garantire velocità e affidabilità anche in caso di picchi di traffico.`,
              `Oltre alla conversione istantanea, viene mostrato lo storico del tasso di cambio franco svizzero / euro con grafici interattivi che coprono gli ultimi 12 mesi, utili per individuare il momento migliore per convertire lo stipendio.`,
              `Per i frontalieri, il tasso di cambio è un fattore determinante: una variazione dell'1 % su uno stipendio di 6000 CHF equivale a circa 55–60 EUR al mese. Monitorare il cambio aiuta a pianificare le conversioni e ridurre le commissioni bancarie.`,
            );
          } else if (canonicalPath.startsWith('/compara-servizi/confronta-casse-malati')) {
            editorialBlocks.push(
              `Il comparatore di casse malati LAMal confronta i premi mensili di 14 assicuratori svizzeri riconosciuti (UFSP), calcolati per cantone, modello assicurativo, franchigia, fascia d'età e copertura infortuni.`,
              `I frontalieri con permesso G hanno diritto di optare tra LAMal svizzera e SSN italiano: la scelta è irrevocabile per tutta la durata del rapporto di lavoro. Questo strumento aiuta a confrontare i costi prima della decisione.`,
              `I premi vengono calcolati con la formula: base × (1 − sconto modello) × (1 + fattore franchigia) × moltiplicatore età × (1 + copertura infortuni). I dati coprono i cantoni TI, GR, VS, ZH, GE, BE e LU.`,
            );
          } else if (canonicalPath.startsWith('/compara-servizi/confronta-banche')) {
            editorialBlocks.push(
              `Il confronto banche analizza le principali banche svizzere e italiane utilizzate dai frontalieri, confrontando commissioni di cambio, costi di conto, carte di debito/credito e servizi di bonifico transfrontaliero.`,
              `Per i frontalieri, la scelta della banca incide direttamente sul netto percepito: le commissioni di cambio CHF→EUR possono variare dallo 0,3 % al 2,5 % a seconda dell'istituto e dello strumento utilizzato.`,
            );
          } else if (canonicalPath.startsWith('/compara-servizi/confronta-offerte-lavoro')) {
            editorialBlocks.push(
              `La sezione lavoro Ticino raccoglie annunci pubblicati su fonti aziendali ufficiali, con normalizzazione dei dati principali per facilitare confronto tra ruolo, sede, contratto e coerenza con il tuo profilo professionale.`,
              `Per ogni posizione vengono mantenuti metadati utili alla valutazione: data pubblicazione, azienda, località, requisiti richiesti e collegamento diretto alla candidatura sul sito originale del datore di lavoro.`,
              `Le offerte vengono filtrate per il Canton Ticino e aggiornate quotidianamente da crawler dedicati che monitorano i portali HR di oltre 100 aziende ticinesi, enti pubblici e multinazionali con sede nel cantone.`,
            );
          } else if (canonicalPath.startsWith('/compara-servizi/costo-auto')) {
            editorialBlocks.push(
              `Il calcolatore del costo auto confronta le spese annuali di possedere e usare un veicolo in Svizzera e in Italia, includendo assicurazione RC, bollo/imposta di circolazione, manutenzione, carburante e pedaggi.`,
              `Per i frontalieri che attraversano quotidianamente il confine, le targhe svizzere e italiane comportano costi differenti: l'assicurazione svizzera copre la circolazione in tutta Europa, ma i premi possono superare i 1500 CHF/anno.`,
            );
          } else if (canonicalPath.startsWith('/compara-servizi/')) {
            editorialBlocks.push(
              `Questa sezione mette a confronto servizi, costi e condizioni rilevanti per chi lavora in Svizzera e vive in Italia, con dati aggiornati e strumenti interattivi per decisioni informate.`,
              `Ogni comparatore utilizza dati reali e fonti verificabili per garantire risultati affidabili. I parametri sono personalizzabili in base alla tua situazione specifica di frontaliere.`,
              `I confronti coprono le principali voci di spesa della vita transfrontaliera — banche, assicurazioni sanitarie, operatori mobili, costo della spesa e asili nido — aiutandoti a risparmiare senza rinunciare alla qualità dei servizi.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/calcola-previdenza')) {
            editorialBlocks.push(
              `Il simulatore previdenziale stima la rendita pensionistica combinando primo pilastro AVS (rendita massima 2024: 2450 CHF/mese), secondo pilastro LPP (accrediti dal 7 % al 18 % in base all'età) e terzo pilastro 3a facoltativo.`,
              `Per i frontalieri, la pensione svizzera viene versata anche dopo il rientro definitivo in Italia. I contributi AVS maturati in Svizzera si sommano a quelli INPS italiani grazie alla convenzione bilaterale di sicurezza sociale.`,
              `Il simulatore mostra anche l'impatto di diverse strategie: versamenti volontari al pilastro 3a, riscatto LPP, e l'effetto del tasso di conversione sulla rendita finale, con proiezioni a 5, 10 e 20 anni.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/scadenze-fiscali')) {
            editorialBlocks.push(
              `Il calendario fiscale mostra tutte le scadenze che un frontaliere deve rispettare in Svizzera e in Italia: dichiarazione dei redditi (730/Modello Redditi PF), conguaglio imposta alla fonte, versamento IMU e addizionali regionali/comunali.`,
              `Per i nuovi frontalieri (regime dal 2024), la franchigia di 10.000 EUR si applica al reddito da lavoro dipendente in Svizzera ai fini IRPEF: la dichiarazione italiana tiene conto di questo abbattimento nella base imponibile.`,
              `Rispettare ogni scadenza evita sanzioni e interessi di mora. Lo strumento ti invia promemoria personalizzati e mostra il calendario completo con le date italiane e svizzere sovrapposte.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/simula-terzo-pilastro')) {
            editorialBlocks.push(
              `Il simulatore del terzo pilastro 3a calcola il capitale accumulato e la rendita futura in base a versamento annuo, durata, rendimento atteso e imposta di riscatto, mostrando il vantaggio fiscale rispetto a investimenti non agevolati.`,
              `Nel 2026, il massimo deducibile per il pilastro 3a è di 7258 CHF per lavoratori affiliati a un fondo pensione LPP. Il versamento riduce direttamente il reddito imponibile ai fini dell'imposta alla fonte cantonale.`,
              `Il simulatore confronta anche scenari con diversi orizzonti temporali e rendimenti, permettendo di visualizzare l'effetto dell'interesse composto e dell'agevolazione fiscale sul lungo periodo.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/crediti-imposta')) {
            editorialBlocks.push(
              `Il calcolatore dei crediti d'imposta determina il credito per imposte pagate all'estero (Art. 165 TUIR) applicabile nella dichiarazione italiana, evitando la doppia imposizione sul reddito da lavoro svizzero.`,
              `Con il Nuovo Accordo 2024, l'Italia tassa il reddito dei nuovi frontalieri con una franchigia di 10.000 EUR e riconosce un credito per l'imposta alla fonte svizzera pagata, fino a concorrenza dell'imposta italiana dovuta.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/dichiarazione-redditi')) {
            editorialBlocks.push(
              `La guida alla dichiarazione dei redditi per frontalieri copre sia l'Italia sia la Svizzera. Per l'Italia: Modello 730 o Redditi PF, reddito in franchi convertito al cambio UIC, franchigia e credito per imposte estere nei quadri RC, CE, CR.`,
              `Per la Svizzera: imposta alla fonte (Quellensteuer), procedura di rettifica entro il 31 marzo, tassazione ordinaria ulteriore (TDR) sopra 120.000 CHF, deduzioni pilastro 3a e LPP, statuto di quasi-residente e compilazione con il software eTax Ticino.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/quiz-fiscale')) {
            editorialBlocks.push(
              `Il quiz fiscale settimanale mette alla prova le conoscenze del frontaliere su tasse, deduzioni, permessi e normative. Ogni settimana vengono selezionate 5 domande dal pool: fiscalità svizzera e italiana, contributi AVS/LPP, assicurazione sanitaria LAMal e permessi di lavoro G/B.`,
              `Le domande coprono scenari reali: aliquote dell'imposta alla fonte cantonale, franchigia IRPEF per nuovi frontalieri, deduzioni del pilastro 3a, obblighi per la disoccupazione e lo statuto di quasi-residente. Il punteggio contribuisce alla gamification e sblocca achievement specifici.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/calcola-ristorni')) {
            editorialBlocks.push(
              `Il tracker dei ristorni monitora i compensi finanziari che il Canton Ticino versa ai comuni italiani di confine per compensare i costi sostenuti a favore dei frontalieri residenti: circa il 40 % dell'imposta alla fonte è restituito ai comuni entro 20 km dal confine.`,
              `Con il Nuovo Accordo 2024, la quota dei ristorni è destinata a diminuire progressivamente man mano che l'Italia assume la tassazione concorrente. I comuni più interessati sono quelli della fascia dei 20 km dalla frontiera.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri')) {
            editorialBlocks.push(
              `Con il Nuovo Accordo fiscale Italia-Svizzera entrato in vigore il 17 luglio 2023, i frontalieri assunti a partire da quella data — i cosiddetti "nuovi frontalieri" — sono soggetti a una tassazione concorrente: pagano l'imposta alla fonte in Svizzera (all'80 % dell'aliquota ordinaria se residenti entro 20 km dal confine) e l'IRPEF in Italia con una franchigia di 10.000 EUR sul reddito da lavoro estero.`,
              `Il simulatore fiscale calcola in modo automatico tutte le componenti del netto mensile: contributi AVS/AI/IPG (5,3 %), AC (1,1 %), LPP variabile per fascia d'età, imposta alla fonte Ticino 2026 secondo le tabelle A/B/C/H, e poi la parte italiana con IRPEF, addizionale regionale e comunale, al netto della franchigia e del credito per imposte estere. Il risultato mostra il netto reale in EUR al tasso di cambio aggiornato.`,
              `Per evitare la doppia imposizione, il credito d'imposta previsto dall'accordo bilaterale permette di detrarre le imposte svizzere già pagate dall'IRPEF italiana dovuta, fino a concorrenza della quota relativa al reddito estero. Il simulatore stima automaticamente questo credito insieme al saldo fiscale finale, così puoi vedere in anticipo quanto pagherai in ciascun paese e pianificare la dichiarazione dei redditi.`,
            );
          } else if (canonicalPath.startsWith('/tasse-e-pensione/')) {
            editorialBlocks.push(
              `Questa sezione copre gli aspetti fiscali e previdenziali del lavoro transfrontaliero: imposta alla fonte svizzera, IRPEF italiana, contributi AVS/LPP e pianificazione pensionistica.`,
              `Le informazioni sono aggiornate al Nuovo Accordo fiscale Italia-Svizzera 2024 e tengono conto delle specificità del Canton Ticino per l'imposta alla fonte e dei regimi transitori per i frontalieri storici (ante 2024).`,
              `Per ogni tema fiscale trovi simulatori interattivi che calcolano il tuo caso specifico e guide passo-passo per compilare correttamente dichiarazioni, moduli e richieste di rimborso.`,
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/primo-giorno-lavoro')) {
            editorialBlocks.push(
              `La guida al primo giorno di lavoro copre tutti i passaggi pratici per il nuovo frontaliere: ritiro del permesso G, apertura del conto bancario svizzero, scelta della cassa malati (LAMal o SSN), iscrizione AIRE e prima dichiarazione dei redditi.`,
              `Ogni passaggio include tempistiche reali, documenti necessari e link agli uffici competenti (Ufficio della migrazione TI, INPS, Agenzia delle Entrate) per completare le pratiche senza errori.`,
              `La checklist interattiva ti accompagna settimana per settimana nei primi 90 giorni, dalla firma del contratto fino alla stabilizzazione fiscale e previdenziale completa.`,
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/permessi-di-lavoro')) {
            editorialBlocks.push(
              `Il confronto permessi analizza le differenze operative tra permesso G (frontaliere, rinnovo annuale) e permesso B (domiciliato, 5 anni): tassazione, accesso ai servizi, diritto di soggiorno e implicazioni per la famiglia.`,
              `La scelta tra permesso G e B dipende dalla distanza dal confine, dalla situazione familiare e fiscale, e dalla durata prevista dell'impiego in Svizzera. Lo strumento aiuta a valutare i pro e i contro di ogni scenario.`,
              `Il confronto include anche le implicazioni previdenziali (AVS, LPP, disoccupazione), la differenza nei diritti di soggiorno per familiari e l'impatto sulla tassazione italiana e svizzera.`,
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/tempi-attesa-dogana/')) {
            editorialBlocks.push(
              `I tempi di attesa ai valichi di confine vengono stimati in base ai dati storici e alle fasce orarie tipiche: ingresso mattutino (6:30–8:30) e uscita serale (17:00–18:30) sono le finestre con maggiore congestione.`,
              `Per ogni valico vengono forniti consigli pratici su orari alternativi, percorsi secondari e strumenti di monitoraggio in tempo reale (webcam, app traffico) per ridurre i tempi di pendolarismo quotidiano.`,
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/tempi-attesa-dogana')) {
            editorialBlocks.push(
              `La mappa dei valichi di confine tra Ticino e Italia mostra tutti i punti di attraversamento con orari di apertura, livello di traffico tipico e tempo medio di attesa per fascia oraria.`,
              `Ogni valico ha caratteristiche diverse: alcuni sono riservati ai residenti locali, altri gestiscono traffico commerciale pesante. Conoscere il valico più adatto al proprio tragitto può risparmiare fino a 30 minuti al giorno.`,
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/trasferimento-auto')) {
            editorialBlocks.push(
              `La guida al trasferimento dell'auto copre le procedure per immatricolare un veicolo italiano in Svizzera e viceversa: sdoganamento, controllo tecnico MFK, assicurazione e tempistiche necessarie per la reimmatricolazione.`,
              `Per i frontalieri che usano un veicolo con targa italiana, vengono spiegate le regole di circolazione in Svizzera: limiti temporali, assicurazione valida per la Svizzera, contravvenzioni e casi particolari con veicolo aziendale.`,
            );
          } else if (canonicalPath.startsWith('/guida-frontaliere/')) {
            editorialBlocks.push(
              `La guida frontaliere raccoglie informazioni pratiche e aggiornate per chi lavora in Ticino e vive in Italia: procedure amministrative, permessi, documenti necessari e consigli basati sull'esperienza di migliaia di frontalieri.`,
              `Ogni sezione è pensata per essere consultabile in modo autonomo e contiene link diretti a modulistica ufficiale, uffici competenti e strumenti di calcolo per verificare immediatamente le implicazioni pratiche.`,
              `Le guide coprono l'intero ciclo di vita del frontaliere: dal primo impiego al pensionamento, passando per disoccupazione, trasferimento auto, valichi di confine e maternità/paternità transfrontaliera.`,
            );
          } else if (canonicalPath.startsWith('/glossario-frontaliere/')) {
            editorialBlocks.push(
              `Il glossario fornisce definizioni chiare e contestualizzate dei termini tecnici che ogni frontaliere incontra: sigle fiscali (AVS, LPP, LAMal, IRPEF), documenti amministrativi (CU, 730, Lohnausweis) e concetti giuridici (domicilio fiscale, stabile organizzazione).`,
              `Ogni voce è scritta con linguaggio accessibile e collegata agli strumenti del sito che utilizzano quel concetto, così da passare dalla definizione all'applicazione pratica in un solo clic.`,
            );
          } else if (canonicalPath.startsWith('/domande-frequenti-frontalieri')) {
            editorialBlocks.push(
              `Le FAQ rispondono alle domande più frequenti dei frontalieri Svizzera-Italia: "Devo fare la dichiarazione dei redditi in Italia?", "Quanto pago di cassa malati?", "La franchigia di 10.000 EUR si applica al mio caso?".`,
              `Ogni risposta include riferimenti normativi aggiornati e link diretti ai simulatori del sito per calcolare l'impatto sulla propria situazione specifica.`,
              `Le domande sono organizzate per tema — fiscale, previdenziale, sanitario, amministrativo — e vengono aggiornate periodicamente in base alle novità legislative e ai quesiti più ricorrenti della community.`,
            );
          } else if (canonicalPath.startsWith('/vivere-in-ticino/operatori-telefonici')) {
            editorialBlocks.push(
              `Il confronto operatori telefonici analizza le offerte mobili più convenienti per chi vive in Italia e lavora in Svizzera: copertura roaming, piani transfrontalieri, costi di chiamata e dati nelle zone di confine.`,
              `Per i frontalieri, la connettività mobile è critica: servono copertura in entrambi i paesi, nessun costo extra per il roaming quotidiano e opzioni flessibili per navigazione dati durante il pendolarismo.`,
            );
          } else if (canonicalPath.startsWith('/vivere-in-ticino/spesa-e-shopping')) {
            editorialBlocks.push(
              `Il calcolatore del costo della spesa confronta i prezzi di un paniere tipo tra supermercati svizzeri (Migros, Coop, Denner) e italiani (Esselunga, Lidl, Eurospin), tenendo conto del cambio CHF-EUR.`,
              `Per molti frontalieri, fare la spesa in Italia è un modo concreto di sfruttare il differenziale di prezzo: su un carrello settimanale da 150 CHF, il risparmio medio acquistando in Italia è del 25–35 %.`,
            );
          } else if (canonicalPath.startsWith('/vivere-in-ticino/costo-della-vita')) {
            editorialBlocks.push(
              `L'indice del costo della vita confronta le principali voci di spesa tra Svizzera (Ticino) e Italia (Lombardia/Piemonte): affitto, trasporti, alimentari, sanità, istruzione e tempo libero.`,
              `Il differenziale di costo della vita è il fattore chiave nella scelta tra permesso G (residenza in Italia) e permesso B (residenza in Svizzera): vivere in Italia può ridurre le spese fisse del 30–50 % rispetto al Ticino.`,
            );
          } else if (canonicalPath.startsWith('/vivere-in-ticino/asili-nido')) {
            editorialBlocks.push(
              `Il comparatore asili nido confronta i costi e le disponibilità di strutture per l'infanzia in Ticino e nelle province italiane di confine, con informazioni su tariffe, orari, liste d'attesa e contributi comunali.`,
              `Per le famiglie frontaliere con figli piccoli, la scelta dell'asilo nido è determinante: un posto in Ticino può costare 1500–2500 CHF/mese, mentre in Italia le tariffe comunali partono da 300–500 EUR/mese.`,
            );
          } else if (canonicalPath.startsWith('/vivere-in-ticino/ristrutturazioni')) {
            editorialBlocks.push(
              `Il calcolatore ristrutturazioni confronta i costi di interventi edilizi tra Svizzera e Italia, tenendo conto delle detrazioni fiscali italiane (bonus 50 %, Ecobonus 65 %) e degli incentivi cantonali ticinesi.`,
              `Per i frontalieri proprietari di immobili, le detrazioni italiane per ristrutturazione e risparmio energetico possono essere portate in detrazione nella dichiarazione dei redditi, riducendo significativamente il costo netto dell'intervento.`,
            );
          } else if (canonicalPath.startsWith('/vivere-in-ticino/')) {
            editorialBlocks.push(
              `La sezione "Vivere in Ticino" copre gli aspetti pratici della vita quotidiana per chi lavora nel cantone: alloggio, trasporti, spesa, servizi per la famiglia e tempo libero.`,
              `Le informazioni sono pensate sia per chi valuta un trasferimento in Svizzera sia per chi resta in Italia e vuole ottimizzare il pendolarismo quotidiano e le spese della vita da frontaliere.`,
              `Trovi comparatori interattivi per asili nido, trasporti pubblici, operatori mobili e costo della spesa, oltre a mappe e classifiche dei comuni di frontiera migliori per qualità di vita e tempi di percorrenza.`,
            );
          } else if (canonicalPath.startsWith('/statistiche/')) {
            editorialBlocks.push(
              `La sezione statistiche presenta dati aggregati e tendenze sul fenomeno frontaliero in Ticino: numero di permessi G per settore, andamento dei salari medi, tasso di disoccupazione cantonale e flussi di traffico ai valichi.`,
              `I dati provengono da fonti ufficiali (USTAT, SECO, UST) e vengono aggiornati periodicamente. I grafici interattivi permettono di esplorare serie storiche e confrontare periodi diversi.`,
              `Le statistiche sono utili per capire l'evoluzione del mercato del lavoro ticinese, identificare i settori in crescita e preparare negoziazioni salariali con dati oggettivi e verificabili.`,
            );
          } else if (isHomePage) {
            editorialBlocks.push(
              `Frontaliere Ticino è la piattaforma di riferimento per i lavoratori transfrontalieri tra Svizzera (Canton Ticino) e Italia: offre simulatori fiscali, comparatori di servizi, guide pratiche e strumenti decisionali aggiornati al 2026.`,
              `Nella home trovi una sintesi immediata delle notizie più rilevanti per frontalieri, il dato della settimana con fonte ufficiale e accessi rapidi a tutti i simulatori principali: netto, busta paga, confronto permessi, bonus, congedi e residenza.`,
              `La piattaforma è pensata per essere consultata anche da mobile durante i tempi di viaggio: ogni blocco ha un obiettivo preciso, con contenuti sintetici in ingresso e approfondimenti completi nelle pagine dedicate.`,
            );
          } else if (isJobsIndex) {
            editorialBlocks.push(
              `La sezione lavoro Ticino raccoglie annunci pubblicati su fonti aziendali ufficiali, con normalizzazione dei dati principali per facilitare confronto tra ruolo, sede, contratto e coerenza con il tuo profilo professionale.`,
              `Per ogni posizione vengono mantenuti metadati utili alla valutazione: data pubblicazione, azienda, località, requisiti richiesti e collegamento diretto alla candidatura sul sito originale del datore di lavoro.`,
            );
          } else if (isArticlesIndex) {
            editorialBlocks.push(
              `La sezione articoli è costruita come hub editoriale: ogni contenuto approfondisce un tema operativo e collega strumenti o guide utili per passare rapidamente dalla notizia alla simulazione numerica.`,
              `Gli articoli vengono scritti con approccio pratico, includendo scenari concreti e implicazioni fiscali o previdenziali, così da migliorare sia l'informazione generale sia la capacità decisionale degli utenti.`,
            );
          } else {
            // Fallback for pages without a specific section match
            editorialBlocks.push(
              `Questa pagina fa parte della piattaforma Frontaliere Ticino, il punto di riferimento per chi lavora in Svizzera (Canton Ticino) e vive in Italia. Troverai strumenti pratici, dati aggiornati e informazioni verificate.`,
              `I contenuti sono pensati per aiutare i frontalieri a prendere decisioni informate su tassazione, previdenza, trasporti, costi della vita e procedure amministrative legate al lavoro transfrontaliero.`,
              `Il sito è aggiornato quotidianamente con le ultime novità legislative, offerte di lavoro verificate e dati di mercato. Tutti gli strumenti sono gratuiti e utilizzabili senza registrazione.`,
            );
          }

          // ── Extract FAQ from structured data to render as visible HTML ──
          // Pages with FAQPage JSON-LD have high-quality Q&A content that
          // currently lives only in <script> tags (invisible to simple crawlers).
          // Rendering it as visible text adds 200-800 words of unique, topically-
          // relevant content — the single most effective soft-404 prevention.
          let faqHtml = '';
          if (seoData.sd) {
            try {
              const sdSeparator = '</script>\n    <script type="application/ld+json">';
              const sdParts = seoData.sd.split(sdSeparator);
              for (const part of sdParts) {
                const obj = JSON.parse(part);
                if (obj['@type'] === 'FAQPage' && Array.isArray(obj.mainEntity)) {
                  const FAQ_HEADING: Record<string, string> = {
                    it: 'Domande frequenti',
                    en: 'Frequently asked questions',
                    de: 'Häufig gestellte Fragen',
                    fr: 'Questions fréquentes',
                  };
                  const qas = obj.mainEntity
                    .filter((e: Record<string, unknown>) => e['@type'] === 'Question' && e.name && (e as Record<string, Record<string, unknown>>).acceptedAnswer?.text)
                    .slice(0, 5);
                  if (qas.length > 0) {
                    faqHtml = `<section style="margin-top:1.25rem"><h2 style="font-size:1rem;font-weight:700;margin:0 0 .75rem">${esc(FAQ_HEADING[locale] ?? FAQ_HEADING.it)}</h2><dl style="margin:0">${qas.map((q: Record<string, Record<string, string>>) => `<dt style="font-weight:600;margin:.75rem 0 .25rem">${esc(String(q.name))}</dt><dd style="margin:0 0 .5rem 0;color:#334155">${esc(String(q.acceptedAnswer?.text ?? ''))}</dd>`).join('')}</dl></section>`;
                  }
                  break;
                }
              }
            } catch { /* structured data not parseable, skip FAQ rendering */ }
          }

          const editorialHtml = `<div style="margin-top:.75rem;font-size:.95rem;line-height:1.6;color:#334155">${editorialBlocks.map((b) => `<p style="margin:.5rem 0">${esc(b)}</p>`).join('')}${faqHtml}${relatedHtml}</div>`;

          // Detect page section from URL for skeleton-aligned static content
          const urlSegs = urlPath.split('/').filter(Boolean);
          const localePrefixes = ['en', 'de', 'fr'];
          const firstSeg = (urlSegs.length > 1 && localePrefixes.includes(urlSegs[0])) ? urlSegs[1] : (urlSegs[0] ?? '');
          const comparatorSlugs = ['compara-servizi', 'compare-services', 'dienste-vergleichen', 'comparer-services'];
          const guideSlugs = ['guida-frontaliere', 'frontier-guide', 'grenzgaenger-leitfaden', 'guide-frontalier', 'glossario-frontaliere', 'domande-frequenti-frontalieri'];
          const fiscoSlugs = ['tasse-e-pensione', 'taxes-and-pension', 'steuern-und-rente', 'impots-et-retraite'];
          const statsSlugs = ['statistiche', 'statistics', 'statistiken', 'statistiques'];
          const blogSlugs = ['articoli-frontaliere', 'cross-border-articles', 'frontier-articles', 'grenzgaenger-artikel', 'articles-frontalier'];
          const vitaSlugs = ['vivere-in-ticino', 'living-in-ticino', 'leben-im-tessin', 'vivre-au-tessin'];
          const bodyHeadingByLocale: Record<string, string[]> = {
            it: ['Contesto', 'Dettagli operativi', 'Punti chiave'],
            en: ['Context', 'Operational details', 'Key points'],
            de: ['Kontext', 'Operative Details', 'Wichtige Punkte'],
            fr: ['Contexte', 'Details pratiques', 'Points cles'],
          };
          const isBlogDetailPage = blogSlugs.includes(firstSeg) && urlSegs.length > (localePrefixes.includes(urlSegs[0] ?? '') ? 2 : 1);
          const localeKey = (locale === 'en' || locale === 'de' || locale === 'fr') ? locale : 'it';
          const articleSlug = isBlogDetailPage ? (urlSegs[urlSegs.length - 1] ?? '') : '';
          const articleId = articleSlug
            ? blogArticleIdByLocale[localeKey as 'it' | 'en' | 'de' | 'fr'][articleSlug] ?? blogArticleIdByLocale.it[articleSlug]
            : undefined;
          const localizedBody = articleId
            ? blogBodyByLocale[localeKey as 'it' | 'en' | 'de' | 'fr'][articleId] ?? blogBodyByLocale.it[articleId]
            : undefined;
          const blogBodySections = cleanupArticleBodySections([localizedBody?.body1, localizedBody?.body2, localizedBody?.body3]);
          const blogFallbackSections = buildArticleSeoSections(
            localeKey as 'it' | 'en' | 'de' | 'fr',
            seoData.ogT,
            seoData.desc,
            '',
          );
          const bodyWordCount = blogBodySections.join(' ').split(/\s+/).filter(Boolean).length;
          const blogSectionData = !blogBodySections.length
            ? blogFallbackSections
            : (bodyWordCount < 360
              ? [
                  ...blogBodySections.map((body, index) => ({
                    heading: bodyHeadingByLocale[localeKey][index] ?? bodyHeadingByLocale[localeKey][2],
                    paragraphs: [body],
                  })),
                  ...blogFallbackSections,
                ]
              : blogBodySections.map((body, index) => ({
                  heading: bodyHeadingByLocale[localeKey][index] ?? bodyHeadingByLocale[localeKey][2],
                  paragraphs: [body],
                })));
          const blogArticleHtml = blogSectionData
            .map((section) => `<section style="margin-top:1rem"><h2 style="font-size:1rem;font-weight:700;margin:0 0 .5rem">${esc(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p style="margin:.5rem 0">${esc(paragraph)}</p>`).join('')}</section>`)
            .join('');

          // Build skeleton-matching HTML for #root to minimize CLS at hydration
          let rootHtml: string;
          // Use border outline (not background:#e2e8f0) to reserve space without triggering skeleton-dominated detection
          const sp = 'border:1px solid #e2e8f0;border-radius:12px;background:#ffffff';
          const skeletonAnim = '';
          if (comparatorSlugs.includes(firstSeg)) {
            rootHtml = `<div style="max-width:56rem;margin:0 auto;padding:1rem"><div style="${sp};height:9rem;margin-bottom:1.5rem"></div><article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:1.5rem"><div style="${sp};height:12rem"></div><div style="${sp};height:12rem"></div></div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
          } else if (guideSlugs.includes(firstSeg)) {
            rootHtml = `<div style="max-width:56rem;margin:0 auto;padding:1rem"><div style="${sp};height:7rem;margin-bottom:1.5rem"></div><article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div style="display:flex;flex-direction:column;gap:1rem;margin-top:1.5rem">${`<div style="${sp};height:5rem"></div>`.repeat(4)}</div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
          } else if (fiscoSlugs.includes(firstSeg)) {
            rootHtml = `<div style="max-width:56rem;margin:0 auto;padding:1rem"><div style="display:flex;gap:.5rem;margin-bottom:1.5rem">${`<div style="${sp};width:6rem;height:2.25rem;border-radius:9999px"></div>`.repeat(5)}</div><article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div style="${sp};height:14rem;margin-top:1.5rem"></div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
          } else if (blogSlugs.includes(firstSeg)) {
            const heroImg = blogHeroImageStatic ? `<img src="${blogHeroImageStatic}" alt="${esc(seoData.ogT)}" width="800" height="320" style="width:100%;height:16rem;object-fit:cover;border-radius:12px;margin-bottom:1.5rem" fetchpriority="high">` : `<div style="${sp};height:16rem;margin-bottom:1.5rem"></div>`;
            // Ad placeholders reserve vertical space so React hydration doesn't cause layout shifts (CLS).
            // Heights match AdSenseBanner's placeholderMinHeight values.
            const adPlaceholder = `<div style="min-height:180px;contain:layout;overflow:hidden;margin:1rem 0" aria-hidden="true"></div>`;
            rootHtml = isBlogDetailPage
              ? `<div style="max-width:56rem;margin:0 auto;padding:1rem">${heroImg}<article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p><div style="margin-top:.75rem;font-size:.95rem;line-height:1.7;color:#334155">${blogArticleHtml}</div>${adPlaceholder}${relatedHtml}</article>${adPlaceholder}<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem;margin-top:1.5rem">${`<div style="${sp};height:12rem"></div>`.repeat(3)}</div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`
              : (() => {
                // FRO-330: SSG article cards — render first 6 articles with real titles for Speed Index
                const blogListSlug = firstSeg;
                const localePrefix = localePrefixes.includes(urlSegs[0] ?? '') ? urlSegs[0] : '';
                const cardLocale = (localePrefix || 'it') as 'it' | 'en' | 'de' | 'fr';
                const top6 = blogArticlesStatic.slice(0, 6);
                const CATEGORY_COLORS: Record<string, string> = {
                  fiscale: 'background:#eef2ff;color:#4338ca',
                  pratico: 'background:#ecfdf5;color:#059669',
                  novita: 'background:#fff7ed;color:#ea580c',
                  pensione: 'background:#fdf4ff;color:#a855f7',
                };
                const CATEGORY_LABELS: Record<string, Record<string, string>> = {
                  fiscale: { it: 'Fiscale', en: 'Tax', de: 'Steuer', fr: 'Fiscal' },
                  pratico: { it: 'Pratico', en: 'Practical', de: 'Praktisch', fr: 'Pratique' },
                  novita: { it: 'Novità', en: 'News', de: 'News', fr: 'Actualité' },
                  pensione: { it: 'Pensione', en: 'Pension', de: 'Rente', fr: 'Retraite' },
                };
                const articleCardsHtml = top6.map(art => {
                  const artSlug = articleIdToSlug[cardLocale]?.[art.id] ?? art.id;
                  const artPath = localePrefix ? `/${localePrefix}/${blogListSlug}/${artSlug}` : `/${blogListSlug}/${artSlug}`;
                  const artSeo = seoMap.get(artPath);
                  const title = artSeo ? esc(artSeo.ogT) : art.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                  const desc = artSeo ? esc(artSeo.desc).substring(0, 150) : '';
                  const catColor = CATEGORY_COLORS[art.category] ?? CATEGORY_COLORS.fiscale;
                  const catLabel = CATEGORY_LABELS[art.category]?.[cardLocale] ?? art.category;
                  const dateStr = new Date(art.date).toLocaleDateString(cardLocale === 'it' ? 'it-IT' : cardLocale, { day: 'numeric', month: 'short', year: 'numeric' });
                  return `<a href="${artPath}" style="display:block;text-decoration:none;color:inherit;${sp};overflow:hidden"><img src="${art.image}" alt="${title}" width="400" height="200" style="width:100%;height:10rem;object-fit:cover" loading="lazy"><div style="padding:.75rem"><span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:.625rem;font-weight:700;${catColor}">${esc(catLabel)}</span><span style="font-size:.625rem;color:#94a3b8;margin-left:.5rem">${dateStr}</span><h3 style="font-size:.875rem;font-weight:700;color:#334155;margin:.5rem 0 .25rem;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${title}</h3>${desc ? `<p style="font-size:.75rem;color:#64748b;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${desc}</p>` : ''}</div></a>`;
                }).join('');
                return `<style>.ssg-article-grid{display:grid;grid-template-columns:1fr;gap:1.25rem;margin-top:1.5rem}@media(min-width:640px){.ssg-article-grid{grid-template-columns:repeat(2,1fr)}}@media(min-width:1024px){.ssg-article-grid{grid-template-columns:repeat(3,1fr)}}</style><div style="max-width:56rem;margin:0 auto;padding:1rem">${heroImg}<article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div class="ssg-article-grid">${articleCardsHtml}</div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
              })();
          } else if (statsSlugs.includes(firstSeg)) {
            rootHtml = `<div style="max-width:72rem;margin:0 auto;padding:1rem"><div style="${sp};height:6rem;margin-bottom:1.5rem"></div><article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:1.5rem"><div style="${sp};height:14rem"></div><div style="${sp};height:14rem"></div></div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
          } else if (vitaSlugs.includes(firstSeg)) {
            rootHtml = `<div style="max-width:56rem;margin:0 auto;padding:1rem"><div style="${sp};height:7rem;margin-bottom:1.5rem"></div><article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:1.5rem"><div style="${sp};height:10rem"></div><div style="${sp};height:10rem"></div></div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
          } else {
            // Default: calculator-like layout
            rootHtml = `<div style="max-width:56rem;margin:0 auto;padding:1rem"><article><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">${esc(seoData.ogT)}</h1><p style="color:#64748b;font-size:.875rem">${esc(seoData.desc)}</p>${editorialHtml}</article><div style="${sp};height:38rem;margin-top:1.5rem"></div><nav style="margin-top:1.5rem;font-size:.75rem;color:#64748b">${navHtml}</nav></div>`;
          }

          // SPA shell: loads the app directly at the correct URL (no redirect)
          if (hasSpaBundle) {
            const useBlockingHomeCss = isHomeCriticalStaticPath(canonicalPath);
            const stylesheetMarkup = useBlockingHomeCss
              ? `<link rel="stylesheet" href="/assets/${entryCss}" crossorigin data-clarity-unmask="true">`
              : `<link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="print" onload="this.media='all'" data-clarity-unmask="true">
    <noscript><link rel="stylesheet" crossorigin href="/assets/${entryCss}" data-clarity-unmask="true"></noscript>
    <script>setTimeout(function(){var l=document.querySelector('link[media="print"][href*="/assets/"]');if(l){l.media='all';try{sessionStorage.setItem('_cssFallbackInfo',JSON.stringify({href:l.href,delayMs:3000,pagePath:location.pathname+location.search,ts:new Date().toISOString()}))}catch(e){}}},3000)</script>`;
            return `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(seoData.title)}</title>
    <meta name="description" content="${esc(seoData.desc)}">
    <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
    <link rel="canonical" href="${fullUrl}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${fullUrl}">
    <meta property="og:title" content="${esc(seoData.ogT)}">
    <meta property="og:description" content="${esc(seoData.ogD)}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:locale" content="${LOC_TAG[locale] ?? 'it_IT'}">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="fb:app_id" content="891036063797338">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(seoData.ogT)}">
    <meta name="twitter:description" content="${esc(seoData.ogD)}">
    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
    <meta name="twitter:site" content="@frontaliereticino">
${hrefTags}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <script>if(localStorage.theme==='dark')document.documentElement.classList.add('dark')</script>
    <style>${criticalCSS}</style>
    <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
    ${stylesheetMarkup}${preloadTag}${getPagePreloads(urlPath, locale)}
    <style>${skeletonAnim}</style>
  </head>
  <body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-x-hidden">
    <script type="application/ld+json">${breadcrumbJsonLd}</script>${seoData.sd ? `\n    <script type="application/ld+json">${seoData.sd}</script>` : ''}
    <div id="root">${rootHtml}</div>
    <script type="module" crossorigin fetchpriority="high" src="/assets/${entryJs}"></script>
  </body>
</html>`;
          }

          // Fallback: redirect to SPA (only if bundles not found)
          return `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(seoData.title)}</title>
    <meta name="description" content="${esc(seoData.desc)}">
    <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
    <link rel="canonical" href="${fullUrl}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${fullUrl}">
    <meta property="og:title" content="${esc(seoData.ogT)}">
    <meta property="og:description" content="${esc(seoData.ogD)}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:locale" content="${LOC_TAG[locale] ?? 'it_IT'}">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="fb:app_id" content="891036063797338">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(seoData.ogT)}">
    <meta name="twitter:description" content="${esc(seoData.ogD)}">
    <meta name="twitter:image" content="${BASE_URL}/og-image.png">
    <meta name="twitter:site" content="@frontaliereticino">
${hrefTags}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <noscript><meta http-equiv="refresh" content="0;url=/?p=${pp}"></noscript>
  </head>
  <body>
    <script type="application/ld+json">${breadcrumbJsonLd}</script>${seoData.sd ? `\n    <script type="application/ld+json">${seoData.sd}</script>` : ''}
    <style>${skeletonAnim}</style>
    <div id="root">${rootHtml}</div>
    <script>location.replace('/${pp.replace(/~and~/g, '&')}'+location.hash)</script>
  </body>
</html>`;
        };

        // Write Italian page only if it doesn't already exist from the main build
        // (important: still generate locale variants below even when Italian exists)
        if (!italianPageExists) {
          const dir = np.join(distDir, url.path);
          /* dir created by _qw */
          const pageHtml = buildPage('it', url.path, seo, url.hreflangs);
          _qw(filePath, pageHtml);
          // Also write flat .html so /slug serves 200 (avoids GitHub Pages 301 redirect)
          // Uses minimal noindex redirect instead of content duplicate to avoid
          // Google's "alternative page with proper canonical" status
          if (url.path !== '/') {
            const flatFile = np.join(distDir, url.path + '.html');
            const canonUrl = `${BASE_URL}/${url.path.replace(/^\/+/, '')}/`.replace(/\/+$/, '/');
            /* dir created by _qw */
            _qw(flatFile, buildFlatRedirect(canonUrl, `/${url.path.replace(/^\/+/, '')}/`));
          }
          count++;
        } else {
          // Homepage special case: inject static content into Vite's index.html
          // so the empty <div id="root"></div> gets pre-rendered content for CLS/LCP.
          // Structured data is already in index.html as static ld+json tags.
          if (url.path === '/' && seo) {
            try {
              const generatedPage = buildPage('it', url.path, seo, url.hreflangs);
              const rootMatch = generatedPage.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/);
              if (rootMatch?.[1]) {
                let existingHtml = fs.readFileSync(filePath, 'utf-8');
                if (existingHtml.includes('<div id="root"></div>')) {
                  existingHtml = existingHtml.replace(
                    '<div id="root"></div>',
                    `<div id="root">${rootMatch[1]}</div>`,
                  );
                  _qw(filePath, existingHtml);
                  console.log('[static-pages] Injected static content into homepage index.html');
                }
              }
            } catch (e) {
              console.warn('[static-pages] Could not inject into homepage:', (e as Error).message);
            }
          }
          // Even if the directory index.html exists, ensure flat .html exists too
          if (url.path !== '/') {
            const flatFile = np.join(distDir, url.path + '.html');
            if (!fs.existsSync(flatFile)) {
              const canonUrl = `${BASE_URL}/${url.path.replace(/^\/+/, '')}/`.replace(/\/+$/, '/');
              /* dir created by _qw */
              _qw(flatFile, buildFlatRedirect(canonUrl, `/${url.path.replace(/^\/+/, '')}/`));
            }
          }
          skipped++;
        }

        // Write locale variants from hreflang data
        for (const hl of url.hreflangs) {
          if (hl.lang === 'it' || hl.lang === 'x-default') continue;
          const locPath = (hl.href.replace(BASE_URL, '') || '/').replace(/\/+$/, '') || '/';
          if (!locPath || locPath === '/') continue;

          const locFile = np.join(distDir, locPath, 'index.html');
          if (fs.existsSync(locFile)) {
            // Ensure flat .html exists even if directory index.html was created by another plugin
            const flatLoc = np.join(distDir, locPath + '.html');
            if (!fs.existsSync(flatLoc)) {
              const canonLocUrl = `${BASE_URL}/${locPath.replace(/^\/+/, '')}/`.replace(/\/+$/, '/');
              _qw(flatLoc, buildFlatRedirect(canonLocUrl, `/${locPath.replace(/^\/+/, '')}/`));
            }
            continue;
          }

          // Look up locale-specific SEO or derive locale-appropriate metadata
          const locSeo = seoMap.get(locPath) ?? deriveLocaleSeo(locPath, hl.lang, seo);

          // Translate FAQPage structured data for non-IT locale variants
          if (locSeo.sd) {
            const sdSeparator = '</script>\n    <script type="application/ld+json">';
            const sdParts = locSeo.sd.split(sdSeparator);
            const translated = sdParts.map(part => {
              try {
                const obj = JSON.parse(part);
                if (obj['@type'] === 'FAQPage' && (hl.lang === 'en' || hl.lang === 'de' || hl.lang === 'fr')) {
                  translateFaqPage(obj, hl.lang);
                  if (typeof obj.inLanguage === 'string') obj.inLanguage = hl.lang;
                  return JSON.stringify(obj);
                }
              } catch { /* not valid JSON, pass through */ }
              return part;
            });
            locSeo.sd = translated.join(sdSeparator);
          }

          const locDir = np.join(distDir, locPath);
          const locPageHtml = buildPage(hl.lang, locPath, locSeo, url.hreflangs);
          _qw(locFile, locPageHtml);
          // Also write flat .html for clean URL — noindex redirect to trailing-slash canonical
          const flatLoc = np.join(distDir, locPath + '.html');
          const canonLocUrl = `${BASE_URL}/${locPath.replace(/^\/+/, '')}/`.replace(/\/+$/, '/');
          _qw(flatLoc, buildFlatRedirect(canonLocUrl, `/${locPath.replace(/^\/+/, '')}/`));
          count++;
        }
      }

      const t0 = Date.now();
      await _flush();
      console.log(`[static-pages] Flushed ${_pw.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`\x1b[36m[static-pages]\x1b[0m Generated ${count} static pages (${skipped} skipped — already exist or no SEO data)`);

      /* ── Auto-update sitemap index lastmod dates to today ─────── */
      const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
      if (fs.existsSync(sitemapIndexPath)) {
        const today = new Date().toISOString().slice(0, 10);
        let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
        idx = idx.replace(
          /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g,
          `<lastmod>${today}</lastmod>`
        );
        fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
        console.log(`\x1b[36m[static-pages]\x1b[0m Updated sitemap.xml lastmod dates to ${today}`);
      }
    },
  };
}
