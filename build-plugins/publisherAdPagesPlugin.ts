/**
 * publisherAdPagesPlugin — static SSG detail page per PUBLISHER ad at
 * `/lavoro/<slug>/` (+ /en, /de, /fr locale variants).
 *
 * WHY a dedicated page (unlike crawled jobs): a crawled job lives on the
 * employer's own career site, so we list it and link OUT. A publisher ad is
 * ORIGINAL content the publisher PAID to host on our site — it deserves its own
 * indexable page with full JobPosting structured data, exactly like the
 * `/cerca-lavoro-…/` SEO pages. The publisher projection already mints the
 * canonical `/lavoro/<slug>` URL (services/lib/publisherJobProjection.mjs); this
 * plugin emits the real static HTML behind it (previously a soft-404 SPA route).
 *
 * Source of truth: the assembled publisher slice
 * `data/jobs/by-crawler/publisher-submitted.json` (one record per ad × location,
 * each with its own slug/url). Every record gets a page in all 4 locales.
 *
 * Contract: apply:'build', emit in closeBundle(), pass distDir. JSON-LD via the
 * shared buildJobPostingSchema (guarantees AGENTS #3 fields: baseSalary,
 * postalCode, streetAddress, title, description, datePosted,
 * hiringOrganization.name, jobLocation, employmentType). Sitemap is written as
 * `dist/sitemap-publisher-ads.xml`; sitemapAliasPlugin auto-discovers it.
 *
 * Gate: SKIP_PUBLISHER_AD_PAGES=1 fast-exits for local builds.
 */
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { buildJobPostingSchema } from './shared/jobPostingSchema';
import { truncateCodeUnits } from './shared/safeTruncate';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { WriteCollector } from './batchWrite';
import { renderPublisherMarkdown } from '../services/publisherMarkdown';
import { generateInitialsLogo } from '../services/logoService';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type AdLocale = (typeof LOCALES)[number];

const OG_LOCALE: Record<AdLocale, string> = { it: 'it_IT', en: 'en_US', de: 'de_DE', fr: 'fr_FR' };

// Locale URL prefix (IT is unprefixed — site convention).
const localePrefix = (locale: AdLocale): string => (locale === 'it' ? '' : `/${locale}`);
// Canonical detail path for a slug in a given locale (trailing slash — site rule).
const detailPath = (locale: AdLocale, slug: string): string => `${localePrefix(locale)}/lavoro/${slug}/`;

// Per-locale job-listing root for the breadcrumb parent.
const JOBS_ROOT: Record<AdLocale, { path: string; label: string }> = {
  it: { path: '/cerca-lavoro-ticino/', label: 'Offerte di lavoro' },
  en: { path: '/en/find-jobs-ticino/', label: 'Job offers' },
  de: { path: '/de/jobs-im-ticino/', label: 'Stellenangebote' },
  fr: { path: '/fr/trouver-emploi-ticino/', label: 'Offres d’emploi' },
};

const HOME_LABEL: Record<AdLocale, string> = { it: 'Home', en: 'Home', de: 'Startseite', fr: 'Accueil' };
const APPLY_LABEL: Record<AdLocale, string> = {
  it: 'Candidati ora', en: 'Apply now', de: 'Jetzt bewerben', fr: 'Postuler',
};
const POSTED_LABEL: Record<AdLocale, string> = {
  it: 'Pubblicato il', en: 'Posted on', de: 'Veröffentlicht am', fr: 'Publié le',
};
const SALARY_LABEL: Record<AdLocale, string> = {
  it: 'Retribuzione', en: 'Salary', de: 'Gehalt', fr: 'Salaire',
};
const SPONSORED_LABEL: Record<AdLocale, string> = {
  it: 'Sponsorizzato', en: 'Sponsored', de: 'Gesponsert', fr: 'Sponsorisé',
};
const CONTRACT_LABEL: Record<AdLocale, string> = {
  it: 'Contratto', en: 'Contract', de: 'Vertrag', fr: 'Contrat',
};
const APPLY_FORM_HINT: Record<AdLocale, string> = {
  it: 'Candidatura diretta — risposta dal datore di lavoro',
  en: 'Direct application — reply from the employer',
  de: 'Direktbewerbung — Antwort vom Arbeitgeber',
  fr: 'Candidature directe — réponse de l’employeur',
};
const APPLY_LOADING: Record<AdLocale, string> = {
  it: 'Caricamento del modulo di candidatura…',
  en: 'Loading the application form…',
  de: 'Bewerbungsformular wird geladen…',
  fr: 'Chargement du formulaire de candidature…',
};
const EMPLOYMENT_LABEL: Record<string, Record<AdLocale, string>> = {
  FULL_TIME: { it: 'Tempo pieno', en: 'Full time', de: 'Vollzeit', fr: 'Temps plein' },
  PART_TIME: { it: 'Part-time', en: 'Part time', de: 'Teilzeit', fr: 'Temps partiel' },
  TEMPORARY: { it: 'Temporaneo', en: 'Temporary', de: 'Befristet', fr: 'Temporaire' },
  CONTRACTOR: { it: 'A progetto', en: 'Contractor', de: 'Freiberuflich', fr: 'Indépendant' },
  INTERN: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' },
};
const CONTRACT_TYPE_LABEL: Record<string, Record<AdLocale, string>> = {
  permanent: { it: 'Indeterminato', en: 'Permanent', de: 'Unbefristet', fr: 'CDI' },
  temporary: { it: 'Determinato', en: 'Fixed-term', de: 'Befristet', fr: 'CDD' },
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

interface AdRecord {
  title?: string;
  slug?: string;
  url?: string;
  company?: string;
  companyLogo?: string | null;
  location?: string;
  addressLocality?: string;
  canton?: string;
  postedDate?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  description?: string;
  descriptionMd?: string | null;
  descriptionByLocale?: Partial<Record<string, string>>;
  titleByLocale?: Partial<Record<string, string>>;
  applyMode?: string;
  applyUrl?: string;
  employmentType?: string;
  contractType?: string;
  tier?: string;
  featured?: boolean;
  [k: string]: unknown;
}

function localizedTitle(rec: AdRecord, locale: AdLocale): string {
  return String(rec.titleByLocale?.[locale] || rec.title || '').trim();
}
// Use the translated description when available, else the (≥50-word, validated)
// source text. Never thinner than the source — translate-pending fills the rest.
function localizedDescription(rec: AdRecord, locale: AdLocale): string {
  return String(rec.descriptionByLocale?.[locale] || rec.description || '').trim();
}

/**
 * Where the "Candidati ora" CTA must point:
 *   - external_url with a real (non-self) URL → the employer's page, new tab.
 *   - in_house / forward_email → the /candidatura/ sub-page, where the SPA
 *     mounts PublisherApplyForm (the static page itself cannot host the form —
 *     this route is staticOverlay, the SPA never hydrates a form into it).
 *     The old fallback pointed the button at the page ITSELF (self-link, dead).
 */
export function applyTarget(rec: AdRecord, locale: AdLocale): { href: string; external: boolean } {
  const slug = String(rec.slug || '');
  const applyUrl = String(rec.applyUrl || '').trim();
  const selfUrl = `${BASE_URL}/lavoro/${slug}`;
  const isSelf = applyUrl === selfUrl || applyUrl === `${selfUrl}/`;
  if (rec.applyMode === 'external_url' && applyUrl && !isSelf) {
    return { href: applyUrl, external: true };
  }
  return { href: `${detailPath(locale, slug)}candidatura/`, external: false };
}

/** Company logo <img> (publisher-provided, https-only) or the deterministic
 * coloured-initials badge — same fallback the SPA renders, never a grey globe. */
function logoHtml(rec: AdRecord, sizeCls: string): string {
  const company = String(rec.company || '').trim();
  const ownLogo = String(rec.companyLogo || '').trim();
  const src = /^https:\/\/\S+$/i.test(ownLogo) ? ownLogo : (company ? generateInitialsLogo(company) : '');
  if (!src) return '';
  return `<img src="${esc(src)}" alt="Logo ${esc(company)}" width="56" height="56" loading="eager" class="${sizeCls} rounded-xl border border-edge bg-surface object-contain flex-shrink-0"${ownLogo ? ` onerror="this.src='${generateInitialsLogo(company)}';this.onerror=null"` : ''}>`;
}

function ctaHtml(rec: AdRecord, locale: AdLocale, extraCls = ''): string {
  const target = applyTarget(rec, locale);
  return `<a href="${esc(target.href)}" rel="nofollow"${target.external ? ' target="_blank"' : ''} class="inline-flex items-center justify-center gap-2 min-h-[44px] px-6 py-3 rounded-xl bg-accent hover:bg-accent-hover text-on-accent font-semibold no-underline transition-colors ${extraCls}">${esc(APPLY_LABEL[locale])}</a>`;
}

export function renderBody(rec: AdRecord, locale: AdLocale): string {
  const title = localizedTitle(rec, locale);
  const company = String(rec.company || '').trim();
  const place = String(rec.location || rec.addressLocality || '').trim();
  const desc = localizedDescription(rec, locale);
  const jobs = JOBS_ROOT[locale];
  // Piano Azienda ads are paid premium too → same rich-markdown + badge as sponsored.
  const sponsored = rec.tier === 'sponsored' || rec.tier === 'azienda';
  const salary = Number.isFinite(rec.salaryMin) && Number(rec.salaryMin) > 0
    ? `${esc(rec.currency || 'CHF')} ${Number(rec.salaryMin).toLocaleString('de-CH')}${Number.isFinite(rec.salaryMax) && Number(rec.salaryMax) ? `–${Number(rec.salaryMax).toLocaleString('de-CH')}` : ''}`
    : null;
  const postedHuman = rec.postedDate ? String(rec.postedDate).slice(0, 10) : null;
  const employment = EMPLOYMENT_LABEL[String(rec.employmentType || '')]?.[locale] || null;
  const contract = CONTRACT_TYPE_LABEL[String(rec.contractType || '')]?.[locale] || null;

  // Sponsored ads with markdown get the rich section renderer (headings,
  // bullet lists, bold) — shared with the editor preview so what the publisher
  // sees while writing is exactly what ships. Everything else: plain paragraphs.
  // The markdown source is written in the ad's source language only — locale
  // variants with a real translation keep their translated plain text.
  const md = sponsored && locale === String(rec.sourceLang || 'it')
    ? String(rec.descriptionMd || '').trim()
    : '';
  const descHtml = md
    ? renderPublisherMarkdown(md, {
      h2: 'text-lg font-bold text-strong mt-7 mb-2 pb-1.5 border-b border-edge',
      h3: 'text-base font-semibold text-strong mt-5 mb-1.5',
      p: 'my-2.5 leading-relaxed text-body',
      ul: 'my-2.5 ml-5 list-disc space-y-1.5 text-body',
    })
    : desc
      .split(/\n{2,}|\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p class="my-2.5 leading-relaxed text-body">${esc(p)}</p>`)
      .join('');

  const tile = (label: string, value: string): string =>
    `<div class="rounded-xl border border-edge bg-surface-alt px-3.5 py-2.5"><div class="text-xs text-muted">${label}</div><div class="text-sm font-semibold text-strong">${value}</div></div>`;
  const tiles = [
    salary ? tile(esc(SALARY_LABEL[locale]), salary) : '',
    contract ? tile(esc(CONTRACT_LABEL[locale]), esc(contract)) : '',
    employment && employment !== contract ? tile('Pensum', esc(employment)) : '',
    postedHuman ? tile(esc(POSTED_LABEL[locale]), `<time datetime="${esc(postedHuman)}">${esc(postedHuman)}</time>`) : '',
  ].filter(Boolean).join('');

  const sponsoredBadge = sponsored && rec.featured
    ? `<span class="inline-flex items-center px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide rounded-full bg-accent-subtle text-link align-middle">${esc(SPONSORED_LABEL[locale])}</span>`
    : '';

  return `<main class="seo-static-content max-w-[760px] mx-auto px-5 pt-6 pb-14 leading-relaxed text-body">
<nav aria-label="breadcrumb" class="text-[13px] text-muted mb-4">
<a href="${esc(localePrefix(locale) || '/')}" class="text-inherit">${esc(HOME_LABEL[locale])}</a> ·
<a href="${esc(jobs.path)}" class="text-inherit">${esc(jobs.label)}</a> ·
<span>${esc(title)}</span>
</nav>
<header class="rounded-2xl border border-edge bg-surface-alt p-5 mb-5">
<div class="flex items-start gap-4">
${logoHtml(rec, 'w-14 h-14')}
<div class="min-w-0">
<h1 class="text-[26px] font-bold text-strong leading-tight m-0 mb-1.5">${esc(title)} ${sponsoredBadge}</h1>
<p class="text-[15px] text-muted m-0">${esc(company)}${company && place ? ' · ' : ''}${esc(place)}</p>
</div>
</div>
${tiles ? `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">${tiles}</div>` : ''}
<div class="mt-4 flex flex-wrap items-center gap-3">
${ctaHtml(rec, locale)}
${rec.applyMode !== 'external_url' ? `<span class="text-xs text-muted">${esc(APPLY_FORM_HINT[locale])}</span>` : ''}
</div>
</header>
<section class="mb-7">${descHtml}</section>
<div class="flex flex-wrap items-center gap-4">
${ctaHtml(rec, locale)}
<a href="${esc(jobs.path)}" class="text-sm font-semibold text-link">${esc(jobs.label)} →</a>
</div>
</main>`;
}

/**
 * Distinct-ad baseSlug collision guard (monetization-critical).
 *
 * Two DISTINCT paid ads whose `title-location-company` slugify to the same
 * baseSlug both resolve to `/lavoro/<slug>/`. WriteCollector dedups by path
 * (Map, last-add-wins — see batchWrite.ts), so the LATER record would SILENTLY
 * overwrite the earlier ad's page. Because the sponsor-blast email re-derives
 * the SAME slug independently (scripts/blast-publisher-ads.mjs, identical
 * slugifyPublisher inputs), the losing ad's CTA recipients would land on the
 * WRONG ad's page — a paying advertiser's traffic sent to a competitor.
 *
 * The slug cannot be disambiguated here: the blast script derives the URL from
 * the same inputs with no shared state, so a plugin-only suffix would make the
 * email 404 instead of mislink. So we resolve DETERMINISTICALLY (first record in
 * slice order wins — stable across builds regardless of slice ordering churn)
 * and surface every collision LOUDLY so the owner renames the colliding source
 * ad. Returns the records to emit plus the collisions that were skipped.
 *
 * Note: sibling SSG plugins (jobsSeoPagesPlugin, careerLandingsPlugin) consume
 * the ALREADY slug-deduped assembled dataset (assemble-jobs-dataset.mjs slug
 * dedup + per-locale collision guard); this plugin is the only one reading the
 * RAW by-crawler slice, so the exposure is specific to it.
 */
export function resolveSlugCollisions(records: AdRecord[]): {
  toEmit: AdRecord[];
  collisions: Array<{ slug: string; winner: string; loser: string }>;
} {
  const identityOf = (r: AdRecord): string =>
    String(r.publisherJobId || r.id || `${r.title ?? ''}|${r.company ?? ''}`);
  const owner = new Map<string, string>(); // slug → identity of the first claimant
  const toEmit: AdRecord[] = [];
  const collisions: Array<{ slug: string; winner: string; loser: string }> = [];
  for (const rec of records) {
    const slug = String(rec.slug || '').trim();
    if (!slug) {
      toEmit.push(rec); // slugless: the emit loop skips it anyway, keep behaviour identical
      continue;
    }
    const identity = identityOf(rec);
    const prev = owner.get(slug);
    if (prev === undefined) {
      owner.set(slug, identity);
      toEmit.push(rec);
    } else if (prev === identity) {
      // Same ad re-listed at the same slug (one ad × location = one record, so
      // this shouldn't happen) — idempotent, keep it, not a collision.
      toEmit.push(rec);
    } else {
      collisions.push({ slug, winner: prev, loser: identity });
    }
  }
  return { toEmit, collisions };
}

/**
 * Minimal 200-status shell behind the in-house apply CTA. The route is mapped
 * by services/router.ts WITHOUT staticOverlay, so the SPA replaces this body
 * with the job detail view + PublisherApplyForm on hydrate. Always noindex —
 * it exists purely so the CTA lands on a real page instead of a 404.
 */
function renderApplyStub(rec: AdRecord, locale: AdLocale): string {
  const title = localizedTitle(rec, locale);
  const back = detailPath(locale, String(rec.slug || ''));
  return `<main class="seo-static-content max-w-[760px] mx-auto px-5 pt-10 pb-14 text-body">
<h1 class="text-xl font-bold text-strong mb-3">${esc(APPLY_LABEL[locale])} — ${esc(title)}</h1>
<p class="text-muted">${esc(APPLY_LOADING[locale])}</p>
<p class="mt-6"><a href="${esc(back)}" class="text-sm font-semibold text-link">← ${esc(title)}</a></p>
</main>`;
}

export function publisherAdPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'publisher-ad-pages',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_PUBLISHER_AD_PAGES === '1') {
        console.log('\x1b[33m[publisher-ad-pages]\x1b[0m Skipped (SKIP_PUBLISHER_AD_PAGES=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const slicePath = np.resolve(rootDir, 'data/jobs/by-crawler/publisher-submitted.json');
      if (!fs.existsSync(slicePath)) {
        console.log('\x1b[33m[publisher-ad-pages]\x1b[0m no publisher-submitted.json — nothing to emit.');
        return;
      }
      let records: AdRecord[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
        records = Array.isArray(parsed) ? parsed : (parsed.jobs || parsed.records || []);
      } catch (err) {
        console.warn('\x1b[33m[publisher-ad-pages]\x1b[0m slice parse failed:', err);
        return;
      }
      if (!records.length) {
        console.log('\x1b[33m[publisher-ad-pages]\x1b[0m 0 publisher ads — nothing to emit.');
        return;
      }

      // Resolve distinct-ad baseSlug collisions BEFORE emitting: keep the first
      // claimant per slug and loudly skip the losers so a later paid ad never
      // silently overwrites an earlier ad's page (see resolveSlugCollisions).
      const { toEmit, collisions } = resolveSlugCollisions(records);
      for (const c of collisions) {
        console.warn(
          `\x1b[31m[publisher-ad-pages]\x1b[0m ⚠️ baseSlug collision on /lavoro/${c.slug}/ — ` +
          `paid ad ${c.loser} collides with already-emitted ${c.winner}; skipping the loser so ` +
          `it cannot overwrite the first ad's page. Its sponsor-blast CTA currently links to the ` +
          `other ad — disambiguate the source ad title/location/company.`,
        );
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const collector = new WriteCollector({ distDir, pluginName: 'publisherAdPagesPlugin' });
      const sitemapEntries: Array<{ canonical: string; alternates: string[] }> = [];
      let pagesWritten = 0;
      let thinSkipped = 0;

      for (const rec of toEmit) {
        const slug = String(rec.slug || '').trim();
        if (!slug) continue;

        const alternates = LOCALES.map((alt) => `${alt}|${BASE_URL}${detailPath(alt, slug)}`);
        alternates.push(`x-default|${BASE_URL}${detailPath('it', slug)}`);
        const hreflangHtml = [
          ...LOCALES.map((alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${detailPath(alt, slug)}">`),
          `    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${detailPath('it', slug)}">`,
        ].join('\n');

        for (const locale of LOCALES) {
          const urlPath = detailPath(locale, slug);
          const canonicalUrl = `${BASE_URL}${urlPath}`;
          const title = localizedTitle(rec, locale);
          if (!title) continue;

          const bodyHtml = renderBody(rec, locale);
          const wordCount = countHtmlBodyWords(bodyHtml);

          const jobPostingLd = inlineScriptJson(buildJobPostingSchema(rec, { locale, url: canonicalUrl }));
          const breadcrumbLd = inlineScriptJson({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: HOME_LABEL[locale], item: `${BASE_URL}${localePrefix(locale)}/` },
              { '@type': 'ListItem', position: 2, name: JOBS_ROOT[locale].label, item: `${BASE_URL}${JOBS_ROOT[locale].path}` },
              { '@type': 'ListItem', position: 3, name: title, item: canonicalUrl },
            ],
          });

          const company = String(rec.company || '').trim();
          const place = String(rec.location || rec.addressLocality || '').trim();
          const metaTitle = `${title}${company ? ` — ${company}` : ''}${place ? `, ${place}` : ''} | Frontaliere Ticino`;
          // Surrogate-safe: ad bodies are user-submitted and contain emoji; a raw
          // slice can split a pair and leave a lone surrogate (� in the SERP snippet).
          const metaDesc = truncateCodeUnits(localizedDescription(rec, locale).replace(/\s+/g, ' '), 160);

          const html = buildSeoPageHtml({
            locale,
            title: metaTitle,
            description: metaDesc,
            canonicalUrl,
            robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
            ogType: 'article',
            ogLocale: OG_LOCALE[locale],
            hreflangHtml,
            jsonLdScripts: [jobPostingLd, breadcrumbLd],
            bodyHtml,
            distDir,
            skipMainWrap: true,
          });

          if (wordCount < MIN_INDEXABLE_WORDS) thinSkipped++;
          collector.add(np.join(distDir, urlPath, 'index.html'), html);
          collector.add(np.join(distDir, urlPath.replace(/\/+$/, '') + '.html'), html);
          pagesWritten++;

          // Whenever the CTA resolves to the /candidatura/ sub-page (in-house /
          // forward-email ads, plus the defensive self-link fallback), emit that
          // page too (200-status stub; the SPA mounts the apply form — see
          // renderApplyStub). Always noindex, never in the sitemap.
          if (!applyTarget(rec, locale).external) {
            const stubPath = `${urlPath}candidatura/`;
            const stubHtml = buildSeoPageHtml({
              locale,
              title: `${APPLY_LABEL[locale]} — ${title}`,
              description: metaDesc,
              canonicalUrl: `${BASE_URL}${stubPath}`,
              robots: 'noindex,follow',
              ogType: 'article',
              ogLocale: OG_LOCALE[locale],
              hreflangHtml: '',
              jsonLdScripts: [],
              bodyHtml: renderApplyStub(rec, locale),
              distDir,
              skipMainWrap: true,
            });
            collector.add(np.join(distDir, stubPath, 'index.html'), stubHtml);
            pagesWritten++;
          }

          // Sitemap: only the IT canonical, and only when that page was actually
          // emitted (title present → not `continue`d above) AND is indexable
          // (wordCount ≥ MIN → index,follow, not noindex/thin). Pushing in the
          // outer loop would submit noindex or skipped-IT (404) URLs to Search
          // Console. Mirrors careerLandingsPlugin's gated push.
          if (locale === 'it' && wordCount >= MIN_INDEXABLE_WORDS) {
            sitemapEntries.push({ canonical: urlPath, alternates });
          }
        }
      }

      if (sitemapEntries.length > 0) {
        try {
          const urls = sitemapEntries
            .map(({ canonical, alternates }) => {
              const alts = alternates
                .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.split('|')[0]}" href="${a.split('|').slice(1).join('|')}" />`)
                .join('\n');
              return `  <url>\n    <loc>${BASE_URL}${canonical}</loc>\n${alts}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`;
            })
            .join('\n');
          const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
          fs.writeFileSync(np.join(distDir, 'sitemap-publisher-ads.xml'), xml, 'utf-8');
        } catch (err) {
          console.warn('\x1b[33m[publisher-ad-pages]\x1b[0m sitemap write failed:', err);
        }
      }

      const written = await collector.flush();
      console.log(
        `\x1b[36m[publisher-ad-pages]\x1b[0m ${records.length} ad record(s) → ${pagesWritten} pages (${thinSkipped} noindex-thin${collisions.length ? `, ${collisions.length} slug-collision skipped` : ''}) — flushed ${written} files.`,
      );
    },
  };
}
