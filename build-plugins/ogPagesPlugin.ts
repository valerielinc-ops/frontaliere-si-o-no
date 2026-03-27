/**
 * Generate OG landing pages for blog articles.
 *
 * For every blog article in seo-blog.ts, writes a full static HTML page
 * with OG/Twitter meta, hreflang alternates, JSON-LD (Article / NewsArticle),
 * article body text, and the SPA entry bundle so the page hydrates into
 * the React app on load.
 */

import path from 'path';
import type { Plugin } from 'vite';
import { BASE_URL, buildFlatRedirect, type FlatRedirectOgMeta } from './constants';
import { buildArticleSeoSections, cleanupArticleBodySections } from './articleSeoFallback';

export function ogPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'og-pages',
    apply: 'build',
    async closeBundle() {
      const fs = await import('node:fs');
      const np = await import('node:path');

      const distDir  = np.resolve(rootDir, 'dist');
      const DEFAULT_IMG = '/og-image.png';
      const blogImageById: Record<string, string> = {};

      // Source of truth fallback for article images (kept in BlogArticles list)
      try {
        const blogSrc = fs.readFileSync(np.resolve(rootDir, 'components/community/BlogArticles.tsx'), 'utf-8');
        const re = /\{\s*id:\s*'([^']+)'\s*,[\s\S]*?\bimage:\s*'([^']+)'/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(blogSrc)) !== null) {
          blogImageById[m[1]] = m[2];
        }
      } catch { /* non-fatal */ }

      const resolveImagePath = (candidate: string, articleId: string): string => {
        const norm = (p: string) => (p.startsWith('/') ? p : `/${p}`).replace(/\/+/g, '/');
        const fileExists = (publicPath: string) => fs.existsSync(np.join(distDir, publicPath.replace(/^\/+/, '')));
        const fromSameBase = (p: string): string | null => {
          const ext = np.extname(p);
          const base = ext ? p.slice(0, -ext.length) : p;
          for (const e of ['.jpg', '.jpeg', '.png', '.webp', '.avif']) {
            const alt = `${base}${e}`;
            if (fileExists(alt)) return alt;
          }
          return null;
        };

        const direct = norm(candidate || '');
        if (direct && fileExists(direct)) return direct;
        const altFromCandidate = direct ? fromSameBase(direct) : null;
        if (altFromCandidate) return altFromCandidate;

        const fromList = norm(blogImageById[articleId] || '');
        if (fromList && fileExists(fromList)) return fromList;
        const altFromList = fromList ? fromSameBase(fromList) : null;
        if (altFromList) return altFromList;

        return DEFAULT_IMG;
      };

      /* ── 1. Parse blog SEO entries from seo-blog.ts chunks ─────── */
      let seoSrc: string;
      try {
        seoSrc = fs.readFileSync(np.resolve(rootDir, 'services/seo/seo-blog.ts'), 'utf-8');
        // Append all seo-blog-N.ts chunks (seo-blog-2.ts, seo-blog-3.ts, etc.)
        for (let n = 2; n <= 10; n++) {
          try {
            seoSrc += '\n' + fs.readFileSync(np.resolve(rootDir, `services/seo/seo-blog-${n}.ts`), 'utf-8');
          } catch { break; }
        }
      } catch {
        try {
          seoSrc = fs.readFileSync(np.resolve(rootDir, 'services/seoService.ts'), 'utf-8');
        } catch {
          console.warn('[og-pages] Could not read seo-blog.ts or seoService.ts — skipping');
          return;
        }
      }

      interface Entry {
        key: string;
        articleId: string;
        title: string;
        desc: string;
        keywords: string;
        ogT: string;
        ogD: string;
        path: string;
        img: string;
        datePub: string;
        dateMod: string;
      }
      const entries: Entry[] = [];

      const keyRx = /'(blog-[^']+)':\s*\{/g;
      let km: RegExpExecArray | null;
      const pos: { key: string; start: number }[] = [];
      while ((km = keyRx.exec(seoSrc)) !== null) pos.push({ key: km[1], start: km.index });

      for (let i = 0; i < pos.length; i++) {
        const s = pos[i].start;
        const key = pos[i].key;
        const articleId = key.replace(/^blog-/, '');
        const e = i + 1 < pos.length ? pos[i + 1].start : Math.min(s + 3000, seoSrc.length);
        const b = seoSrc.substring(s, e);

        const matchStr = (key: string, flags = ''): string => {
          const rx = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, flags);
          return b.match(rx)?.[1]?.replace(/\\(.)/g, (_: string, c: string) => c === 'n' ? ' ' : c === 'r' ? '' : c === 't' ? ' ' : c) ?? '';
        };
        const title = matchStr('title', 'm') || '';
        const desc  = matchStr('description', 'm') || '';
        const keywords = matchStr('keywords', 'm') || '';
        const ogT   = matchStr('ogTitle') || title;
        const ogD   = matchStr('ogDescription') || desc;
        const cp    = b.match(/canonicalPath:\s*'([^']+)'/)?.[1] ?? '';
        const imRaw = b.match(/\/images\/[^'"`\s,}]+/)?.[0] ?? DEFAULT_IMG;
        const im = resolveImagePath(imRaw, articleId);
        const datePub = b.match(/"datePublished":\s*"([^"]+)"/)?.[1] ?? '';
        const dateMod = b.match(/"dateModified":\s*"([^"]+)"/)?.[1] ?? '';

        if (cp.startsWith('/articoli-frontaliere/')) {
          entries.push({ key, articleId, title, desc, keywords, ogT, ogD, path: cp, img: im, datePub, dateMod });
        }
      }

      if (!entries.length) { console.warn('[og-pages] No blog entries found'); return; }

      /* ── 2. Parse blog slug map + blog index slugs from router.ts ── */
      // BLOG_SLUGS: Record<BlogArticleId, { it, en, de, fr }> — flat lookup
      const blogSlugs: Record<string, Record<string, string>> = {};
      // Blog index slug per locale (e.g. 'articoli-frontaliere')
      const blogIndexSlug: Record<string, string> = {};
      try {
        const rSrc = fs.readFileSync(np.resolve(rootDir, 'services/routerBlogData.ts'), 'utf-8');
        // Parse BLOG_SLUGS map
        const bsBlock = rSrc.match(/const BLOG_SLUGS[\s\S]*?\n\};/m)?.[0] ?? '';
        const bsRx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
        let bm: RegExpExecArray | null;
        while ((bm = bsRx.exec(bsBlock)) !== null) {
          blogSlugs[bm[1]] = { it: bm[2], en: bm[3], de: bm[4], fr: bm[5] };
        }
        // Parse blog index slug from SLUG_TABLES in router.ts
        try {
          const routerSrc = fs.readFileSync(np.resolve(rootDir, 'services/router.ts'), 'utf-8');
          const stBlock = routerSrc.match(/const SLUG_TABLES[\s\S]*?^};/m)?.[0] ?? '';
          for (const loc of ['it', 'en', 'de', 'fr']) {
            const lm = stBlock.match(new RegExp(`  ${loc}: \\{([\\s\\S]*?)\\n  \\}`, 'm'));
            if (!lm) continue;
            const bm2 = lm[1].match(/\bblog:\s*'([^']+)'/);
            if (bm2) blogIndexSlug[loc] = bm2[1];
          }
        } catch { /* hreflang index slug will fall back to hardcoded values */ }
        // Hardcoded fallbacks if parsing failed
        if (!blogIndexSlug.it) blogIndexSlug.it = 'articoli-frontaliere';
        if (!blogIndexSlug.en) blogIndexSlug.en = 'cross-border-articles';
        if (!blogIndexSlug.de) blogIndexSlug.de = 'grenzgaenger-artikel';
        if (!blogIndexSlug.fr) blogIndexSlug.fr = 'articles-frontalier';
      } catch { /* hreflang will be omitted */ }

      const unescapeTsString = (value: string): string =>
        value
          .replace(/\\'/g, '\'')
          .replace(/\\"/g, '"')
          .replace(/\\n/g, ' ')
          .replace(/\\r/g, '')
          .replace(/\\t/g, ' ')
          .replace(/\\\\/g, '\\');

      const parseBlogMetaLocale = (locale: 'en' | 'de' | 'fr') => {
        const out: Record<string, { title?: string; excerpt?: string; imageAlt?: string }> = {};
        const p = np.resolve(rootDir, `services/locales/blog-meta-${locale}.ts`);
        let src = '';
        try { src = fs.readFileSync(p, 'utf-8'); } catch { return out; }
        const rx = /'blog\.article\.([^']+)\.(title|excerpt|imageAlt)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(src)) !== null) {
          const articleId = m[1];
          const field = m[2] as 'title' | 'excerpt' | 'imageAlt';
          const value = unescapeTsString(m[3]);
          if (!out[articleId]) out[articleId] = {};
          out[articleId][field] = value;
        }
        return out;
      };

      const parseBlogBodyLocale = (locale: 'it' | 'en' | 'de' | 'fr') => {
        const out: Record<string, Record<string, string>> = {};
        const dir = np.resolve(rootDir, 'services', 'locales', 'blog-body', locale);
        let files: string[] = [];
        try { files = fs.readdirSync(dir); } catch { return out; }
        const rx = /'blog\.article\.([^']+)\.(body\d+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
        for (const file of files) {
          if (!file.endsWith('.ts')) continue;
          let src = '';
          try { src = fs.readFileSync(np.join(dir, file), 'utf-8'); } catch { continue; }
          let m: RegExpExecArray | null;
          while ((m = rx.exec(src)) !== null) {
            const articleId = m[1];
            const field = m[2];
            const value = unescapeTsString(m[3]);
            if (!out[articleId]) out[articleId] = {};
            out[articleId][field] = value;
          }
        }
        return out;
      };

      const blogMetaByLocale = {
        en: parseBlogMetaLocale('en'),
        de: parseBlogMetaLocale('de'),
        fr: parseBlogMetaLocale('fr'),
      } as const;

      const blogBodyByLocale = {
        it: parseBlogBodyLocale('it'),
        en: parseBlogBodyLocale('en'),
        de: parseBlogBodyLocale('de'),
        fr: parseBlogBodyLocale('fr'),
      } as const;

      const normalizeDateTime = (value: string): string => {
        if (!value) return value;
        if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00+01:00`;
        if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return `${value}+01:00`;
        return value;
      };

      /* ── 3. Write OG landing pages ──────────────────────────────── */
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
         .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const LOC_TAG: Record<string, string> = { it: 'it_IT', en: 'en_US', de: 'de_DE', fr: 'fr_FR' };
      let count = 0;

      const assetsDir = np.join(distDir, 'assets');
      let entryJs = '', entryCss = '', vendorReactChunk = '';
      try {
        const builtHtml = fs.readFileSync(np.join(distDir, 'index.html'), 'utf-8');
        entryJs = builtHtml.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)?.[1] ?? '';
        entryCss = builtHtml.match(/href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/)?.[1] ?? '';
      } catch { /* index.html missing */ }
      let blogMetaItChunk = '';
      try {
        const assetFiles = fs.readdirSync(assetsDir);
        vendorReactChunk = assetFiles.find((f: string) => f.startsWith('vendor-react-') && f.endsWith('.js') && !f.endsWith('.js.map')) ?? '';
        blogMetaItChunk = assetFiles.find((f: string) => /^blog-meta-it-[A-Za-z0-9_-]+\.js$/.test(f) && !f.endsWith('.js.map')) ?? '';
      } catch { /* assets dir missing */ }
      const hasSpaBundle = !!(entryJs && entryCss);
      let itCriticalTags = '';
      try {
        const af = fs.readdirSync(assetsDir);
        for (const f of af) {
          if (/^it-(core|calculator)-[A-Za-z0-9_-]+\.js$/.test(f) && !f.endsWith('.js.map')) {
            itCriticalTags += `\n    <link rel="modulepreload" href="/assets/${f}">`;
          }
        }
      } catch { /* */ }
      const corePreloads = [
        vendorReactChunk ? `<link rel="modulepreload" crossorigin href="/assets/${vendorReactChunk}">` : '',
        itCriticalTags,
      ].filter(Boolean).join('');
      const preloadTag = corePreloads ? '\n    ' + corePreloads : '';

      const criticalCSS = '@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/inter-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}*,::after,::before{box-sizing:border-box;border:0 solid #e5e7eb}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}.bg-slate-50{background-color:#f8fafc}.dark .dark\\:bg-slate-950,.dark.bg-slate-950{background-color:#020617}.text-slate-900{color:#0f172a}.dark .dark\\:text-slate-100{color:#f1f5f9}#root{min-height:100vh}';

      for (const en of entries) {
        const locSlugs = blogSlugs[en.articleId];

        const lp: Record<string, string | null> = { it: en.path, en: null, de: null, fr: null };
        if (locSlugs) {
          for (const l of ['en', 'de', 'fr']) {
            const as = locSlugs[l], bs = blogIndexSlug[l];
            if (as && bs) lp[l] = `/${l}/${bs}/${as}`;
          }
        }

        const withTrailingSlash = (path: string): string => {
          if (!path || path === '/') return '/';
          const clean = path.replace(/\/+$/, '');
          return clean ? `${clean}/` : '/';
        };

        /** Extract plain-text excerpt from HTML body for structured data articleBody */
        const extractExcerpt = (htmlBody: string | undefined, maxChars = 500): string => {
          if (!htmlBody) return '';
          return htmlBody
            .replace(/<[^>]+>/g, ' ')      // strip HTML tags
            .replace(/&[a-z]+;/gi, ' ')     // strip HTML entities
            .replace(/\s+/g, ' ')           // normalize whitespace
            .trim()
            .slice(0, maxChars)
            .replace(/\s+\S*$/, '');        // truncate at last complete word
        };

        /** Count words in HTML body */
        const countWords = (htmlBody: string | undefined): number => {
          if (!htmlBody) return 0;
          return htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).length;
        };

        const html = (locale: string, urlPath: string) => {
          const localeForMeta: 'en' | 'de' | 'fr' | null =
            (locale === 'en' || locale === 'de' || locale === 'fr') ? locale : null;
          const localizedMeta = localeForMeta ? blogMetaByLocale[localeForMeta][en.articleId] : null;
          const localizedTitle = localizedMeta?.title || en.ogT;
          const localizedDesc = localizedMeta?.excerpt || en.ogD;
          const localizedPageTitle = localizedMeta?.title ? `${localizedMeta.title} | Frontaliere Ticino` : en.title;
          const articleBodyLocale = (locale === 'it' || locale === 'en' || locale === 'de' || locale === 'fr') ? locale : 'it';
          const localizedBody = blogBodyByLocale[articleBodyLocale][en.articleId] ?? blogBodyByLocale.it[en.articleId];
          const allBodyKeys = localizedBody ? Object.keys(localizedBody).sort((a, b) => {
            const na = parseInt(a.replace('body', ''), 10);
            const nb = parseInt(b.replace('body', ''), 10);
            return na - nb;
          }) : [];
          const bodySections = cleanupArticleBodySections(allBodyKeys.map(k => localizedBody?.[k]));
          const canonicalPath = withTrailingSlash(urlPath);
          const full = `${BASE_URL}${canonicalPath}`;
          const imgU = `${BASE_URL}${en.img}`;
          const pp   = urlPath.slice(1).replace(/&/g, '~and~');
          const href = Object.entries(lp)
            .filter((x): x is [string, string] => x[1] !== null)
            .map(([l, p]) => `    <link rel="alternate" hreflang="${l}" href="${BASE_URL}${withTrailingSlash(p)}">`)
            .concat([`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withTrailingSlash(lp.it)}">`])
            .join('\n');

          const ldObj: Record<string, unknown> = {
            '@context': 'https://schema.org',
            '@type': (en.datePub && (Date.now() - new Date(en.datePub).getTime()) < 90 * 24 * 60 * 60 * 1000) ? 'NewsArticle' : 'Article',
            headline: localizedTitle,
            description: localizedDesc,
            image: {
              '@type': 'ImageObject',
              url: imgU,
              width: 1200,
              height: en.img?.includes('/images/places/') ? 563 : 675,
            },
            url: full,
            inLanguage: locale,
            // Reference standalone Organization defined in index.html (FRO-312)
            publisher: { '@id': `${BASE_URL}/#organization` },
            // Expert Person author — AI systems give citation boost for named authors
            author: {
              '@type': 'Person',
              name: 'Redazione Frontaliere Ticino',
              jobTitle: 'Esperti in fiscalità transfrontaliera',
              description: 'Portale di riferimento per i frontalieri ticino dal 2020. Analisi fiscali, previdenziali e pratiche basate su fonti ufficiali: ESTV, UST, INPS, Agenzia delle Entrate.',
              url: `${BASE_URL}/chi-siamo/`,
              worksFor: { '@type': 'Organization', name: 'Frontaliere Ticino', '@id': `${BASE_URL}/#organization` },
              knowsAbout: [
                'Imposta alla fonte Svizzera',
                'Frontalieri Ticino',
                'AVS LPP pensione',
                'LAMal assicurazione malattia',
                'Accordo fiscale italo-svizzero 2020',
              ],
              sameAs: [],
            },
            mainEntityOfPage: full,
            speakable: {
              '@type': 'SpeakableSpecification',
              cssSelector: ['article h1', 'article h2', 'article p'],
            },
            // Google Discover eligibility fields
            isAccessibleForFree: true,
            articleSection: 'Frontalieri Ticino',
          };
          const buildDateIso = new Date().toISOString();
          const todayIso = buildDateIso.slice(0, 10);
          ldObj.datePublished = normalizeDateTime(en.datePub || en.dateMod || todayIso);
          // Always use build date for dateModified — AI systems weight freshness heavily
          ldObj.dateModified  = buildDateIso;

          // articleBody excerpt + wordCount (Google Discover uses this for topic relevance)
          const fullBodyHtml = bodySections.join('\n');
          const excerpt = extractExcerpt(fullBodyHtml, 500);
          if (excerpt) {
            ldObj.articleBody = excerpt;
            ldObj.wordCount = countWords(fullBodyHtml);
          }

          // keywords from article metadata
          if (en.keywords) {
            const kw = typeof en.keywords === 'string'
              ? en.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
              : Array.isArray(en.keywords) ? en.keywords : [];
            if (kw.length > 0) ldObj.keywords = kw;
          }

          const ldJsonStr = JSON.stringify(ldObj).replace(/</g, '\\u003c');

          // BreadcrumbList for article pages (enables rich result breadcrumbs in Google)
          const sectionName = locale === 'en' ? 'Articles' : locale === 'de' ? 'Artikel' : locale === 'fr' ? 'Articles' : 'Articoli';
          const sectionSlug = blogIndexSlug[locale] || (locale === 'en' ? 'cross-border-articles' : locale === 'de' ? 'grenzgaenger-artikel' : locale === 'fr' ? 'articles-frontalier' : 'articoli-frontaliere');
          const breadcrumbLd = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
              { '@type': 'ListItem', position: 2, name: sectionName, item: `${BASE_URL}/${sectionSlug}/` },
              { '@type': 'ListItem', position: 3, name: localizedTitle },
            ],
          }).replace(/</g, '\\u003c');

          // FAQPage schema for blog articles — locale-aware generic frontaliere FAQs
          const blogFaqsByLocale: Record<string, Array<{ q: string; a: string }>> = {
            it: [
              { q: 'Dove posso trovare un simulatore fiscale gratuito per frontalieri?', a: 'Su Frontaliere Ticino trovi un simulatore fiscale gratuito che calcola il netto per nuovi e vecchi frontalieri, considerando imposta alla fonte svizzera, IRPEF italiana, AVS, LPP e il nuovo accordo 2026.' },
              { q: 'Come posso restare aggiornato sulle novità per frontalieri in Ticino?', a: 'Frontaliere Ticino pubblica articoli quotidiani su fisco, lavoro, dogane e servizi per frontalieri. Puoi anche iscriverti alla newsletter settimanale per ricevere un riepilogo delle novità più importanti.' },
              { q: 'Quali strumenti gratuiti offre Frontaliere Ticino?', a: 'Il sito offre: simulatore fiscale, confronto cambio valuta CHF/EUR, comparatore assicurazioni LAMal, bacheca lavoro con oltre 4.000 annunci aggiornati, guida completa ai permessi G e B, e calcolatore costo pendolarismo.' },
            ],
            en: [
              { q: 'Where can I find a free tax simulator for cross-border workers?', a: 'Frontaliere Ticino offers a free tax simulator that calculates net salary for new and old cross-border workers, considering Swiss withholding tax, Italian IRPEF, AVS, LPP and the 2026 agreement.' },
              { q: 'How can I stay updated on news for cross-border workers in Ticino?', a: 'Frontaliere Ticino publishes daily articles on taxes, jobs, customs and services for cross-border workers. You can also subscribe to the weekly newsletter for a summary of the most important news.' },
              { q: 'What free tools does Frontaliere Ticino offer?', a: 'The site offers: tax simulator, CHF/EUR exchange rate comparison, LAMal insurance comparator, job board with 4,000+ updated listings, complete guide to G and B permits, and commuting cost calculator.' },
            ],
            de: [
              { q: 'Wo finde ich einen kostenlosen Steuerrechner für Grenzgänger?', a: 'Frontaliere Ticino bietet einen kostenlosen Steuerrechner, der das Nettogehalt für neue und alte Grenzgänger berechnet, unter Berücksichtigung der Schweizer Quellensteuer, der italienischen IRPEF, AHV, BVG und der Vereinbarung 2026.' },
              { q: 'Wie bleibe ich über Neuigkeiten für Grenzgänger im Tessin informiert?', a: 'Frontaliere Ticino veröffentlicht täglich Artikel zu Steuern, Arbeit, Zoll und Dienstleistungen für Grenzgänger. Sie können auch den wöchentlichen Newsletter abonnieren.' },
              { q: 'Welche kostenlosen Tools bietet Frontaliere Ticino?', a: 'Die Website bietet: Steuerrechner, CHF/EUR-Wechselkursvergleich, KVG-Versicherungsvergleich, Stellenbörse mit über 4.000 aktualisierten Anzeigen, Leitfaden zu G- und B-Bewilligungen und Pendlerkostenrechner.' },
            ],
            fr: [
              { q: 'Où trouver un simulateur fiscal gratuit pour frontaliers ?', a: 'Frontaliere Ticino propose un simulateur fiscal gratuit qui calcule le salaire net pour les nouveaux et anciens frontaliers, en tenant compte de l\'impôt à la source suisse, de l\'IRPEF italien, de l\'AVS, de la LPP et de l\'accord 2026.' },
              { q: 'Comment rester informé des nouveautés pour les frontaliers au Tessin ?', a: 'Frontaliere Ticino publie quotidiennement des articles sur la fiscalité, l\'emploi, les douanes et les services pour frontaliers. Vous pouvez aussi vous abonner à la newsletter hebdomadaire.' },
              { q: 'Quels outils gratuits propose Frontaliere Ticino ?', a: 'Le site propose : simulateur fiscal, comparateur de taux de change CHF/EUR, comparateur d\'assurances LAMal, bourse d\'emploi avec plus de 4 000 annonces, guide complet des permis G et B, et calculateur de frais de pendulaire.' },
            ],
          };
          const faqItems = blogFaqsByLocale[locale] || blogFaqsByLocale.it;
          const faqLd = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: faqItems.map((f) => ({
              '@type': 'Question',
              name: f.q,
              acceptedAnswer: { '@type': 'Answer', text: f.a },
            })),
          }).replace(/</g, '\\u003c');

          const headTags = `    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(localizedPageTitle)}</title>
    <meta name="description" content="${esc(localizedDesc)}">
    <link rel="canonical" href="${full}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${full}">
    <meta property="og:title" content="${esc(localizedTitle)}">
    <meta property="og:description" content="${esc(localizedDesc)}">
    <meta property="og:image" content="${imgU}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="${en.img?.includes('/images/places/') ? '563' : '675'}">
    <meta property="og:image:type" content="${en.img?.includes('.webp') ? 'image/webp' : 'image/jpeg'}">
    <meta property="og:locale" content="${LOC_TAG[locale] ?? 'it_IT'}">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
    <meta property="fb:app_id" content="891036063797338">
    <meta property="article:published_time" content="${esc(normalizeDateTime(en.datePub || en.dateMod || todayIso))}">
    <meta property="article:modified_time" content="${esc(normalizeDateTime(en.dateMod || en.datePub || todayIso))}">
    <meta property="article:section" content="Frontalieri Ticino">
    <meta property="article:author" content="${BASE_URL}/chi-siamo/">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(localizedTitle)}">
    <meta name="twitter:description" content="${esc(localizedDesc)}">
    <meta name="twitter:image" content="${imgU}">
    <meta name="twitter:site" content="@frontaliereticino">
${href}
    <link rel="alternate" type="application/rss+xml" title="Frontaliere Ticino" href="${BASE_URL}/rss.xml">
    <script type="application/ld+json">${ldJsonStr}</script>
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${faqLd}</script>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

          const blogPreloads = [
            `<link rel="preload" as="image" href="${en.img}" fetchpriority="high">`,
            blogMetaItChunk ? `<link rel="modulepreload" href="/assets/${blogMetaItChunk}">` : '',
          ].filter(Boolean).join('\n    ');

          if (hasSpaBundle) {
            const fallbackSections = buildArticleSeoSections(
              articleBodyLocale,
              localizedTitle,
              localizedDesc,
              en.keywords,
            );
            const bodyWordCount = bodySections.join(' ').split(/\s+/).filter(Boolean).length;
            const sectionSource = !bodySections.length
              ? fallbackSections
              : (bodyWordCount < 360
                ? [
                    ...bodySections.map((body, i) => ({
                      heading: i === 0 ? 'Contesto' : i === 1 ? 'Dettagli operativi' : 'Punti chiave',
                      paragraphs: [body],
                    })),
                    ...fallbackSections,
                  ]
                : bodySections.map((body, i) => ({
                    heading: i === 0 ? 'Contesto' : i === 1 ? 'Dettagli operativi' : 'Punti chiave',
                    paragraphs: [body],
                  })));
            const articleBodyHtml = sectionSource
              .map((section) => `<section><h2>${esc(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}</section>`)
              .join('');
            return `<!DOCTYPE html>
<html lang="${locale}">
  <head>
${headTags}
    ${blogPreloads}
    <script>if(localStorage.theme==='dark')document.documentElement.classList.add('dark')</script>
    <style>${criticalCSS}</style>
    <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="print" onload="this.media='all'" data-clarity-unmask="true">
    <noscript><link rel="stylesheet" crossorigin href="/assets/${entryCss}" data-clarity-unmask="true"></noscript>
    <script>setTimeout(function(){var l=document.querySelector('link[media="print"][href*="/assets/"]');if(l){l.media='all';try{sessionStorage.setItem('_cssFallbackInfo',JSON.stringify({href:l.href,delayMs:3000,pagePath:location.pathname+location.search,ts:new Date().toISOString()}))}catch(e){}}},3000)</script>${preloadTag}
  </head>
  <body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-x-hidden">
    <div id="root"><article><h1>${esc(localizedTitle)}</h1><p class="article-byline" style="font-size:0.85rem;color:#64748b;margin:0.25rem 0 1rem">Di Redazione Frontaliere Ticino · ${esc(normalizeDateTime(en.datePub || en.dateMod || todayIso).split('T')[0])}</p><p>${esc(localizedDesc)}</p>${articleBodyHtml}<nav><a href="/">Simulatore Fiscale</a> | <a href="/compara-servizi/">Confronta Servizi</a> | <a href="/tasse-e-pensione/">Tasse e Pensione</a> | <a href="/guida-frontaliere/">Guida Frontaliere</a> | <a href="/domande-frequenti-frontalieri/">FAQ</a> | <a href="/glossario-frontaliere/">Glossario</a> | <a href="/articoli-frontaliere/">Articoli</a></nav></article></div>
    <script type="module" crossorigin fetchpriority="high" src="/assets/${entryJs}"></script>
  </body>
</html>`;
          }

          return `<!DOCTYPE html>
<html lang="${locale}">
  <head>
${headTags}
    <noscript><meta http-equiv="refresh" content="0;url=/?p=${pp}"></noscript>
  </head>
  <body>
    <div id="root"><article><h1>${esc(localizedTitle)}</h1><p>${esc(localizedDesc)}</p><nav><a href="/">Simulatore Fiscale</a> | <a href="/compara-servizi">Confronta Servizi</a> | <a href="/tasse-e-pensione">Tasse e Pensione</a> | <a href="/guida-frontaliere">Guida Frontaliere</a> | <a href="/domande-frequenti-frontalieri">FAQ</a> | <a href="/glossario-frontaliere">Glossario</a> | <a href="/articoli-frontaliere">Articoli</a></nav></article></div>
    <script>location.replace('/${pp.replace(/~and~/g, '&')}'+location.hash)</script>
  </body>
</html>`;
        };

        // Italian (primary)
        const d0 = np.join(distDir, en.path);
        fs.mkdirSync(d0, { recursive: true });
        const itHtml = html('it', en.path);
        fs.writeFileSync(np.join(d0, 'index.html'), itHtml);
        // Also write flat .html so /slug serves 200 (avoids GitHub Pages 301 redirect)
        // Include OG tags so social crawlers (Facebook, etc.) get the correct preview
        const flatIt = np.join(distDir, en.path + '.html');
        const canonItUrl = `${BASE_URL}/${en.path.replace(/^\/+/, '')}/`.replace(/\/+$/, '/');
        fs.mkdirSync(np.dirname(flatIt), { recursive: true });
        const itOg: FlatRedirectOgMeta = { title: en.ogT, description: en.ogD, image: `${BASE_URL}${en.img}`, lang: 'it' };
        fs.writeFileSync(flatIt, buildFlatRedirect(canonItUrl, `/${en.path.replace(/^\/+/, '')}/`, itOg));
        count++;

        // EN / DE / FR
        for (const [loc, lPath] of Object.entries(lp)) {
          if (loc === 'it' || !lPath) continue;
          const ld = np.join(distDir, lPath);
          fs.mkdirSync(ld, { recursive: true });
          const locHtml = html(loc, lPath);
          fs.writeFileSync(np.join(ld, 'index.html'), locHtml);
          // Also write flat .html for clean URL — include OG tags for social crawlers
          const flatLoc = np.join(distDir, lPath + '.html');
          const canonLocUrl = `${BASE_URL}/${lPath.replace(/^\/+/, '')}/`.replace(/\/+$/, '/');
          fs.mkdirSync(np.dirname(flatLoc), { recursive: true });
          const locMeta = (loc === 'en' || loc === 'de' || loc === 'fr')
            ? blogMetaByLocale[loc][en.articleId]
            : null;
          const locOg: FlatRedirectOgMeta = {
            title: locMeta?.title || en.ogT,
            description: locMeta?.excerpt || en.ogD,
            image: `${BASE_URL}${en.img}`,
            lang: loc,
          };
          fs.writeFileSync(flatLoc, buildFlatRedirect(canonLocUrl, `/${lPath.replace(/^\/+/, '')}/`, locOg));
          count++;
        }
      }

      console.log(`\x1b[36m[og-pages]\x1b[0m Generated ${count} OG landing pages for ${entries.length} articles`);
    },
  };
}
