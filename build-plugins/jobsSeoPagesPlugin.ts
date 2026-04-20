/**
 * Generate localized static landing pages for every job in data/jobs.json.
 *
 * For each job × 4 locales, writes a standalone HTML page with structured
 * data (JobPosting, BreadcrumbList), OG/Twitter meta, related jobs,
 * and an "Apply now" CTA linking to the original listing.
 * Also writes sitemap-jobs.xml and patches it into the main sitemap index.
 */

import path from 'path';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage, SPA_ACTION_REDIRECT_SCRIPT, robotsMetaForContent, countHtmlBodyWords, MIN_INDEXABLE_WORDS, GTAG_SNIPPET, FAVICON_LINKS } from './constants';
import { buildSimplePage } from './htmlTemplate';
import { WriteCollector } from './batchWrite';
import { CRAWLED_COMPANY_LOGOS } from '../services/jobDataNormalization';
import { deriveJobPostalCode } from '../services/jobLocationSnapshot';
import { EMPLOYER_BRANDS, type EmployerBrand } from '../services/employerBrands';
import {
 buildJobCareVariantLandingModel,
 buildJobLocationLandingModel,
 buildJobLocationSectorLandingModel,
 buildJobLocationTypeLandingModel,
 buildJobNursesHubLandingModel,
 buildJobOfficialGazetteLandingModel,
 buildJobPartTimeLandingModel,
 buildJobTodayLandingModel,
 EDITORIAL_CANTONS,
} from './jobEditorialLanding';
import {
 CITY_HUB_KEYS,
 CITY_HUB_SLUG,
 buildCityHubPath,
 buildCityHubSeo,
 countCityJobsByLocale,
 type CityHubKey,
} from './cityJobsHub';
// F3a — Job Page CTR Optimization: shared 50-60 char title templates and
// 140-160 char meta-description templates that drive SERP CTR on the
// top-20 job listing pages. See services/seo/job-board-titles.ts and
// services/seo/meta-descriptions.ts for details.
import {
 buildEmployerHubTitle,
 buildRoleHubTitle,
} from '../services/seo/job-board-titles';
import {
 buildCityHubMeta as buildCtrCityHubMeta,
 buildEmployerHubMeta,
 buildRoleHubMeta,
} from '../services/seo/meta-descriptions';

export const JOB_SEO_LOCALES = ['it', 'en', 'de', 'fr'] as const;

export function pickSearchLandingFallbackJobs<T>(
 matchingJobsByLocale: Record<(typeof JOB_SEO_LOCALES)[number], T[]>,
): T[] {
 for (const locale of JOB_SEO_LOCALES) {
 const localeJobs = matchingJobsByLocale[locale];
 if (Array.isArray(localeJobs) && localeJobs.length > 0) {
 return localeJobs;
 }
 }
 return [];
}

export function jobsSeoPagesPlugin(rootDir: string): Plugin {
 return {
 name: 'jobs-seo-pages',
 apply: 'build',
 async closeBundle() {
 const fs = await import('node:fs');
 const np = await import('node:path');
 const distDir = np.resolve(rootDir, 'dist');
 const jobsPath = np.resolve(rootDir, 'data/jobs.json');

 // ─── Parameterized defaults ──────────────────────────────────────────
 // Change DEFAULT_CANTON to expand the primary target region.
 // See scripts/lib/crawler-location-config.mjs for the central switch.
 const DEFAULT_CANTON = 'TI';
 const DEFAULT_POSTAL_CODE = '6900';
 const DEFAULT_CANTON_DISPLAY = 'Ticino';
 const CANTON_DISPLAY: Record<string, string> = {
 'TI': 'Ticino', 'GR': 'Graubünden', 'ZH': 'Zürich', 'BE': 'Bern',
 'LU': 'Luzern', 'BS': 'Basel', 'GE': 'Genève', 'VD': 'Vaud',
 'AG': 'Aargau', 'SG': 'St. Gallen', 'VS': 'Valais', 'FR': 'Fribourg',
 'NE': 'Neuchâtel', 'ZG': 'Zug', 'SH': 'Schaffhausen', 'SO': 'Solothurn',
 'BL': 'Basel-Landschaft', 'TG': 'Thurgau', 'SZ': 'Schwyz', 'GL': 'Glarus',
 'JU': 'Jura', 'NW': 'Nidwalden', 'OW': 'Obwalden', 'AR': 'Appenzell AR',
 'AI': 'Appenzell AI', 'UR': 'Uri',
 };
 const CANTON_FALLBACK_POSTAL: Record<string, string> = {
 'TI': '6900', 'GR': '7000', 'ZH': '8001', 'BE': '3001',
 'LU': '6003', 'BS': '4001', 'GE': '1201', 'VD': '1003',
 'AG': '5001', 'SG': '9001', 'VS': '1950', 'FR': '1700',
 'NE': '2000', 'ZG': '6300', 'SH': '8200', 'SO': '4500',
 'BL': '4410', 'TG': '8500', 'SZ': '6430', 'GL': '8750',
 'JU': '2800', 'NW': '6370', 'OW': '6060', 'AR': '9100',
 'AI': '9050', 'UR': '6460',
 };

 /* ── Buffered write system via shared WriteCollector ── */
 const collector = new WriteCollector({ distDir });
 const _ensuredDirs = new Set<string>();
 function _md(dir: string) {
 if (_ensuredDirs.has(dir)) return;
 fs.mkdirSync(dir, { recursive: true });
 _ensuredDirs.add(dir);
 }
 const _writtenPaths = new Set<string>();
 function _qw(filePath: string, content: string) {
 _writtenPaths.add(filePath);
 collector.add(filePath, content);
 }

 /* ── Find SPA entry bundle so job pages hydrate into the full app ── */
 let entryJs = '', entryCss = '';
 try {
 const builtHtml = fs.readFileSync(np.join(distDir, 'index.html'), 'utf-8');
 entryJs = builtHtml.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)?.[1] ?? '';
 entryCss = builtHtml.match(/href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/)?.[1] ?? '';
 } catch { /* index.html missing */ }
 const hasSpaBundle = !!(entryJs && entryCss);
 if (!hasSpaBundle) console.warn('[jobs-seo-pages] Could not find SPA entry bundles — pages will be static-only');

 // ── Load blog article data for cross-linking (SEO: internal links from job → article pages) ──
 interface RecentArticle { id: string; category: string; date: string; image: string }
 let recentArticles: RecentArticle[] = [];
 const articleSlugByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
 const articleTitleByLocale: Record<'it' | 'en' | 'de' | 'fr', Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
 const blogSectionByLocale: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'articoli-frontaliere', en: 'cross-border-articles', de: 'grenzgaenger-artikel', fr: 'articles-frontalier',
 };
 const recentArticlesLabel: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'Articoli per frontalieri', en: 'Articles for cross-border workers',
 de: 'Artikel für Grenzgänger', fr: 'Articles pour frontaliers',
 };
 try {
 const blogDataSrc = fs.readFileSync(np.resolve(rootDir, 'data', 'blog-articles-data.ts'), 'utf-8');
 const articleBlocks = [...blogDataSrc.matchAll(/\{\s*id:\s*'([^']+)',\s*category:\s*'([^']+)',\s*date:\s*'([^']+)',\s*image:\s*'([^']+)'/gs)];
 recentArticles = articleBlocks
 .map(m => ({ id: m[1], category: m[2], date: m[3], image: m[4] }))
 .sort((a, b) => b.date.localeCompare(a.date))
 .slice(0, 5);
 } catch { /* non-fatal */ }
 try {
 const routerBlogSrc = fs.readFileSync(np.resolve(rootDir, 'services/routerBlogData.ts'), 'utf-8');
 const rx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
 let m: RegExpExecArray | null;
 while ((m = rx.exec(routerBlogSrc)) !== null) {
 articleSlugByLocale.it[m[1]] = m[2];
 articleSlugByLocale.en[m[1]] = m[3];
 articleSlugByLocale.de[m[1]] = m[4];
 articleSlugByLocale.fr[m[1]] = m[5];
 }
 } catch { /* non-fatal */ }
 // Parse article titles from seo-blog*.ts for readable link text
 try {
 let seoSrc = fs.readFileSync(np.resolve(rootDir, 'services/seo/seo-blog.ts'), 'utf-8');
 for (let n = 2; n <= 10; n++) {
 try { seoSrc += '\n' + fs.readFileSync(np.resolve(rootDir, `services/seo/seo-blog-${n}.ts`), 'utf-8'); } catch { break; }
 }
 // Extract ogTitle for Italian articles (path → title)
 const titleRx = /path:\s*'\/articoli-frontaliere\/([^']+?)\/?'[\s\S]*?ogTitle:\s*'((?:[^'\\]|\\.)*)'/g;
 let tm: RegExpExecArray | null;
 while ((tm = titleRx.exec(seoSrc)) !== null) {
 const articleId = Object.entries(articleSlugByLocale.it).find(([, slug]) => slug === tm![1])?.[0] || tm[1];
 articleTitleByLocale.it[articleId] = tm[2].replace(/\\'/g, "'");
 }
 } catch { /* non-fatal */ }

 const buildRecentArticlesHtml = (locale: 'it' | 'en' | 'de' | 'fr'): string => {
 if (recentArticles.length === 0) return '';
 const items = recentArticles.map(art => {
 const slug = articleSlugByLocale[locale]?.[art.id] ?? art.id;
 const prefix = locale === 'it' ? '' : `/${locale}`;
 const href = `${BASE_URL}${prefix}/${blogSectionByLocale[locale]}/${slug}/`;
 const title = articleTitleByLocale.it[art.id] || art.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
 return `<li style="margin:0 0 8px 0"><a href="${href}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(title)}</a></li>`;
 }).join('');
 return `<section class="related" style="margin-top:12px"><h2 style="margin:0 0 10px 0;font-size:16px">${esc(recentArticlesLabel[locale])}</h2><ul style="list-style:none;padding:0;margin:0">${items}</ul></section>`;
 };

 // Default search-section route slugs — these are actual URL paths that must exist in the router.
 // They use "Ticino/Tessin" because that is the primary/branded section; other cantons share it.
 const sectionByLocale: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'cerca-lavoro-ticino',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
 };
 const localePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: '',
 en: '/en',
 de: '/de',
 fr: '/fr',
 };
 const localeOg: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'it_IT',
 en: 'en_US',
 de: 'de_DE',
 fr: 'fr_FR',
 };
 const localeCopy: Record<'it' | 'en' | 'de' | 'fr', {
 suffix: string;
 sectionName: string;
 descriptionLabel: string;
 applyNow: string;
 quickDetails: string;
 location: string;
 canton: string;
 contract: string;
 relatedJobs: string;
 allJobsLink: string;
 practicalNotes: string[];
 requirementsLabel: string;
 summaryLabel: string;
 highlightsLabel: string;
 responsibilitiesLabel: string;
 benefitsLabel: string;
 processLabel: string;
 keywordsLabel: string;
 readingLabel: string;
 }> = {
 it: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Cerca lavoro in Ticino',
 descriptionLabel: 'Descrizione',
 applyNow: 'Vai alla candidatura',
 quickDetails: 'Dettagli rapidi',
 location: 'Località',
 canton: 'Cantone',
 contract: 'Contratto',
 relatedJobs: 'Annunci correlati',
 allJobsLink: 'Tutte le offerte di lavoro in Ticino',
 practicalNotes: [
 'Questa scheda aggrega i dettagli principali dell\'annuncio e li struttura in modo leggibile per frontalieri che cercano lavoro in Ticino.',
 'Verifica sempre lingua richiesta, sede effettiva e modalità di candidatura prima di inviare il CV: alcuni ruoli prevedono step internazionali e assessment tecnici.',
 'Prima di candidarti, confronta il ruolo con costo della vita locale e simulazione del netto, così valuti subito la sostenibilità economica reale.',
 ],
 requirementsLabel: 'Requisiti principali',
 summaryLabel: 'Panoramica',
 highlightsLabel: 'Punti chiave',
 responsibilitiesLabel: 'Responsabilità principali',
 benefitsLabel: 'Cosa offre l’azienda',
 processLabel: 'Processo di candidatura',
 keywordsLabel: 'Keyword utili',
 readingLabel: 'Tempo di lettura',
 },
 en: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Find jobs in Ticino',
 descriptionLabel: 'Description',
 applyNow: 'Apply now',
 quickDetails: 'Quick details',
 location: 'Location',
 canton: 'Canton',
 contract: 'Contract',
 relatedJobs: 'Related jobs',
 allJobsLink: 'All job offers in Ticino',
 practicalNotes: [
 'This page consolidates the key details of the listing and presents them in a structured format for cross-border candidates targeting Ticino.',
 'Always verify required language, actual office location and application flow before submitting: some positions include international interview steps.',
 'Before applying, compare this role with local cost of living and net salary simulation to assess real take-home sustainability.',
 ],
 requirementsLabel: 'Key requirements',
 summaryLabel: 'Role overview',
 highlightsLabel: 'Key points',
 responsibilitiesLabel: 'Main responsibilities',
 benefitsLabel: 'What the company offers',
 processLabel: 'Application process',
 keywordsLabel: 'Useful keywords',
 readingLabel: 'Reading time',
 },
 de: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Jobs im Tessin',
 descriptionLabel: 'Beschreibung',
 applyNow: 'Jetzt bewerben',
 quickDetails: 'Kurzdaten',
 location: 'Ort',
 canton: 'Kanton',
 contract: 'Vertrag',
 relatedJobs: 'Ähnliche Stellen',
 allJobsLink: 'Alle Stellenangebote im Tessin',
 practicalNotes: [
 'Diese Seite bündelt die wichtigsten Informationen der Stelle in einer klaren Struktur für Grenzgängerinnen und Grenzgänger im Tessin.',
 'Prüfen Sie vor der Bewerbung Sprache, effektiven Arbeitsort und Bewerbungsablauf genau, da manche Rollen internationale Prozessschritte enthalten.',
 'Vergleichen Sie das Stellenprofil mit Lebenshaltungskosten und Nettolohn-Simulation, um die finanzielle Tragfähigkeit realistisch einzuschätzen.',
 ],
 requirementsLabel: 'Wichtige Anforderungen',
 summaryLabel: 'Rollenüberblick',
 highlightsLabel: 'Kernpunkte',
 responsibilitiesLabel: 'Hauptaufgaben',
 benefitsLabel: 'Was das Unternehmen bietet',
 processLabel: 'Bewerbungsprozess',
 keywordsLabel: 'Nützliche Keywords',
 readingLabel: 'Lesezeit',
 },
 fr: {
 suffix: 'Frontaliere Ticino',
 sectionName: 'Trouver un emploi au Tessin',
 descriptionLabel: 'Description',
 applyNow: 'Postuler',
 quickDetails: 'Détails rapides',
 location: 'Lieu',
 canton: 'Canton',
 contract: 'Contrat',
 relatedJobs: 'Offres liées',
 allJobsLink: 'Toutes les offres d\'emploi au Tessin',
 practicalNotes: [
 'Cette fiche regroupe les informations essentielles de l\'offre et les présente de manière structurée pour les frontaliers visant le Tessin.',
 'Avant de postuler, vérifiez la langue requise, le lieu réel du poste et le processus de sélection: certaines offres incluent des étapes internationales.',
 'Comparez ce poste avec le coût de la vie local et la simulation du salaire net pour évaluer la viabilité économique réelle.',
 ],
 requirementsLabel: 'Exigences principales',
 summaryLabel: 'Vue d’ensemble du poste',
 highlightsLabel: 'Points clés',
 responsibilitiesLabel: 'Responsabilités principales',
 benefitsLabel: 'Ce que l’entreprise offre',
 processLabel: 'Processus de candidature',
 keywordsLabel: 'Mots-clés utiles',
 readingLabel: 'Temps de lecture',
 },
 };

 // ── Canton-aware text helpers ────────────────────────────────
 // These produce locale-correct text for any Swiss canton,
 // used wherever SEO copy references the job's region.
 const frenchCantonPrep = (dc: string): string => {
 if (['Tessin', 'Jura'].includes(dc)) return `au ${dc}`;
 if (dc === 'Grisons') return `aux ${dc}`;
 if (dc === 'Valais') return `en ${dc}`;
 return `dans le canton de ${dc}`;
 };
 const germanCantonPrep = (dc: string): string => {
 if (['Tessin', 'Wallis', 'Jura'].includes(dc)) return `im ${dc}`;
 return `in ${dc}`;
 };
 const cantonSectionName = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const map: Record<string, string> = {
 it: `Cerca lavoro in ${cantonDisplay}`,
 en: `Find jobs in ${cantonDisplay}`,
 de: `Jobs ${germanCantonPrep(cantonDisplay)}`,
 fr: `Trouver un emploi ${frenchCantonPrep(cantonDisplay)}`,
 };
 return map[locale] || map.it;
 };
 const cantonPracticalNote0 = (locale: 'it' | 'en' | 'de' | 'fr', cantonDisplay: string): string => {
 const dePrep = germanCantonPrep(cantonDisplay);
 const frPrep = frenchCantonPrep(cantonDisplay);
 const map: Record<string, string> = {
 it: `Questa scheda aggrega i dettagli principali dell'annuncio e li struttura in modo leggibile per frontalieri che cercano lavoro in ${cantonDisplay}.`,
 en: `This page consolidates the key details of the listing and presents them in a structured format for cross-border candidates targeting ${cantonDisplay}.`,
 de: `Diese Seite bündelt die wichtigsten Informationen der Stelle in einer klaren Struktur für Grenzgängerinnen und Grenzgänger ${dePrep}.`,
 fr: `Cette fiche regroupe les informations essentielles de l'offre et les présente de manière structurée pour les frontaliers visant ${frPrep === frenchCantonPrep(cantonDisplay) ? frPrep : `le ${cantonDisplay}`}.`,
 };
 return map[locale] || map.it;
 };

 // Multi-canton display string for search pages (not per-job)
 const TARGET_CANTONS_CODES = ['TI', 'GR', 'VS'];
 const targetCantonsDisplay: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: TARGET_CANTONS_CODES.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' e $1'),
 en: TARGET_CANTONS_CODES.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' and $1'),
 de: TARGET_CANTONS_CODES.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' und $1'),
 fr: TARGET_CANTONS_CODES.map(c => CANTON_DISPLAY[c] || c).join(', ').replace(/, ([^,]+)$/, ' et $1'),
 };

 if (!fs.existsSync(jobsPath)) {
 console.warn('[jobs-seo-pages] data/jobs.json not found');
 return;
 }
 const jobsRaw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
 const jobs = Array.isArray(jobsRaw) ? jobsRaw : [];
 const slugify = (input: string) => String(input || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '')
 .slice(0, 90);
 const localeList = JOB_SEO_LOCALES;
 const localizedSlug = (job: any, locale: 'it' | 'en' | 'de' | 'fr') => {
 // 1. Explicit per-locale slug (from AI-translated crawlers)
 const explicit = String(job?.slugByLocale?.[locale] || '').trim();
 if (explicit) return explicit;
 // 2. Canonical slug from data (set by all crawlers, including custom ones)
 const canonical = String(job?.slug || '').trim();
 if (canonical) return canonical;
 // 3. Compute from localized title + company + location (last-resort fallback)
 const localizedTitle = String(job?.titleByLocale?.[locale] || job?.title || '');
 return slugify(`${localizedTitle}-${job?.company || ''}-${job?.location || ''}`) || slugify(localizedTitle);
 };

 const validJobs = jobs
 .filter((j: any) => j?.title && j?.company && j?.location && (j?.description || j?.descriptionByLocale))
 .map((j: any) => ({
 ...j,
 slug: j.slug || slugify(`${j.title}-${j.company}-${j.location}`) || j.id || '',
 }))
 .filter((j: any) => !!j.slug);

 const esc = (s: string) => String(s || '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
 /** Decode common HTML entities so source text doesn't get double-escaped by esc(). */
 const decodeHtmlEntities = (s: string) => String(s || '')
 .replace(/&amp;/g, '&')
 .replace(/&lt;/g, '<')
 .replace(/&gt;/g, '>')
 .replace(/&quot;/g, '"')
 .replace(/&#39;/g, "'")
 .replace(/&#x27;/g, "'")
 .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
 .replace(/&[A-Za-z]+;/g, ' ');
 /** Convert a plain-text description to basic HTML.
 * Wraps paragraphs in <p>, converts bullet/numbered lines to <ul>/<ol><li>,
 * recognizes section headings (lines ending with ':' followed by list items),
 * and single newlines to <br>. */
 const plainTextToHtml = (text: string): string => {
 if (!text || /<(p|ul|li|h[1-6]|br|strong|em)\b/i.test(text)) return text;
 const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
 const blocks = normalized.split(/\n{2,}/);
 const htmlParts: string[] = [];
 for (const block of blocks) {
 const trimmed = block.trim();
 if (!trimmed) continue;
 const lines = trimmed.split('\n');
 // Check if this block is a bullet list (all lines start with - or • or *)
 const isBulletList = lines.length > 1 && lines.every((l) => /^\s*[-•*]\s/.test(l));
 // Check if this block is a numbered list (all lines start with digit.)
 const isNumberedList = lines.length > 1 && lines.every((l) => /^\s*\d+[.)]\s/.test(l));
 // Check if this block has a heading line followed by list items
 const hasHeadingWithList = lines.length > 2
 && /[:\u2013\u2014]$/.test(lines[0].trim())
 && lines.slice(1).every((l) => /^\s*[-•*\d]/.test(l));

 if (hasHeadingWithList) {
 const heading = lines[0].trim().replace(/[:\u2013\u2014]$/, '').trim();
 htmlParts.push(`<p><strong>${esc(heading)}</strong></p>`);
 const listLines = lines.slice(1);
 const isOl = listLines.every((l) => /^\s*\d+[.)]\s/.test(l));
 const tag = isOl ? 'ol' : 'ul';
 const items = listLines.map((l) => `<li>${esc(l.replace(/^\s*[-•*]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('');
 htmlParts.push(`<${tag}>${items}</${tag}>`);
 } else if (isBulletList) {
 const items = lines.map((l) => `<li>${esc(l.replace(/^\s*[-•*]\s+/, ''))}</li>`).join('');
 htmlParts.push(`<ul>${items}</ul>`);
 } else if (isNumberedList) {
 const items = lines.map((l) => `<li>${esc(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('');
 htmlParts.push(`<ol>${items}</ol>`);
 } else if (lines.length === 1 && /[:\u2013\u2014]$/.test(trimmed)) {
 // Standalone heading-like line ending with colon
 const heading = trimmed.replace(/[:\u2013\u2014]$/, '').trim();
 htmlParts.push(`<p><strong>${esc(heading)}</strong></p>`);
 } else {
 // Single block — join internal newlines with <br>
 const inner = lines.map((l) => esc(l.trim())).filter(Boolean).join('<br>');
 if (inner) htmlParts.push(`<p>${inner}</p>`);
 }
 }
 return htmlParts.join('');
 };
 const normalizeText = (s: string) => String(s || '')
 .replace(/\r/g, '\n')
 .replace(/\t/g, ' ')
 .replace(/&[A-Za-z]+;/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 /** Strip markdown syntax, emojis & structured noise for clean meta descriptions. */
 const cleanMetaDescription = (raw: string): string => {
 let s = String(raw || '');
 // Strip markdown headings (at line start or inline after content)
 s = s.replace(/#{1,6}\s+/g, '');
 s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
 s = s.replace(/^[-*_]{3,}$/gm, '');
 // Strip markdown links/images but keep text
 s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
 // Strip inline code
 s = s.replace(/`([^`]+)`/g, '$1');
 // Strip emojis (common Unicode ranges)
 s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
 // Strip bullet/list markers at line starts
 s = s.replace(/^\s*[-*•]\s+/gm, '');
 // Strip HTML entities like &NewLine; &colo;
 s = s.replace(/&[A-Za-z]+;/g, ' ');
 // Collapse whitespace
 s = s.replace(/\s+/g, ' ').trim();
 return s;
 };
 const splitIntoParagraphs = (s: string): string[] => {
 const viaBreaks = String(s || '')
 .replace(/\r/g, '\n')
 .split(/\n{2,}/)
 .map((p) => p.trim())
 .filter((p) => p.length > 40);
 if (viaBreaks.length >= 2) return viaBreaks;
 return normalizeText(s)
 .split(/(?<=[.!?])\s+/)
 .map((p) => p.trim())
 .filter((p) => p.length > 40);
 };
 const firstItems = (value: unknown, max = 8): string[] => {
 if (!Array.isArray(value)) return [];
 return value
 .map((x) => normalizeText(String(x || '')))
 .filter((x) => x.length > 2)
 .slice(0, max);
 };
 const cleanItems = (value: unknown, max = 10): string[] => {
 if (!Array.isArray(value)) return [];
 const expanded: string[] = [];
 for (const entry of value) {
 const clean = normalizeText(String(entry || ''));
 if (!clean || clean.length < 3) continue;
 // Skip truncated artifacts (e.g. "Requisiti di ordine ge ...")
 if (/\.{2,}\s*$/.test(clean)) continue;
 // Split joined list items separated by "; - " or "; •"
 const parts = clean.split(/;\s*[-•]\s+/).map((p) => p.replace(/^[-•]\s*/, '').trim()).filter((p) => p.length >= 3);
 expanded.push(...(parts.length > 1 ? parts : [clean]));
 }
 const out: string[] = [];
 const seen = new Set<string>();
 for (const item of expanded) {
 const key = item.toLowerCase();
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(item);
 if (out.length >= max) break;
 }
 return out;
 };
 const parseCanonicalSections = (value: unknown, max = 8): Array<{ id: string; heading: string; paragraphs: string[]; bullets: string[] }> => {
 if (!Array.isArray(value)) return [];
 const out: Array<{ id: string; heading: string; paragraphs: string[]; bullets: string[] }> = [];
 for (const item of value) {
 const raw = item as {
 id?: unknown;
 heading?: unknown;
 paragraphs?: unknown;
 bullets?: unknown;
 };
 const heading = normalizeText(String(raw?.heading || ''));
 const paragraphs = cleanItems(raw?.paragraphs, 8);
 const bullets = cleanItems(raw?.bullets, 10);
 if (!heading && paragraphs.length === 0 && bullets.length === 0) continue;
 out.push({
 id: normalizeText(String(raw?.id || 'details')).toLowerCase() || 'details',
 heading: heading || 'Details',
 paragraphs,
 bullets,
 });
 if (out.length >= max) break;
 }
 return out;
 };
 const readCanonicalByLocale = (job: any, locale: 'it' | 'en' | 'de' | 'fr') => {
 const byLocale = job?.canonicalContent?.byLocale || {};
 return byLocale?.[locale] || null;
 };
 const toIsoDateTime = (raw: string) => {
 if (!raw) return new Date().toISOString();
 const parsed = new Date(raw);
 if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
 const safe = new Date(`${raw}T00:00:00.000Z`);
 return Number.isNaN(safe.getTime()) ? new Date().toISOString() : safe.toISOString();
 };
 const toValidThrough = (postedRaw: string, crawledAt?: string) => {
 // If crawledAt is available (= job was verified active at crawl time),
 // use it as base + 60 days — tolerates up to ~1 month of rebuild interruption.
 // Fallback: postedDate + 90 days (more lenient than the old 60d window).
 const base = crawledAt ? new Date(crawledAt) : new Date(toIsoDateTime(postedRaw));
 if (Number.isNaN(base.getTime())) {
 const fallback = new Date();
 fallback.setUTCDate(fallback.getUTCDate() + 60);
 return fallback.toISOString();
 }
 const result = new Date(base);
 result.setUTCDate(result.getUTCDate() + (crawledAt ? 60 : 90));
 return result.toISOString();
 };
 const contractMap: Record<string, string> = {
 'full-time': 'FULL_TIME',
 'part-time': 'PART_TIME',
 temporary: 'TEMPORARY',
 internship: 'INTERN',
 contract: 'CONTRACTOR',
 };
 const hostFromUrl = (raw?: string): string => {
 if (!raw) return '';
 try {
 return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
 } catch {
 return '';
 }
 };
 const companyWebsite = (job: any): string => {
 const domain = job?.companyDomain || hostFromUrl(job?.url);
 return domain ? `https://www.${domain}` : BASE_URL;
 };
 /** Sanitize address fields — reject crawler artifacts */
 const isValidAddress = (s: string): boolean => {
 if (!s || s.length > 100) return false;
 // Reject strings with too many spaces (likely scraped garbage)
 if ((s.match(/\s/g) || []).length > 8) return false;
 // Reject strings with navigation/UI artifacts
 if (/stampa|segnalazione|descrizione|annuncio|verifica|attività|dillo/i.test(s)) return false;
 return true;
 };
 const isValidPostalCode = (s: string): boolean => {
 if (!s) return false;
 // Swiss postal codes: 4 digits starting with 1-9
 if (!/^[1-9]\d{3}$/.test(s)) return false;
 // Reject years (2020-2039) that accidentally match the 4-digit pattern
 const n = Number(s);
 if (n >= 2020 && n <= 2039) return false;
 return true;
 };

 /** Company HQ addresses — used as fallback when job data has no valid streetAddress */
 const COMPANY_HQ_ADDRESSES: Record<string, { streetAddress: string; postalCode: string; addressLocality: string }> = {
 'eoc-ente-ospedaliero-cantonale': { streetAddress: 'Viale Officina 3', postalCode: '6500', addressLocality: 'Bellinzona' },
 'ente-ospedaliero-cantonale-eoc': { streetAddress: 'Viale Officina 3', postalCode: '6500', addressLocality: 'Bellinzona' },
 'lis-lugano-istituti-sociali': { streetAddress: 'Via alla Bozzoreda 15', postalCode: '6963', addressLocality: 'Pregassona' },
 'amministrazione-cantonale-ti': { streetAddress: 'Piazza Governo', postalCode: '6501', addressLocality: 'Bellinzona' },
 'migros-ticino': { streetAddress: 'Via Serrai 1', postalCode: '6592', addressLocality: 'S. Antonino' },
 'coop-ticino': { streetAddress: 'Via Vedeggio 4', postalCode: '6805', addressLocality: 'Mezzovico' },
 'vf-international-the-north-face-timberland':{ streetAddress: 'Via Laveggio 5', postalCode: '6855', addressLocality: 'Stabio' },
 'zurich-insurance-sede-ticino': { streetAddress: 'Via Pretorio 22', postalCode: '6900', addressLocality: 'Lugano' },
 'banca-cler': { streetAddress: 'Piazza Grande 5', postalCode: '6600', addressLocality: 'Locarno' },
 'ffs-officine-ferrovie-federali': { streetAddress: 'Via Ludovico Benteler 12', postalCode: '6500', addressLocality: 'Bellinzona' },
 'ubs': { streetAddress: 'Via G. Calgari 2', postalCode: '6900', addressLocality: 'Lugano' },
 'corner-banca': { streetAddress: 'Via Canova 16', postalCode: '6901', addressLocality: 'Lugano' },
 'helsinn': { streetAddress: 'Via Pian Scairolo 9', postalCode: '6912', addressLocality: 'Lugano' },
 'ibsa-institut-biochimique': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
 'medacta-international': { streetAddress: 'Strada Regina', postalCode: '6874', addressLocality: 'Castel San Pietro' },
 'rsi-radiotelevisione-svizzera': { streetAddress: 'Via Canevascini 7', postalCode: '6903', addressLocality: 'Lugano' },
 'usi-universita-della-svizzera-italiana': { streetAddress: 'Via G. Buffi 13', postalCode: '6904', addressLocality: 'Lugano' },
 'supsi-dti': { streetAddress: 'Via Cantonale 2c', postalCode: '6928', addressLocality: 'Manno' },
 // Graubünden companies
 'kantonsspital-graubunden-ksgr': { streetAddress: 'Loëstrasse 170', postalCode: '7000', addressLocality: 'Chur' },
 'kantonsspital-graubunden': { streetAddress: 'Loëstrasse 170', postalCode: '7000', addressLocality: 'Chur' },
 'tsmg': { streetAddress: 'Masanserstrasse 2', postalCode: '7000', addressLocality: 'Chur' },
 // Ticino companies missing from original list
 'board-international': { streetAddress: 'Corso San Gottardo 46', postalCode: '6830', addressLocality: 'Chiasso' },
 'alten-switzerland': { streetAddress: 'Via Industria 1', postalCode: '6855', addressLocality: 'Stabio' },
 'fincons-group': { streetAddress: 'Via Cantonale 2a', postalCode: '6928', addressLocality: 'Manno' },
 'fondazione-la-fonte': { streetAddress: 'Via Trevano 55', postalCode: '6900', addressLocality: 'Lugano' },
 'bracco-suisse-s-a': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
 'bracco-suisse': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
 'bracco': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
 'schindler': { streetAddress: 'Via Cantonale 1', postalCode: '6532', addressLocality: 'Castione' },
 'abb-svizzera-sede-ticino': { streetAddress: 'Via Cantonale 32', postalCode: '6572', addressLocality: 'Quartino' },
 'abb': { streetAddress: 'Via Cantonale 32', postalCode: '6572', addressLocality: 'Quartino' },
 'ruag-ag': { streetAddress: 'Via Campagna 1', postalCode: '6517', addressLocality: 'Arbedo' },
 'post-ch-ag': { streetAddress: 'Piazza Stazione 1', postalCode: '6500', addressLocality: 'Bellinzona' },
 'postfinance-ag': { streetAddress: 'Piazza Stazione 1', postalCode: '6500', addressLocality: 'Bellinzona' },
 'ariston-group': { streetAddress: 'Via Cantonale 31', postalCode: '6930', addressLocality: 'Bedano' },
 'skyguide': { streetAddress: 'Via Aeroporto', postalCode: '6982', addressLocality: 'Agno' },
 'skyguide-sa': { streetAddress: 'Via Aeroporto', postalCode: '6982', addressLocality: 'Agno' },
 'sunrise-communications-ag': { streetAddress: 'Via Cantonale 2c', postalCode: '6928', addressLocality: 'Manno' },
 'zucchetti-switzerland-sa': { streetAddress: 'Via Dunant 7', postalCode: '6828', addressLocality: 'Balerna' },
 'goline-sa': { streetAddress: 'Via Industria 5', postalCode: '6855', addressLocality: 'Stabio' },
 'avaloq': { streetAddress: 'Via Cantonale 10', postalCode: '6900', addressLocality: 'Lugano' },
 'lidl-svizzera': { streetAddress: 'Via Industria 6', postalCode: '6593', addressLocality: 'Cadenazzo' },
 // Generic company keys used in expired job data (no region suffix)
 'coop': { streetAddress: 'Via Vedeggio 4', postalCode: '6805', addressLocality: 'Mezzovico' },
 'galenica': { streetAddress: 'Untermattweg 8', postalCode: '3027', addressLocality: 'Bern' },
 'fnz': { streetAddress: 'Via Cantonale 19', postalCode: '6900', addressLocality: 'Lugano' },
 'fust': { streetAddress: 'Zürcherstrasse 22', postalCode: '9246', addressLocality: 'Niederbüren' },
 };

 /** Does the value look like an actual street address (not just a city/region name)? */
 const isStreetLikeAddress = (s: string): boolean => {
 if (!s || s.length < 3) return false;
 // Must contain a known street keyword
 if (/\b(via|piazza|piazzale|piazzetta|viale|strada|corso|vicolo|salita|sentiero|contrada|largo|riva|lungolago|rampa|passaggio)\b/i.test(s)) return true;
 // Accept strings with both letters AND digits (e.g. "Rue de Lausanne 42") —
 // but reject pure-digit strings like "2026" that are years, not addresses
 if (/[a-zA-Z]/.test(s) && /\d/.test(s)) return true;
 return false;
 };

 /** City → generic central street address for last-resort fallback */
 const CITY_GENERIC_ADDRESS: Record<string, string> = {
 // Luganese
 'lugano': 'Piazza Riforma 1', 'paradiso': 'Riva Albertolli 1', 'massagno': 'Via S. Gottardo 52',
 'viganello': 'Via San Gottardo 87', 'pregassona': 'Via Pregassona 29', 'breganzona': 'Via Breganzona 16',
 'montagnola': 'Via Cantonale 24', 'grancia': 'Via Cantonale 18', 'muzzano': 'Via Municipio 8',
 'cadempino': 'Via Cantonale 31', 'lamone': 'Via Cantonale 31', 'comano': 'Via Cantonale 4',
 'canobbio': 'Via Cantone 1', 'tesserete': 'Via Stazione 2', 'capriasca': 'Via Stazione 2',
 'agno': 'Piazza Luini 2', 'bioggio': 'Via Cantonale 19', 'manno': 'Via Cantonale 2c', 'caslano': 'Piazza Lago 2',
 'novaggio': 'Via Cantonale 5', 'noranco': 'Via Noranco 10', 'neggio': 'Via Cantonale 12',
 'luganese': 'Piazza Riforma 1', 'malcantone': 'Piazza Lago 2',
 // Bellinzonese
 'bellinzona': 'Piazza Governo', 'giubiasco': 'Piazza Grande 1', 'sementina': 'Via Cantonale 35',
 'camorino': 'Via Cantonale 20', 'arbedo': 'Via Cantonale 1', 'castione': 'Via Cantonale 8',
 'cadenazzo': 'Via Stazione 10', 's. antonino': 'Via Serrai 1', 's.antonino': 'Via Serrai 1',
 'castione-arbedo': 'Via Cantonale 1', 'belinzona': 'Piazza Governo',
 // Sopraceneri
 'lodrino': 'Via Cantonale 1', 'sopraceneri': 'Piazza Governo',
 // Locarnese
 'locarno': 'Piazza Grande 18', 'muralto': 'Via Stazione 1', 'minusio': 'Via San Gottardo 73',
 'gordola': 'Via Cantonale 40', 'tenero': 'Via Brere 7', 'ascona': 'Via Borgo 34',
 'losone': 'Via Municipio 9', 'magadino': 'Via Cantonale 32', 'quartino': 'Via Cantonale 32',
 // Mendrisiotto
 'mendrisio': 'Via Luigi Benteler 1', 'chiasso': 'Corso San Gottardo 84', 'stabio': 'Via Industria 1',
 'balerna': 'Via Municipio 13', 'coldrerio': 'Via Municipio 12', 'novazzano': 'Via Cantonale 5',
 'castel san pietro': 'Via Municipio 1', 'morbio inferiore': 'Via Cantonale 46', 'vacallo': 'Via Municipio 8',
 // Leventina / Blenio
 'airolo': 'Piazza Stazione 1', 'faido': 'Piazza Municipio 1', 'bodio': 'Via Cantonale 3',
 'biasca': 'Via Giuseppe Lepori 1', 'mezzovico': 'Via Vedeggio 4', 'rivera': 'Via Cantonale 1',
 'taverne': 'Via Cantonale 20', 'pazzallo': 'Via Pazzallo 10', 'cadro': 'Via Cadro 5',
 'riazzino': 'Via Cantonale 12', 'castelrotto': 'Via Pratocarasso 1',
 'bedano': 'Via Cantonale 31', 'pollegio': 'Via Cantonale 1',
 // Graubünden / Grigioni
 'chur': 'Bahnhofstrasse 1', 'coira': 'Bahnhofstrasse 1',
 'landquart': 'Bahnhofstrasse 1', 'davos': 'Promenade 68',
 'st. moritz': 'Via Maistra 12', 'samedan': 'Plazzet 4', 'pontresina': 'Via Maistra 133',
 'walenstadt': 'Bahnhofstrasse 19', 'obervaz': 'Voa Principala 22',
 'ilanz': 'Via Centrala 2', 'thusis': 'Neudorfstrasse 60', 'poschiavo': 'Via da la Stazione 1',
 // Ginevra
 'plan-les-ouates': 'Route de Saint-Julien 7',
 'genève': 'Rue du Rhône 1', 'ginevra': 'Rue du Rhône 1', 'genf': 'Rue du Rhône 1', 'geneva': 'Rue du Rhône 1',
 // Major Swiss cities outside Ticino/GR
 'zürich': 'Bahnhofstrasse 1', 'zurich': 'Bahnhofstrasse 1', 'zurigo': 'Bahnhofstrasse 1',
 'bern': 'Bundesplatz 1', 'berna': 'Bundesplatz 1',
 'basel': 'Marktplatz 1', 'basilea': 'Marktplatz 1',
 'lausanne': 'Place de la Palud 2', 'losanna': 'Place de la Palud 2',
 'luzern': 'Bahnhofstrasse 1', 'lucerna': 'Bahnhofstrasse 1', 'lucerne': 'Bahnhofstrasse 1',
 'st. gallen': 'Bahnhofplatz 1', 'san gallo': 'Bahnhofplatz 1',
 'winterthur': 'Bahnhofplatz 1',
 'zug': 'Bahnhofstrasse 1',
 'aarau': 'Bahnhofstrasse 1',
 'fribourg': 'Rue de Romont 1', 'friburgo': 'Rue de Romont 1',
 'neuchâtel': 'Place du Port 1',
 'schaffhausen': 'Bahnhofstrasse 1',
 'solothurn': 'Hauptgasse 1',
 'thun': 'Bahnhofstrasse 1',
 'baden': 'Bahnhofstrasse 1',
 'olten': 'Bahnhofstrasse 1',
 };

 /** Normalise a locality string to extract the core city name for lookup.
 * Strips suffixes like ", Switzerland", ", Ticino", "TI + smart working", postal codes, etc. */
 const normaliseCityName = (raw: string): string[] => {
 const candidates: string[] = [];
 const s = raw.replace(/[_]/g, ' ').trim();
 // Split on comma, dot-separator, or dash-separated compound
 const parts = s.split(/[,·]/).map(p => p.trim()).filter(Boolean);
 for (const part of parts) {
 // Strip known suffixes
 const cleaned = part
 .replace(/\b(switzerland|svizzera|suisse|schweiz|ticino|ti|gr|ge|ch)\b/gi, '')
 .replace(/\+\s*smart\s*working/gi, '')
 .replace(/\b\d{4}\b/g, '') // postal codes
 .replace(/\s+/g, ' ')
 .trim();
 if (cleaned.length >= 2) candidates.push(cleaned.toLowerCase());
 }
 // Also try the raw first part before any comma
 if (parts[0]) candidates.unshift(parts[0].trim().toLowerCase());
 return [...new Set(candidates)];
 };

 /** Canton capital fallback — used as ultimate last resort */
 const CANTON_CAPITAL_ADDRESS: Record<string, string> = {
 'TI': 'Piazza Governo', 'GR': 'Bahnhofstrasse 1', 'GE': 'Rue du Rhône 1',
 'ZH': 'Bahnhofstrasse 1', 'BE': 'Bundesplatz 1', 'LU': 'Bahnhofstrasse 1',
 'VS': 'Place de la Planta 1', 'VD': 'Place de la Palud 2',
 'BS': 'Marktplatz 1', 'SG': 'Bahnhofplatz 1', 'AG': 'Bahnhofstrasse 1',
 'FR': 'Rue de Romont 1', 'NE': 'Place du Port 1', 'ZG': 'Bahnhofstrasse 1',
 'SH': 'Bahnhofstrasse 1', 'SO': 'Hauptgasse 1', 'BL': 'Marktplatz 1',
 };

 /** City name → canton code for deriving addressRegion from location */
 const CITY_TO_CANTON: Record<string, string> = {
 // Ticino
 'lugano': 'TI', 'bellinzona': 'TI', 'locarno': 'TI', 'mendrisio': 'TI', 'chiasso': 'TI',
 'biasca': 'TI', 'agno': 'TI', 'manno': 'TI', 'stabio': 'TI', 'giubiasco': 'TI',
 'ascona': 'TI', 'paradiso': 'TI', 'massagno': 'TI', 'cadenazzo': 'TI', 'mezzovico': 'TI',
 'balerna': 'TI', 'bedano': 'TI', 'airolo': 'TI', 'faido': 'TI', 'rivera': 'TI',
 // Graubünden
 'chur': 'GR', 'coira': 'GR', 'davos': 'GR', 'st. moritz': 'GR', 'landquart': 'GR',
 'ilanz': 'GR', 'thusis': 'GR', 'poschiavo': 'GR', 'samedan': 'GR',
 // Major Swiss cities
 'zürich': 'ZH', 'zurich': 'ZH', 'zurigo': 'ZH', 'winterthur': 'ZH', 'kloten': 'ZH',
 'dübendorf': 'ZH', 'dietlikon': 'ZH',
 'bern': 'BE', 'berna': 'BE', 'thun': 'BE', 'interlaken': 'BE',
 'basel': 'BS', 'basilea': 'BS',
 'genève': 'GE', 'ginevra': 'GE', 'genf': 'GE', 'geneva': 'GE', 'plan-les-ouates': 'GE',
 'lausanne': 'VD', 'losanna': 'VD',
 'luzern': 'LU', 'lucerna': 'LU', 'lucerne': 'LU',
 'st. gallen': 'SG', 'san gallo': 'SG', 'gossau': 'SG',
 'aarau': 'AG', 'baden': 'AG', 'lenzburg': 'AG',
 'fribourg': 'FR', 'friburgo': 'FR',
 'neuchâtel': 'NE',
 'zug': 'ZG',
 'schaffhausen': 'SH',
 'solothurn': 'SO', 'olten': 'SO',
 'frauenfeld': 'TG',
 'sion': 'VS', 'brig': 'VS', 'visp': 'VS', 'sierre': 'VS', 'martigny': 'VS',
 };

 /** Derive canton code from job location/addressLocality, falling back to job.canton or DEFAULT_CANTON */
 const deriveCanton = (job: any): string => {
 const explicitCanton = String(job.canton || job.addressRegion || '').toUpperCase().trim();
 if (explicitCanton && explicitCanton.length === 2 && /^[A-Z]{2}$/.test(explicitCanton)) return explicitCanton;
 // Try to infer from city names
 const candidates = [
 ...normaliseCityName(String(job.addressLocality || '')),
 ...normaliseCityName(String(job.location || '')),
 ];
 for (const c of candidates) {
 if (CITY_TO_CANTON[c]) return CITY_TO_CANTON[c];
 }
 return DEFAULT_CANTON;
 };

 /** Derive streetAddress from job data, company HQ, or city generic.
 * Always returns a street address (canton capital as last resort). */
 const deriveStreetAddress = (job: any): string => {
 // 1. Try job's own streetAddress — only if it looks like a real street
 const raw = String(job.streetAddress || '').trim();
 if (isValidAddress(raw) && isStreetLikeAddress(raw)) return raw;
 // 2. Try company HQ address
 const companyKey = String(job.companyKey || '').toLowerCase().trim();
 if (companyKey && COMPANY_HQ_ADDRESSES[companyKey]) return COMPANY_HQ_ADDRESSES[companyKey].streetAddress;
 // 3. Try city-based generic address (exact match)
 const locality = String(job.addressLocality || '').toLowerCase().trim();
 if (locality && CITY_GENERIC_ADDRESS[locality]) return CITY_GENERIC_ADDRESS[locality];
 // 4. Try location field parts (split on ·)
 const loc = String(job.location || '');
 const locParts = loc.split('·').map((s: string) => s.trim()).filter(Boolean);
 for (const part of locParts) {
 const key = part.toLowerCase().trim();
 if (key && CITY_GENERIC_ADDRESS[key]) return CITY_GENERIC_ADDRESS[key];
 }
 // 5. If job.streetAddress is non-empty but not street-like, try as city lookup
 const rawLower = raw.toLowerCase();
 if (rawLower && CITY_GENERIC_ADDRESS[rawLower]) return CITY_GENERIC_ADDRESS[rawLower];
 // 6. Fuzzy: normalise locality/location by stripping suffixes and try again
 const candidates = [
 ...normaliseCityName(String(job.addressLocality || '')),
 ...normaliseCityName(loc),
 ...normaliseCityName(raw),
 ];
 for (const c of candidates) {
 if (CITY_GENERIC_ADDRESS[c]) return CITY_GENERIC_ADDRESS[c];
 }
 // 7. Canton capital fallback — always produces a result
 const canton = String(job.canton || job.addressRegion || DEFAULT_CANTON).toUpperCase().trim();
 return CANTON_CAPITAL_ADDRESS[canton] || CANTON_CAPITAL_ADDRESS[DEFAULT_CANTON] || 'Piazza Governo';
 };
 // Map internal category strings to O*NET-SOC major group codes for Google Jobs.
 // https://www.onetcenter.org/taxonomy.html
 const CATEGORY_TO_ONET: Record<string, string> = {
 tech: '15-0000', technology: '15-0000', it: '15-0000', development: '15-0000',
 devops: '15-0000', analysis: '15-2000', 'IT / Software Development': '15-0000',
 'Corporate and Staff Functions/Information Technology': '15-0000',
 engineering: '17-0000', 'Ingegneria & Tecnica': '17-0000', impiantistica: '17-0000',
 meccanica: '17-0000', metallo: '17-0000', drafting: '17-3000', technician: '17-3000',
 architecture: '17-1000', 'Robotica & Automazione': '17-0000',
 health: '29-0000', healthcare: '29-0000', 'Life Science & Tecnologia Medica': '29-0000',
 'Chimica & Analisi': '19-0000', science: '19-0000', researcher: '19-0000',
 phd: '19-0000', sustainability: '19-0000',
 finance: '13-0000', finanza: '13-0000', assicurazioni: '13-0000', insurance: '13-0000',
 'Corporate and Staff Functions/Finance & Control': '13-0000', accounting: '13-2000',
 management: '11-0000', consulting: '11-0000', 'Consulenza gestionale': '11-0000',
 operations: '11-0000',
 admin: '43-0000', Administration: '43-0000', 'Servizi Aziendali': '43-0000',
 staff: '43-0000', general: '43-0000', 'public-administration': '43-0000',
 sales: '41-0000', vendita: '41-0000', 'Vendita & Commercio': '41-0000',
 'Commercio al dettaglio': '41-0000',
 logistics: '53-0000', 'Logistica & Trasporti': '53-0000', 'Logistica & Magazzino': '53-0000',
 Logistik: '53-0000', aviation: '53-0000',
 marketing: '27-3000', design: '27-1000', translation: '27-3000',
 hr: '13-1000', 'risorse-umane': '13-1000',
 legal: '23-0000',
 education: '25-0000', professor: '25-0000',
 'social-services': '21-0000', 'real-estate': '13-0000',
 'Turismo & Ospitalità': '35-0000', hospitality: '35-0000', gastronomy: '35-0000',
 cucina: '35-0000', servizio: '35-0000',
 'Agricoltura & Commercio': '45-0000',
 edilizia: '47-0000', cantiere: '47-0000',
 production: '51-0000', manufacturing: '51-0000',
 security: '33-0000', safety: '33-0000',
 };
 const mapCategoryToONet = (cat: string): string | undefined => CATEGORY_TO_ONET[cat];

 const companyLogo = (job: any): string => {
 const key = job?.companyKey || '';
 if (key && CRAWLED_COMPANY_LOGOS[key]) return CRAWLED_COMPANY_LOGOS[key];
 // Use branded 1200×630 OG image as fallback — Google's favicon service
 // only returns 128px which is too small for social preview requirements
 // (minimum 600×314px recommended by Open Graph spec).
 return `${BASE_URL}/og-image.png`;
 };

 const referralUrl = (raw: string, job: any): string => {
 try {
 const u = new URL(raw);
 u.searchParams.set('utm_source', 'frontaliereticino');
 u.searchParams.set('utm_medium', 'referral');
 u.searchParams.set('utm_campaign', 'job-board');
 u.searchParams.set('utm_content', job.slug || job.id || '');
 return u.toString();
 } catch {
 return raw;
 }
 };

 const withSlash = (s: string) => (s.endsWith('/') ? s : `${s}/`);
 const dateStamp = new Date().toISOString().slice(0, 10);
 const searchRoutePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'ricerca',
 en: 'search',
 de: 'suche',
 fr: 'recherche',
 };
 // Search pages aggregate jobs across all target cantons — use "in Svizzera" for titles
 // (60-char SEO limit) and full canton list in descriptions/editorial.
 const searchPageCopy: Record<'it' | 'en' | 'de' | 'fr', {
 title: (name: string) => string;
 description: (name: string, count: number) => string;
 heading: (name: string) => string;
 openListing: string;
 editorial: string;
 }> = {
 it: {
 title: (name: string) => `Offerte di lavoro ${name} in Svizzera - Posizioni aperte oggi | Frontaliere Ticino`,
 description: (name: string, count: number) => `${count}+ offerte di lavoro ${name} in ${targetCantonsDisplay.it} aggiornate ogni giorno. Annunci raccolti dai siti ufficiali delle aziende svizzere con link diretto alla candidatura.`,
 heading: (name: string) => `Lavoro ${name} in Svizzera`,
 openListing: 'Apri il job board completo',
 editorial: `Gli annunci di lavoro sono raccolti direttamente dai siti ufficiali delle aziende in ${targetCantonsDisplay.it} e aggiornati quotidianamente. Ogni offerta rimanda alla pagina di candidatura originale del datore di lavoro. Il job board copre tutti i settori: sanità, finanza, tecnologia, ingegneria, commercio e amministrazione.`,
 },
 en: {
 title: (name: string) => `${name} jobs in Switzerland - Open positions today | Frontaliere Ticino`,
 description: (name: string, count: number) => `${count}+ ${name} job openings in ${targetCantonsDisplay.en} updated daily. Listings sourced from official Swiss employer career pages with direct application links.`,
 heading: (name: string) => `${name} jobs in Switzerland`,
 openListing: 'Open the full job board',
 editorial: `Job listings are sourced directly from official company career pages in ${targetCantonsDisplay.en} and refreshed daily. Every listing links to the employer's original application page. The job board covers all sectors: healthcare, finance, technology, engineering, retail, and administration.`,
 },
 de: {
 title: (name: string) => `${name} Jobs in der Schweiz - Offene Stellen heute | Frontaliere Ticino`,
 description: (name: string, count: number) => `${count}+ aktuelle ${name} Stellenangebote in ${targetCantonsDisplay.de}, täglich aktualisiert. Direkt von offiziellen Karriereportalen Schweizer Unternehmen mit Bewerbungslink.`,
 heading: (name: string) => `${name} Jobs in der Schweiz`,
 openListing: 'Komplettes Job Board öffnen',
 editorial: `Stellenanzeigen werden direkt von den offiziellen Karriereseiten der Unternehmen in ${targetCantonsDisplay.de} bezogen und täglich aktualisiert. Jedes Inserat verlinkt zur originalen Bewerbungsseite des Arbeitgebers. Das Job Board deckt alle Branchen ab: Gesundheit, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung.`,
 },
 fr: {
 title: (name: string) => `Offres d'emploi ${name} en Suisse - Postes ouverts | Frontaliere Ticino`,
 description: (name: string, count: number) => `${count}+ offres d'emploi ${name} en ${targetCantonsDisplay.fr} mises à jour quotidiennement. Annonces provenant des portails officiels des entreprises suisses avec lien de candidature.`,
 heading: (name: string) => `Emploi ${name} en Suisse`,
 openListing: 'Ouvrir le job board complet',
 editorial: `Les offres d'emploi proviennent directement des portails carrière officiels des entreprises en ${targetCantonsDisplay.fr} et sont actualisées quotidiennement. Chaque annonce renvoie à la page de candidature originale de l'employeur. Le job board couvre tous les secteurs : santé, finance, technologie, ingénierie, commerce et administration.`,
 },
 };
 const normalizeSearchTerm = (value: string): string => String(value || '')
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .trim();
 const matchesSearchLanding = (job: any, query: string, locale: 'it' | 'en' | 'de' | 'fr'): boolean => {
 const haystack = normalizeSearchTerm([
 job?.titleByLocale?.[locale],
 job?.title,
 job?.company,
 job?.location,
 job?.canton,
 job?.descriptionByLocale?.[locale],
 job?.description,
 ].filter(Boolean).join(' '));
 const tokens = normalizeSearchTerm(query).split(/\s+/).filter(Boolean);
 return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
 };

 /** Tracks every dist/ directory written by the active-job page generator
 * so that expired soft-landing pages never overwrite a live job page. */
 const activeJobDirs = new Set<string>();

 /** Caches active job page HTML by `${locale}:${slug}` so bridge pages
 * (previousSlugs) can serve identical full-content pages with only the
 * canonical URL pointing to the current slug. */
 const jobHtmlCache = new Map<string, string>();

 const companyRoutePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
 it: 'azienda',
 en: 'company',
 de: 'unternehmen',
 fr: 'entreprise',
 };
 const slugifyCompanyBuild = (value: string): string =>
 String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
 /** Mirror runtime canonicalCompanyRouteSlug logic */
 const canonicalCompanySlugBuild = (company: string, companyKey?: string): string => {
 const keyNorm = String(companyKey || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
 const nameNorm = String(company || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
 if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
 return slugifyCompanyBuild(company);
 };

 // Truncate string to ≤max chars at the last word boundary
 const truncTitle = (s: string, max = 60): string => {
 if (s.length <= max) return s;
 const cut = s.lastIndexOf(' ', max - 1);
 return (cut > 0 ? s.substring(0, cut) : s.substring(0, max - 1)) + '…';
 };

 for (const job of validJobs) {
 const perLocaleSlug = {
 it: localizedSlug(job, 'it'),
 en: localizedSlug(job, 'en'),
 de: localizedSlug(job, 'de'),
 fr: localizedSlug(job, 'fr'),
 };
 for (const locale of localeList) {
 const relPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${perLocaleSlug[locale]}`.replace(/\/+/g, '/');
 const canonicalPath = withSlash(relPath);
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const localizedTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 const jobLocation = String(job.location || '').trim();
 const dc = CANTON_DISPLAY[String(job.canton || DEFAULT_CANTON)] || String(job.canton || DEFAULT_CANTON);
 const TITLE_MAX = 60;
 const title = (() => {
 const suffix = localeCopy[locale].suffix;
 // 1. Full format: title — company, city | suffix
 if (jobLocation) {
 const full = `${localizedTitle} — ${job.company}, ${jobLocation} | ${suffix}`;
 if (full.length <= TITLE_MAX) return full;
 }
 // 2. Without city: title — company | suffix
 const noCityFull = `${localizedTitle} — ${job.company} | ${suffix}`;
 if (noCityFull.length <= TITLE_MAX) return noCityFull;
 // 3. Without brand: title — company, city
 if (jobLocation) {
 const noBrand = `${localizedTitle} — ${job.company}, ${jobLocation}`;
 if (noBrand.length <= TITLE_MAX) return noBrand;
 }
 // 4. Without brand or city: title — company
 const noBrandNoCity = `${localizedTitle} — ${job.company}`;
 if (noBrandNoCity.length <= TITLE_MAX) return noBrandNoCity;
 // 5. Truncate the job title to fit within "truncTitle — company"
 const companySuffix = ` — ${job.company}`;
 const availableForTitle = TITLE_MAX - companySuffix.length;
 if (availableForTitle >= 15) {
 const truncatedTitle = truncTitle(localizedTitle, availableForTitle);
 return `${truncatedTitle}${companySuffix}`;
 }
 // 6. Last resort: just truncate the whole thing
 return truncTitle(localizedTitle, TITLE_MAX);
 })();
 const localizedDescriptionRaw = String(job?.descriptionByLocale?.[locale] || job.description || '');
 const localizedDescription = normalizeText(localizedDescriptionRaw);
 const cleanDesc = cleanMetaDescription(localizedDescriptionRaw);
 // Build an SEO-friendly meta description with salary and CTA
 const metaIntro = locale === 'de'
 ? `${localizedTitle} bei ${job.company} in ${job.location || DEFAULT_CANTON_DISPLAY}.`
 : locale === 'fr'
 ? `${localizedTitle} chez ${job.company} à ${job.location || DEFAULT_CANTON_DISPLAY}.`
 : locale === 'en'
 ? `${localizedTitle} at ${job.company} in ${job.location || DEFAULT_CANTON_DISPLAY}.`
 : `${localizedTitle} presso ${job.company} a ${job.location || DEFAULT_CANTON_DISPLAY}.`;
 // Inline salary snippet for meta description (before salaryText is computed)
 const metaSalaryMin = Number(job.salaryMin);
 const metaSalaryMax = Number(job.salaryMax);
 const metaCurrency = String(job.currency || 'CHF');
 const metaSalarySnippet = Number.isFinite(metaSalaryMin) && metaSalaryMin > 0
 ? (Number.isFinite(metaSalaryMax) && metaSalaryMax > metaSalaryMin
 ? ` ${locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario'}: ${metaCurrency} ${Math.round(metaSalaryMin).toLocaleString('de-CH')}-${Math.round(metaSalaryMax).toLocaleString('de-CH')}.`
 : ` ${locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario'}: ${metaCurrency} ${Math.round(metaSalaryMin).toLocaleString('de-CH')}.`)
 : '';
 const metaCta = locale === 'de' ? ' Jetzt auf Frontaliere Ticino bewerben.'
 : locale === 'fr' ? ' Postulez sur Frontaliere Ticino.'
 : locale === 'en' ? ' Apply now on Frontaliere Ticino.'
 : ' Candidati ora su Frontaliere Ticino.';
 const metaBody = cleanDesc.length > 40 ? ` ${cleanDesc}` : '';
 // Assemble: intro + salary + body, truncated to 160 chars; fallback to body if over limit
 const descWithSalary = `${metaIntro}${metaSalarySnippet}${metaCta}`;
 // Truncate meta description at word boundary, avoiding trailing hyphens/prepositions
 const truncMetaDesc = (s: string, max = 160): string => {
 if (s.length <= max) return s;
 let cut = s.lastIndexOf(' ', max - 1);
 if (cut <= 0) cut = max - 1;
 let result = s.substring(0, cut).trimEnd();
 // Strip trailing hyphens, dashes, and common prepositions
 result = result.replace(/[\s\-–—]+$/, '').replace(/\s+(di|da|per|a|in|con|su|del|della|dei|delle|at|in|for|of|the|an|bei|für|im|von|chez|pour|au|du|de|des|les)\s*$/i, '');
 return result + '...';
 };
 // Decode HTML entities from source data to prevent double-escaping in esc()
 const description = decodeHtmlEntities(descWithSalary.length <= 160
 ? descWithSalary
 : truncMetaDesc(`${metaIntro}${metaSalarySnippet}${metaBody}`));
 const descriptionParagraphs = splitIntoParagraphs(localizedDescriptionRaw).slice(0, 10);
 const requirements = firstItems(job?.requirementsByLocale?.[locale] || job?.requirements, 8);
 const canonicalLocale = readCanonicalByLocale(job, locale);
 const canonicalSummary = cleanItems(canonicalLocale?.summary, 4);
 const canonicalSections = parseCanonicalSections(canonicalLocale?.sections, 8)
 .filter((section) => !['requirements', 'benefits', 'process'].includes(section.id));
 const canonicalResponsibilities = cleanItems(canonicalLocale?.responsibilities, 10);
 const canonicalRequirements = cleanItems(canonicalLocale?.requirements, 12);
 const canonicalBenefits = cleanItems(canonicalLocale?.benefits, 10);
 const canonicalProcess = cleanItems(canonicalLocale?.process, 8);
 const canonicalKeywords = cleanItems(canonicalLocale?.keywords, 8);
 const fallbackParagraphs = [cantonPracticalNote0(locale, dc), ...localeCopy[locale].practicalNotes.slice(1)];
 const bodyParagraphs = (descriptionParagraphs.length >= 3
 ? descriptionParagraphs.slice(0, 3)
 : [localizedDescription, ...fallbackParagraphs]
 )
 .filter((p) => p && p.length > 25)
 .slice(0, 4);
 const summaryParagraphs = canonicalSummary.length > 0 ? canonicalSummary : bodyParagraphs;
 const mergedRequirements = canonicalRequirements.length > 0 ? canonicalRequirements : requirements;
 const logoUrl = companyLogo(job);
 const related = validJobs
 .filter((r: any) => r.slug !== job.slug && (r.category === job.category || r.location === job.location))
 .slice(0, 4);
 const relatedHtml = related
 .map((r: any) => {
 const rp = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(r, locale)}`.replace(/\/+/g, '/');
 const href = `${BASE_URL}${withSlash(rp)}`;
 const relatedTitle = String(r?.titleByLocale?.[locale] || r.title || '');
 const rLogo = companyLogo(r);
 const rSalary = (() => {
 if (!r.salaryMin) return '';
 const min = (r.salaryMin / 1000).toFixed(0);
 const max = r.salaryMax ? (r.salaryMax / 1000).toFixed(0) : null;
 return max ? `${r.currency || 'CHF'} ${min}k – ${max}k` : `${r.currency || 'CHF'} ${min}k+`;
 })();
 return `<li style="margin:0 0 8px 0"><a href="${href}" style="display:flex;align-items:flex-start;gap:12px;text-decoration:none;padding:12px;border:1px solid #e2e8f0;border-radius:12px"><img src="${esc(rLogo)}" alt="Logo ${esc(r.company)}" width="40" height="40" loading="lazy" style="width:40px;height:40px;object-fit:contain;border-radius:8px;border:1px solid #e2e8f0;flex-shrink:0"><div style="min-width:0;flex:1"><div style="font-size:14px;font-weight:700;color:#0f172a;line-height:1.3">${esc(relatedTitle)}</div><div style="font-size:12px;color:#64748b;margin-top:2px">${esc(r.company)} · ${esc(r.location)}${r.canton ? ` (${esc(r.canton)})` : ''}</div>${rSalary ? `<div style="font-size:12px;font-weight:600;color:#16a34a;margin-top:4px">${esc(rSalary)}</div>` : ''}</div></a></li>`;
 })
 .join('');
 const summaryHtml = summaryParagraphs
 .map((p) => `<p>${esc(p)}</p>`)
 .join('');
 const isSubheadItem = (value: string) => /^(requisiti necessari|requisiti auspicati|required|preferred)$/i.test(normalizeText(value));
 const sectionHtml = (heading: string, paragraphs: string[], bullets: string[]) => {
 const paragraphsHtml = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
 const bulletsHtml = bullets.length > 0
 ? `<ul>${bullets.map((item) => `<li${isSubheadItem(item) ? ' class="subhead"' : ''}>${esc(item)}</li>`).join('')}</ul>`
 : '';
 return `<section class="section"><h4>${esc(heading)}</h4>${paragraphsHtml}${bulletsHtml}</section>`;
 };
 const timelineBlocks: Array<{ heading: string; paragraphs: string[]; bullets: string[] }> = [];
 if (canonicalResponsibilities.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].responsibilitiesLabel, paragraphs: [], bullets: canonicalResponsibilities });
 }
 if (mergedRequirements.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].requirementsLabel, paragraphs: [], bullets: mergedRequirements });
 }
 if (canonicalBenefits.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].benefitsLabel, paragraphs: [], bullets: canonicalBenefits });
 }
 if (canonicalProcess.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].processLabel, paragraphs: [], bullets: canonicalProcess });
 }
 for (const section of canonicalSections) {
 if (section.paragraphs.length === 0 && section.bullets.length === 0) continue;
 timelineBlocks.push({
 heading: section.heading,
 paragraphs: section.paragraphs,
 bullets: section.bullets,
 });
 }
 if (canonicalKeywords.length > 0) {
 timelineBlocks.push({ heading: localeCopy[locale].keywordsLabel, paragraphs: [], bullets: canonicalKeywords });
 }
 const timelineHtml = timelineBlocks
 .map((section) => `<div class="timeline-step">${sectionHtml(section.heading, section.paragraphs, section.bullets)}</div>`)
 .join('');
 const parserAssignedChunks = summaryParagraphs.length
 + timelineBlocks.reduce((sum, section) => sum + section.paragraphs.length + section.bullets.length, 0);
 const parserOriginalChunks = Math.max(1, descriptionParagraphs.length + mergedRequirements.length);
 const parserCoverage = Math.min(100, Math.round((parserAssignedChunks / parserOriginalChunks) * 100));
 const isRemote = /remote|telelavor|smart[-\s]?working|home office|hybrid/i.test(
 `${job.title || ''} ${localizedDescription || ''} ${job.location || ''}`
 );
 // Salary data is pre-populated by re-enrich-jobs.mjs (SECTORS estimation)
 const salaryMin = Number.isFinite(Number(job.salaryMin))
 ? Number(job.salaryMin)
 : Number(job?.baseSalary?.value?.minValue);
 const salaryMax = Number.isFinite(Number(job.salaryMax))
 ? Number(job.salaryMax)
 : Number(job?.baseSalary?.value?.maxValue);
 const salaryCurrency = String(job.currency || job?.baseSalary?.currency || job?.baseSalary?.value?.currency || 'CHF');
 const salaryFormatter = new Intl.NumberFormat(
 locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-CH' : 'it-CH',
 { maximumFractionDigits: 0 }
 );
 const salaryText = Number.isFinite(salaryMin)
 ? (Number.isFinite(salaryMax) && salaryMax > salaryMin
 ? `${salaryCurrency} ${salaryFormatter.format(salaryMin)} - ${salaryFormatter.format(salaryMax)}`
 : `${salaryCurrency} ${salaryFormatter.format(salaryMin)}`)
 : (locale === 'de'
 ? 'nicht angegeben'
 : locale === 'fr'
 ? 'non indiqué'
 : locale === 'en'
 ? 'not specified'
 : 'non indicato');
 const rawLocality = String(job.addressLocality || '').trim();
 const addressLocality = isValidAddress(rawLocality) ? rawLocality : String(job.location || DEFAULT_CANTON_DISPLAY);
 const addressRegion = deriveCanton(job);
 const addressCountry = String(job.addressCountry || 'CH');
 const rawPostal = String(job.postalCode || '').trim();
 const postalCode = deriveJobPostalCode(job);
 const streetAddress = deriveStreetAddress(job);
 const alternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${perLocaleSlug[l]}`.replace(/\/+/g, '/');
 return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
 });
 const xDefaultHref = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || '';
 const hreflangHtml = [
 ...alternates.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ...(xDefaultHref ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`] : []),
 ].join('\n');

 // Build an HTML-formatted description for JobPosting structured data.
 // Google requires a non-empty description and recommends HTML format.
 // Assemble from summary paragraphs + structured sections, with a
 // plain-text fallback for jobs that lack parsed content.
 const descriptionHtmlParts: string[] = [];
 for (const p of summaryParagraphs) {
 if (p && p.length > 10) descriptionHtmlParts.push(`<p>${esc(p)}</p>`);
 }
 for (const block of timelineBlocks) {
 if (block.heading) descriptionHtmlParts.push(`<h3>${esc(block.heading)}</h3>`);
 for (const p of block.paragraphs) {
 if (p) descriptionHtmlParts.push(`<p>${esc(p)}</p>`);
 }
 if (block.bullets.length > 0) {
 descriptionHtmlParts.push(`<ul>${block.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
 }
 }
 const jobPostingDescriptionHtml = descriptionHtmlParts.join('').slice(0, 5000);
 // Fallback: use plain text description or metaIntro if HTML assembly is empty
 const jobPostingDescription = jobPostingDescriptionHtml.length >= 50
 ? jobPostingDescriptionHtml
 : (localizedDescription.length >= 50
 ? plainTextToHtml(localizedDescription).slice(0, 5000) || localizedDescription.slice(0, 5000)
 : plainTextToHtml(`${metaIntro} ${localizedDescription}`.trim()).slice(0, 5000)
 || `${metaIntro} ${localizedDescription}`.trim().slice(0, 5000));
 // Skip JobPosting schema entirely when no meaningful description exists
 const hasValidJobPostingDescription = jobPostingDescription.length >= 30;
 const jobLd = hasValidJobPostingDescription ? JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'JobPosting',
 title: localizedTitle,
 description: jobPostingDescription,
 inLanguage: locale,
 datePosted: toIsoDateTime(job.postedDate),
 validThrough: toValidThrough(job.postedDate, job.crawledAt),
 employmentType: contractMap[String(job.contract || '').toLowerCase()] || 'OTHER',
 identifier: {
 '@type': 'PropertyValue',
 name: job.company,
 value: job.id || job.slug,
 },
 hiringOrganization: {
 '@type': 'Organization',
 name: job.company,
 sameAs: companyWebsite(job),
 logo: logoUrl,
 },
 jobLocationType: isRemote ? 'TELECOMMUTE' : undefined,
 applicantLocationRequirements: {
 '@type': 'Country',
 name: 'CH',
 },
 // Always include jobLocation when address data exists — even for
 // remote/hybrid roles. Google supports both jobLocationType: TELECOMMUTE
 // and jobLocation simultaneously, and postalCode is required for rich results.
 // All JobPosting fields must always be present for maximum rich snippet
 // eligibility. Google considers missing fields as lower quality even when
 // they are technically "recommended" and not "required".
 jobLocation: {
 '@type': 'Place',
 address: {
 '@type': 'PostalAddress',
 streetAddress: streetAddress || addressLocality,
 addressLocality,
 addressRegion,
 addressCountry,
 postalCode: postalCode || CANTON_FALLBACK_POSTAL[addressRegion] || DEFAULT_POSTAL_CODE,
 },
 },
 // FRO-358: baseSalary fallback must use a valid minValue > 0 (validator rejects 0).
 // FRO-maxValue: maxValue MUST always be present — GSC flags missing maxValue as quality issue.
 // Ticino minimum wage ~CHF 19.75/h ≈ CHF 41,080/year as a floor.
 baseSalary: (() => {
 const min = Number.isFinite(salaryMin) && salaryMin > 0 ? salaryMin : 41080;
 const max = Number.isFinite(salaryMax) && salaryMax > min ? salaryMax : Math.round(min * 1.2);
 const cur = Number.isFinite(salaryMin) && salaryMin > 0 ? salaryCurrency : 'CHF';
 return {
 '@type': 'MonetaryAmount',
 currency: cur,
 value: {
 '@type': 'QuantitativeValue',
 minValue: min,
 maxValue: max,
 unitText: 'YEAR',
 },
 };
 })(),
 directApply: Boolean(job.url),
 url: canonicalUrl,
 ...(canonicalResponsibilities.length > 0 ? { responsibilities: canonicalResponsibilities.join('\n') } : {}),
 ...(canonicalKeywords.length > 0 ? { skills: canonicalKeywords.join(', ') } : {}),
 ...(canonicalRequirements.length > 0 ? { qualifications: canonicalRequirements.join('\n') } : {}),
 ...(job.crawledAt ? { dateModified: new Date(job.crawledAt).toISOString() } : job.updatedAt ? { dateModified: new Date(job.updatedAt).toISOString() } : {}),
 ...(job.category && mapCategoryToONet(job.category) ? { occupationalCategory: mapCategoryToONet(job.category) } : {}),
 }) : null;
 const breadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
 { '@type': 'ListItem', position: 2, name: cantonSectionName(locale, dc), item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}` },
 { '@type': 'ListItem', position: 3, name: localizedTitle, item: canonicalUrl },
 ],
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(title)}</title>
 <meta name="description" content="${esc(description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(title)}">
 <meta property="og:description" content="${esc(description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(title)}">
 <meta name="twitter:description" content="${esc(description)}">
 <meta name="twitter:image" content="${BASE_URL}/og-image.png">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
 <link rel="preconnect" href="https://fonts.googleapis.com">
 <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
 <link rel="preload" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" as="style" crossorigin>
 <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" media="print" onload="this.media='all'" data-clarity-unmask="true"><noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" data-clarity-unmask="true"></noscript>
 <style>
 :root {
 --bg: #f5f8fd;
 --ink: #0f172a;
 --line: #d8e4f4;
 }
 * { box-sizing: border-box; }
 body {
 margin: 0;
 padding: 0;
 font-family: "Manrope", sans-serif;
 color: var(--ink);
 background:
 radial-gradient(1100px 600px at 0% -10%, rgba(14, 165, 233, 0.15), transparent 60%),
 radial-gradient(1000px 600px at 100% 0%, rgba(16, 185, 129, 0.12), transparent 60%),
 var(--bg);
 }
 /* Padding only for static pre-hydration content */
 body > #root > main.static-job-page { padding: 26px; }
 h1, h2, h3, h4 { margin: 0; font-family: "Outfit", sans-serif; }
 main { max-width: 1120px; margin: 0 auto; display: grid; gap: 12px; }
 .proposal {
 border: 1px solid var(--line);
 background: #fff;
 border-radius: 20px;
 padding: 12px;
 overflow: hidden;
 }
 .hero {
 border: 1px solid #cae0ff;
 background:
 linear-gradient(130deg, rgba(229, 243, 255, 0.98), rgba(237, 252, 245, 0.98));
 border-radius: 16px;
 padding: 14px;
 margin-bottom: 10px;
 }
 .hero-title {
 font-size: 23px;
 line-height: 1.18;
 letter-spacing: -0.01em;
 }
 .hero-sub {
 margin-top: 4px;
 font-size: 14px;
 color: #475569;
 }
 .hero-meta {
 margin-top: 10px;
 display: flex;
 flex-wrap: wrap;
 gap: 7px;
 }
 .hero-meta span {
 border: 1px solid #cfe0f7;
 background: rgba(255, 255, 255, 0.75);
 border-radius: 999px;
 padding: 5px 8px;
 font-size: 11px;
 font-weight: 800;
 color: #385171;
 }
 .section {
 border: 1px solid #dce6f5;
 border-radius: 14px;
 padding: 12px;
 margin-bottom: 9px;
 background: #fff;
 }
 .section h4 {
 font-size: 14px;
 text-transform: uppercase;
 letter-spacing: 0.02em;
 color: #2f435f;
 margin-bottom: 8px;
 }
 .section p {
 margin: 0 0 8px 0;
 font-size: 14px;
 line-height: 1.58;
 color: #1f3149;
 }
 .section ul {
 margin: 0;
 padding-left: 18px;
 }
 .section li {
 margin-bottom: 7px;
 font-size: 14px;
 line-height: 1.52;
 color: #1f3149;
 }
 .section li.subhead {
 list-style: none;
 margin-left: -12px;
 margin-top: 4px;
 margin-bottom: 6px;
 font-weight: 800;
 color: #234b87;
 }
 .timeline {
 position: relative;
 margin-left: 6px;
 padding-left: 16px;
 border-left: 2px dashed #acc7ef;
 }
 .timeline-step {
 margin-bottom: 10px;
 position: relative;
 }
 .timeline-step::before {
 content: "";
 position: absolute;
 left: -22px;
 top: 8px;
 width: 9px;
 height: 9px;
 border-radius: 999px;
 background: #1769ff;
 }
 .cta {
 display: inline-flex;
 align-items: center;
 justify-content: center;
 margin-top: 2px;
 padding: 10px 13px;
 border-radius: 10px;
 text-decoration: none;
 font-size: 13px;
 font-weight: 800;
 background: linear-gradient(135deg, #1769ff, #0f8bff);
 color: #fff;
 }
 .related {
 margin-top: 8px;
 background: #fff;
 border: 1px solid #d8e4f4;
 border-radius: 16px;
 padding: 14px;
 }
 .related h2 {
 margin: 0 0 10px 0;
 font-size: 18px;
 }
 @media (max-width: 980px) {
 body > #root > main.static-job-page { padding: 14px; }
 .hero-title { font-size: 22px; }
 }
 </style>
${hreflangHtml}
${jobLd ? ` <script type="application/ld+json">${jobLd}</script>\n` : ''} <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url:canonicalUrl,isPartOf:{'@type':'CollectionPage','@id':`${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g,'/'))}`,name:cantonSectionName(locale,dc)}})}</script>
 <script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"SpeakableSpecification","cssSelector":["h1",".hero-sub",".section"]})}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${SPA_ACTION_REDIRECT_SCRIPT}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main class="static-job-page">
 <nav style="margin:0 0 16px;font-size:14px"><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:#4f46e5;text-decoration:none;font-weight:600">&larr; ${esc(localeCopy[locale].allJobsLink)}</a></nav>
 <article class="proposal">
 <section class="hero">
 <h1 class="hero-title">${esc(localizedTitle)}</h1>
 <div class="hero-sub">${esc(job.company)} · ${esc(job.location)} (${esc(job.canton || DEFAULT_CANTON)})</div>
 <div class="hero-meta">
 <span>${esc(`Categoria: ${String(job.category || 'other')}`)}</span>
 <span>${esc(`Contratto: ${String(job.contract || 'other')}`)}</span>
 <span>${esc(`Salario: ${salaryText}`)}</span>
 </div>
 </section>
 <section class="section">
 <h4>${esc(localeCopy[locale].summaryLabel)}</h4>
 ${summaryHtml}
 </section>
 <div class="timeline">
 ${timelineHtml || `<div class="timeline-step">${sectionHtml(localeCopy[locale].descriptionLabel, bodyParagraphs, [])}</div>`}
 </div>
 <a href="${referralUrl(job.url || canonicalUrl, job)}" rel="noopener noreferrer" class="cta">${esc(localeCopy[locale].applyNow)}</a>
 </article>
 ${(() => {
 const cSlugBanner = canonicalCompanySlugBuild(job.company, job.companyKey);
 const cHref = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${companyRoutePrefix[locale]}-${cSlugBanner}`.replace(/\/+/g, '/'))}`;
 const cLogo = companyLogo(job);
 const companyHeading: Record<string, string> = { it: 'Azienda', en: 'Company', de: 'Unternehmen', fr: 'Entreprise' };
 const companyMonitoring: Record<string, string> = { it: 'Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.', en: 'Frontaliere Ticino discovered this opportunity through company monitoring.', de: 'Frontaliere Ticino hat diese Möglichkeit im Unternehmensmonitoring entdeckt.', fr: 'Frontaliere Ticino a repéré cette opportunité dans le suivi des entreprises.' };
 return `<a href="${cHref}" style="display:flex;align-items:flex-start;gap:12px;text-decoration:none;padding:16px;border:1px solid #e2e8f0;border-radius:12px;margin-top:12px"><img src="${esc(cLogo)}" alt="Logo ${esc(job.company)}" width="28" height="28" loading="lazy" style="width:40px;height:40px;object-fit:contain;border-radius:8px;border:1px solid #e2e8f0;flex-shrink:0"><div><div style="font-size:14px;font-weight:700;color:#0f172a">${companyHeading[locale] || companyHeading.it}</div><div style="font-size:14px;color:#475569;margin-top:4px">${esc(job.company)} · ${esc(job.location || dc)}</div><div style="font-size:14px;color:#94a3b8;margin-top:8px">${companyMonitoring[locale] || companyMonitoring.it}</div></div></a>`;
 })()}
 ${related.length > 0 ? `<section class="related"><h2>${esc(localeCopy[locale].relatedJobs)}</h2><ul style="list-style:none;padding:0;margin:0">${relatedHtml}</ul></section>` : ''}
 ${buildRecentArticlesHtml(locale)}
 ${(() => {
 const loc = esc(job.location || dc);
 const co = esc(job.company || '');
 const taxUrl = `${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}`;
 const cat = String(job.category || '').toLowerCase();
 const sectorLabel: Record<string, Record<string, string>> = {
 it: { healthcare: 'sanità', technology: 'tecnologia', finance: 'servizi finanziari', engineering: 'ingegneria', hospitality: 'ospitalità', retail: 'commercio', manufacturing: 'manifattura', education: 'formazione', construction: 'edilizia', logistics: 'logistica', sales: 'vendite', administration: 'amministrazione' },
 en: { healthcare: 'healthcare', technology: 'technology', finance: 'financial services', engineering: 'engineering', hospitality: 'hospitality', retail: 'retail', manufacturing: 'manufacturing', education: 'education', construction: 'construction', logistics: 'logistics', sales: 'sales', administration: 'administration' },
 de: { healthcare: 'Gesundheitswesen', technology: 'Technologie', finance: 'Finanzdienstleistungen', engineering: 'Ingenieurwesen', hospitality: 'Gastgewerbe', retail: 'Einzelhandel', manufacturing: 'Fertigung', education: 'Bildung', construction: 'Bauwesen', logistics: 'Logistik', sales: 'Vertrieb', administration: 'Verwaltung' },
 fr: { healthcare: 'santé', technology: 'technologie', finance: 'services financiers', engineering: 'ingénierie', hospitality: 'hôtellerie', retail: 'commerce', manufacturing: 'industrie', education: 'formation', construction: 'construction', logistics: 'logistique', sales: 'ventes', administration: 'administration' },
 };
 const sectorName = sectorLabel[locale]?.[cat] || sectorLabel[locale]?.['administration'] || '';
 const frontalierInfo: Record<string, string> = {
 it: `<section class="section"><h4>Informazioni per frontalieri</h4><p>${co ? `${co} si trova` : 'Questa posizione si trova'} a ${loc} in Canton ${esc(dc)}. Per lavorare come frontaliere in Svizzera serve il <strong>Permesso G</strong>, rinnovabile annualmente. Il Canton ${esc(dc)} applica l'<strong>imposta alla fonte</strong> con aliquote variabili sul reddito lordo, mentre i frontalieri dal 2024 sono soggetti al <strong>Nuovo Accordo fiscale</strong> che prevede una tassazione concorrente Italia-Svizzera.</p><p>I contributi sociali svizzeri includono AVS (5,3%), assicurazione disoccupazione (1,1%) e LPP (previdenza professionale). Usa il nostro <a href="${taxUrl}">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p></section>`,
 en: `<section class="section"><h4>Information for cross-border workers</h4><p>${co ? `${co} is located` : 'This position is located'} in ${loc}, Canton of ${esc(dc)}. Cross-border workers need a <strong>G Permit</strong>, renewable annually, to work in Switzerland. The Canton of ${esc(dc)} applies <strong>withholding tax</strong> at variable rates on gross income, and since 2024 the <strong>New Tax Agreement</strong> introduces concurrent taxation between Italy and Switzerland.</p><p>Swiss social contributions include AVS (5.3%), unemployment insurance (1.1%) and LPP (occupational pension). Use our <a href="${taxUrl}">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p></section>`,
 de: `<section class="section"><h4>Informationen für Grenzgänger</h4><p>${co ? `${co} befindet sich` : 'Diese Stelle befindet sich'} in ${loc} im Kanton ${esc(dc)}. Grenzgänger benötigen eine <strong>G-Bewilligung</strong> (jährlich erneuerbar), um in der Schweiz zu arbeiten. Der Kanton ${esc(dc)} erhebt eine <strong>Quellensteuer</strong> mit variablen Sätzen auf das Bruttoeinkommen. Seit 2024 gilt das <strong>Neue Steuerabkommen</strong> mit konkurrierender Besteuerung zwischen Italien und der Schweiz.</p><p>Die Schweizer Sozialabgaben umfassen AHV (5,3%), Arbeitslosenversicherung (1,1%) und BVG (berufliche Vorsorge). Nutzen Sie unseren <a href="${taxUrl}">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p></section>`,
 fr: `<section class="section"><h4>Informations pour les frontaliers</h4><p>${co ? `${co} se trouve` : 'Ce poste se trouve'} à ${loc} dans le Canton du ${esc(dc)}. Les travailleurs frontaliers ont besoin d'un <strong>permis G</strong> (renouvelable annuellement) pour travailler en Suisse. Le Canton du ${esc(dc)} applique un <strong>impôt à la source</strong> à taux variable sur le revenu brut. Depuis 2024, le <strong>Nouvel Accord fiscal</strong> introduit une imposition concurrente entre l'Italie et la Suisse.</p><p>Les cotisations sociales suisses comprennent l'AVS (5,3%), l'assurance chômage (1,1%) et la LPP (prévoyance professionnelle). Utilisez notre <a href="${taxUrl}">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le coût de la vie entre la Suisse et l'Italie.</p></section>`,
 };
 const deCantonPrep = germanCantonPrep(dc);
 const frCantonPrep = frenchCantonPrep(dc);
 const faqSection: Record<string, string> = {
 it: `<section class="section"><h4>Domande frequenti</h4><dl><dt><strong>Qual è lo stipendio netto per un frontaliere in ${esc(dc)}?</strong></dt><dd>Lo stipendio netto dipende dal reddito lordo, dallo stato civile e dal numero di figli. In Canton ${esc(dc)} l'imposta alla fonte varia dal 2% al 15% circa. ${sectorName ? `Nel settore ${sectorName} in ${esc(dc)} ` : ''}Usa il nostro simulatore per un calcolo personalizzato.</dd><dt><strong>Serve la cassa malati svizzera LAMal come frontaliere?</strong></dt><dd>I nuovi frontalieri dal 2024 devono iscriversi alla LAMal svizzera entro 3 mesi dall'inizio del lavoro. I premi variano per cantone, modello assicurativo e franchigia. Confronta i premi con il nostro <a href="${BASE_URL}/compara-servizi/assicurazione-malattia/">comparatore LAMal</a>.</dd></dl></section>`,
 en: `<section class="section"><h4>Frequently asked questions</h4><dl><dt><strong>What is the net salary for a cross-border worker in ${esc(dc)}?</strong></dt><dd>Net salary depends on gross income, marital status and number of children. In the Canton of ${esc(dc)}, withholding tax ranges from about 2% to 15%. ${sectorName ? `In the ${sectorName} sector in ${esc(dc)} ` : ''}Use our simulator for a personalised calculation.</dd><dt><strong>Do cross-border workers need Swiss LAMal health insurance?</strong></dt><dd>New cross-border workers since 2024 must enrol in Swiss LAMal within 3 months of starting work. Premiums vary by canton, insurance model and deductible. Compare premiums with our <a href="${BASE_URL}/en/compare-services/health-insurance/">LAMal comparator</a>.</dd></dl></section>`,
 de: `<section class="section"><h4>Häufig gestellte Fragen</h4><dl><dt><strong>Wie hoch ist das Nettogehalt für Grenzgänger ${esc(deCantonPrep)}?</strong></dt><dd>Das Nettogehalt hängt vom Bruttoeinkommen, Familienstand und der Kinderzahl ab. Im Kanton ${esc(dc)} liegt die Quellensteuer zwischen ca. 2% und 15%. ${sectorName ? `In der Branche ${sectorName} ${esc(deCantonPrep)} ` : ''}Nutzen Sie unseren Simulator für eine individuelle Berechnung.</dd><dt><strong>Brauchen Grenzgänger eine Schweizer KVG-Versicherung?</strong></dt><dd>Neue Grenzgänger seit 2024 müssen sich innerhalb von 3 Monaten nach Arbeitsbeginn bei der KVG anmelden. Die Prämien variieren je nach Kanton, Versicherungsmodell und Franchise. Vergleichen Sie die Prämien mit unserem <a href="${BASE_URL}/de/dienste-vergleichen/krankenversicherung/">KVG-Vergleich</a>.</dd></dl></section>`,
 fr: `<section class="section"><h4>Questions fréquentes</h4><dl><dt><strong>Quel est le salaire net pour un frontalier ${esc(frCantonPrep)} ?</strong></dt><dd>Le salaire net dépend du revenu brut, de l'état civil et du nombre d'enfants. Dans le Canton du ${esc(dc)}, l'impôt à la source varie d'environ 2% à 15%. ${sectorName ? `Dans le secteur ${sectorName} ${esc(frCantonPrep)} ` : ''}Utilisez notre simulateur pour un calcul personnalisé.</dd><dt><strong>Les frontaliers doivent-ils souscrire à la LAMal suisse ?</strong></dt><dd>Les nouveaux frontaliers depuis 2024 doivent s'inscrire à la LAMal dans les 3 mois suivant le début du travail. Les primes varient selon le canton, le modèle d'assurance et la franchise. Comparez les primes avec notre <a href="${BASE_URL}/fr/comparer-services/assurance-maladie/">comparateur LAMal</a>.</dd></dl></section>`,
 };
 return (frontalierInfo[locale] || '') + (faqSection[locale] || '');
 })()}
 <nav style="margin:24px 0 0;padding:16px 0;border-top:1px solid #e2e8f0;font-size:14px">
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:#1e3a8a;text-decoration:none;font-weight:600">${esc(cantonSectionName(locale, dc))} &rarr;</a>${(() => {
 const cSlug = canonicalCompanySlugBuild(job.company, job.companyKey);
 if (!cSlug) return '';
 const cPrefix = companyRoutePrefix[locale];
 const cFullSlug = `${cPrefix}-${cSlug}`;
 const cPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${cFullSlug}`.replace(/\/+/g, '/'));
 return ` · <a href="${BASE_URL}${cPath}" style="color:#1e3a8a;text-decoration:none;font-weight:600">${esc(job.company)} &rarr;</a>`;
 })()}
 </nav>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 _qw(np.join(outDir, 'index.html'), html);
 jobHtmlCache.set(`${locale}:${perLocaleSlug[locale]}`, html);
 // Also write flat .html so /slug serves 200 (avoids GitHub Pages 301 redirect)
 // Uses a canonical bridge page instead of a noindex/meta-refresh alias
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }

 // Legacy redirect: if non-IT locale and Italian slug differs from locale slug,
 // generate redirect from Italian-slug-in-non-IT-locale → canonical URL
 if (locale !== 'it' && perLocaleSlug[locale] !== job.slug) {
 const legacyRel = `${localePrefix[locale]}/${sectionByLocale[locale]}/${job.slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const legacyHtml = buildCanonicalBridgePage({
 canonicalUrl,
 pathLabel: canonicalPath,
 title: `${esc(localizedTitle)} | Frontaliere Ticino`,
 description: `Versione legacy dell annuncio ${localizedTitle}. Apri la pagina canonica aggiornata.`,
 body: `Questa URL legacy dell annuncio non e la versione principale. Usa la pagina canonica per contenuto e metadati aggiornati.`,
 ctaLabel: String(localizedTitle || 'Apri annuncio'),
 lang: locale,
 noindex: false,
 });
 const legacyDir = np.join(distDir, legacyRel);
 if (!fs.existsSync(np.join(legacyDir, 'index.html'))) {
 _md(legacyDir);
 _qw(np.join(legacyDir, 'index.html'), legacyHtml);
 }
 const legacyFlat = np.join(distDir, legacyRel + '.html');
 if (!fs.existsSync(legacyFlat)) {
 _md(np.dirname(legacyFlat));
 _qw(legacyFlat, legacyHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }
 }
 }

 /* ── Company landing pages ────────────────────────────────── */
 type CompanyCopyEntry = {
 title: (companyName: string) => string;
 description: (companyName: string, count: number) => string;
 heading: (companyName: string) => string;
 viewAll: string;
 allJobsLink: string;
 sectionName: string;
 editorial: string;
 };
 const getCompanyCopy = (cantonDisplay: string): Record<'it' | 'en' | 'de' | 'fr', CompanyCopyEntry> => {
 const frPrep = frenchCantonPrep(cantonDisplay);
 const dePrep = germanCantonPrep(cantonDisplay);
 // F3a — title delegates to buildEmployerHubTitle (50-60 visible chars).
 // description delegates to buildEmployerHubMeta (140-160 visible chars).
 // Heading / viewAll / editorial stay unchanged (used on-page, not in head).
 const ctrYear = new Date().getFullYear();
 const ctrTitle = (loc: 'it' | 'en' | 'de' | 'fr') => (companyName: string) =>
 buildEmployerHubTitle({ locale: loc, companyDisplay: companyName, count: 0, year: ctrYear });
 const ctrDesc = (loc: 'it' | 'en' | 'de' | 'fr') => (companyName: string, count: number) =>
 buildEmployerHubMeta({ locale: loc, companyDisplay: companyName, count });
 return {
 it: {
 title: ctrTitle('it'),
 description: ctrDesc('it'),
 heading: (companyName: string) => `${companyName} — posizioni aperte in ${cantonDisplay}`,
 viewAll: 'Vedi tutte le offerte',
 allJobsLink: `Tutte le offerte di lavoro in ${cantonDisplay}`,
 sectionName: `Cerca lavoro in ${cantonDisplay}`,
 editorial: `Questa pagina raccoglie le posizioni aperte pubblicate direttamente sul sito aziendale. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico e collegano alla pagina di candidatura ufficiale. Se non trovi posizioni attive, l'azienda potrebbe non avere ruoli aperti in ${cantonDisplay} al momento — salva la pagina per ricevere aggiornamenti.`,
 },
 en: {
 title: ctrTitle('en'),
 description: ctrDesc('en'),
 heading: (companyName: string) => `${companyName} jobs in ${cantonDisplay}`,
 viewAll: 'View all jobs',
 allJobsLink: `All job offers in ${cantonDisplay}`,
 sectionName: `Find jobs in ${cantonDisplay}`,
 editorial: `This page lists positions published directly on the company's career portal. Listings are refreshed daily by our automated crawler and link to the official application page. If no roles are shown, the company may not have open positions in ${cantonDisplay} right now — bookmark this page to stay updated.`,
 },
 de: {
 title: ctrTitle('de'),
 description: ctrDesc('de'),
 heading: (companyName: string) => `${companyName} Jobs ${dePrep}`,
 viewAll: 'Alle Stellen ansehen',
 allJobsLink: `Alle Stellenangebote ${dePrep}`,
 sectionName: `Jobs ${dePrep}`,
 editorial: `Auf dieser Seite finden Sie Stellen, die direkt auf der Karriereseite des Unternehmens veröffentlicht wurden. Die Angebote werden täglich von unserem automatischen Crawler aktualisiert und verlinken zur offiziellen Bewerbungsseite. Wenn keine Stellen angezeigt werden, gibt es derzeit möglicherweise keine offenen Positionen ${dePrep}.`,
 },
 fr: {
 title: ctrTitle('fr'),
 description: ctrDesc('fr'),
 heading: (companyName: string) => `${companyName} — postes ouverts ${frPrep}`,
 viewAll: 'Voir toutes les offres',
 allJobsLink: `Toutes les offres d'emploi ${frPrep}`,
 sectionName: `Trouver un emploi ${frPrep}`,
 editorial: `Cette page rassemble les postes publiés directement sur le portail carrière de l'entreprise. Les annonces sont actualisées quotidiennement par notre robot et renvoient à la page de candidature officielle. Si aucun poste n'est affiché, l'entreprise n'a peut-être pas de postes ouverts ${frPrep} actuellement.`,
 },
 };
 };
 // Collect unique companies by canonical slug (mirrors runtime grouping)
 const companyMap = new Map<string, { name: string; jobs: typeof validJobs; rawSlugs: Set<string> }>();
 for (const job of validJobs) {
 const canonical = canonicalCompanySlugBuild(job.company, job.companyKey);
 const raw = slugifyCompanyBuild(job.company);
 if (!canonical) continue;
 if (!companyMap.has(canonical)) companyMap.set(canonical, { name: job.company, jobs: [], rawSlugs: new Set() });
 companyMap.get(canonical)!.jobs.push(job);
 if (raw && raw !== canonical) companyMap.get(canonical)!.rawSlugs.add(raw);
 }

 let companyPagesCount = 0;
 for (const [cSlug, { name: companyName, jobs: companyJobs, rawSlugs }] of companyMap) {
 for (const locale of localeList) {
 const prefix = companyRoutePrefix[locale];
 const fullSlug = `${prefix}-${cSlug}`;
 const sectionSlug = sectionByLocale[locale];
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionSlug}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const companyPrimaryCanton = [...new Set(companyJobs.map((j: any) => String(j.canton || DEFAULT_CANTON)).filter(Boolean))][0] || DEFAULT_CANTON;
 const companyDisplayCanton = CANTON_DISPLAY[companyPrimaryCanton] || companyPrimaryCanton;
 const copy = getCompanyCopy(companyDisplayCanton)[locale];
 // Tentative defaults — overridden below if a curated brand is registered.
 // F3a: title + description come from the shared CTR-optimized helpers so
 // the live job count is baked into both.
 let title = buildEmployerHubTitle({
 locale,
 companyDisplay: companyName,
 count: companyJobs.length,
 year: new Date().getFullYear(),
 });
 let description = copy.description(companyName, companyJobs.length);

 const alternates = localeList.map((l) => {
 const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
 });
 const xDefaultHrefC = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || '';
 const hreflangHtml = [
 ...alternates.map((h) => ` <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
 ...(xDefaultHrefC ? [` <link rel="alternate" hreflang="x-default" href="${xDefaultHrefC}">`] : []),
 ].join('\n');

 const jobListHtml = companyJobs.slice(0, 20).map((job) => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return `<li style="margin:0 0 10px 0"><a href="${jHref}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.location)} · ${esc(String(job.contract || 'other'))}</div></li>`;
 }).join('');

 const breadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
 { '@type': 'ListItem', position: 2, name: copy.sectionName, item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}` },
 { '@type': 'ListItem', position: 3, name: companyName, item: canonicalUrl },
 ],
 });

 // Organization schema for company pages — derived from job data
 const companyLocations = [...new Set(companyJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const cWebsite = companyWebsite(companyJobs[0]);
 const orgLdObj: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: companyName,
 url: cWebsite !== BASE_URL ? cWebsite : undefined,
 address: {
 '@type': 'PostalAddress',
 ...(primaryLocation ? { addressLocality: primaryLocation } : {}),
 addressRegion: companyDisplayCanton,
 addressCountry: 'CH',
 },
 };
 // Add number of open positions as a signal
 if (companyJobs.length > 0) {
 orgLdObj.numberOfEmployees = {
 '@type': 'QuantitativeValue',
 value: companyJobs.length,
 unitText: 'open positions',
 };
 }
 // Remove undefined values before serialization
 if (!orgLdObj.url) delete orgLdObj.url;
 // Curated employer brand overlay (EOC, Lidl, …). When present, we
 // (a) override the generic organization JSON-LD with a richer one,
 // (b) emit FAQPage + ItemList JSON-LD, and
 // (c) swap the generic "About/Frontalier" sections for the curated hub HTML.
 const curatedBrand: EmployerBrand | undefined = EMPLOYER_BRANDS[cSlug];
 let organizationLd: string;
 let curatedExtraLd = '';
 let curatedBodyHtml = '';
 let curatedMetaTitle: string | undefined;
 let curatedMetaDescription: string | undefined;
 if (curatedBrand) {
 const brandCopy = curatedBrand.copy[locale];
 const curatedOrgLd: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'Organization',
 name: curatedBrand.name,
 legalName: curatedBrand.fullName,
 alternateName: curatedBrand.shortName,
 url: curatedBrand.website,
 address: {
 '@type': 'PostalAddress',
 streetAddress: curatedBrand.headquarters.streetAddress,
 postalCode: curatedBrand.headquarters.postalCode,
 addressLocality: curatedBrand.headquarters.addressLocality,
 addressRegion: curatedBrand.headquarters.addressRegion,
 addressCountry: curatedBrand.headquarters.addressCountry,
 },
 description: brandCopy.paragraphs[0] ?? brandCopy.tagline,
 numberOfEmployees: { '@type': 'QuantitativeValue', value: companyJobs.length, unitText: 'open positions' },
 ...(curatedBrand.sameAs && curatedBrand.sameAs.length > 0 ? { sameAs: [...curatedBrand.sameAs] } : {}),
 };
 organizationLd = JSON.stringify(curatedOrgLd);

 // ItemList with top open roles
 const itemListItems = companyJobs.slice(0, 10).map((job, idx) => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return { '@type': 'ListItem', position: idx + 1, url: jHref, name: jTitle };
 });
 const itemListLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: `${curatedBrand.shortName} — ${brandCopy.sectionHeadings.openRoles}`,
 url: canonicalUrl,
 numberOfItems: companyJobs.length,
 itemListElement: itemListItems,
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: brandCopy.faqs.map((f) => ({
 '@type': 'Question',
 name: f.q,
 acceptedAnswer: { '@type': 'Answer', text: f.a },
 })),
 });
 curatedExtraLd = `\n <script type="application/ld+json">${itemListLd}</script>\n <script type="application/ld+json">${faqLd}</script>`;
 curatedMetaTitle = brandCopy.metaTitle;
 curatedMetaDescription = brandCopy.metaDescription;

 // Curated body HTML — replaces the generic company landing body.
 const paragraphsHtml = brandCopy.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
 const locationsHtml = curatedBrand.locations
 .map((loc) => `<li>${esc(loc)}</li>`)
 .join('');
 const benefitsHtml = brandCopy.benefits
 .map((b) => `<li><strong>${esc(b.title)}.</strong> ${esc(b.desc)}</li>`)
 .join('');
 const faqsHtml = brandCopy.faqs
 .map(
 (f) =>
 `<div style="margin:0 0 12px 0;padding:12px 14px;border:1px solid #e2e8f0;border-radius:10px"><h3 style="margin:0 0 6px 0;font-size:15px;color:#0f172a">${esc(
 f.q,
 )}</h3><p style="margin:0;font-size:14px;color:#334155;line-height:1.55">${esc(
 f.a,
 )}</p></div>`,
 )
 .join('');
 const openRolesListHtml = companyJobs
 .slice(0, 10)
 .map((job) => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return `<li style="margin:0 0 8px 0"><a href="${jHref}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(
 jTitle,
 )}</a><div style="font-size:13px;color:#64748b">${esc(job.location)}${
 job.canton ? ` · ${esc(job.canton)}` : ''
 }</div></li>`;
 })
 .join('');
 const listingUrlCurated = `${BASE_URL}${withSlash(
 `${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'),
 )}`;
 const headerBadge = `<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#4f46e5;font-weight:700">${esc(
 curatedBrand.shortName,
 )}</p>`;
 const hubLabels = {
 viewAllLabel: copy.viewAll,
 };
 curatedBodyHtml = [
 `<header>${headerBadge}<h1>${esc(brandCopy.h1)}</h1><p style="font-size:16px;color:#475569;margin-top:4px">${esc(
 brandCopy.tagline,
 )}</p></header>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.about)}</h2>${paragraphsHtml}</section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.locations)}</h2><p>${esc(
 brandCopy.locationsIntro,
 )}</p><ul>${locationsHtml}</ul></section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.benefits)}</h2><ul>${benefitsHtml}</ul></section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.howToApply)}</h2><p>${esc(
 brandCopy.howToApply,
 )}</p>${
 curatedBrand.careersUrl
 ? `<p><a href="${esc(curatedBrand.careersUrl)}" rel="noopener noreferrer" target="_blank" style="color:#1e3a8a;font-weight:600;text-decoration:none">${esc(
 curatedBrand.website.replace(/^https?:\/\//, ''),
 )} &rarr;</a></p>`
 : ''
 }</section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.openRoles)} (${companyJobs.length})</h2>${
 openRolesListHtml
 ? `<ul style="list-style:none;padding:0;margin:16px 0">${openRolesListHtml}</ul><p><a href="${listingUrlCurated}">${esc(
 hubLabels.viewAllLabel,
 )}</a></p>`
 : `<p>${esc(brandCopy.emptyStateNote)}</p>`
 }</section>`,
 `<section style="margin-top:28px"><h2>${esc(brandCopy.sectionHeadings.faq)}</h2>${faqsHtml}</section>`,
 ].join('\n');

 // Apply curated meta overrides so brand-queried SERPs show branded titles.
 if (curatedMetaTitle) title = curatedMetaTitle;
 if (curatedMetaDescription) description = curatedMetaDescription;
 } else {
 organizationLd = JSON.stringify(orgLdObj);
 }

 const companyHtml = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(title)}</title>
 <meta name="description" content="${esc(description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(title)}">
 <meta property="og:description" content="${esc(description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(title)}">
 <meta name="twitter:description" content="${esc(description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${hreflangHtml}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${organizationLd}</script>
 <script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url:canonicalUrl,isPartOf:{'@type':'CollectionPage','@id':`${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g,'/'))}`,name:copy.sectionName}})}</script>${curatedExtraLd}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main class="static-job-page">
 <nav style="margin:0 0 16px;font-size:14px"><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}" style="color:#4f46e5;text-decoration:none;font-weight:600">&larr; ${esc(copy.allJobsLink)}</a></nav>
${curatedBodyHtml ? curatedBodyHtml + '\n' : `<h1>${esc(copy.heading(companyName))}</h1>\n<p>${esc(description)}</p>\n`}${curatedBodyHtml ? '' : (() => {
 // Collect location info from company jobs
 const companyLocations = [...new Set(companyJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 const companySectors = [...new Set(companyJobs.map((j: any) => String(j.category || j.sector || '')).filter(Boolean))];
 const companyContracts = [...new Set(companyJobs.map((j: any) => String(j.contract || '')).filter(Boolean))];
 const primaryLocation = companyLocations[0] || '';
 const displayCanton = companyDisplayCanton;
 const locationListStr = companyLocations.slice(0, 5).join(', ');
 const listingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}`;

 const parts: string[] = [];

 // Company info section
 if (locale === 'it') {
 parts.push(`<section style="margin-top:20px"><h2>Informazioni su ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} offre attualmente <strong>${companyJobs.length} posizioni aperte</strong> in Canton ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Le sedi di lavoro includono: ${esc(locationListStr)}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` L'azienda opera nel settore ${esc(companySectors.slice(0, 3).join(', '))}.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Tipologie di contratto disponibili: ${esc(companyContracts.join(', '))}.</p>`);
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section style="margin-top:20px"><h2>About ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} currently has <strong>${companyJobs.length} open positions</strong> in the Canton of ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Work locations include: ${esc(locationListStr)}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` The company operates in the ${esc(companySectors.slice(0, 3).join(', '))} sector.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Available contract types: ${esc(companyContracts.join(', '))}.</p>`);
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section style="margin-top:20px"><h2>\u00dcber ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} bietet derzeit <strong>${companyJobs.length} offene Stellen</strong> im Kanton ${esc(displayCanton)} an.`);
 if (locationListStr) parts[parts.length - 1] += ` Arbeitsorte sind unter anderem: ${esc(locationListStr)}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` Das Unternehmen ist in den Bereichen ${esc(companySectors.slice(0, 3).join(', '))} t\u00e4tig.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Verf\u00fcgbare Vertragsarten: ${esc(companyContracts.join(', '))}.</p>`);
 parts.push('</section>');
 } else {
 parts.push(`<section style="margin-top:20px"><h2>\u00c0 propos de ${esc(companyName)}</h2>`);
 parts.push(`<p>${esc(companyName)} propose actuellement <strong>${companyJobs.length} postes ouverts</strong> dans le Canton du ${esc(displayCanton)}.`);
 if (locationListStr) parts[parts.length - 1] += ` Les lieux de travail incluent : ${esc(locationListStr)}.`;
 if (companySectors.length > 0) parts[parts.length - 1] += ` L'entreprise op\u00e8re dans le secteur ${esc(companySectors.slice(0, 3).join(', '))}.`;
 parts[parts.length - 1] += '</p>';
 if (companyContracts.length > 0) parts.push(`<p>Types de contrat disponibles : ${esc(companyContracts.join(', '))}.</p>`);
 parts.push('</section>');
 }

 // Job list
 parts.push(`<section style="margin-top:20px"><h2>${locale === 'it' ? 'Posizioni aperte' : locale === 'en' ? 'Open positions' : locale === 'de' ? 'Offene Stellen' : 'Postes ouverts'}</h2>`);
 parts.push(`<ul style="list-style:none;padding:0;margin:16px 0">${jobListHtml}</ul>`);
 parts.push(`<p><a href="${listingUrl}">${esc(copy.viewAll)}</a></p>`);
 parts.push('</section>');

 // Frontalier info section
 if (locale === 'it') {
 parts.push(`<section style="margin-top:20px"><h2>Informazioni per frontalieri</h2>`);
 parts.push(`<p>${esc(companyName)} ha sede${primaryLocation ? ` a ${esc(primaryLocation)}` : ''} in Canton ${esc(displayCanton)}, Svizzera. Per lavorare come frontaliere presso questa azienda serve il Permesso G. Il Canton ${esc(displayCanton)} applica l'imposta alla fonte con aliquote variabili sul reddito lordo dei lavoratori transfrontalieri. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p>`);
 parts.push('</section>');
 } else if (locale === 'en') {
 parts.push(`<section style="margin-top:20px"><h2>Information for cross-border workers</h2>`);
 parts.push(`<p>${esc(companyName)} is based${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} in the Canton of ${esc(displayCanton)}, Switzerland. Cross-border workers need a G Permit to work at this company. The Canton of ${esc(displayCanton)} applies withholding tax at variable rates on the gross income of cross-border employees. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p>`);
 parts.push('</section>');
 } else if (locale === 'de') {
 parts.push(`<section style="margin-top:20px"><h2>Informationen f\u00fcr Grenzg\u00e4nger</h2>`);
 parts.push(`<p>${esc(companyName)} hat seinen Sitz${primaryLocation ? ` in ${esc(primaryLocation)}` : ''} im Kanton ${esc(displayCanton)}, Schweiz. Grenzg\u00e4nger ben\u00f6tigen eine G-Bewilligung, um bei diesem Unternehmen zu arbeiten. Der Kanton ${esc(displayCanton)} erhebt eine Quellensteuer mit variablen S\u00e4tzen auf das Bruttoeinkommen der Grenzg\u00e4nger. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p>`);
 parts.push('</section>');
 } else {
 parts.push(`<section style="margin-top:20px"><h2>Informations pour les frontaliers</h2>`);
 parts.push(`<p>${esc(companyName)} a son si\u00e8ge${primaryLocation ? ` \u00e0 ${esc(primaryLocation)}` : ''} dans le Canton du ${esc(displayCanton)}, en Suisse. Les travailleurs frontaliers ont besoin d'un permis G pour travailler dans cette entreprise. Le Canton du ${esc(displayCanton)} applique un imp\u00f4t \u00e0 la source \u00e0 taux variable sur le revenu brut des frontaliers. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le co\u00fbt de la vie entre la Suisse et l'Italie.</p>`);
 parts.push('</section>');
 }

 // Editorial
 parts.push(`<p style="margin-top:16px;font-size:14px;color:#475569;line-height:1.6">${esc(copy.editorial)}</p>`);
 return parts.join('\n');
 })()}
 ${curatedBodyHtml ? `<p style="margin-top:24px;font-size:14px;color:#475569;line-height:1.6">${esc(copy.editorial)}</p>` : ''}
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), companyHtml);
 // Flat .html variant — write real content (no redirect stub)
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, companyHtml);
 }
 // Redirect pages for raw slugs that differ from canonical (e.g. lidl-svizzera → lidl)
 for (const rawSlug of rawSlugs) {
 const rawFullSlug = `${prefix}-${rawSlug}`;
 const rawRelPath = `${localePrefix[locale]}/${sectionSlug}/${rawFullSlug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const redirectHtml = buildCanonicalBridgePage({
 canonicalUrl,
 pathLabel: canonicalPath,
 title: `${esc(companyName)} | Frontaliere Ticino`,
 description: `Versione alternativa della pagina azienda ${companyName}.`,
 body: `Questa URL azienda non e la variante canonica. Apri la pagina principale dell azienda per gli annunci aggiornati.`,
 ctaLabel: String(companyName || 'Apri azienda'),
 lang: locale,
 noindex: false,
 });
 const rawDir = np.join(distDir, rawRelPath);
 if (!fs.existsSync(np.join(rawDir, 'index.html'))) {
 _md(rawDir);
 _qw(np.join(rawDir, 'index.html'), redirectHtml);
 }
 const rawFlat = np.join(distDir, rawRelPath + '.html');
 if (!fs.existsSync(rawFlat)) {
 _md(np.dirname(rawFlat));
 _qw(rawFlat, redirectHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }
 companyPagesCount++;
 }
 }
 if (companyPagesCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${companyPagesCount} company landing pages for ${companyMap.size} companies`);
 }

 const editorialLocations = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'] as const;
 const editorialTypeKeys = ['apprenticeship', 'internship', 'partTime'] as const;
 const editorialSectorKeys = ['health', 'finance', 'tech', 'engineering', 'admin', 'hospitality', 'sales'] as const;
 const editorialCareKeys = ['clinics', 'careHomes', 'oss', 'educators'] as const;

 const editorialSearchSlugsByLocale = new Map<typeof localeList[number], Set<string>>(
 localeList.map((locale) => [locale, new Set<string>()]),
 );

 /* ── Editorial landing: jobs today + location hubs ─────────── */
 let editorialEntries = '';
 {
 const editorialSitemapEntries: string[] = [];
 const renderJobList = (items: Array<{ title: string; company: string; location: string; href: string }>) =>
 items.length > 0
 ? `<ul style="list-style:none;padding:0;margin:0">${items.map((item) => `<li style="margin:0 0 12px 0;padding:0 0 12px;border-bottom:1px solid #e2e8f0"><a href="${item.href}" style="text-decoration:none;color:#1d4ed8;font-weight:700">${esc(item.title)}</a><div style="font-size:13px;color:#64748b;margin-top:4px">${esc(item.company)} · ${esc(item.location)}</div></li>`).join('')}</ul>`
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const buildEditorialJsonLd = (options: {
 locale: typeof localeList[number];
 name: string;
 url: string;
 description: string;
 isPartOf: string;
 breadcrumbs: Array<{ name: string; item: string }>;
 items: Array<{ title: string; href: string }>;
 }) => {
 const breadcrumbLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: options.breadcrumbs.map((crumb, index) => ({
 '@type': 'ListItem',
 position: index + 1,
 name: crumb.name,
 item: crumb.item,
 })),
 });
 const collectionLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: options.name,
 url: options.url,
 description: options.description,
 inLanguage: options.locale,
 isPartOf: options.isPartOf,
 });
 const itemListLd = options.items.length > 0
 ? JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: options.name,
 itemListElement: options.items.slice(0, 10).map((item, index) => ({
 '@type': 'ListItem',
 position: index + 1,
 name: item.title,
 url: item.href,
 })),
 })
 : '';
 return { breadcrumbLd, collectionLd, itemListLd };
 };

 const pushEditorialSitemapEntry = (
 buildModel: (locale: typeof localeList[number]) => { slug: string },
 priority: string,
 ) => {
 const itModel = buildModel('it');
 const itPath = withSlash(`/${sectionByLocale.it}/${itModel.slug}`.replace(/\/+/g, '/'));
 const alternateLinks = localeList.map((locale) => {
 const localeModel = buildModel(locale);
 const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localeModel.slug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${withSlash(path)}" />`;
 }).join('\n');
 editorialSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>${priority}</priority>\n </url>`);
 };

 for (const editorialCanton of EDITORIAL_CANTONS) {
 for (const locale of localeList) {
 const model = buildJobTodayLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });

 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobTodayLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const openAllHref = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cityCards = model.sections.cities.length > 0
 ? model.sections.cities.map((city) => `<a href="${city.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(city.name)}</span><span style="color:#1d4ed8">${city.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const internalLinks = model.internalLinks.map((item) => `<a href="${item.href}" style="display:inline-flex;padding:8px 12px;border-radius:999px;background:#eef2ff;color:#3730a3;text-decoration:none;font-weight:700;font-size:13px">${esc(item.label)}</a>`).join('');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.sections.last24Hours.jobs, ...model.sections.last3Days.jobs, ...model.sections.partTime.jobs],
 });

 const editorialHtml = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.sections.last24Hours.label)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.sections.last24Hours.jobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:#f0fdf4;border:1px solid #bbf7d0"><div style="font-size:12px;color:#15803d;font-weight:700;text-transform:uppercase">${esc(model.sections.last3Days.label)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.sections.last3Days.jobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:#fff7ed;border:1px solid #fed7aa"><div style="font-size:12px;color:#c2410c;font-weight:700;text-transform:uppercase">${esc(model.sections.partTime.label)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.sections.partTime.jobs.length}</div></div>
 </section>
 <nav style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px">${internalLinks}</nav>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.sections.cityHubLabel)}</h2>
 <a href="${openAllHref}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${cityCards}</div>
 </section>
 <section id="last-24-hours" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.sections.last24Hours.label)}</h2>
 ${renderJobList(model.sections.last24Hours.jobs)}
 </section>
 <section id="last-3-days" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.sections.last3Days.label)}</h2>
 ${renderJobList(model.sections.last3Days.jobs)}
 </section>
 <section id="part-time" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.sections.partTime.label)}</h2>
 ${renderJobList(model.sections.partTime.jobs)}
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;

 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), editorialHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, editorialHtml);
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobTodayLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.8');
 }

 for (const locale of localeList) {
 const model = buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const explainerCards = model.explainerCards.map((card) => `<div style="padding:18px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff"><h3 style="margin:0 0 8px;font-size:18px;color:#0f172a">${esc(card.title)}</h3><p style="margin:0;color:#475569;line-height:1.7">${esc(card.body)}</p></div>`).join('');
 const internalLinks = model.internalLinks.map((item) => `<a href="${item.href}" style="display:inline-flex;padding:8px 12px;border-radius:999px;background:#eef2ff;color:#3730a3;text-decoration:none;font-weight:700;font-size:13px">${esc(item.label)}</a>`).join('');
 const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff"><summary style="cursor:pointer;font-weight:700;color:#0f172a">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:#475569;line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:#f8fafc;border:1px solid #cbd5e1"><div style="font-size:12px;color:#334155;font-weight:700;text-transform:uppercase">${esc(model.officialSourceLabel)}</div><div style="margin-top:8px;font-size:15px;font-weight:800"><a href="${model.officialSourceUrl}" style="color:#1d4ed8;text-decoration:none">concorsi.ti.ch</a></div></div>
 </section>
 <nav style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px">${internalLinks}</nav>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.explainerTitle)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${explainerCards}</div>
 </section>
 <section id="official-competitions" style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div style="display:grid;gap:12px">${faqHtml}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobOfficialGazetteLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 }), '0.78');

 for (const editorialCanton of EDITORIAL_CANTONS) {
 for (const locale of localeList) {
 const model = buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const variantLinks = model.variants.length > 0
 ? model.variants.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#1d4ed8">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const explainerCards = model.explainerCards.map((card) => `<div style="padding:18px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff"><h3 style="margin:0 0 8px;font-size:18px;color:#0f172a">${esc(card.title)}</h3><p style="margin:0;color:#475569;line-height:1.7">${esc(card.body)}</p></div>`).join('');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff"><summary style="cursor:pointer;font-weight:700;color:#0f172a">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:#475569;line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 <div style="padding:18px;border-radius:22px;background:#f0fdf4;border:1px solid #bbf7d0"><div style="font-size:12px;color:#15803d;font-weight:700;text-transform:uppercase">${esc(model.variantTitle)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.variants.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.variantTitle)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${variantLinks}</div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${explainerCards}</div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div style="display:grid;gap:12px">${faqHtml}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobNursesHubLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.77');
 }

 /* ── Editorial landing: global part-time ───────────────────── */
 for (const editorialCanton of EDITORIAL_CANTONS) {
 for (const locale of localeList) {
 const model = buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale: altLocale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cityCards = model.cityLinks.length > 0
 ? model.cityLinks.map((city) => `<a href="${city.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(city.name)}</span><span style="color:#1d4ed8">${city.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const faqLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: model.faq.map((entry) => ({
 '@type': 'Question',
 name: entry.question,
 acceptedAnswer: {
 '@type': 'Answer',
 text: entry.answer,
 },
 })),
 });
 const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff"><summary style="cursor:pointer;font-weight:700;color:#0f172a">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:#475569;line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}
 <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.cityHubLabel)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${cityCards}</div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'Frequently asked questions' : locale === 'de' ? 'Haufige Fragen' : 'Questions frequentes'}</h2>
 <div style="display:grid;gap:12px">${faqHtml}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobPartTimeLandingModel({
 jobs: validJobs,
 locale,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.76');
 }

 for (const clusterKey of editorialCareKeys) {
 for (const editorialCanton of EDITORIAL_CANTONS) {
 const italianCareModel = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale: 'it',
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 canton: editorialCanton,
 });
 if (italianCareModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const model = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale: altLocale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 canton: editorialCanton,
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const siblingLinks = model.siblingLinks.length > 0
 ? model.siblingLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#1d4ed8">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentHubHref,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: cantonSectionName(locale, CANTON_DISPLAY[editorialCanton] || editorialCanton), item: sectionRootUrl },
 { name: locale === 'it' ? `Infermieri in ${CANTON_DISPLAY[editorialCanton] || editorialCanton}` : locale === 'en' ? `Nurses in ${CANTON_DISPLAY[editorialCanton] || editorialCanton}` : locale === 'de' ? `Pflege-Jobs ${germanCantonPrep(CANTON_DISPLAY[editorialCanton] || editorialCanton)}` : `Infirmiers ${frenchCantonPrep(CANTON_DISPLAY[editorialCanton] || editorialCanton)}`, item: model.parentHubHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const edc = CANTON_DISPLAY[editorialCanton] || editorialCanton;
 const backLabel = locale === 'it' ? `Torna all\u2019hub infermieri in ${edc}` : locale === 'en' ? `Back to nurses in ${edc}` : locale === 'de' ? `Zur\u00FCck zum Pflege-Hub ${germanCantonPrep(edc)}` : `Retour au hub infirmiers ${frenchCantonPrep(edc)}`;
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 <p style="margin:14px 0 0"><a href="${model.parentHubHref}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(backLabel)}</a></p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${sectionRootUrl}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? 'Altri percorsi sanitari' : locale === 'en' ? 'Other care paths' : locale === 'de' ? 'Weitere Pflegepfade' : 'Autres parcours sante')}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${siblingLinks}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobCareVariantLandingModel({
 jobs: validJobs,
 locale,
 clusterKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 canton: editorialCanton,
 }), '0.71');
 }
 }

 for (const location of editorialLocations) {
 const italianLocationModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 });
 if (italianLocationModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const model = buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 // Detect if this location is a canonical geo-hub city — those pages are
 // canonicalized to the clean `/cerca-lavoro-ticino/<city>/` URL rather
 // than the legacy `ricerca-<city>` editorial slug, to resolve GSC
 // cannibalization and concentrate link equity on the clean hub.
 const cityHubKey: CityHubKey | undefined = CITY_HUB_KEYS.find(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 const legacyPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalPath = cityHubKey
 ? buildCityHubPath(locale, cityHubKey)
 : legacyPath;
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 if (cityHubKey) {
 // Clean-URL alternates for geo-hub cities.
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${buildCityHubPath(altLocale, cityHubKey)}">`;
 }
 const altModel = buildJobLocationLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const typeLinks = model.relatedTypeLinks.length > 0
 ? model.relatedTypeLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#1d4ed8">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const sectorLinks = model.relatedSectorLinks.length > 0
 ? model.relatedSectorLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dcfce7;border-radius:16px;background:#f0fdf4;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#15803d">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 // For geo-hub cities, override title/description with boosted count+fire
 // copy to target high-intent queries like "lavoro lugano".
 const cityHubSeo = cityHubKey
 ? buildCityHubSeo(locale, cityHubKey, model.totalJobs, new Date().getFullYear())
 : null;
 const pageTitle = cityHubSeo ? cityHubSeo.title : model.title;
 const pageDesc = cityHubSeo ? cityHubSeo.desc : model.description;
 const pageOgTitle = cityHubSeo ? cityHubSeo.ogT : model.title;
 const pageOgDesc = cityHubSeo ? cityHubSeo.ogD : model.description;
 const pageH1 = cityHubSeo ? cityHubSeo.h1 : model.heading;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: pageH1,
 url: canonicalUrl,
 description: pageDesc,
 isPartOf: sectionRootUrl,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: pageH1, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(pageTitle)}</title>
 <meta name="description" content="${esc(pageDesc)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(pageOgTitle)}">
 <meta property="og:description" content="${esc(pageOgDesc)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(pageOgTitle)}">
 <meta name="twitter:description" content="${esc(pageOgDesc)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(pageH1)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(pageDesc)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Tipi di lavoro a ${location}` : locale === 'en' ? `Job types in ${location}` : locale === 'de' ? `Jobtypen in ${location}` : `Types d'emploi a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${typeLinks}</div>
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Settori a ${location}` : locale === 'en' ? `Sectors in ${location}` : locale === 'de' ? `Branchen in ${location}` : `Secteurs a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${sectorLinks}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 // Primary write — at canonicalPath (clean URL for geo-hub cities,
 // legacy `ricerca-<slug>` editorial path otherwise).
 const writeCityOrLegacy = (targetPath: string, body: string) => {
 const outDir = np.join(distDir, targetPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), body);
 const flat = targetPath.replace(/\/+$/, '');
 if (flat) {
 const flatFile = np.join(distDir, flat.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, body.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 };
 writeCityOrLegacy(canonicalPath, html);
 // Geo-hub cities: also keep the legacy /<section>/ricerca-<city>/
 // path live (backward-compat + external links) but emitting the same
 // HTML whose canonical already points at the clean URL.
 if (cityHubKey && legacyPath !== canonicalPath) {
 writeCityOrLegacy(legacyPath, html);
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationLandingModel({
 jobs: validJobs,
 locale,
 location,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 }), '0.75');

 // Geo-hub city: add a dedicated sitemap entry for the clean canonical
 // URL /cerca-lavoro-ticino/<city>/ (and locale variants). Priority 0.85
 // — higher than legacy ricerca-* editorial pages since the clean URL is
 // the canonical target for high-intent queries.
 {
 const cityHubKey: CityHubKey | undefined = CITY_HUB_KEYS.find(
 (k) => k.toLowerCase() === location.toLowerCase(),
 );
 if (cityHubKey) {
 const itPath = `/${sectionByLocale.it}/${CITY_HUB_SLUG.it[cityHubKey]}/`.replace(/\/+/g, '/');
 const alternateLinks = localeList.map((locale) => {
 const altPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${CITY_HUB_SLUG[locale][cityHubKey]}/`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${altPath}" />`;
 }).join('\n');
 editorialSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.85</priority>\n </url>`);
 }
 }

 for (const typeKey of editorialTypeKeys) {
 const italianTypeModel = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 });
 if (italianTypeModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const model = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const siblingLinks = model.siblingTypeLinks.length > 0
 ? model.siblingTypeLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#1d4ed8">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const parentLabel = locale === 'it' ? `Torna a lavoro a ${location}` : locale === 'en' ? `Back to jobs in ${location}` : locale === 'de' ? `Zuruck zu Jobs in ${location}` : `Retour aux emplois a ${location}`;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentLocationHref,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: locale === 'it' ? `Lavoro a ${location} in Ticino` : locale === 'en' ? `Jobs in ${location}, Ticino` : locale === 'de' ? `Jobs in ${location}, Tessin` : `Emploi a ${location}, Tessin`, item: model.parentLocationHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 <p style="margin:14px 0 0"><a href="${model.parentLocationHref}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(parentLabel)}</a></p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Altri tipi di lavoro a ${location}` : locale === 'en' ? `Other job types in ${location}` : locale === 'de' ? `Weitere Jobtypen in ${location}` : `Autres types d'emploi a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${siblingLinks}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationTypeLandingModel({
 jobs: validJobs,
 locale,
 location,
 typeKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 }), '0.68');
 }

 for (const sectorKey of editorialSectorKeys) {
 const italianSectorModel = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale: 'it',
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale.it,
 localePrefix: localePrefix.it,
 });
 if (italianSectorModel.totalJobs === 0) continue;

 for (const locale of localeList) {
 const model = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 });
 editorialSearchSlugsByLocale.get(locale)?.add(model.slug);
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const alternates = localeList
 .map((altLocale) => {
 const altModel = buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale: altLocale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[altLocale],
 localePrefix: localePrefix[altLocale],
 });
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const siblingLinks = model.siblingSectorLinks.length > 0
 ? model.siblingSectorLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dcfce7;border-radius:16px;background:#f0fdf4;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#15803d">${link.count}</span></a>`).join('')
 : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
 const parentLabel = locale === 'it' ? `Torna a lavoro a ${location}` : locale === 'en' ? `Back to jobs in ${location}` : locale === 'de' ? `Zuruck zu Jobs in ${location}` : `Retour aux emplois a ${location}`;
 const sectionRootUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const { breadcrumbLd, collectionLd, itemListLd } = buildEditorialJsonLd({
 locale,
 name: model.heading,
 url: canonicalUrl,
 description: model.description,
 isPartOf: model.parentLocationHref,
 breadcrumbs: [
 { name: 'Home', item: `${BASE_URL}/` },
 { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
 { name: locale === 'it' ? `Lavoro a ${location} in Ticino` : locale === 'en' ? `Jobs in ${location}, Ticino` : locale === 'de' ? `Jobs in ${location}, Tessin` : `Emploi a ${location}, Tessin`, item: model.parentLocationHref },
 { name: model.heading, item: canonicalUrl },
 ],
 items: [...model.feed.jobs, ...model.latestJobs],
 });
 const html = `<!doctype html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 ${FAVICON_LINKS}
 <title>${esc(model.title)}</title>
 <meta name="description" content="${esc(model.description)}">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="og:locale" content="${localeOg[locale]}">
 <meta property="og:title" content="${esc(model.title)}">
 <meta property="og:description" content="${esc(model.description)}">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:image" content="${BASE_URL}/og-image.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta property="og:image:type" content="image/png">
 <meta name="twitter:card" content="summary_large_image">
 <meta name="twitter:title" content="${esc(model.title)}">
 <meta name="twitter:description" content="${esc(model.description)}">
 <meta name="twitter:site" content="@frontaliereticino">
 <link rel="canonical" href="${canonicalUrl}">
${alternates}
 <script type="application/ld+json">${breadcrumbLd}</script>
 <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : ''}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
 <header style="margin-bottom:28px">
 <p style="margin:0 0 8px;color:#4f46e5;font-size:13px;font-weight:700">${esc(model.updatedLabel)} · ${dateStamp}</p>
 <h1 style="margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.05">${esc(model.heading)}</h1>
 <p style="margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px">${esc(model.description)}</p>
 <p style="margin:0;color:#475569;line-height:1.7;max-width:860px">${esc(model.intro)}</p>
 <p style="margin:14px 0 0"><a href="${model.parentLocationHref}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(parentLabel)}</a></p>
 </header>
 <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px">
 <div style="padding:18px;border-radius:22px;background:#eef2ff;border:1px solid #c7d2fe"><div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(model.countsLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.totalJobs}</div></div>
 <div style="padding:18px;border-radius:22px;background:#ecfeff;border:1px solid #a5f3fc"><div style="font-size:12px;color:#0f766e;font-weight:700;text-transform:uppercase">${esc(model.latestLabel)}</div><div style="margin-top:8px;font-size:32px;font-weight:800">${model.latestJobs.length}</div></div>
 </section>
 <section style="margin:0 0 28px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:0 0 14px">
 <h2 style="margin:0;font-size:24px">${esc(model.feed.label)}</h2>
 <a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}" style="color:#1d4ed8;text-decoration:none;font-weight:700">${esc(model.openAllLabel)}</a>
 </div>
 ${renderJobList(model.feed.jobs)}
 </section>
 <section style="margin:0 0 28px;padding:22px;border-radius:28px;border:1px solid #e2e8f0;background:#ffffff">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(model.latestLabel)}</h2>
 ${renderJobList(model.latestJobs)}
 </section>
 <section style="margin:0 0 28px">
 <h2 style="margin:0 0 14px;font-size:24px">${esc(locale === 'it' ? `Altri settori a ${location}` : locale === 'en' ? `Other sectors in ${location}` : locale === 'de' ? `Weitere Branchen in ${location}` : `Autres secteurs a ${location}`)}</h2>
 <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${siblingLinks}</div>
 </section>
 </main>
 </div>${hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
 </body>
</html>`;
 const outDir = np.join(distDir, canonicalPath.slice(1));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), html);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 }
 }

 pushEditorialSitemapEntry((locale) => buildJobLocationSectorLandingModel({
 jobs: validJobs,
 locale,
 location,
 sectorKey,
 now: new Date().toISOString(),
 localizedSlug,
 baseUrl: BASE_URL,
 sectionSlug: sectionByLocale[locale],
 localePrefix: localePrefix[locale],
 }), '0.67');
 }
 }

 editorialEntries = editorialSitemapEntries.join('\n');

 }

 /* ── Static paginated listing pages (/cerca-lavoro-ticino/pagina-N/) ── */
 const paginationSlugs: Record<'it' | 'en' | 'de' | 'fr', string> = { it: 'pagina', en: 'page', de: 'seite', fr: 'page' };
 const JOBS_PER_LISTING_PAGE = 20;
 const MAX_LISTING_PAGES = 25;
 const sortedForPagination = [...validJobs].sort((a: any, b: any) => {
 const da = new Date(b.crawledAt || b.datePosted || 0).getTime();
 const db = new Date(a.crawledAt || a.datePosted || 0).getTime();
 if (da !== db) return da - db;
 return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
 });
 const totalListingPages = Math.min(MAX_LISTING_PAGES, Math.ceil(sortedForPagination.length / JOBS_PER_LISTING_PAGE));
 let paginationPageCount = 0;
 const paginationSitemapEntries: string[] = [];
 const pagCopy: Record<'it' | 'en' | 'de' | 'fr', { title: (n: number) => string; desc: (n: number, from: number, to: number) => string; heading: (n: number) => string }> = {
 it: { title: (n) => `Lavoro in Ticino - Pagina ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Pagina ${n}: annunci di lavoro dal ${f} al ${t} in Ticino. Offerte aggiornate quotidianamente.`, heading: (n) => `Offerte di lavoro in Ticino \u2014 Pagina ${n}` },
 en: { title: (n) => `Jobs in Ticino - Page ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Page ${n}: job listings ${f}\u2013${t} in Ticino. Updated daily from Swiss career portals.`, heading: (n) => `Job openings in Ticino \u2014 Page ${n}` },
 de: { title: (n) => `Stellen im Tessin - Seite ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Seite ${n}: Stellenangebote ${f}\u2013${t} im Tessin. T\u00e4glich aktualisiert.`, heading: (n) => `Stellenangebote im Tessin \u2014 Seite ${n}` },
 fr: { title: (n) => `Emploi au Tessin - Page ${n} | Frontaliere Ticino`, desc: (n, f, t) => `Page ${n}: offres d'emploi ${f}\u2013${t} au Tessin. Mises \u00e0 jour quotidiennement.`, heading: (n) => `Offres d'emploi au Tessin \u2014 Page ${n}` },
 };
 for (let pageNum = 2; pageNum <= totalListingPages; pageNum++) {
 const startIdx = (pageNum - 1) * JOBS_PER_LISTING_PAGE;
 const pgJobs = sortedForPagination.slice(startIdx, startIdx + JOBS_PER_LISTING_PAGE);
 if (pgJobs.length === 0) break;
 for (const locale of localeList) {
 const pgSlug = `${paginationSlugs[locale]}-${pageNum}`;
 const pgCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${pgSlug}`.replace(/\/+/g, '/'));
 const pgCanonicalUrl = `${BASE_URL}${pgCanonicalPath}`;
 const pgCopy = pagCopy[locale];
 const pgFrom = startIdx + 1;
 const pgTo = Math.min(startIdx + JOBS_PER_LISTING_PAGE, sortedForPagination.length);
 const pgTitle = pgCopy.title(pageNum);
 const pgDesc = pgCopy.desc(pageNum, pgFrom, pgTo);
 const pgAlternates = localeList.map((al) => {
 const alSlug = `${paginationSlugs[al]}-${pageNum}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${al}" href="${BASE_URL}${withSlash(alPath)}">`;
 }).join('\n');
 const pgXDefault = ` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(`/${sectionByLocale.it}/${paginationSlugs.it}-${pageNum}`.replace(/\/+/g, '/'))}">`;
 const pgSectionPath = `${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/');
 const pgPrevHref = pageNum === 2 ? `${BASE_URL}${withSlash(pgSectionPath)}` : `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum - 1}`.replace(/\/+/g, '/'))}`;
 const pgNextHref = pageNum < totalListingPages ? `${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${pageNum + 1}`.replace(/\/+/g, '/'))}` : '';
 const pgPrevLink = ` <link rel="prev" href="${pgPrevHref}">`;
 const pgNextLink = pgNextHref ? `\n <link rel="next" href="${pgNextHref}">` : '';
 const pgListHtml = pgJobs.map((job: any) => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return `<li style="margin:0 0 10px 0"><a href="${jHref}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} \u00b7 ${esc(job.location)}</div></li>`;
 }).join('');
 const pgCollLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: pgTitle, url: pgCanonicalUrl, description: pgDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL } });
 const pgItemLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', name: pgTitle, numberOfItems: pgJobs.length, itemListElement: pgJobs.slice(0, 10).map((job: any, i: number) => ({ '@type': 'ListItem', position: i + 1, name: String(job?.titleByLocale?.[locale] || job.title || ''), url: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/'))}` })) });
 const pgMainUrl = `${BASE_URL}${withSlash(pgSectionPath)}`;
 const pgNav: string[] = [`<a href="${pgMainUrl}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:8px 12px">1</a>`];
 for (let np2 = Math.max(2, pageNum - 2); np2 <= Math.min(totalListingPages, pageNum + 2); np2++) {
 if (np2 === pageNum) { pgNav.push(`<strong>${np2}</strong>`); continue; }
 pgNav.push(`<a href="${BASE_URL}${withSlash(`${pgSectionPath}/${paginationSlugs[locale]}-${np2}`.replace(/\/+/g, '/'))}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:8px 12px">${np2}</a>`);
 }
 const pgBackLabel = locale === 'it' ? 'Torna alla lista completa' : locale === 'en' ? 'Back to full listing' : locale === 'de' ? 'Zur\u00fcck zur Liste' : 'Retour \u00e0 la liste';
 const pgHtml = buildSimplePage({
 locale,
 title: pgTitle,
 description: pgDesc,
 canonicalUrl: pgCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: `${pgAlternates}\n${pgXDefault}`,
 extraHeadHtml: `${pgPrevLink}${pgNextLink}`,
 jsonLdScripts: [pgCollLd, pgItemLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(pgCopy.heading(pageNum))}</h1>\n <p>${esc(pgDesc)}</p>\n <ul style="list-style:none;padding:0;margin:16px 0">${pgListHtml}</ul>\n <nav style="margin:24px 0;text-align:center;font-size:14px">${pgNav.join(' &middot; ')}</nav>\n <p><a href="${pgMainUrl}">${esc(pgBackLabel)}</a></p>`,
 });
 const pgOutDir = np.join(distDir, pgCanonicalPath.slice(1));
 activeJobDirs.add(pgCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(pgOutDir);
 _qw(np.join(pgOutDir, 'index.html'), pgHtml);
 const pgFlatPath = pgCanonicalPath.replace(/\/+$/, '');
 if (pgFlatPath) { const pgFlatFile = np.join(distDir, pgFlatPath.slice(1) + '.html'); _md(np.dirname(pgFlatFile)); _qw(pgFlatFile, pgHtml); }
 paginationPageCount++;
 }
 const pgItSlug = `${paginationSlugs.it}-${pageNum}`;
 const pgItPath = withSlash(`/${sectionByLocale.it}/${pgItSlug}`.replace(/\/+/g, '/'));
 const pgSmAlternates = localeList.map((l) => { const ls = `${paginationSlugs[l]}-${pageNum}`; const lp = `${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'); return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(lp)}" />`; }).join('\n');
 paginationSitemapEntries.push(` <url>\n <loc>${BASE_URL}${pgItPath}</loc>\n${pgSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pgItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.4</priority>\n </url>`);
 }
 if (paginationPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${paginationPageCount} paginated listing pages (${totalListingPages - 1} pages \u00d7 4 locales)`);

 /* ── Category listing pages (/cerca-lavoro-ticino/categoria-sanita/) ── */
 const catSlugsMap: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
 health: { it: 'sanita', en: 'health', de: 'gesundheit', fr: 'sante' },
 finance: { it: 'finanza', en: 'finance', de: 'finanzen', fr: 'finance' },
 tech: { it: 'informatica', en: 'tech', de: 'technik', fr: 'tech' },
 engineering: { it: 'ingegneria', en: 'engineering', de: 'ingenieurwesen', fr: 'ingenierie' },
 admin: { it: 'amministrazione', en: 'admin', de: 'verwaltung', fr: 'administration' },
 hospitality: { it: 'ristorazione', en: 'hospitality', de: 'gastgewerbe', fr: 'hotellerie' },
 sales: { it: 'vendita', en: 'sales', de: 'vertrieb', fr: 'vente' },
 other: { it: 'altro', en: 'other', de: 'andere', fr: 'autre' },
 };
 const catPrefix: Record<'it' | 'en' | 'de' | 'fr', string> = { it: 'categoria', en: 'category', de: 'kategorie', fr: 'categorie' };
 const catLabels: Record<string, Record<'it' | 'en' | 'de' | 'fr', string>> = {
 health: { it: 'Sanit\u00e0', en: 'Healthcare', de: 'Gesundheit', fr: 'Sant\u00e9' },
 finance: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
 tech: { it: 'Informatica', en: 'Technology', de: 'Technik', fr: 'Technologie' },
 engineering: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ing\u00e9nierie' },
 admin: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
 hospitality: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastgewerbe', fr: 'H\u00f4tellerie' },
 sales: { it: 'Vendita', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
 other: { it: 'Altro', en: 'Other', de: 'Andere', fr: 'Autre' },
 };
 let categoryPageCount = 0;
 const categorySitemapEntries: string[] = [];
 const CAT_PER_PAGE = 30;
 for (const catKey of Object.keys(catSlugsMap)) {
 const catJobs = sortedForPagination.filter((j: any) => String(j.category || '').toLowerCase() === catKey);
 if (catJobs.length < 3) continue;
 const catTotalPages = Math.min(10, Math.ceil(catJobs.length / CAT_PER_PAGE));
 for (let catPage = 1; catPage <= catTotalPages; catPage++) {
 const catStart = (catPage - 1) * CAT_PER_PAGE;
 const catPageJobs = catJobs.slice(catStart, catStart + CAT_PER_PAGE);
 if (catPageJobs.length === 0) break;
 for (const locale of localeList) {
 const catSlugL = catSlugsMap[catKey][locale];
 const catPageSuffix = catPage > 1 ? `/${paginationSlugs[locale]}-${catPage}` : '';
 const catFullSlug = `${catPrefix[locale]}-${catSlugL}${catPageSuffix}`;
 const catCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${catFullSlug}`.replace(/\/+/g, '/'));
 const catCanonicalUrl = `${BASE_URL}${catCanonicalPath}`;
 const catLabel = catLabels[catKey][locale];
 const catPageLabel = catPage > 1 ? ` - ${locale === 'de' ? 'Seite' : 'Pagina'} ${catPage}` : '';
 const catUniqueCompanies = [...new Set(catJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const catUniqueLocations = [...new Set(catJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 // F3a — CTR-optimized 50-60 char title for page 1, paginated suffix for >1.
 // Description uses the shared 140-160 char template from meta-descriptions.
 const catPrimaryTitle = buildRoleHubTitle({
 locale,
 roleDisplay: catLabel,
 count: catJobs.length,
 year: new Date().getFullYear(),
 });
 const catTitle = catPage > 1
 ? (locale === 'it' ? `${catPrimaryTitle} — Pagina ${catPage}` : locale === 'de' ? `${catPrimaryTitle} — Seite ${catPage}` : `${catPrimaryTitle} — Page ${catPage}`)
 : catPrimaryTitle;
 const catDescription = buildRoleHubMeta({
 locale,
 roleDisplay: catLabel,
 count: catJobs.length,
 });
 const catAlternates = localeList.map((al) => { const alSlug = `${catPrefix[al]}-${catSlugsMap[catKey][al]}${catPage > 1 ? `/${paginationSlugs[al]}-${catPage}` : ''}`; const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/'); return ` <link rel="alternate" hreflang="${al}" href="${BASE_URL}${withSlash(alPath)}">`; }).join('\n');
 const catListHtml = catPageJobs.map((job: any) => { const jSlug = localizedSlug(job, locale); const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/'); const jTitle = String(job?.titleByLocale?.[locale] || job.title || ''); return `<li style="margin:0 0 10px 0"><a href="${BASE_URL}${withSlash(jPath)}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} \u00b7 ${esc(job.location)}</div></li>`; }).join('');
 const catOtherLinks = Object.keys(catSlugsMap).filter((k) => k !== catKey).map((k) => { const kSlug = `${catPrefix[locale]}-${catSlugsMap[k][locale]}`; return `<a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${kSlug}`.replace(/\/+/g, '/'))}" style="text-decoration:none;color:#1e3a8a;display:inline-flex;align-items:center;min-height:44px;padding:8px 4px">${catLabels[k][locale]}</a>`; });
 const catCollLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: catTitle, url: catCanonicalUrl, description: catDescription, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL } });
 const catSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const catBreadcrumbLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
 { '@type': 'ListItem', position: 2, name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: catSectionUrl },
 { '@type': 'ListItem', position: 3, name: catTitle.replace(' | Frontaliere Ticino', ''), item: catCanonicalUrl },
 ] });
 // Build editorial intro and market context paragraphs
 const catTopCompanies = catUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const catIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${catJobs.length} offerte di lavoro</strong> nel settore ${catLabel.toLowerCase()} in Ticino, pubblicate da ${catUniqueCompanies.length} aziende in ${catUniqueLocations.length} localit\u00e0. Tra le aziende che assumono: ${catTopCompanies}. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico che raccoglie le offerte direttamente dai portali carriera delle aziende ticinesi.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${catJobs.length} job openings</strong> in the ${catLabel.toLowerCase()} sector in Ticino, published by ${catUniqueCompanies.length} companies across ${catUniqueLocations.length} locations. Hiring companies include: ${catTopCompanies}. Listings are refreshed daily by our automated crawler that collects jobs directly from company career portals in Ticino.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${catJobs.length} Stellenangebote</strong> im Bereich ${catLabel} im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${catUniqueCompanies.length} Unternehmen an ${catUniqueLocations.length} Standorten. Einstellende Unternehmen: ${catTopCompanies}. Die Anzeigen werden t\u00e4glich von unserem automatischen Crawler aktualisiert.</p>`;
 return `<p>${catJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles dans le secteur ${catLabel.toLowerCase()} au Tessin, publi\u00e9es par ${catUniqueCompanies.length} entreprises dans ${catUniqueLocations.length} localit\u00e9s. Entreprises qui recrutent : ${catTopCompanies}. Les annonces sont mises \u00e0 jour quotidiennement.</p>`;
 })();
 const catMarketSection = (() => {
 if (locale === 'it') return `<section style="margin-top:20px"><h2>Lavorare nel settore ${catLabel.toLowerCase()} in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. Il settore ${catLabel.toLowerCase()} rappresenta una delle aree pi\u00f9 attive del mercato ticinese. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section style="margin-top:20px"><h2>Working in ${catLabel.toLowerCase()} in Ticino</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. The ${catLabel.toLowerCase()} sector is one of the most active areas in the Ticino job market. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`;
 if (locale === 'de') return `<section style="margin-top:20px"><h2>Arbeiten im Bereich ${catLabel} im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. Der Bereich ${catLabel} geh\u00f6rt zu den aktivsten Sektoren des Tessiner Arbeitsmarkts. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`;
 return `<section style="margin-top:20px"><h2>Travailler dans le secteur ${catLabel.toLowerCase()} au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Le secteur ${catLabel.toLowerCase()} est l'un des domaines les plus actifs du march\u00e9 tessinois. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`;
 })();
 const catOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board \u00f6ffnen' : 'Ouvrir le job board complet';
 const catNavLabel = locale === 'it' ? 'Altre categorie' : locale === 'en' ? 'Other categories' : locale === 'de' ? 'Weitere Kategorien' : 'Autres cat\u00e9gories';
 const catHtml = buildSimplePage({
 locale,
 title: catTitle,
 description: catDescription,
 canonicalUrl: catCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: catAlternates,
 jsonLdScripts: [catCollLd, catBreadcrumbLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(catTitle.replace(' | Frontaliere Ticino', ''))}</h1>\n <p>${esc(catDescription)}</p>\n ${catIntro}\n <ul style="list-style:none;padding:0;margin:16px 0">${catListHtml}</ul>\n <p><a href="${catSectionUrl}">${esc(catOpenAllLabel)}</a></p>\n ${catMarketSection}\n <nav style="margin:20px 0;font-size:14px">${catNavLabel}: ${catOtherLinks.join(' \u00b7 ')}</nav>`,
 });
 const catOutDir = np.join(distDir, catCanonicalPath.slice(1));
 activeJobDirs.add(catCanonicalPath.slice(1).replace(/\/+$/, ''));
 _md(catOutDir);
 _qw(np.join(catOutDir, 'index.html'), catHtml);
 const catFlatPath = catCanonicalPath.replace(/\/+$/, '');
 if (catFlatPath) { const catFlatFile = np.join(distDir, catFlatPath.slice(1) + '.html'); _md(np.dirname(catFlatFile)); _qw(catFlatFile, catHtml); }
 categoryPageCount++;
 }
 if (catPage === 1) {
 const catItSlug = `${catPrefix.it}-${catSlugsMap[catKey].it}`;
 const catItPath = withSlash(`/${sectionByLocale.it}/${catItSlug}`.replace(/\/+/g, '/'));
 const catSmAlternates = localeList.map((l) => { const ls = `${catPrefix[l]}-${catSlugsMap[catKey][l]}`; const lp = `${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'); return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(lp)}" />`; }).join('\n');
 categorySitemapEntries.push(` <url>\n <loc>${BASE_URL}${catItPath}</loc>\n${catSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${catItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`);
 }
 }
 }
 if (categoryPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${categoryPageCount} category listing pages`);

 /* ── GSC-driven keyword landing pages ──────────────────────── */
 let keywordPageCount = 0;
 const keywordSitemapEntries: string[] = [];
 const kwConfigPath = np.resolve(rootDir, 'data/keyword-pages-config.json');
 if (fs.existsSync(kwConfigPath)) {
 try {
 const kwConfig = JSON.parse(fs.readFileSync(kwConfigPath, 'utf-8'));
 const kwPages: any[] = Array.isArray(kwConfig?.pages) ? kwConfig.pages : [];
 for (const kwPage of kwPages) {
 const kwSlug = String(kwPage.slug || '').trim();
 const kwFilterWords: string[] = Array.isArray(kwPage.filterKeywords) ? kwPage.filterKeywords : [];
 if (!kwSlug || kwFilterWords.length === 0) continue;
 // Match jobs where ALL filter keywords appear in title/description/company/location
 const kwJobs = sortedForPagination.filter((j: any) => {
 const haystack = [
 String(j.title || ''), String(j.description || ''),
 String(j.company || ''), String(j.location || ''),
 ...(Object.values(j.titleByLocale || {}) as string[]),
 ].join(' ').toLowerCase();
 return kwFilterWords.every((kw: string) => haystack.includes(kw));
 }).slice(0, 30);
 if (kwJobs.length < 3) continue;
 const itCopy = kwPage.copy?.it;
 if (!itCopy) continue;
 const kwUniqueCompanies = [...new Set(kwJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const kwUniqueLocations = [...new Set(kwJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 for (const locale of localeList) {
 const kwFullSlug = `${searchRoutePrefix[locale]}-${kwSlug}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(kwFullSlug)) continue;
 const kwCanonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${kwFullSlug}`.replace(/\/+/g, '/'));
 const kwRelDir = kwCanonicalPath.slice(1).replace(/\/+$/, '');
 if (activeJobDirs.has(kwRelDir)) continue;
 const kwCanonicalUrl = `${BASE_URL}${kwCanonicalPath}`;
 const kwQueryDisplay = String(kwPage.query || '').trim();
 // F3a — delegate title/description to the shared CTR-optimized helpers so
 // keyword landing pages get the same 50-60 / 140-160 char treatment as
 // role / city / employer hubs. The Italian landing preserves its curated
 // `itCopy.title` because that was hand-tuned per query in keyword config.
 const kwTitle = locale === 'it'
 ? itCopy.title
 : buildRoleHubTitle({
 locale,
 roleDisplay: kwQueryDisplay || 'Jobs',
 count: kwJobs.length,
 year: new Date().getFullYear(),
 });
 const kwDesc = buildRoleHubMeta({
 locale,
 roleDisplay: kwQueryDisplay || (locale === 'it' ? 'lavoro' : locale === 'en' ? 'jobs' : locale === 'de' ? 'Stellen' : 'emploi'),
 count: kwJobs.length,
 });
 const kwAlternates = localeList.map((al) => {
 const alSlug = `${searchRoutePrefix[al]}-${kwSlug}`;
 const alPath = `${localePrefix[al]}/${sectionByLocale[al]}/${alSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${al}" href="${BASE_URL}${withSlash(alPath)}">`;
 }).join('\n');
 const kwListHtml = kwJobs.map((job: any) => {
 const jSlug = localizedSlug(job, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return `<li style="margin:0 0 10px 0"><a href="${BASE_URL}${withSlash(jPath)}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} \u00b7 ${esc(job.location)}</div></li>`;
 }).join('');
 const kwCollLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: kwTitle, url: kwCanonicalUrl, description: kwDesc, inLanguage: locale, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: BASE_URL } });
 const kwCtaCopy: Record<string, string> = {
 it: `Consulta le ${kwJobs.length} posizioni aperte qui sotto. Le offerte vengono aggiornate quotidianamente da aziende con sede in Ticino e Grigioni. Utilizza il nostro calcolatore per confrontare stipendio netto, tasse e costo della vita tra Svizzera e Italia.`,
 en: `Browse the ${kwJobs.length} open positions listed below. Listings are updated daily from employers based in Ticino and Graubünden. Use our calculator to compare net salary, taxes, and cost of living between Switzerland and Italy.`,
 de: `Entdecken Sie die ${kwJobs.length} offenen Stellen unten. Die Angebote werden täglich von Arbeitgebern im Tessin und Graubünden aktualisiert. Nutzen Sie unseren Rechner, um Nettolohn, Steuern und Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.`,
 fr: `Consultez les ${kwJobs.length} postes ouverts ci-dessous. Les offres sont mises à jour quotidiennement par des employeurs basés au Tessin et dans les Grisons. Utilisez notre calculateur pour comparer salaire net, impôts et coût de la vie entre la Suisse et l'Italie.`,
 };
 const kwCta = kwCtaCopy[locale] || kwCtaCopy.it;
 const kwSectionUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const kwTopCompanies = kwUniqueCompanies.slice(0, 5).map((c) => esc(c)).join(', ');
 const kwIntro = (() => {
 if (locale === 'it') return `<p>Sono attualmente disponibili <strong>${kwJobs.length} offerte di lavoro</strong> per "${esc(kwQueryDisplay)}" in Ticino, pubblicate da ${kwUniqueCompanies.length} aziende${kwUniqueLocations.length > 1 ? ` in ${kwUniqueLocations.length} localit\u00e0` : ''}. Tra le aziende che assumono: ${kwTopCompanies}. Gli annunci vengono aggiornati quotidianamente.</p>`;
 if (locale === 'en') return `<p>There are currently <strong>${kwJobs.length} job openings</strong> for "${esc(kwQueryDisplay)}" in Ticino, published by ${kwUniqueCompanies.length} companies${kwUniqueLocations.length > 1 ? ` across ${kwUniqueLocations.length} locations` : ''}. Hiring companies include: ${kwTopCompanies}. Listings are refreshed daily.</p>`;
 if (locale === 'de') return `<p>Derzeit sind <strong>${kwJobs.length} Stellenangebote</strong> f\u00fcr "${esc(kwQueryDisplay)}" im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${kwUniqueCompanies.length} Unternehmen${kwUniqueLocations.length > 1 ? ` an ${kwUniqueLocations.length} Standorten` : ''}. Einstellende Unternehmen: ${kwTopCompanies}.</p>`;
 return `<p>${kwJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles pour "${esc(kwQueryDisplay)}" au Tessin, publi\u00e9es par ${kwUniqueCompanies.length} entreprises${kwUniqueLocations.length > 1 ? ` dans ${kwUniqueLocations.length} localit\u00e9s` : ''}. Entreprises qui recrutent : ${kwTopCompanies}.</p>`;
 })();
 const kwMarketSection = (() => {
 if (locale === 'it') return `<section style="margin-top:20px"><h2>Il mercato del lavoro in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`;
 if (locale === 'en') return `<section style="margin-top:20px"><h2>The Ticino job market</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`;
 if (locale === 'de') return `<section style="margin-top:20px"><h2>Der Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`;
 return `<section style="margin-top:20px"><h2>Le march\u00e9 de l'emploi au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`;
 })();
 const kwOpenAllLabel = locale === 'it' ? 'Apri il job board completo' : locale === 'en' ? 'Open the full job board' : locale === 'de' ? 'Komplettes Job Board \u00f6ffnen' : 'Ouvrir le job board complet';
 const kwHtml = buildSimplePage({
 locale,
 title: kwTitle,
 description: kwDesc,
 canonicalUrl: kwCanonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: kwAlternates,
 jsonLdScripts: [kwCollLd],
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(itCopy.heading)}</h1>\n <p>${esc(kwDesc)}</p>\n ${kwIntro}\n <p>${esc(kwCta)}</p>\n <ul style="list-style:none;padding:0;margin:16px 0">${kwListHtml}</ul>\n <p><a href="${kwSectionUrl}">${esc(kwOpenAllLabel)}</a></p>\n ${kwMarketSection}`,
 });
 const kwOutDir = np.join(distDir, kwCanonicalPath.slice(1));
 activeJobDirs.add(kwRelDir);
 _md(kwOutDir);
 _qw(np.join(kwOutDir, 'index.html'), kwHtml);
 const kwFlatPath = kwCanonicalPath.replace(/\/+$/, '');
 if (kwFlatPath) { const kwFlatFile = np.join(distDir, kwFlatPath.slice(1) + '.html'); _md(np.dirname(kwFlatFile)); _qw(kwFlatFile, kwHtml); }
 keywordPageCount++;
 }
 // Sitemap entry (Italian canonical)
 const kwItSlug = `${searchRoutePrefix.it}-${kwSlug}`;
 const kwItPath = withSlash(`/${sectionByLocale.it}/${kwItSlug}`.replace(/\/+/g, '/'));
 const kwSmAlternates = localeList.map((l) => { const ls = `${searchRoutePrefix[l]}-${kwSlug}`; const lp = `${localePrefix[l]}/${sectionByLocale[l]}/${ls}`.replace(/\/+/g, '/'); return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(lp)}" />`; }).join('\n');
 keywordSitemapEntries.push(` <url>\n <loc>${BASE_URL}${kwItPath}</loc>\n${kwSmAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${kwItPath}" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 } catch (e) {
 console.warn(`\x1b[33m[jobs-seo-pages]\x1b[0m Failed to load keyword pages config: ${e}`);
 }
 }
 if (keywordPageCount > 0) console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${keywordPageCount} GSC keyword landing pages`);

 /* ── Search landing pages from stats leaders ───────────────── */
 let searchEntries = '';
 const statsPath = np.resolve(rootDir, 'data/jobs-stats.json');
 if (fs.existsSync(statsPath)) {
 const statsRaw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
 const leaderGroups = [
 ...(Array.isArray(statsRaw?.leaders?.topLocationsActive) ? statsRaw.leaders.topLocationsActive : []),
 ...(Array.isArray(statsRaw?.leaders?.topLocationsAdded30d) ? statsRaw.leaders.topLocationsAdded30d : []),
 ...(Array.isArray(statsRaw?.leaders?.topTitlesAdded30d) ? statsRaw.leaders.topTitlesAdded30d : []),
 ];
 const searchLeaderMap = new Map<string, { key: string; name: string }>();
 for (const item of leaderGroups) {
 const key = String(item?.key || '').trim();
 const name = String(item?.name || '').trim();
 if (!key || !name || searchLeaderMap.has(key)) continue;
 searchLeaderMap.set(key, { key, name });
 }

 let searchPageCount = 0;
 const searchSitemapEntries: string[] = [];
 for (const { key, name } of searchLeaderMap.values()) {
 const matchingJobsByLocale = {
 it: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'it')).slice(0, 20),
 en: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'en')).slice(0, 20),
 de: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'de')).slice(0, 20),
 fr: validJobs.filter((job: any) => matchesSearchLanding(job, name, 'fr')).slice(0, 20),
 };
 if (localeList.every((locale) => matchingJobsByLocale[locale].length === 0)) continue;
 const fallbackMatchingJobs = pickSearchLandingFallbackJobs(matchingJobsByLocale);
 if (fallbackMatchingJobs.length === 0) continue;

 for (const locale of localeList) {
 const matchingJobs = matchingJobsByLocale[locale].length > 0
 ? matchingJobsByLocale[locale]
 : fallbackMatchingJobs;
 if (matchingJobs.length === 0) continue;

 const fullSlug = `${searchRoutePrefix[locale]}-${key}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(fullSlug)) continue;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const copy = searchPageCopy[locale];
 const title = copy.title(name);
 const description = copy.description(name, matchingJobs.length);
 const alternates = localeList
 .map((altLocale) => {
 const altSlug = `${searchRoutePrefix[altLocale]}-${key}`;
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const listHtml = matchingJobs.map((job: any) => {
 const slug = localizedSlug(job, locale);
 const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
 const href = `${BASE_URL}${withSlash(path)}`;
 const jobTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return `<li style="margin:0 0 10px 0"><a href="${href}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jobTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} · ${esc(job.location)}</div></li>`;
 }).join('');

 const twitterCards = ` <meta name="twitter:card" content="summary_large_image">\n <meta name="twitter:title" content="${esc(title)}">\n <meta name="twitter:description" content="${esc(description)}">\n <meta name="twitter:site" content="@frontaliereticino">`;
 const searchBodyParts: string[] = [];
 {
 const listingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const uniqueCompanies = [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const uniqueLocations = [...new Set(matchingJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 if (locale === 'it') {
 searchBodyParts.push(`<p>Sono attualmente disponibili <strong>${matchingJobs.length} offerte di lavoro</strong> per ${esc(name)} in Ticino, pubblicate da ${uniqueCompanies.length} aziende in ${uniqueLocations.length} localit\u00e0. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico che raccoglie le offerte direttamente dai portali carriera delle aziende ticinesi.</p>`);
 } else if (locale === 'en') {
 searchBodyParts.push(`<p>There are currently <strong>${matchingJobs.length} job openings</strong> for ${esc(name)} in Ticino, published by ${uniqueCompanies.length} companies across ${uniqueLocations.length} locations. Listings are refreshed daily by our automated crawler that collects jobs directly from company career portals in Ticino.</p>`);
 } else if (locale === 'de') {
 searchBodyParts.push(`<p>Derzeit sind <strong>${matchingJobs.length} Stellenangebote</strong> f\u00fcr ${esc(name)} im Tessin verf\u00fcgbar, ver\u00f6ffentlicht von ${uniqueCompanies.length} Unternehmen an ${uniqueLocations.length} Standorten. Die Anzeigen werden t\u00e4glich von unserem automatischen Crawler aktualisiert, der Stellen direkt von den Karriereportalen der Tessiner Unternehmen sammelt.</p>`);
 } else {
 searchBodyParts.push(`<p>${matchingJobs.length} <strong>offres d'emploi</strong> sont actuellement disponibles pour ${esc(name)} au Tessin, publi\u00e9es par ${uniqueCompanies.length} entreprises dans ${uniqueLocations.length} localit\u00e9s. Les annonces sont mises \u00e0 jour quotidiennement par notre robot qui collecte les offres directement depuis les portails carri\u00e8re des entreprises tessinoises.</p>`);
 }
 searchBodyParts.push(`<ul style="list-style:none;padding:0;margin:16px 0">${listHtml}</ul>`);
 searchBodyParts.push(`<p><a href="${listingUrl}">${esc(copy.openListing)}</a></p>`);
 if (locale === 'it') {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>Il mercato del lavoro in Ticino</h2><p>Il Canton Ticino \u00e8 il principale polo economico della Svizzera italiana con oltre 180.000 posti di lavoro. I settori pi\u00f9 attivi includono sanit\u00e0, finanza, tecnologia, ingegneria, commercio e amministrazione. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte sul reddito lordo. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere.</p></section>`);
 } else if (locale === 'en') {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>The Ticino job market</h2><p>The Canton of Ticino is the main economic hub of Italian-speaking Switzerland with over 180,000 jobs. The most active sectors include healthcare, finance, technology, engineering, retail, and administration. For cross-border workers with a G Permit, Ticino applies withholding tax on gross income. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker.</p></section>`);
 } else if (locale === 'de') {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>Der Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz mit \u00fcber 180.000 Arbeitspl\u00e4tzen. Die aktivsten Branchen sind Gesundheitswesen, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer auf das Bruttoeinkommen. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen.</p></section>`);
 } else {
 searchBodyParts.push(`<section style="margin-top:20px"><h2>Le march\u00e9 de l'emploi au Tessin</h2><p>Le Canton du Tessin est le principal p\u00f4le \u00e9conomique de la Suisse italienne avec plus de 180 000 emplois. Les secteurs les plus actifs incluent la sant\u00e9, la finance, la technologie, l'ing\u00e9nierie, le commerce et l'administration. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source sur le revenu brut. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier.</p></section>`);
 }
 searchBodyParts.push(`<p style="margin-top:16px;font-size:14px;color:#475569;line-height:1.6">${esc(copy.editorial)}</p>`);
 }
 const searchHtml = buildSimplePage({
 locale,
 title,
 description,
 canonicalUrl,
 robots: matchingJobs.length >= 3 ? 'index,follow' : 'noindex,follow',
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 extraHeadHtml: twitterCards,
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(copy.heading(name))}</h1>\n <p>${esc(description)}</p>\n${searchBodyParts.join('\n')}`,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), searchHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, searchHtml);
 }
 searchPageCount++;
 }

 // Add indexable search pages (≥3 jobs) to sitemap
 if (fallbackMatchingJobs.length >= 3) {
 const sItSlug = `${searchRoutePrefix.it}-${key}`;
 const sItPath = withSlash(`/${sectionByLocale.it}/${sItSlug}`.replace(/\/+/g, '/'));
 const sAlternates = localeList.map((l) => {
 const lSlug = `${searchRoutePrefix[l]}-${key}`;
 const sp = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(sp)}" />`;
 }).join('\n');
 const sXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${sItPath}" />`;
 searchSitemapEntries.push(` <url>\n <loc>${BASE_URL}${sItPath}</loc>\n${sAlternates}\n${sXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 }

 /* ── Combo search landing pages ────────────────────────────── */
 // Helper: generate a combo search landing page with custom filter & copy
 const generateComboPage = (
 comboKey: string,
 copyByLocale: Record<'it' | 'en' | 'de' | 'fr', { title: string; description: (count: number) => string; heading: string }>,
 filterFn: (job: any) => boolean,
 ): void => {
 const matchingJobs = validJobs.filter(filterFn).slice(0, 20);
 if (matchingJobs.length === 0) return;

 for (const locale of localeList) {
 const fullSlug = `${searchRoutePrefix[locale]}-${comboKey}`;
 if (editorialSearchSlugsByLocale.get(locale)?.has(fullSlug)) continue;
 if (searchLeaderMap.has(comboKey)) continue;
 const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${fullSlug}`.replace(/\/+/g, '/'));
 const canonicalUrl = `${BASE_URL}${canonicalPath}`;
 const copy = copyByLocale[locale];
 const description = copy.description(matchingJobs.length);
 const alternates = localeList
 .map((altLocale) => {
 const altSlug = `${searchRoutePrefix[altLocale]}-${comboKey}`;
 const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altSlug}`.replace(/\/+/g, '/');
 return ` <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
 })
 .join('\n');
 const listHtml = matchingJobs.map((job: any) => {
 const slug = localizedSlug(job, locale);
 const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
 const href = `${BASE_URL}${withSlash(path)}`;
 const jobTitle = String(job?.titleByLocale?.[locale] || job.title || '');
 return `<li style="margin:0 0 10px 0"><a href="${href}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jobTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} · ${esc(job.location)}</div></li>`;
 }).join('');

 const comboOgImage = ` <meta property="og:image" content="${BASE_URL}/og-image.png">\n <meta property="og:image:width" content="1200">\n <meta property="og:image:height" content="630">\n <meta property="og:image:type" content="image/png">`;
 const comboBodyParts: string[] = [];
 {
 const cListingUrl = `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}`;
 const cUniqueCompanies = [...new Set(matchingJobs.map((j: any) => String(j.company || '')).filter(Boolean))];
 const cUniqueLocations = [...new Set(matchingJobs.map((j: any) => String(j.location || '')).filter(Boolean))];
 if (locale === 'it') {
 comboBodyParts.push(`<p>Abbiamo trovato <strong>${matchingJobs.length} offerte di lavoro</strong> corrispondenti a questa ricerca, pubblicate da ${cUniqueCompanies.length} aziende${cUniqueLocations.length > 1 ? ` in ${cUniqueLocations.length} localit\u00e0 del Ticino` : cUniqueLocations.length === 1 ? ` a ${esc(cUniqueLocations[0])}` : ' in Ticino'}. Ogni annuncio rimanda direttamente alla pagina di candidatura ufficiale dell'azienda.</p>`);
 } else if (locale === 'en') {
 comboBodyParts.push(`<p>We found <strong>${matchingJobs.length} job openings</strong> matching this search, published by ${cUniqueCompanies.length} companies${cUniqueLocations.length > 1 ? ` across ${cUniqueLocations.length} locations in Ticino` : cUniqueLocations.length === 1 ? ` in ${esc(cUniqueLocations[0])}` : ' in Ticino'}. Each listing links directly to the official company application page.</p>`);
 } else if (locale === 'de') {
 comboBodyParts.push(`<p>Wir haben <strong>${matchingJobs.length} Stellenangebote</strong> f\u00fcr diese Suche gefunden, ver\u00f6ffentlicht von ${cUniqueCompanies.length} Unternehmen${cUniqueLocations.length > 1 ? ` an ${cUniqueLocations.length} Standorten im Tessin` : cUniqueLocations.length === 1 ? ` in ${esc(cUniqueLocations[0])}` : ' im Tessin'}. Jedes Inserat verlinkt direkt zur offiziellen Bewerbungsseite des Unternehmens.</p>`);
 } else {
 comboBodyParts.push(`<p>Nous avons trouv\u00e9 <strong>${matchingJobs.length} offres d'emploi</strong> correspondant \u00e0 cette recherche, publi\u00e9es par ${cUniqueCompanies.length} entreprises${cUniqueLocations.length > 1 ? ` dans ${cUniqueLocations.length} localit\u00e9s au Tessin` : cUniqueLocations.length === 1 ? ` \u00e0 ${esc(cUniqueLocations[0])}` : ' au Tessin'}. Chaque annonce renvoie directement \u00e0 la page de candidature officielle de l'entreprise.</p>`);
 }
 comboBodyParts.push(`<ul style="list-style:none;padding:0;margin:16px 0">${listHtml}</ul>`);
 comboBodyParts.push(`<p><a href="${cListingUrl}">${esc(searchPageCopy[locale].openListing)}</a></p>`);
 if (locale === 'it') {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Lavorare in Ticino come frontaliere</h2><p>Il Canton Ticino \u00e8 la principale area economica della Svizzera italiana. Per i lavoratori frontalieri con Permesso G, il Ticino applica l'imposta alla fonte con aliquote variabili sul reddito lordo. I principali centri economici sono Lugano, Bellinzona, Mendrisio, Locarno e Chiasso. Usa il nostro <a href="${BASE_URL}/">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto come frontaliere e confrontare vantaggi e svantaggi tra residenza in Svizzera e pendolarismo dall'Italia.</p></section>`);
 } else if (locale === 'en') {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Working in Ticino as a cross-border commuter</h2><p>The Canton of Ticino is the main economic area of Italian-speaking Switzerland. For cross-border workers with a G Permit, Ticino applies withholding tax at variable rates on gross income. The main economic centres are Lugano, Bellinzona, Mendrisio, Locarno, and Chiasso. Use our <a href="${BASE_URL}/en/">free tax simulator</a> to calculate your net salary as a cross-border worker and compare the pros and cons of living in Switzerland versus commuting from Italy.</p></section>`);
 } else if (locale === 'de') {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Arbeiten im Tessin als Grenzg\u00e4nger</h2><p>Der Kanton Tessin ist das wirtschaftliche Zentrum der italienischen Schweiz. F\u00fcr Grenzg\u00e4nger mit G-Bewilligung erhebt das Tessin eine Quellensteuer mit variablen S\u00e4tzen auf das Bruttoeinkommen. Die wichtigsten Wirtschaftszentren sind Lugano, Bellinzona, Mendrisio, Locarno und Chiasso. Nutzen Sie unseren <a href="${BASE_URL}/de/">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt als Grenzg\u00e4nger zu berechnen und die Vor- und Nachteile eines Wohnsitzes in der Schweiz gegen\u00fcber dem Pendeln aus Italien zu vergleichen.</p></section>`);
 } else {
 comboBodyParts.push(`<section style="margin-top:20px"><h2>Travailler au Tessin en tant que frontalier</h2><p>Le Canton du Tessin est la principale zone \u00e9conomique de la Suisse italienne. Pour les frontaliers avec un permis G, le Tessin applique un imp\u00f4t \u00e0 la source \u00e0 taux variable sur le revenu brut. Les principaux centres \u00e9conomiques sont Lugano, Bellinzona, Mendrisio, Locarno et Chiasso. Utilisez notre <a href="${BASE_URL}/fr/">simulateur fiscal gratuit</a> pour calculer votre salaire net en tant que frontalier et comparer les avantages et inconv\u00e9nients entre r\u00e9sider en Suisse et faire la navette depuis l'Italie.</p></section>`);
 }
 comboBodyParts.push(`<p style="margin-top:16px;font-size:14px;color:#475569;line-height:1.6">${esc(searchPageCopy[locale].editorial)}</p>`);
 }
 const comboHtml = buildSimplePage({
 locale,
 title: copy.title,
 description,
 canonicalUrl,
 ogLocale: localeOg[locale],
 hreflangHtml: alternates,
 extraHeadHtml: comboOgImage,
 entryJs: hasSpaBundle ? entryJs : undefined,
 entryCss: hasSpaBundle ? entryCss : undefined,
 bodyHtml: `<h1>${esc(copy.heading)}</h1>\n <p>${esc(description)}</p>\n${comboBodyParts.join('\n')}`,
 });

 const outDir = np.join(distDir, canonicalPath.slice(1));
 activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
 _md(outDir);
 _qw(np.join(outDir, 'index.html'), comboHtml);
 const flatPath = canonicalPath.replace(/\/+$/, '');
 if (flatPath) {
 const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, comboHtml);
 }
 searchPageCount++;
 }

 // Add qualifying combo pages to sitemap for discovery
 if (matchingJobs.length >= 3) {
 const cItSlug = `${searchRoutePrefix.it}-${comboKey}`;
 const cItPath = withSlash(`/${sectionByLocale.it}/${cItSlug}`.replace(/\/+/g, '/'));
 const cAlternates = localeList.map((l) => {
 const lSlug = `${searchRoutePrefix[l]}-${comboKey}`;
 const cp = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(cp)}" />`;
 }).join('\n');
 const cXDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${cItPath}" />`;
 searchSitemapEntries.push(` <url>\n <loc>${BASE_URL}${cItPath}</loc>\n${cAlternates}\n${cXDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.5</priority>\n </url>`);
 }
 };

 // Collect unique locations and companies from stats leaders
 const locationLeaders = new Map<string, string>();
 for (const groupKey of ['topLocationsActive', 'topLocationsAdded30d'] as const) {
 for (const item of (statsRaw?.leaders?.[groupKey] ?? [])) {
 const k = String(item?.key || '').trim();
 const n = String(item?.name || '').trim();
 if (k && n && !locationLeaders.has(k)) locationLeaders.set(k, n);
 }
 }
 const companyLeaders = new Map<string, string>();
 for (const groupKey of ['topCompaniesActive', 'topCompaniesAdded30d'] as const) {
 for (const item of (statsRaw?.leaders?.[groupKey] ?? [])) {
 const k = String(item?.key || '').trim();
 const n = String(item?.name || '').trim();
 if (k && n && !companyLeaders.has(k)) companyLeaders.set(k, n);
 }
 }
 // Filter out non-city location keys
 const cityKeys = new Set<string>();
 for (const [k] of locationLeaders) {
 if (k !== 'ticino' && k !== 'grigioni' && !k.includes('-') && k.length < 30) cityKeys.add(k);
 }

 // 1) città + azienda combinations
 let comboCount = 0;
 for (const [cityKey, cityName] of locationLeaders) {
 if (!cityKeys.has(cityKey)) continue;
 for (const [compKey, compName] of companyLeaders) {
 const comboKey = `${cityKey}-${compKey}`;
 const normCity = normalizeSearchTerm(cityKey);
 const normComp = normalizeSearchTerm(compKey);
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${compName} a ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro ${compName} a ${cityName}. Scopri le posizioni aperte e candidati subito.`,
 heading: `Lavoro ${compName} a ${cityName}`,
 },
 en: {
 title: `${compName} jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${compName} job openings in ${cityName}. Browse available positions and apply today.`,
 heading: `${compName} jobs in ${cityName}`,
 },
 de: {
 title: `${compName} Jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offene Stellen bei ${compName} in ${cityName}. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${compName} Jobs in ${cityName}`,
 },
 fr: {
 title: `Emploi ${compName} à ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${compName} à ${cityName}. Consultez les postes ouverts et postulez directement.`,
 heading: `Emploi ${compName} à ${cityName}`,
 },
 }, (job) => {
 const loc = normalizeSearchTerm(job?.location || '');
 const comp = normalizeSearchTerm([job?.company, job?.companyKey].filter(Boolean).join(' '));
 return loc.includes(normCity) && comp.includes(normComp);
 });
 comboCount++;
 }
 }

 // 2) città + contratto combinations
 const contractTypes: { key: string; labels: Record<'it' | 'en' | 'de' | 'fr', string>; match: string[] }[] = [
 { key: 'full-time', labels: { it: 'Full-time', en: 'Full-time', de: 'Vollzeit', fr: 'Temps plein' }, match: ['full-time'] },
 { key: 'part-time', labels: { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' }, match: ['part-time'] },
 { key: 'stage', labels: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' }, match: ['internship'] },
 { key: 'apprendistato', labels: { it: 'Apprendistato', en: 'Apprenticeship', de: 'Lehrstelle', fr: 'Apprentissage' }, match: ['apprenticeship'] },
 { key: 'tempo-determinato', labels: { it: 'Tempo determinato', en: 'Temporary', de: 'Befristet', fr: 'Temporaire' }, match: ['temporary'] },
 ];
 for (const [cityKey, cityName] of locationLeaders) {
 if (!cityKeys.has(cityKey)) continue;
 for (const ct of contractTypes) {
 const comboKey = `${cityKey}-${ct.key}`;
 const normCity = normalizeSearchTerm(cityKey);
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${ct.labels.it} a ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro ${ct.labels.it.toLowerCase()} a ${cityName}. Trova posizioni ${ct.labels.it.toLowerCase()} e candidati subito.`,
 heading: `Lavoro ${ct.labels.it} a ${cityName}`,
 },
 en: {
 title: `${ct.labels.en} jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${ct.labels.en.toLowerCase()} job openings in ${cityName}. Browse positions and apply today.`,
 heading: `${ct.labels.en} jobs in ${cityName}`,
 },
 de: {
 title: `${ct.labels.de} Jobs in ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} ${ct.labels.de}-Stellen in ${cityName}. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${ct.labels.de} Jobs in ${cityName}`,
 },
 fr: {
 title: `Emploi ${ct.labels.fr} à ${cityName} | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${ct.labels.fr.toLowerCase()} à ${cityName}. Consultez les postes et postulez.`,
 heading: `Emploi ${ct.labels.fr} à ${cityName}`,
 },
 }, (job) => {
 const loc = normalizeSearchTerm(job?.location || '');
 return loc.includes(normCity) && ct.match.includes(String(job?.contract || '').toLowerCase());
 });
 comboCount++;
 }
 }

 // 3) settore + Ticino combinations
 const sectorTypes: { key: string; category: string[]; labels: Record<'it' | 'en' | 'de' | 'fr', string> }[] = [
 { key: 'sanita', category: ['health', 'healthcare'], labels: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheitswesen', fr: 'Santé' } },
 { key: 'finanza', category: ['finance'], labels: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' } },
 { key: 'informatica', category: ['tech', 'technology'], labels: { it: 'Informatica', en: 'IT', de: 'Informatik', fr: 'Informatique' } },
 { key: 'vendita', category: ['sales'], labels: { it: 'Vendita', en: 'Sales', de: 'Verkauf', fr: 'Vente' } },
 { key: 'ingegneria', category: ['engineering'], labels: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' } },
 { key: 'amministrazione', category: ['admin', 'management', 'operations'], labels: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' } },
 { key: 'ristorazione', category: ['hospitality'], labels: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastronomie', fr: 'Restauration' } },
 { key: 'produzione', category: ['production', 'manufacturing', 'maintenance'], labels: { it: 'Produzione', en: 'Manufacturing', de: 'Produktion', fr: 'Production' } },
 { key: 'formazione', category: ['education', 'professor', 'researcher', 'phd'], labels: { it: 'Formazione', en: 'Education', de: 'Bildung', fr: 'Formation' } },
 { key: 'legale', category: ['legal'], labels: { it: 'Legale', en: 'Legal', de: 'Recht', fr: 'Juridique' } },
 { key: 'design', category: ['design'], labels: { it: 'Design', en: 'Design', de: 'Design', fr: 'Design' } },
 ];
 for (const sector of sectorTypes) {
 const comboKey = `${sector.key}-ticino`;
 const catSet = new Set(sector.category.map((c) => c.toLowerCase()));
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${sector.labels.it} in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro nel settore ${sector.labels.it.toLowerCase()} in Ticino. Scopri le posizioni aperte e candidati subito.`,
 heading: `Lavoro ${sector.labels.it} in Ticino`,
 },
 en: {
 title: `${sector.labels.en} jobs in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} ${sector.labels.en.toLowerCase()} job openings in Ticino. Browse available positions and apply today.`,
 heading: `${sector.labels.en} jobs in Ticino`,
 },
 de: {
 title: `${sector.labels.de} Jobs im Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offene ${sector.labels.de}-Stellen im Tessin. Entdecke aktuelle Positionen und bewirb dich direkt.`,
 heading: `${sector.labels.de} Jobs im Tessin`,
 },
 fr: {
 title: `Emploi ${sector.labels.fr} au Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${sector.labels.fr.toLowerCase()} au Tessin. Consultez les postes ouverts et postulez.`,
 heading: `Emploi ${sector.labels.fr} au Tessin`,
 },
 }, (job) => catSet.has(String(job?.category || '').toLowerCase()));
 comboCount++;
 }

 // 4) ruolo + Ticino combinations — from internal search demand
 // Users search for specific roles: Medico, Infermiere, Autista, Cuoco, Piastrellista, etc.
 const roleTypes: { key: string; match: RegExp; labels: Record<'it' | 'en' | 'de' | 'fr', string> }[] = [
 { key: 'medico', match: /\b(medic[oa]|arzt|doctor|médecin|assistente di studio medico|medical)\b/i, labels: { it: 'Medico', en: 'Doctor', de: 'Arzt', fr: 'Médecin' } },
 { key: 'infermiere', match: /\b(infermier[ea]|nurse|krankenpfleger|infirmier|pflege)\b/i, labels: { it: 'Infermiere', en: 'Nurse', de: 'Krankenpfleger', fr: 'Infirmier' } },
 { key: 'autista', match: /\b(autista|driver|fahrer|chauffeur|conducente)\b/i, labels: { it: 'Autista', en: 'Driver', de: 'Fahrer', fr: 'Chauffeur' } },
 { key: 'cuoco', match: /\b(cuoc[oa]|chef|koch|cuisinier|aiuto cuoco)\b/i, labels: { it: 'Cuoco', en: 'Chef', de: 'Koch', fr: 'Cuisinier' } },
 { key: 'piastrellista', match: /\b(piastrellista|tiler|plattenleger|carreleur|muratore|mason)\b/i, labels: { it: 'Piastrellista', en: 'Tiler', de: 'Plattenleger', fr: 'Carreleur' } },
 { key: 'elettricista', match: /\b(elettricista|electrician|elektriker|électricien)\b/i, labels: { it: 'Elettricista', en: 'Electrician', de: 'Elektriker', fr: 'Électricien' } },
 { key: 'vendita', match: /\b(vendit[oa]r[ei]|addett[oa] (alle )?vendite?|sales|verkäufer|vendeur|shop assistant|commess[oa])\b/i, labels: { it: 'Vendita', en: 'Sales', de: 'Verkauf', fr: 'Vente' } },
 { key: 'educatore', match: /\b(educator[ei]|educatric[ei]|educator|erzieher|éducateur)\b/i, labels: { it: 'Educatore', en: 'Educator', de: 'Erzieher', fr: 'Éducateur' } },
 { key: 'contabile', match: /\b(contabil[ei]|accountant|buchhalter|comptable|ragionier)\b/i, labels: { it: 'Contabile', en: 'Accountant', de: 'Buchhalter', fr: 'Comptable' } },
 { key: 'meccanico', match: /\b(meccanic[oa]|mechanic|mechaniker|mécanicien)\b/i, labels: { it: 'Meccanico', en: 'Mechanic', de: 'Mechaniker', fr: 'Mécanicien' } },
 ];
 for (const role of roleTypes) {
 const comboKey = `${role.key}-ticino`;
 if (searchLeaderMap.has(comboKey)) { comboCount++; continue; }
 generateComboPage(comboKey, {
 it: {
 title: `Lavoro ${role.labels.it} in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} offerte di lavoro come ${role.labels.it.toLowerCase()} in Ticino. Posizioni aggiornate ogni giorno, candidatura diretta.`,
 heading: `Lavoro come ${role.labels.it} in Ticino`,
 },
 en: {
 title: `${role.labels.en} jobs in Ticino | Frontaliere Ticino`,
 description: (c) => `${c} ${role.labels.en.toLowerCase()} job openings in Ticino. Updated daily, apply directly.`,
 heading: `${role.labels.en} jobs in Ticino`,
 },
 de: {
 title: `${role.labels.de} Jobs im Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offene ${role.labels.de}-Stellen im Tessin. Täglich aktualisiert, direkt bewerben.`,
 heading: `${role.labels.de} Jobs im Tessin`,
 },
 fr: {
 title: `Emploi ${role.labels.fr} au Tessin | Frontaliere Ticino`,
 description: (c) => `${c} offres d'emploi ${role.labels.fr.toLowerCase()} au Tessin. Mises à jour quotidiennes, postulez directement.`,
 heading: `Emploi ${role.labels.fr} au Tessin`,
 },
 }, (job) => {
 const title = normalizeSearchTerm([job?.title, job?.titleByLocale?.it].filter(Boolean).join(' '));
 return role.match.test(title);
 });
 comboCount++;
 }

 if (comboCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated combo search pages from ${comboCount} combinations`);
 }

 searchEntries = [editorialEntries, searchSitemapEntries.join('\n')].filter(Boolean).join('\n');
 if (searchPageCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${searchPageCount} search landing pages (stats + combos)`);
 }
 } else {
 searchEntries = editorialEntries;
 }

 // Generate sitemap with hreflang alternates for all locales
 const landingAlternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const landingEntry = ` <url>\n <loc>${BASE_URL}/cerca-lavoro-ticino/</loc>\n${landingAlternates}\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/cerca-lavoro-ticino/" />\n <lastmod>${dateStamp}</lastmod>\n <changefreq>daily</changefreq>\n <priority>0.9</priority>\n </url>`;

 // Filter out thin content jobs (<50 words IT description) from sitemap (FRO-278).
 // Also exclude jobs flagged `needsRetranslation` — per-locale alternates would
 // point at stale/auto-generated text and waste crawl budget until AI
 // retranslation completes (seo/sitemap-crawl-budget).
 const sitemapEligibleJobs = validJobs.filter((job) => {
 if ((job as any).needsRetranslation === true) return false;
 const desc = String((job as any).descriptionByLocale?.it || (job as any).description || '');
 const wordCount = desc.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
 return wordCount >= 50;
 });
 const jobEntries = sitemapEligibleJobs.map((job) => {
 const perLocaleSlugMap = {
 it: localizedSlug(job, 'it'),
 en: localizedSlug(job, 'en'),
 de: localizedSlug(job, 'de'),
 fr: localizedSlug(job, 'fr'),
 };
 const itPath = withSlash(`/${sectionByLocale.it}/${perLocaleSlugMap.it}`.replace(/\/+/g, '/'));
 const alternateLinks = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${perLocaleSlugMap[l]}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 const jobLastmod = job.crawledAt ? new Date(job.crawledAt).toISOString().slice(0, 10) : dateStamp;
 return ` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n${xDefault}\n <lastmod>${jobLastmod}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.6</priority>\n </url>`;
 }).join('\n');

 // FRO-SEO / seo/sitemap-crawl-budget: previousSlugs bridge pages are NOT
 // listed in the sitemap. Each bridge already emits `<link rel="canonical">`
 // pointing at the current slug, which is how Google consolidates signals —
 // enumerating 13k+ bridge URLs in the sitemap just multiplied crawl-budget
 // waste without adding a consolidation signal. We still render the bridge
 // HTML (see bridge generator below) so the old URL resolves, we just stop
 // advertising it in the sitemap.
 //
 // To re-enable the old behavior flip this flag to true; the generation code
 // below is kept intact so the opt-in path keeps working.
 const INCLUDE_PREV_SLUG_SITEMAP_ENTRIES = false;
 const prevSlugEntries: string[] = [];
 const prevSlugSitemapPaths = new Set<string>(); // dedup
 for (const job of (INCLUDE_PREV_SLUG_SITEMAP_ENTRIES ? sitemapEligibleJobs : [])) {
 const prevSlugsLegacy: string[] = Array.isArray((job as any).previousSlugs) ? (job as any).previousSlugs : [];
 const pslByLocale = (job as any).previousSlugsByLocale;
 // Identify locale-aware slugs so we can separate legacy-only
 const localeAwareAll = new Set<string>();
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s as string);
 }
 }
 const legacyOnly = prevSlugsLegacy.filter(s => !localeAwareAll.has(s));
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;

 const currentItSlug = localizedSlug(job, 'it');
 const currentItPath = withSlash(`/${sectionByLocale.it}/${currentItSlug}`.replace(/\/+/g, '/'));
 const canonicalAlternates = localeList.map((l) => {
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${localizedSlug(job, l)}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${currentItPath}" />`;
 const jobLastmod = job.crawledAt ? new Date(job.crawledAt).toISOString().slice(0, 10) : dateStamp;

 const addEntry = (ps: string, locale: 'it' | 'en' | 'de' | 'fr') => {
 const currentSlug = localizedSlug(job, locale);
 if (!ps || ps === currentSlug) return;
 if (!jobHtmlCache.has(`${locale}:${currentSlug}`)) return;
 const psRelPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${ps}`.replace(/\/+/g, '/').replace(/^\//, '');
 if (activeJobDirs.has(psRelPath)) return;
 if (prevSlugSitemapPaths.has(psRelPath)) return;
 prevSlugSitemapPaths.add(psRelPath);
 const psPath = withSlash(`/${psRelPath}`);
 prevSlugEntries.push(` <url>\n <loc>${BASE_URL}${psPath}</loc>\n${canonicalAlternates}\n${xDefault}\n <lastmod>${jobLastmod}</lastmod>\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`);
 };

 // Locale-specific previousSlugs → sitemap entry under their locale prefix
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const [locale, slugs] of Object.entries(pslByLocale)) {
 if (!Array.isArray(slugs) || !localeList.includes(locale as any)) continue;
 for (const ps of slugs as string[]) addEntry(ps, locale as typeof localeList[number]);
 }
 }
 // Legacy flat previousSlugs → sitemap entry under Italian path
 for (const ps of legacyOnly) addEntry(ps, 'it');
 }
 const prevSlugSitemap = prevSlugEntries.length > 0 ? '\n' + prevSlugEntries.join('\n') : '';

 // Company sitemap entries
 const companyEntries = [...companyMap.keys()].map((cSlug) => {
 const itSlug = `${companyRoutePrefix.it}-${cSlug}`;
 const itPath = withSlash(`/${sectionByLocale.it}/${itSlug}`.replace(/\/+/g, '/'));
 const alternateLinks = localeList.map((l) => {
 const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
 const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 return ` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n${xDefault}\n <lastmod>${dateStamp}</lastmod>\n <changefreq>weekly</changefreq>\n <priority>0.7</priority>\n </url>`;
 }).join('\n');

 const paginationSitemap = paginationSitemapEntries.length > 0 ? '\n' + paginationSitemapEntries.join('\n') : '';
 const categorySitemap = categorySitemapEntries.length > 0 ? '\n' + categorySitemapEntries.join('\n') : '';
 const keywordSitemap = keywordSitemapEntries.length > 0 ? '\n' + keywordSitemapEntries.join('\n') : '';
 const sitemapJobs = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${landingEntry}\n${companyEntries}\n${searchEntries}\n${jobEntries}${prevSlugSitemap}${paginationSitemap}${categorySitemap}${keywordSitemap}\n</urlset>\n`;
 fs.writeFileSync(np.join(distDir, 'sitemap-jobs.xml'), sitemapJobs, 'utf-8');

 const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexPath)) {
 let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
 if (!idx.includes('sitemap-jobs.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs.xml</loc>\n <lastmod>${dateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 } else {
 // Update existing lastmod for sitemap-jobs.xml
 idx = idx.replace(
 /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-jobs\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
 `$1${dateStamp}$2`
 );
 }
 fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
 }

 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${validJobs.length * 4} localized job pages and sitemap-jobs.xml (${prevSlugEntries.length} previousSlug entries)`);

 /* ── Expired-job soft-landing pages ────────────────────────── */
 // 1. Read tracking file + merge current jobs
 const trackingPath = np.resolve(rootDir, 'data/all-known-job-slugs.json');
 let tracking: Record<string, Record<string, string>> = {};
 try {
 tracking = JSON.parse(fs.readFileSync(trackingPath, 'utf-8'));
 } catch { /* file missing or malformed — start fresh */ }

 const currentSlugs = new Set<string>();
 // Collect slug values that differ from slugByLocale.it — these are legacy
 // identifier slugs that no longer have an active page at that path. They
 // should be treated as previous slugs (bridge pages), not as current.
 const implicitPreviousSlugs: { job: typeof validJobs[0]; slug: string }[] = [];
 for (const job of validJobs) {
 const itSlug = localizedSlug(job, 'it');
 // Only add job.slug to currentSlugs if it matches the actual IT page slug.
 // When they differ, the old slug needs a bridge page, not exclusion.
 if (job.slug === itSlug) {
 currentSlugs.add(job.slug);
 } else {
 // job.slug is a legacy identifier — treat as implicit previous slug
 // so it gets a bridge page pointing to the current URL
 implicitPreviousSlugs.push({ job, slug: job.slug });
 }
 // Also mark all localized slugs as "current" so they aren't treated as
 // expired when they appear as orphan tracking keys. Without this, a
 // German master slug that differs from the IT localizedSlug can end up
 // generating a thin expired soft-landing at the master-slug path.
 for (const locale of localeList) {
 const ls = localizedSlug(job, locale);
 if (ls) currentSlugs.add(ls);
 }
 if (!tracking[job.slug]) {
 tracking[job.slug] = {};
 for (const locale of localeList) {
 const relPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/');
 tracking[job.slug][locale] = relPath;
 }
 }
 }
 // Remove search combo slugs from tracking — these are handled by the search
 // combo section, not the job crawler pipeline. They were incorrectly imported
 // from orphan-indexed-job-slugs.json in previous builds.
 const searchComboPattern = /^(?:search|ricerca|suche|recherche)-/;
 let searchCombosRemoved = 0;
 for (const key of Object.keys(tracking)) {
 if (searchComboPattern.test(key) && !currentSlugs.has(key)) {
 delete tracking[key];
 searchCombosRemoved++;
 }
 }
 if (searchCombosRemoved > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Cleaned ${searchCombosRemoved} search combo slugs from tracking`);
 }
 fs.writeFileSync(trackingPath, JSON.stringify(tracking, null, 2) + '\n', 'utf-8');

 // 1b. Merge orphan indexed slugs (GSC-indexed URLs with no matching job)
 // into the tracking so they get soft-landing pages too.
 const orphanSlugsPath = np.resolve(rootDir, 'data/orphan-indexed-job-slugs.json');
 try {
 const orphanSlugs: (string | { locale: string; path: string })[] = JSON.parse(fs.readFileSync(orphanSlugsPath, 'utf-8'));
 if (Array.isArray(orphanSlugs)) {
 let orphansMerged = 0;
 for (const entry of orphanSlugs) {
 if (!entry) continue;
 if (typeof entry === 'string') {
 // Legacy format: IT-only slug string
 if (tracking[entry]) continue;
 // Skip search combo pages (ricerca-*, search-*, etc.)
 if (/^(?:search|ricerca|suche|recherche)-/.test(entry)) continue;
 tracking[entry] = { it: `/cerca-lavoro-ticino/${entry}` };
 } else if (typeof entry === 'object' && entry.locale && entry.path) {
 // Locale-aware format: { locale: "de", path: "/de/jobs-im-tessin/..." }
 // Key = last path segment (the slug), value = { [locale]: path }
 const cleanPath = entry.path.replace(/\/+$/, ''); // strip trailing slash
 const slug = cleanPath.split('/').pop()!;
 if (!slug) continue;
 // Skip search combo pages — these are generated by the search section,
 // not by the job crawler pipeline. Importing them as orphan jobs would
 // create duplicate pages and confuse the flat-file generation.
 if (/^(?:search|ricerca|suche|recherche)-/.test(slug)) continue;
 if (!tracking[slug]) tracking[slug] = {};
 (tracking[slug] as Record<string, string>)[entry.locale] = cleanPath;
 } else {
 continue;
 }
 orphansMerged++;
 }
 if (orphansMerged > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${orphansMerged} orphan GSC slugs into expired tracking`);
 }
 }
 } catch { /* file missing — skip */ }

 // 1b2. Merge GSC 404 compat paths into tracking so they get soft-landing pages
 // instead of thin "Pagina archiviata" pages from legacyRedirectsPlugin.
 // The compat file is a manual GSC export; the orphan pipeline now subsumes it.
 // Handles all locales: IT (/cerca-lavoro-ticino/), DE (/de/jobs-im-tessin/), FR (/fr/trouver-emploi-tessin/)
 const compatPathsFile = np.resolve(rootDir, 'data/seo-404-compat-paths.json');
 try {
 const compatData = JSON.parse(fs.readFileSync(compatPathsFile, 'utf-8'));
 const compatPaths: string[] = Array.isArray(compatData?.paths) ? compatData.paths : [];
 let compatAdded = 0;
 const COMPAT_JOB_PATTERNS: { re: RegExp; locale: string; prefix: string }[] = [
 { re: /\/cerca-lavoro-ticino\/([^/]+)\/?$/, locale: 'it', prefix: '/cerca-lavoro-ticino/' },
 { re: /\/en\/find-jobs?-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
 { re: /\/en\/job-search-ticino\/([^/]+)\/?$/, locale: 'en', prefix: '/en/find-jobs-ticino/' },
 { re: /\/de\/jobs-im-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
 { re: /\/de\/jobsuche-tessin\/([^/]+)\/?$/, locale: 'de', prefix: '/de/jobs-im-tessin/' },
 { re: /\/fr\/trouver-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
 { re: /\/fr\/recherche-emploi-tessin\/([^/]+)\/?$/, locale: 'fr', prefix: '/fr/trouver-emploi-tessin/' },
 ];
 const SKIP_PREFIX_RE = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
 for (const p of compatPaths) {
 const raw = String(p || '');
 for (const { re, locale, prefix } of COMPAT_JOB_PATTERNS) {
 const m = raw.match(re);
 if (!m) continue;
 const slug = m[1];
 if (!slug || SKIP_PREFIX_RE.test(slug)) break;
 if (!tracking[slug]) tracking[slug] = {};
 if ((tracking[slug] as Record<string, string>)[locale]) break; // locale path already known
 (tracking[slug] as Record<string, string>)[locale] = `${prefix}${slug}`;
 compatAdded++;
 break;
 }
 }
 if (compatAdded > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${compatAdded} GSC-404 compat job paths into expired tracking`);
 }
 } catch { /* file missing — skip */ }

 // 1c. Load enriched data for orphan slugs (GSC queries + translation cache titles/descriptions)
 const orphanEnrichedPath = np.resolve(rootDir, 'data/orphan-enriched-data.json');
 interface OrphanEnriched {
 queries?: string[];
 totalImpressions?: number;
 totalClicks?: number;
 topQuery?: string | null;
 title?: string;
 titleByLocale?: Record<string, string>;
 descriptionByLocale?: Record<string, string>;
 company?: string;
 companyKey?: string;
 location?: string;
 sector?: string;
 salaryMin?: number;
 salaryCurrency?: string;
 slugByLocale?: Record<string, string>;
 localePaths?: Record<string, string>;
 sourceUrl?: string;
 }
 const orphanGscData = new Map<string, OrphanEnriched>();
 try {
 const enrichedArr: any[] = JSON.parse(fs.readFileSync(orphanEnrichedPath, 'utf-8'));
 let withQueries = 0;
 let withContent = 0;
 for (const entry of enrichedArr) {
 if (!entry?.slug) continue;
 const data: OrphanEnriched = {};
 if (entry.queries?.length > 0) {
 data.queries = entry.queries;
 data.totalImpressions = entry.totalImpressions || 0;
 data.totalClicks = entry.totalClicks || 0;
 data.topQuery = entry.topQuery || null;
 withQueries++;
 }
 if (entry.title) data.title = entry.title;
 if (entry.titleByLocale) data.titleByLocale = entry.titleByLocale;
 if (entry.descriptionByLocale && Object.keys(entry.descriptionByLocale).length > 0) {
 data.descriptionByLocale = entry.descriptionByLocale;
 withContent++;
 }
 if (entry.company) data.company = entry.company;
 if (entry.companyKey) data.companyKey = entry.companyKey;
 if (entry.location) data.location = entry.location;
 if (entry.sector) data.sector = entry.sector;
 if (entry.salaryMin) data.salaryMin = entry.salaryMin;
 if (entry.salaryCurrency) data.salaryCurrency = entry.salaryCurrency;
 if (entry.slugByLocale) data.slugByLocale = entry.slugByLocale;
 if (entry.localePaths) data.localePaths = entry.localePaths;
 if (entry.sourceUrl) data.sourceUrl = entry.sourceUrl;
 if (Object.keys(data).length > 0) orphanGscData.set(entry.slug, data);
 }
 if (orphanGscData.size > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Loaded enrichment for ${orphanGscData.size} orphan slugs (${withQueries} with GSC queries, ${withContent} with full content)`);
 }
 } catch { /* file missing — skip */ }

 // 2. Load expired job data for rich content (previousSlugs, title, company, etc.)
 const expiredJobsPath = np.resolve(rootDir, 'data/expired-jobs.json');
 let expiredJobsData: any[] = [];
 try {
 expiredJobsData = JSON.parse(fs.readFileSync(expiredJobsPath, 'utf-8'));
 if (!Array.isArray(expiredJobsData)) expiredJobsData = [];
 } catch { /* no expired data */ }
 const expiredBySlug = new Map<string, any>();
 for (const ej of expiredJobsData) {
 if (ej.slug) expiredBySlug.set(ej.slug, ej);
 // Also index previousSlugs so renamed-then-deleted jobs get enriched soft-landing pages
 if (Array.isArray(ej.previousSlugs)) {
 for (const ps of ej.previousSlugs) {
 if (ps && !expiredBySlug.has(ps)) expiredBySlug.set(ps, ej);
 }
 }
 // Also index previousSlugsByLocale entries
 if (ej.previousSlugsByLocale && typeof ej.previousSlugsByLocale === 'object') {
 for (const arr of Object.values(ej.previousSlugsByLocale)) {
 if (Array.isArray(arr)) {
 for (const ps of arr as string[]) {
 if (ps && !expiredBySlug.has(ps)) expiredBySlug.set(ps, ej);
 }
 }
 }
 }
 }

 // FRO-343: Load swiss-postal-codes for postalCode enrichment of soft-landing pages
 let plzLookup: Record<string, string> = {};
 const plzPath = np.resolve(rootDir, 'data', 'swiss-postal-codes.json');
 if (fs.existsSync(plzPath)) {
 try { plzLookup = JSON.parse(fs.readFileSync(plzPath, 'utf-8')); } catch { /* ok */ }
 }

 // 3. Generate soft-landing pages for expired slugs
 // Pre-build a set of all previousSlugs from active jobs so we can exclude them from
 // expiredSlugs. These slugs will be handled as bridge pages (canonical → new URL) and
 // must NOT appear in the expired sitemap (which would cause validate-canonical failures
 // because bridge HTML has a non-self canonical). The all-writes-are-queued pattern means
 // fs.existsSync cannot guard against the bridge page overwriting the expired HTML, so
 // the cleanest fix is to exclude bridge slugs from expiredSlugs entirely.
 const bridgeSlugSet = new Set<string>();
 // Helper: collect all previous slugs from both formats (defined early so the
 // fuzzy-match step below can use it to check "already known" slugs).
 const _allPrevSlugs = (j: any): string[] => {
 const all = new Set<string>(Array.isArray(j.previousSlugs) ? j.previousSlugs : []);
 if (j.previousSlugsByLocale && typeof j.previousSlugsByLocale === 'object') {
 for (const arr of Object.values(j.previousSlugsByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) all.add(s);
 }
 }
 return [...all];
 };

 /* ── Fuzzy match orphan slugs to active jobs ─────────────────── */
 // When a company rebrand or title rewrite causes a slug to change, only the
 // locale that triggered regeneration records the old slug in previousSlugsByLocale.
 // The sibling locales' old slugs (which Google may still have indexed) become
 // orphans that fall through to the self-healing "offerta aggiornata" page.
 // Scan `tracking` (merged active + orphan + compat paths) and for each slug
 // not already attached to any active job, score it against every active job's
 // slugByLocale via token overlap. If the best match is confident enough
 // (>=60% token overlap AND ≥3 shared tokens), inject it into that job's
 // previousSlugsByLocale so the downstream bridge + cross-locale blocks
 // generate a full-content reconciliation page.
 const knownSlugs = new Set<string>();
 for (const j of validJobs) {
 if (j.slug) knownSlugs.add(j.slug);
 if (j.slugByLocale) for (const s of Object.values(j.slugByLocale)) if (typeof s === 'string' && s) knownSlugs.add(s);
 for (const s of _allPrevSlugs(j)) knownSlugs.add(s);
 }
 const tokenize = (s: string): string[] => s.split('-').filter(t => t.length >= 3);
 // Index active jobs by every token that appears in any of their slugs so we
 // can quickly find candidates for a given orphan slug (avoids O(orphan × jobs)).
 const jobsByToken = new Map<string, Set<number>>();
 validJobs.forEach((j, idx) => {
 const sbl = (j as any).slugByLocale || {};
 const allJobSlugs = [
 ...Object.values(sbl).filter((s): s is string => typeof s === 'string' && s.length > 0),
 j.slug,
 ].filter(Boolean) as string[];
 const tokens = new Set<string>();
 for (const s of allJobSlugs) for (const t of tokenize(s)) tokens.add(t);
 for (const t of tokens) {
 if (!jobsByToken.has(t)) jobsByToken.set(t, new Set());
 jobsByToken.get(t)!.add(idx);
 }
 });
 const SKIP_PREFIX_FUZZY = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;
 let fuzzyMatched = 0;
 for (const orphanSlug of Object.keys(tracking)) {
 if (knownSlugs.has(orphanSlug)) continue;
 if (SKIP_PREFIX_FUZZY.test(orphanSlug)) continue;
 const orphanTokens = tokenize(orphanSlug);
 if (orphanTokens.length < 4) continue;
 // Candidate jobs share at least one token with the orphan slug
 const candidateIdx = new Map<number, number>();
 for (const t of orphanTokens) {
 const idxSet = jobsByToken.get(t);
 if (!idxSet) continue;
 for (const i of idxSet) candidateIdx.set(i, (candidateIdx.get(i) || 0) + 1);
 }
 if (candidateIdx.size === 0) continue;
 // Score only candidates that share ≥3 tokens with the orphan (coarse filter)
 let best: { job: any; locale: string; score: number; shared: number } | null = null;
 for (const [idx, shared] of candidateIdx) {
 if (shared < 3) continue;
 const cand = validJobs[idx];
 const sbl = (cand as any).slugByLocale || {};
 for (const locale of localeList) {
 const candSlug = sbl[locale] || cand.slug || '';
 if (!candSlug) continue;
 const candTokens = new Set(tokenize(candSlug));
 if (candTokens.size === 0) continue;
 const inter = orphanTokens.filter(t => candTokens.has(t)).length;
 const score = inter / Math.max(orphanTokens.length, candTokens.size);
 if (!best || score > best.score) best = { job: cand, locale, score, shared: inter };
 }
 }
 if (!best || best.score < 0.6 || best.shared < 3) continue;
 const target = best.job as { previousSlugsByLocale?: Record<string, string[]> };
 if (!target.previousSlugsByLocale) target.previousSlugsByLocale = {};
 const arr = target.previousSlugsByLocale[best.locale] || (target.previousSlugsByLocale[best.locale] = []);
 if (!arr.includes(orphanSlug)) {
 arr.push(orphanSlug);
 knownSlugs.add(orphanSlug);
 fuzzyMatched++;
 }
 }
 if (fuzzyMatched > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Fuzzy-matched ${fuzzyMatched} orphan slugs to active jobs as implicit previousSlugs`);
 }

 // Collect IT paths of all previous slugs so we can also exclude their
 // locale-variant tracking keys (e.g. EN/DE/FR slug for the same old job).
 // The tracking file stores one key per locale slug, all pointing to the
 // same IT path, so we must group by IT path to catch them all.
 const bridgeItPaths = new Set<string>();
 for (const job of validJobs) {
 for (const s of _allPrevSlugs(job)) {
 bridgeSlugSet.add(s);
 const itPath = (tracking[s] as any)?.it;
 if (itPath) bridgeItPaths.add(itPath);
 }
 }
 // Add implicit previous slugs (job.slug ≠ slugByLocale.it) to bridge set
 // and ensure they're in previousSlugsByLocale for bridge page generation
 for (const { job, slug } of implicitPreviousSlugs) {
 bridgeSlugSet.add(slug);
 // Write to locale-aware field (IT locale since these are master slug mismatches)
 if (!(job as any).previousSlugsByLocale) (job as any).previousSlugsByLocale = {};
 if (!Array.isArray((job as any).previousSlugsByLocale.it)) (job as any).previousSlugsByLocale.it = [];
 if (!(job as any).previousSlugsByLocale.it.includes(slug)) {
 (job as any).previousSlugsByLocale.it.push(slug);
 }
 // Also keep legacy flat array in sync
 if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
 if (!job.previousSlugs.includes(slug)) job.previousSlugs.push(slug);
 // Ensure tracking has this slug with correct locale paths
 if (!tracking[slug]) {
 tracking[slug] = {
 it: `/${sectionByLocale.it}/${slug}`,
 en: `/en/${sectionByLocale.en}/${slug}`,
 de: `/de/${sectionByLocale.de}/${slug}`,
 fr: `/fr/${sectionByLocale.fr}/${slug}`,
 };
 }
 }
 // FRO-SEO: Build a set of actual FILE PATHS that bridge pages will claim.
 // Previously we excluded entire tracking keys whose IT path matched any bridge
 // IT path. This was too aggressive: locale-variant keys (EN/DE/FR slug →
 // same IT path) have DIFFERENT translated locale paths that don't conflict
 // with bridge pages (which use the IT slug for all locales). The old approach
 // created a "dead zone" of ~1,700 tracking keys with NO pages generated.
 // Now we exclude only the specific locale paths that actually conflict.
 const bridgeClaimedPaths = new Set<string>();
 for (const job of validJobs) {
 for (const oldSlug of _allPrevSlugs(job)) {
 if (!oldSlug) continue;
 for (const locale of localeList) {
 const p = `${localePrefix[locale]}/${sectionByLocale[locale]}/${oldSlug}`.replace(/\/+/g, '/');
 bridgeClaimedPaths.add(p);
 }
 }
 }
 for (const { slug } of implicitPreviousSlugs) {
 for (const locale of localeList) {
 const p = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
 bridgeClaimedPaths.add(p);
 }
 }
 // Include ALL tracking keys except direct bridge slugs. Keys that happen to
 // match a currentSlug value are included because their locale paths may differ
 // from the active job's paths — writeSoftLandingPage already skips paths
 // where active or bridge pages exist (via _writtenPaths / activeJobDirs).
 const expiredSlugs = Object.keys(tracking).filter((s) => !bridgeSlugSet.has(s));

 const expiredBannerCopy: Record<string, { title: string; banner: string }> = {
 it: { title: 'Offerta non più disponibile', banner: 'Questa posizione non è più attiva. Di seguito trovi i dettagli originali e posizioni simili.' },
 en: { title: 'Job no longer available', banner: 'This position is no longer active. Below you\'ll find the original details and similar positions.' },
 de: { title: 'Stelle nicht mehr verfügbar', banner: 'Diese Position ist nicht mehr aktiv. Nachfolgend finden Sie die Originaldetails und ähnliche Stellen.' },
 fr: { title: 'Offre non disponible', banner: 'Ce poste n\'est plus actif. Vous trouverez ci-dessous les détails originaux et des postes similaires.' },
 };
 const archiveRelatedLabel: Record<string, string> = {
 it: 'Posizioni aperte simili in Ticino',
 en: 'Similar open positions in Ticino',
 de: 'Ähnliche offene Stellen im Tessin',
 fr: 'Postes similaires ouverts au Tessin',
 };
 const archiveCtaLabel: Record<string, string> = {
 it: 'Tutte le offerte di lavoro in Ticino',
 en: 'All job openings in Ticino',
 de: 'Alle offenen Stellen im Tessin',
 fr: 'Toutes les offres d\'emploi au Tessin',
 };
 const hashCode = (s: string) => {
 let h = 0;
 for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
 return h;
 };


 // --- extractInfoFromSlug: de-slugify orphan slugs to recover title/company/location ---
 // Build lookup tables for matching
 const adapterDir = np.resolve(rootDir, 'data/jobs-crawler-adapters/adapters');
 const companySlugMap: { slug: string; name: string }[] = [];
 const seenCompanySlugs = new Set<string>();
 try {
 for (const f of fs.readdirSync(adapterDir).filter((n: string) => n.endsWith('.json'))) {
 const d = JSON.parse(fs.readFileSync(np.join(adapterDir, f), 'utf-8'));
 const name = d.companyName || d.company || '';
 if (!name) continue;
 const adapterSlug = f.replace('.json', '');
 companySlugMap.push({ slug: adapterSlug, name });
 seenCompanySlugs.add(adapterSlug);
 // Also generate a slugified version of the company name for matching
 // e.g. "FART – Ferrovie Autolinee Regionali Ticinesi" → "fart-ferrovie-autolinee-regionali-ticinesi"
 const nameSlug = name
 .toLowerCase()
 .replace(/[–—]/g, '-')
 .replace(/[()]/g, '')
 .replace(/[^a-z0-9\s-]/g, '')
 .replace(/\s+/g, '-')
 .replace(/-{2,}/g, '-')
 .replace(/^-|-$/g, '');
 if (nameSlug && nameSlug !== adapterSlug && !seenCompanySlugs.has(nameSlug)) {
 companySlugMap.push({ slug: nameSlug, name });
 seenCompanySlugs.add(nameSlug);
 }
 }
 } catch { /* adapters dir missing */ }
 // Also include companies from active jobs (covers crawlers without adapters)
 for (const job of validJobs) {
 const key = String(job.companyKey || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
 if (key && !seenCompanySlugs.has(key)) {
 companySlugMap.push({ slug: key, name: job.company });
 seenCompanySlugs.add(key);
 }
 }
 // Sort by slug length descending for longest-match-first
 companySlugMap.sort((a, b) => b.slug.length - a.slug.length);

 // Location names from swiss-postal-codes.json (key=locationName, value=postalCode)
 const locationNames = Object.keys(plzLookup).sort((a, b) => b.length - a.length);
 // Slugified location names for matching (e.g. "riva san vitale" -> "riva-san-vitale")
 const locationSlugPairs = locationNames.map(name => ({
 name,
 slug: name.toLowerCase().replace(/\s+/g, '-'),
 postalCode: plzLookup[name],
 }));

 // Common Italian/English stop words and gender markers to strip from de-slugified titles
 const slugStopFragments = new Set([
 'm-f', 'f-m', 'm-w', 'f-m-d', 'm-w-d', 'm-f-d', 'w-m-d', 'w-m',
 '100', '80', '60', '80-100', '60-100', '60-80',
 'afc', 'cfp', 'a', 'o', 'e',
 'm', 'f', 'd', 'w', // standalone gender markers (after company slug removal splits "m-f-d")
 ]);

 const extractInfoFromSlug = (slug: string): { title: string; company: string; companyKey: string; location: string; postalCode: string } => {
 let remaining = slug;
 let company = '';
 let companyKey = '';
 let location = '';
 let postalCode = '';

 // 1. Match company (longest slug match first, word-boundary aware)
 // Use regex with hyphen/start/end boundaries to prevent false positives
 // e.g. "a-group" must not match inside "prada-group"
 for (const c of companySlugMap) {
 const escaped = c.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const re = new RegExp(`(?:^|-)${escaped}(?:-|$)`);
 if (re.test(remaining)) {
 company = c.name;
 companyKey = c.slug;
 remaining = remaining.replace(re, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
 break;
 }
 }

 // 2. Match location (longest name match first, at end of slug preferred)
 for (const loc of locationSlugPairs) {
 if (remaining.endsWith(loc.slug) || remaining.endsWith('-' + loc.slug)) {
 location = loc.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
 postalCode = loc.postalCode;
 remaining = remaining.replace(new RegExp('-?' + loc.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
 break;
 }
 // Also check if location appears mid-slug (common for e.g. "coop-mezzovico")
 if (!location && remaining.includes('-' + loc.slug + '-')) {
 location = loc.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
 postalCode = loc.postalCode;
 remaining = remaining.replace('-' + loc.slug + '-', '-').replace(/^-+|-+$/g, '');
 }
 }

 // Also check broader Swiss locations not in Ticino PLZ
 if (!location) {
 const broadLocations: Record<string, string> = {
 'grigioni': 'Grigioni', 'graubunden': 'Graubünden', 'st-moritz': 'St. Moritz',
 'coira': 'Coira', 'chur': 'Chur', 'davos': 'Davos', 'berna': 'Berna',
 'zurigo': 'Zurigo', 'zurich': 'Zürich', 'basilea': 'Basilea', 'ginevra': 'Ginevra',
 'losanna': 'Losanna', 'lucerna': 'Lucerna', 'anniviers': 'Anniviers',
 'domat-ems': 'Domat/Ems', 'svizzera': '', // generic, don't use as location
 };
 for (const [locSlug, locName] of Object.entries(broadLocations)) {
 if (locName && (remaining.endsWith(locSlug) || remaining.endsWith('-' + locSlug))) {
 location = locName;
 remaining = remaining.replace(new RegExp('-?' + locSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
 break;
 }
 }
 }

 // 3. Clean up remaining to form the title
 // Remove leading number prefixes (e.g. "1-addetto" -> "addetto")
 remaining = remaining.replace(/^\d+-/, '');
 // Remove stop fragments
 const parts = remaining.split('-').filter(p => p && !slugStopFragments.has(p));
 // De-slugify: capitalize first word, join with spaces
 const title = parts
 .join(' ')
 .replace(/amp\s/g, '& ') // decode &amp; in slugs
 .replace(/\bdot\b/g, '.') // decode dots
 .replace(/^./, c => c.toUpperCase())
 .trim();

 return { title: title || slug, company, companyKey, location, postalCode };
 };

 let expiredCount = 0;
 let legacyCount = 0;
 const expiredSitemapEntries: string[] = [];

 // Pre-compute invariant HTML fragments for soft-landing pages (~69K pages).
 // Avoids re-building the same ~2KB of boilerplate for each page.
 const currentYear = new Date().getFullYear();
 const darkModeScript = `<script>(function(){if(localStorage.theme==='dark'||((!('theme' in localStorage))&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}})()</script>`;
 const darkModeStyles = `<style>
 .dark body{background:#0f172a;color:#e2e8f0}
 .dark .ft-static-nav{background:rgba(15,23,42,.7);border-color:rgba(30,41,59,.5)}
 .dark .ft-static-nav a{color:#93c5fd}
 .dark .ft-static-article{color:#e2e8f0}
 .dark .ft-static-article a{color:#818cf8}
 .dark .ft-static-footer{background:rgba(15,23,42,.5);border-color:rgba(30,41,59,1);color:#94a3b8}
 .dark .ft-static-footer a{color:#93c5fd}
 </style>`;
 const navSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="28" height="28"><rect x="10" y="10" width="80" height="80" rx="16" fill="#1e293b"/><rect x="22" y="22" width="56" height="20" rx="4" fill="#94a3b8"/><rect x="22" y="52" width="24" height="24" rx="6" fill="#dc2626"/><path d="M34 58v12M28 64h12" stroke="white" stroke-width="3" stroke-linecap="round"/><mask id="m"><rect x="54" y="52" width="24" height="24" rx="6" fill="white"/></mask><g mask="url(#m)"><rect x="54" y="52" width="8" height="24" fill="#16a34a"/><rect x="62" y="52" width="8" height="24" fill="white"/><rect x="70" y="52" width="8" height="24" fill="#dc2626"/></g></svg>`;
 const spaBundleCss = hasSpaBundle ? `\n <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all" data-clarity-unmask="true">` : '';
 const spaBundleJs = hasSpaBundle ? `\n <script type="module" crossorigin src="/assets/${entryJs}"></script>` : '';
 // Per-locale pre-built nav + footer (only 4 strings to cache)
 const localeShells = Object.fromEntries(localeList.map(l => {
 const lp = `${localePrefix[l]}/${sectionByLocale[l]}/`.replace(/\/+/g, '/');
 const sectionLink = `${BASE_URL}${lp}`;
 const sectionName = esc(localeCopy[l].sectionName);
 const nav = `<nav class="ft-static-nav" aria-label="Navigazione principale" style="position:sticky;top:0;z-index:50;background:rgba(255,255,255,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(226,232,240,.5);box-shadow:0 1px 2px rgba(0,0,0,.05);padding:0 16px">
 <div style="max-width:2400px;width:95%;margin:0 auto;display:flex;align-items:center;height:56px;gap:12px">
 <a href="${BASE_URL}/" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:#2563eb;font-weight:700;font-size:15px;font-family:system-ui,sans-serif">
 ${navSvg}
 Frontaliere Ticino
 </a>
 <span style="flex:1"></span>
 <a href="${sectionLink}" style="font-size:13px;color:#4f46e5;text-decoration:none;font-family:system-ui,sans-serif">${sectionName}</a>
 </div>
 </nav>`;
 const footer = `<footer class="ft-static-footer" style="border-top:1px solid rgba(226,232,240,.6);background:rgba(255,255,255,.5);padding:24px 16px;margin-top:auto;font-family:system-ui,sans-serif;font-size:13px;color:#64748b;text-align:center">
 <div style="max-width:1280px;margin:0 auto">
 &copy; ${currentYear} <a href="${BASE_URL}/" style="color:#4f46e5;text-decoration:none">Frontaliere Ticino</a> &mdash;
 <a href="${sectionLink}" style="color:#4f46e5;text-decoration:none">${sectionName}</a>
 </div>
 </footer>`;
 return [l, { nav, footer, listingPath: lp }];
 }));

 // Assembler: builds a complete soft-landing HTML page from pre-computed parts + dynamic slots
 const buildSoftLandingHtml = (locale: string, pageTitle: string, pageDesc: string, robotsTag: string,
 selfUrl: string, hreflangLinks: string, jsonLdScripts: string, expiredWindowData: string,
 staticBodyJson: string, staticBody: string): string => {
 const shell = localeShells[locale];
 return `<!DOCTYPE html>
<html lang="${locale}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 ${FAVICON_LINKS}
 <title>${pageTitle}</title>
 <meta name="description" content="${pageDesc}">${robotsTag}
 <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
 <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
 <link rel="canonical" href="${selfUrl}">
${hreflangLinks}
 ${darkModeScript}
 ${darkModeStyles}
 ${jsonLdScripts}
 <script>window.__EXPIRED_JOB_DATA__=${expiredWindowData};window.__STATIC_BODY_HTML__=${staticBodyJson};</script>${spaBundleCss}
 ${SPA_ACTION_REDIRECT_SCRIPT}
 ${GTAG_SNIPPET}
 </head>
 <body>
 <div id="root">
 ${shell.nav}
 <article class="ft-static-article" style="max-width:1280px;margin:0 auto;padding:24px 16px;font-family:system-ui,sans-serif;color:#334155;">
 ${staticBody}
 </article>
 ${shell.footer}
 </div>${spaBundleJs}
 </body>
</html>`;
 };
 const writeSoftLandingPage = (outRelPath: string, html: string) => {
 // Normalize: strip trailing slashes to prevent flat files like ".html" (hidden files)
 const normPath = outRelPath.replace(/\/+$/, '');
 // Never overwrite ANY page already written by an earlier phase
 // (active jobs, company pages, search pages, editorial pages)
 const targetFile = np.join(distDir, normPath, 'index.html');
 if (_writtenPaths.has(targetFile)) return;
 if (activeJobDirs.has(normPath)) return;

 const outDir = np.join(distDir, normPath);
 _qw(np.join(outDir, 'index.html'), html);
 const flatFile = np.join(distDir, normPath + '.html');
 _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 };

 // Pre-compute company → active jobs lookup (O(1) instead of O(n) per expired page)
 const companyActiveJobsMap = new Map<string, any[]>();
 for (const j of validJobs) {
 const key = String(j.company || '').toLowerCase();
 if (!key) continue;
 const arr = companyActiveJobsMap.get(key);
 if (arr) { if (arr.length < 5) arr.push(j); }
 else companyActiveJobsMap.set(key, [j]);
 }
 // Pre-compute deterministic "recent jobs" pools: 20 jobs pre-sorted,
 // then select 5 per expired slug via modular index (avoids O(n log n) sort per page)
 const recentJobPool = validJobs.slice(0, Math.min(50, validJobs.length));
 const selectRecentJobs = (seed: string, exclude: string) => {
 const h = hashCode(seed);
 const result: any[] = [];
 for (let i = 0; i < recentJobPool.length && result.length < 5; i++) {
 const idx = (h + i * 7) % recentJobPool.length;
 const j = recentJobPool[idx];
 if (j.slug !== exclude && !result.includes(j)) result.push(j);
 }
 return result;
 };

 // Cache soft-landing HTML per (locale, slug) so the cross-locale
 // reconciliation pass below can reuse it instead of re-rendering.
 // Only cache slugs that actually need it — jobs from expired-jobs.json
 // whose slugByLocale has divergent values across locales — otherwise
 // we'd pin ~18k HTML strings (~550MB) in memory for no benefit.
 const expiredSoftLandingCache = new Map<string, string>();
 const expiredCacheKeys = new Set<string>();
 for (const ej of expiredJobsData) {
 const sbl = (ej && ej.slugByLocale) as Record<string, string> | undefined;
 if (!sbl || typeof sbl !== 'object') continue;
 const distinct = new Set(Object.values(sbl).filter(Boolean));
 if (distinct.size < 2) continue;
 for (const loc of localeList) {
 const s = sbl[loc];
 if (s) expiredCacheKeys.add(`${loc}:${s}`);
 }
 }

 for (const slug of expiredSlugs) {
 const paths = tracking[slug];
 const ejData = expiredBySlug.get(slug);

 // For orphan slugs with no ejData, extract info from the slug itself
 const slugInfo = !ejData?.title ? extractInfoFromSlug(slug) : null;

 // Build hreflang alternates for this expired slug (x-default → IT version)
 const hreflangLinks = [
 ...localeList.map((l) => {
 const p = paths[l];
 if (!p) return '';
 return ` <link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}">`;
 }).filter(Boolean),
 ...(paths.it ? [` <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(paths.it)}">`] : []),
 ].join('\n');

 // Track IT page word count for sitemap inclusion decision
 let itBodyWordCount = 0;

 for (const locale of localeList) {
 const relPath = paths[locale];
 if (!relPath) continue;
 // Skip paths claimed by bridge pages to avoid canonical conflicts
 if (bridgeClaimedPaths.has(relPath)) continue;
 const selfUrl = `${BASE_URL}${withSlash(relPath)}`;
 const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/`.replace(/\/+/g, '/');
 const copy = expiredBannerCopy[locale] ?? expiredBannerCopy.it;

 // Rich content fallback chain: expired-jobs.json → orphan enriched data → slug extraction
 const gscInfo = orphanGscData.get(slug);
 const jobTitle = String(ejData?.titleByLocale?.[locale] || ejData?.title || gscInfo?.titleByLocale?.[locale] || gscInfo?.title || slugInfo?.title || copy.title);
 const jobCompany = String(ejData?.company || gscInfo?.company || slugInfo?.company || '');
 const jobLocation = String(ejData?.location || ejData?.addressLocality || gscInfo?.location || slugInfo?.location || '');
 const jobDescription = String(ejData?.descriptionByLocale?.[locale] || ejData?.descriptionByLocale?.it || ejData?.description || gscInfo?.descriptionByLocale?.[locale] || gscInfo?.descriptionByLocale?.it || '');

 // Title for <title> tag: use job title if available (including slug-extracted)
 const hasRealTitle = !!(ejData?.title || gscInfo?.title || slugInfo?.title);
 const pageTitle = hasRealTitle
 ? `${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''} | Frontaliere Ticino`
 : `${esc(copy.title)} | Frontaliere Ticino`;

 const pageDesc = `${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}. ${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)}.`;

 // Seed expired job data as window global so the SPA can render
 // rich content (title, company, description) without depending on
 // the runtime expired-jobs.json fetch (which only has recently expired jobs).
 const expiredWindowData = JSON.stringify({
 slug,
 title: ejData?.title || gscInfo?.title || slugInfo?.title || '',
 titleByLocale: ejData?.titleByLocale || gscInfo?.titleByLocale || {},
 company: ejData?.company || gscInfo?.company || slugInfo?.company || '',
 companyKey: ejData?.companyKey || gscInfo?.companyKey || slugInfo?.companyKey || '',
 location: ejData?.location || ejData?.addressLocality || gscInfo?.location || slugInfo?.location || '',
 descriptionByLocale: ejData?.descriptionByLocale || gscInfo?.descriptionByLocale || {},
 slugByLocale: ejData?.slugByLocale || gscInfo?.slugByLocale || {},
 sector: ejData?.sector || gscInfo?.sector || '',
 expiredAt: ejData?.expiredAt || '',
 ...(gscInfo?.queries ? { gscQueries: gscInfo.queries, gscImpressions: gscInfo.totalImpressions, gscClicks: gscInfo.totalClicks } : {}),
 });

 // FRO-320: Generate static body content so Google sees real text, not an empty SPA shell.
 // Enriched template ensures >100 words per page for every expired job.
 const staticBodyParts: string[] = [];
 const jobCanton = String(ejData?.canton || DEFAULT_CANTON);
 const jobSector = String(ejData?.sector || '');
 const jobContract = String(ejData?.contract || '');
 const jobDatePosted = String(ejData?.datePosted || '');
 const jobExpiredAt = String(ejData?.expiredAt || '');
 const displayCanton = CANTON_DISPLAY[jobCanton] || jobCanton;

 // Find active jobs from the same company for cross-linking (O(1) map lookup)
 const sameCompanyActiveJobs = jobCompany
 ? (companyActiveJobsMap.get(jobCompany.toLowerCase()) || [])
 : [];

 // --- H1 + expired notice ---
 staticBodyParts.push(`<h1>${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}</h1>`);
 staticBodyParts.push(`<p><strong>${esc(copy.banner)}</strong></p>`);

 // --- Description section ---
 if (jobDescription && jobDescription.length > 30) {
 const descText = jobDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
 staticBodyParts.push(`<section><h2>${locale === 'it' ? 'Descrizione originale' : locale === 'en' ? 'Original description' : locale === 'de' ? 'Originalbeschreibung' : 'Description originale'}</h2><div>${descText.slice(0, 2000)}</div></section>`);
 }

 // --- Job details section ---
 const detailsHeading = locale === 'it' ? 'Dettagli dell\'offerta' : locale === 'en' ? 'Job details' : locale === 'de' ? 'Stellendetails' : 'D\u00e9tails de l\'offre';
 const detailItems: string[] = [];
 if (jobCompany) detailItems.push(`<li><strong>${locale === 'it' ? 'Azienda' : locale === 'en' ? 'Company' : locale === 'de' ? 'Unternehmen' : 'Entreprise'}:</strong> ${esc(jobCompany)}</li>`);
 detailItems.push(`<li><strong>${locale === 'it' ? 'Posizione' : locale === 'en' ? 'Position' : locale === 'de' ? 'Position' : 'Poste'}:</strong> ${esc(jobTitle)}</li>`);
 if (jobLocation) detailItems.push(`<li><strong>${locale === 'it' ? 'Sede' : locale === 'en' ? 'Location' : locale === 'de' ? 'Standort' : 'Lieu'}:</strong> ${esc(jobLocation)}, ${esc(displayCanton)}</li>`);
 if (jobContract) detailItems.push(`<li><strong>${locale === 'it' ? 'Tipo contratto' : locale === 'en' ? 'Contract type' : locale === 'de' ? 'Vertragsart' : 'Type de contrat'}:</strong> ${esc(jobContract)}</li>`);
 if (jobSector) detailItems.push(`<li><strong>${locale === 'it' ? 'Settore' : locale === 'en' ? 'Sector' : locale === 'de' ? 'Branche' : 'Secteur'}:</strong> ${esc(jobSector)}</li>`);
 if (jobDatePosted) detailItems.push(`<li><strong>${locale === 'it' ? 'Pubblicata il' : locale === 'en' ? 'Posted on' : locale === 'de' ? 'Ver\u00f6ffentlicht am' : 'Publi\u00e9e le'}:</strong> ${esc(jobDatePosted.slice(0, 10))}</li>`);
 if (jobExpiredAt) detailItems.push(`<li><strong>${locale === 'it' ? 'Scaduta il' : locale === 'en' ? 'Expired on' : locale === 'de' ? 'Abgelaufen am' : 'Expir\u00e9e le'}:</strong> ${esc(jobExpiredAt.slice(0, 10))}</li>`);
 staticBodyParts.push(`<section><h2>${esc(detailsHeading)}</h2><ul>${detailItems.join('')}</ul></section>`);

 // --- Same-company active jobs ---
 if (sameCompanyActiveJobs.length > 0) {
 const companyJobsHeading = locale === 'it' ? `Altre offerte di ${esc(jobCompany)}` : locale === 'en' ? `More jobs at ${esc(jobCompany)}` : locale === 'de' ? `Weitere Stellen bei ${esc(jobCompany)}` : `Autres offres chez ${esc(jobCompany)}`;
 const companyJobsList = sameCompanyActiveJobs.map((j: any) => {
 const jSlug = localizedSlug(j, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(j?.titleByLocale?.[locale] || j.title || '');
 return `<li><a href="${jHref}">${esc(jTitle)}</a> — ${esc(j.location)}</li>`;
 }).join('');
 staticBodyParts.push(`<section><h2>${companyJobsHeading}</h2><ul>${companyJobsList}</ul></section>`);
 }

 // --- Search suggestions ---
 if (locale === 'it') {
 const searchSugParts: string[] = [];
 if (jobCompany) searchSugParts.push(`<p>Scopri tutte le <a href="${BASE_URL}/cerca-lavoro-ticino/">posizioni aperte</a> sul nostro job board con oltre 1000 offerte attive in Ticino.</p>`);
 if (jobLocation) searchSugParts.push(`<p>Cerca altre offerte nella zona: <a href="${BASE_URL}/cerca-lavoro-ticino/">Lavoro in ${esc(displayCanton)}</a></p>`);
 searchSugParts.push(`<p>Torna alla <a href="${BASE_URL}/cerca-lavoro-ticino/">Job Board completa</a> per trovare la tua prossima opportunit\u00e0 lavorativa come frontaliere in Svizzera.</p>`);
 staticBodyParts.push(`<section><h2>Offerte simili in ${esc(displayCanton)}</h2>${searchSugParts.join('\n')}</section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Similar jobs in ${esc(displayCanton)}</h2><p>Browse our <a href="${BASE_URL}/en/find-jobs-ticino/">complete job board</a> with over 1000 active positions in Ticino.</p>${jobLocation ? `<p>Search for more jobs near ${esc(jobLocation)}: <a href="${BASE_URL}/en/find-jobs-ticino/">Jobs in ${esc(displayCanton)}</a></p>` : ''}<p>Find your next opportunity as a cross-border worker in Switzerland.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>\u00c4hnliche Stellen im ${esc(displayCanton)}</h2><p>Durchsuchen Sie unser <a href="${BASE_URL}/de/job-suche-tessin/">komplettes Job Board</a> mit \u00fcber 1000 aktiven Stellen im Tessin.</p>${jobLocation ? `<p>Weitere Stellen in der N\u00e4he von ${esc(jobLocation)}: <a href="${BASE_URL}/de/job-suche-tessin/">Jobs im ${esc(displayCanton)}</a></p>` : ''}<p>Finden Sie Ihre n\u00e4chste Stelle als Grenzg\u00e4nger in der Schweiz.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Offres similaires au ${esc(displayCanton)}</h2><p>Parcourez notre <a href="${BASE_URL}/fr/recherche-emploi-tessin/">job board complet</a> avec plus de 1000 postes actifs au Tessin.</p>${jobLocation ? `<p>Recherchez d'autres offres pr\u00e8s de ${esc(jobLocation)}: <a href="${BASE_URL}/fr/recherche-emploi-tessin/">Emplois au ${esc(displayCanton)}</a></p>` : ''}<p>Trouvez votre prochaine opportunit\u00e9 en tant que frontalier en Suisse.</p></section>`);
 }

 // --- Frontalier info section (always shown — adds ~100 words of unique contextual content) ---
 const taxUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Informazioni per frontalieri</h2><p>${jobCompany ? `${esc(jobCompany)} si trova` : 'Questa posizione si trovava'}${jobLocation ? ` a ${esc(jobLocation)}` : ''} in Canton ${esc(displayCanton)}. Per lavorare come frontaliere in Svizzera serve il <strong>Permesso G</strong>, rinnovabile annualmente. Il Canton ${esc(displayCanton)} applica l'<strong>imposta alla fonte</strong> con aliquote variabili sul reddito lordo, mentre i frontalieri dal 2024 sono soggetti al <strong>Nuovo Accordo fiscale</strong> che prevede una tassazione concorrente Italia-Svizzera.</p><p>I contributi sociali svizzeri includono AVS (5,3%), assicurazione disoccupazione (1,1%) e LPP (previdenza professionale). Usa il nostro <a href="${taxUrl}">simulatore fiscale gratuito</a> per calcolare il tuo stipendio netto e confrontare i costi della vita tra Svizzera e Italia.</p></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Information for cross-border workers</h2><p>${jobCompany ? `${esc(jobCompany)} is located` : 'This position was located'}${jobLocation ? ` in ${esc(jobLocation)}` : ''} in the Canton of ${esc(displayCanton)}. Cross-border workers need a <strong>G Permit</strong>, renewable annually, to work in Switzerland. The Canton of ${esc(displayCanton)} applies <strong>withholding tax</strong> at variable rates on gross income. Since 2024, the <strong>New Tax Agreement</strong> introduces concurrent taxation between Italy and Switzerland.</p><p>Swiss social contributions include AVS (5.3%), unemployment insurance (1.1%) and LPP (occupational pension). Use our <a href="${taxUrl}">free tax simulator</a> to calculate your net salary and compare the cost of living between Switzerland and Italy.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>Informationen f\u00fcr Grenzg\u00e4nger</h2><p>${jobCompany ? `${esc(jobCompany)} befindet sich` : 'Diese Stelle befand sich'}${jobLocation ? ` in ${esc(jobLocation)}` : ''} im Kanton ${esc(displayCanton)}. Grenzg\u00e4nger ben\u00f6tigen eine <strong>G-Bewilligung</strong> (j\u00e4hrlich erneuerbar), um in der Schweiz zu arbeiten. Der Kanton ${esc(displayCanton)} erhebt eine <strong>Quellensteuer</strong> mit variablen S\u00e4tzen auf das Bruttoeinkommen. Seit 2024 gilt das <strong>Neue Steuerabkommen</strong> mit konkurrierender Besteuerung zwischen Italien und der Schweiz.</p><p>Die Schweizer Sozialabgaben umfassen AHV (5,3%), Arbeitslosenversicherung (1,1%) und BVG (berufliche Vorsorge). Nutzen Sie unseren <a href="${taxUrl}">kostenlosen Steuersimulator</a>, um Ihr Nettogehalt zu berechnen und die Lebenshaltungskosten zwischen der Schweiz und Italien zu vergleichen.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Informations pour les frontaliers</h2><p>${jobCompany ? `${esc(jobCompany)} se trouve` : 'Ce poste se trouvait'}${jobLocation ? ` \u00e0 ${esc(jobLocation)}` : ''} dans le Canton du ${esc(displayCanton)}. Les travailleurs frontaliers ont besoin d'un <strong>permis G</strong> (renouvelable annuellement) pour travailler en Suisse. Le Canton du ${esc(displayCanton)} applique un <strong>imp\u00f4t \u00e0 la source</strong> \u00e0 taux variable sur le revenu brut. Depuis 2024, le <strong>Nouvel Accord fiscal</strong> introduit une imposition concurrente entre l'Italie et la Suisse.</p><p>Les cotisations sociales suisses comprennent l'AVS (5,3%), l'assurance ch\u00f4mage (1,1%) et la LPP (pr\u00e9voyance professionnelle). Utilisez notre <a href="${taxUrl}">simulateur fiscal gratuit</a> pour calculer votre salaire net et comparer le co\u00fbt de la vie entre la Suisse et l'Italie.</p></section>`);
 }

 // --- FAQ section (always shown — adds ~80 words of unique Q&A content) ---
 const lamalUrl: Record<string, string> = {
 it: `${BASE_URL}/compara-servizi/assicurazione-malattia/`,
 en: `${BASE_URL}/en/compare-services/health-insurance/`,
 de: `${BASE_URL}/de/dienste-vergleichen/krankenversicherung/`,
 fr: `${BASE_URL}/fr/comparer-services/assurance-maladie/`,
 };
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Domande frequenti</h2><dl><dt><strong>Qual \u00e8 lo stipendio netto per un frontaliere in ${esc(displayCanton)}?</strong></dt><dd>Lo stipendio netto dipende dal reddito lordo, dallo stato civile e dal numero di figli. In Canton ${esc(displayCanton)} l'imposta alla fonte varia dal 2% al 15% circa. Usa il nostro simulatore per un calcolo personalizzato.</dd><dt><strong>Serve la cassa malati svizzera LAMal come frontaliere?</strong></dt><dd>I nuovi frontalieri dal 2024 devono iscriversi alla LAMal svizzera entro 3 mesi dall'inizio del lavoro. I premi variano per cantone, modello assicurativo e franchigia. <a href="${lamalUrl.it}">Confronta i premi LAMal</a>.</dd></dl></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Frequently asked questions</h2><dl><dt><strong>What is the net salary for a cross-border worker in ${esc(displayCanton)}?</strong></dt><dd>Net salary depends on gross income, marital status and number of children. In the Canton of ${esc(displayCanton)}, withholding tax ranges from about 2% to 15%. Use our simulator for a personalised calculation.</dd><dt><strong>Do cross-border workers need Swiss LAMal health insurance?</strong></dt><dd>New cross-border workers since 2024 must enrol in Swiss LAMal within 3 months of starting work. Premiums vary by canton, insurance model and deductible. <a href="${lamalUrl.en}">Compare LAMal premiums</a>.</dd></dl></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>H\u00e4ufig gestellte Fragen</h2><dl><dt><strong>Wie hoch ist das Nettogehalt f\u00fcr Grenzg\u00e4nger im ${esc(displayCanton)}?</strong></dt><dd>Das Nettogehalt h\u00e4ngt vom Bruttoeinkommen, Familienstand und der Kinderzahl ab. Im Kanton ${esc(displayCanton)} liegt die Quellensteuer zwischen ca. 2% und 15%. Nutzen Sie unseren Simulator f\u00fcr eine individuelle Berechnung.</dd><dt><strong>Brauchen Grenzg\u00e4nger eine Schweizer KVG-Versicherung?</strong></dt><dd>Neue Grenzg\u00e4nger seit 2024 m\u00fcssen sich innerhalb von 3 Monaten nach Arbeitsbeginn bei der KVG anmelden. Die Pr\u00e4mien variieren je nach Kanton, Versicherungsmodell und Franchise. <a href="${lamalUrl.de}">KVG-Pr\u00e4mien vergleichen</a>.</dd></dl></section>`);
 } else {
 staticBodyParts.push(`<section><h2>Questions fr\u00e9quentes</h2><dl><dt><strong>Quel est le salaire net pour un frontalier au ${esc(displayCanton)} ?</strong></dt><dd>Le salaire net d\u00e9pend du revenu brut, de l'\u00e9tat civil et du nombre d'enfants. Dans le Canton du ${esc(displayCanton)}, l'imp\u00f4t \u00e0 la source varie d'environ 2% \u00e0 15%. Utilisez notre simulateur pour un calcul personnalis\u00e9.</dd><dt><strong>Les frontaliers doivent-ils souscrire \u00e0 la LAMal suisse ?</strong></dt><dd>Les nouveaux frontaliers depuis 2024 doivent s'inscrire \u00e0 la LAMal dans les 3 mois suivant le d\u00e9but du travail. Les primes varient selon le canton, le mod\u00e8le d'assurance et la franchise. <a href="${lamalUrl.fr}">Comparer les primes LAMal</a>.</dd></dl></section>`);
 }

 // --- Fallback: recent active jobs when no same-company jobs were shown ---
 // This ensures even pages without ejData have cross-links to active listings,
 // adding both word count and genuine user value.
 if (sameCompanyActiveJobs.length === 0) {
 // Pick up to 5 recent active jobs (deterministic by slug hash, O(1) via pre-computed pool)
 const recentJobs = selectRecentJobs(slug, slug);
 if (recentJobs.length > 0) {
 const recentHeading = locale === 'it' ? 'Posizioni attive recenti' : locale === 'en' ? 'Recent active positions' : locale === 'de' ? 'Aktuelle offene Stellen' : 'Postes actifs r\u00e9cents';
 const recentList = recentJobs.map((j: any) => {
 const jSlug = localizedSlug(j, locale);
 const jPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${jSlug}`.replace(/\/+/g, '/');
 const jHref = `${BASE_URL}${withSlash(jPath)}`;
 const jTitle = String(j?.titleByLocale?.[locale] || j.title || '');
 const jCompany = String(j.company || '');
 const jLoc = String(j.location || '');
 return `<li><a href="${jHref}">${esc(jTitle)}</a>${jCompany ? ` \u2014 ${esc(jCompany)}` : ''}${jLoc ? `, ${esc(jLoc)}` : ''}</li>`;
 }).join('');
 staticBodyParts.push(`<section><h2>${recentHeading}</h2><ul>${recentList}</ul></section>`);
 }
 }

 // --- Fallback enrichment for pages without expired-jobs.json data ---
 // Ensures pages without rich ejData still have enough content (>= 50 words)
 // by adding general info about the Ticino cross-border job market.
 if (!ejData?.title && !gscInfo?.title) {
 if (locale === 'it') {
 staticBodyParts.push(`<section><h2>Mercato del lavoro in Ticino</h2><p>Il Canton Ticino offre numerose opportunit\u00e0 per i lavoratori frontalieri provenienti dall'Italia. Con oltre 70.000 frontalieri attivi, il Ticino rappresenta una delle principali destinazioni per chi cerca lavoro in Svizzera dalla regione insubrica. I settori pi\u00f9 attivi includono industria, servizi finanziari, sanit\u00e0, commercio e tecnologia. Lo stipendio medio in Ticino \u00e8 significativamente pi\u00f9 alto rispetto alle regioni italiane di confine, rendendo il lavoro transfrontaliero un'opzione molto attraente per i residenti di Lombardia, Piemonte e altre province vicine.</p></section>`);
 } else if (locale === 'en') {
 staticBodyParts.push(`<section><h2>Job market in Ticino</h2><p>The Canton of Ticino offers numerous opportunities for cross-border workers from Italy. With over 70,000 active cross-border commuters, Ticino is one of the main destinations for those seeking employment in Switzerland from the Insubria region. The most active sectors include industry, financial services, healthcare, retail and technology. The average salary in Ticino is significantly higher than in Italian border regions, making cross-border work a very attractive option for residents of Lombardy, Piedmont and other nearby provinces.</p></section>`);
 } else if (locale === 'de') {
 staticBodyParts.push(`<section><h2>Arbeitsmarkt im Tessin</h2><p>Der Kanton Tessin bietet zahlreiche M\u00f6glichkeiten f\u00fcr Grenzg\u00e4nger aus Italien. Mit \u00fcber 70.000 aktiven Grenzpendlern ist das Tessin eines der wichtigsten Ziele f\u00fcr Arbeitssuchende in der Schweiz aus der Region Insubrien. Die aktivsten Branchen sind Industrie, Finanzdienstleistungen, Gesundheitswesen, Handel und Technologie. Das Durchschnittsgehalt im Tessin liegt deutlich h\u00f6her als in den italienischen Grenzregionen, was die Grenzg\u00e4ngerarbeit zu einer sehr attraktiven Option f\u00fcr Bewohner der Lombardei, des Piemonts und anderer naher Provinzen macht.</p></section>`);
 } else {
 staticBodyParts.push(`<section><h2>March\u00e9 du travail au Tessin</h2><p>Le Canton du Tessin offre de nombreuses opportunit\u00e9s pour les travailleurs frontaliers venant d'Italie. Avec plus de 70 000 frontaliers actifs, le Tessin est l'une des principales destinations pour ceux qui cherchent un emploi en Suisse depuis la r\u00e9gion insubrienne. Les secteurs les plus actifs comprennent l'industrie, les services financiers, la sant\u00e9, le commerce et la technologie. Le salaire moyen au Tessin est nettement plus \u00e9lev\u00e9 que dans les r\u00e9gions frontali\u00e8res italiennes, ce qui fait du travail transfrontalier une option tr\u00e8s attractive pour les r\u00e9sidents de Lombardie, du Pi\u00e9mont et d'autres provinces voisines.</p></section>`);
 }
 }

 // --- GSC related searches section (only for orphan slugs with query data) ---
 if (gscInfo?.queries && gscInfo.queries.length > 0) {
 const relatedQueries = gscInfo.queries
 .filter((q: string) => q.length > 3)
 .slice(0, 6);
 if (relatedQueries.length > 0) {
 const relSearchHeading: Record<string, string> = {
 it: 'Ricerche correlate',
 en: 'Related searches',
 de: 'Verwandte Suchanfragen',
 fr: 'Recherches associées',
 };
 const queryLinks = relatedQueries.map((q: string) =>
 `<li><a href="${BASE_URL}${listingPath}">${esc(q)}</a></li>`
 ).join('');
 staticBodyParts.push(`<section><h2>${relSearchHeading[locale] || relSearchHeading.it}</h2><ul>${queryLinks}</ul></section>`);
 }
 }

 staticBodyParts.push(`<p><a href="${BASE_URL}${listingPath}">${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)} \u2192</a></p>`);
 const staticBody = staticBodyParts.join('\n');

 // Track IT word count for sitemap inclusion decision
 if (locale === 'it') {
 itBodyWordCount = countHtmlBodyWords(staticBody);
 }

 // Escape staticBody for embedding in a JS string (JSON.stringify handles quotes/newlines)
 const staticBodyJson = JSON.stringify(staticBody);

 // Make robots directive conditional on actual content quality.
 // Pages with >= MIN_INDEXABLE_WORDS of real text get index,follow (SEO value
 // from long-tail searches). Pages below threshold get noindex,follow.
 const expiredRobotsTag = robotsMetaForContent(staticBody);

 // Build JSON-LD scripts (BreadcrumbList + optional JobPosting)
 const breadcrumbLd = `<script type="application/ld+json">${JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'BreadcrumbList',
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Frontaliere Ticino', item: BASE_URL + '/' },
 { '@type': 'ListItem', position: 2, name: cantonSectionName(locale, displayCanton), item: `${BASE_URL}${listingPath}` },
 { '@type': 'ListItem', position: 3, name: jobTitle },
 ],
 })}</script>`;

 const jobPostingLd = (() => {
 // Only emit JobPosting when we have real job data
 const realTitle = ejData?.titleByLocale?.[locale] || ejData?.title || '';
 const realExpiredAt = ejData?.expiredAt || '';
 if (!realTitle || !realExpiredAt || !jobCompany) return '';
 const finalDescription = jobDescription || (() => {
 const parts: string[] = [];
 parts.push(`<p><strong>${esc(copy.banner)}</strong></p>`);
 if (locale === 'it') {
 parts.push(`<p>Questa posizione di ${esc(realTitle)} presso ${esc(jobCompany)}${jobLocation ? ` a ${esc(jobLocation)}` : ' in Ticino'} non è più disponibile.</p>`);
 } else if (locale === 'en') {
 parts.push(`<p>This ${esc(realTitle)} position at ${esc(jobCompany)}${jobLocation ? ` in ${esc(jobLocation)}` : ' in Ticino'} is no longer available.</p>`);
 } else if (locale === 'de') {
 parts.push(`<p>Diese Stelle als ${esc(realTitle)} bei ${esc(jobCompany)}${jobLocation ? ` in ${esc(jobLocation)}` : ' im Tessin'} ist nicht mehr verfügbar.</p>`);
 } else {
 parts.push(`<p>Ce poste de ${esc(realTitle)} chez ${esc(jobCompany)}${jobLocation ? ` à ${esc(jobLocation)}` : ' au Tessin'} n'est plus disponible.</p>`);
 }
 parts.push(`<p>${locale === 'it' ? 'Azienda' : locale === 'en' ? 'Company' : locale === 'de' ? 'Unternehmen' : 'Entreprise'}: ${esc(jobCompany)}</p>`);
 if (jobLocation) parts.push(`<p>${locale === 'it' ? 'Sede' : locale === 'en' ? 'Location' : locale === 'de' ? 'Standort' : 'Lieu'}: ${esc(jobLocation)}</p>`);
 return parts.join('');
 })();
 if (finalDescription.length < 30) return '';
 const jp: Record<string, unknown> = {
 '@context': 'https://schema.org',
 '@type': 'JobPosting',
 title: realTitle,
 description: finalDescription,
 url: selfUrl,
 validThrough: new Date(realExpiredAt).toISOString(),
 datePosted: (() => {
 if (ejData?.postedDate) { const d = new Date(ejData.postedDate); if (!isNaN(d.getTime())) return d.toISOString(); }
 if (ejData?.crawledAt) { const d = new Date(ejData.crawledAt); if (!isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() - 30); return d.toISOString(); } }
 const d = new Date(realExpiredAt); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString();
 })(),
 employmentType: (() => {
 const c = String(ejData?.contract || '').toLowerCase();
 if (c === 'full-time' || c === 'full_time') return 'FULL_TIME';
 if (c === 'part-time' || c === 'part_time') return 'PART_TIME';
 if (c === 'temporary') return 'TEMPORARY';
 if (c === 'internship' || c === 'intern') return 'INTERN';
 if (c === 'contract' || c === 'contractor') return 'CONTRACTOR';
 return 'OTHER';
 })(),
 hiringOrganization: { '@type': 'Organization', name: jobCompany },
 };
 {
 const address: Record<string, string> = {
 '@type': 'PostalAddress',
 addressLocality: jobLocation || DEFAULT_CANTON_DISPLAY,
 addressRegion: jobCanton || DEFAULT_CANTON,
 addressCountry: 'CH',
 };
 const ejPostalCode = ejData?.postalCode || slugInfo?.postalCode;
 if (ejPostalCode) {
 address.postalCode = ejPostalCode;
 } else if (jobLocation && plzLookup[jobLocation]) {
 address.postalCode = plzLookup[jobLocation];
 } else {
 address.postalCode = CANTON_FALLBACK_POSTAL[address.addressRegion] || DEFAULT_POSTAL_CODE;
 }
 const ejStreet = ejData?.streetAddress;
 if (ejStreet) {
 address.streetAddress = ejStreet;
 } else if ((ejData?.companyKey || slugInfo?.companyKey) && COMPANY_HQ_ADDRESSES[ejData?.companyKey || slugInfo?.companyKey || '']) {
 const hq = COMPANY_HQ_ADDRESSES[ejData?.companyKey || slugInfo?.companyKey || ''];
 address.streetAddress = hq.streetAddress;
 if (!address.postalCode || address.postalCode === CANTON_FALLBACK_POSTAL[DEFAULT_CANTON]) address.postalCode = hq.postalCode;
 } else {
 address.streetAddress = address.addressLocality || DEFAULT_CANTON_DISPLAY;
 }
 jp.jobLocation = { '@type': 'Place', address };
 }
 // FRO-maxValue: maxValue MUST always be present — GSC flags missing maxValue as quality issue.
 {
 const ejMin = Number(ejData?.salaryMin) || 0;
 const ejMax = Number(ejData?.salaryMax) || 0;
 const min = ejMin > 0 ? ejMin : 41080;
 const max = ejMax > min ? ejMax : Math.round(min * 1.2);
 jp.baseSalary = {
 '@type': 'MonetaryAmount',
 currency: ejMin > 0 ? (ejData?.salaryCurrency || 'CHF') : 'CHF',
 value: {
 '@type': 'QuantitativeValue',
 minValue: min,
 maxValue: max,
 unitText: ejData?.salaryPeriod || 'YEAR',
 },
 };
 }
 return `<script type="application/ld+json">${JSON.stringify(jp)}</script>`;
 })();

 const jsonLdScripts = breadcrumbLd + (jobPostingLd ? '\n ' + jobPostingLd : '');

 const softLandingHtml = buildSoftLandingHtml(
 locale, pageTitle, pageDesc, expiredRobotsTag,
 selfUrl, hreflangLinks, jsonLdScripts, expiredWindowData,
 staticBodyJson, staticBody
 );

 writeSoftLandingPage(relPath.slice(1), softLandingHtml);
 const cacheKey = `${locale}:${slug}`;
 if (expiredCacheKeys.has(cacheKey)) {
 expiredSoftLandingCache.set(cacheKey, softLandingHtml);
 }
 expiredCount++;

 // Legacy slug bridge (Italian slug in non-IT locale path)
 if (locale !== 'it') {
 const legacyRel = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/').replace(/^\//, '');
 const trackedRel = relPath.replace(/^\//, '');
 if (legacyRel !== trackedRel) {
 writeSoftLandingPage(legacyRel, softLandingHtml);
 legacyCount++;
 }
 }
 }

 // Only add expired slugs to sitemap when:
 // 1. The IT page has enough content (>= MIN_INDEXABLE_WORDS) — thin content wastes crawl budget
 // 2. The IT page was actually written (not overwritten by an active page)
 const itPath = paths.it ? withSlash(paths.it) : '';
 const itPageFile = itPath ? np.join(distDir, itPath.slice(1), 'index.html') : '';
 const itPageOverwritten = itPageFile && _writtenPaths.has(itPageFile);
 if (itPath && itBodyWordCount >= MIN_INDEXABLE_WORDS && !itPageOverwritten && !bridgeClaimedPaths.has(paths.it)) {
 const altLinks = localeList.map((l) => {
 const p = paths[l];
 if (!p) return '';
 return ` <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
 }).filter(Boolean).join('\n');
 const xDefault = ` <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
 const lastmod = ejData?.expiredAt ? new Date(ejData.expiredAt).toISOString().slice(0, 10) : dateStamp;
 expiredSitemapEntries.push(` <url>\n <loc>${BASE_URL}${itPath}</loc>\n${altLinks}\n${xDefault}\n <lastmod>${lastmod}</lastmod>\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`);
 }
 }

 // Write expired jobs sitemap
 if (expiredSitemapEntries.length > 0) {
 const sitemapExpired = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${expiredSitemapEntries.join('\n')}\n</urlset>\n`;
 fs.writeFileSync(np.join(distDir, 'sitemap-jobs-expired.xml'), sitemapExpired, 'utf-8');

 // Register in sitemap index
 const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
 if (fs.existsSync(sitemapIndexPath)) {
 let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
 if (!idx.includes('sitemap-jobs-expired.xml')) {
 idx = idx.replace(
 '</sitemapindex>',
 ` <sitemap>\n <loc>${BASE_URL}/sitemap-jobs-expired.xml</loc>\n <lastmod>${dateStamp}</lastmod>\n </sitemap>\n</sitemapindex>`
 );
 fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
 }
 }
 }

 if (expiredCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${expiredCount} soft-landing pages for ${expiredSlugs.length} expired jobs${legacyCount > 0 ? ` (+ ${legacyCount} legacy slug bridges)` : ''}`);
 }

 /* ── Cross-locale reconciliation for expired jobs ──────────── */
 // Mirrors the active-jobs cross-locale block below, but for expired jobs.
 // When an expired job has distinct `slugByLocale`, generate a soft-landing
 // bridge at every (baseLocale × foreignSlug) combination so a direct hit on
 // e.g. `/cerca-lavoro-ticino/<slug-fr>` renders soft-landing content in
 // Italian instead of a 404. Canonical (inherited from the cached HTML)
 // already points to the base locale's tracked slug URL.
 let crossLocaleExpiredCount = 0;
 for (const ej of expiredJobsData) {
 const slugByLocale = (ej && ej.slugByLocale) as Record<string, string> | undefined;
 if (!slugByLocale || typeof slugByLocale !== 'object') continue;
 for (const baseLocale of localeList) {
 const baseSlug = slugByLocale[baseLocale];
 if (!baseSlug) continue;
 const baseHtml = expiredSoftLandingCache.get(`${baseLocale}:${baseSlug}`);
 if (!baseHtml) continue;
 const foreignSlugs = new Set<string>();
 for (const otherLocale of localeList) {
 if (otherLocale === baseLocale) continue;
 const fs2 = slugByLocale[otherLocale];
 if (fs2 && fs2 !== baseSlug) foreignSlugs.add(fs2);
 }
 if (foreignSlugs.size === 0) continue;
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(baseSlug)};</script>`;
 const bridgeHtml = baseHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 for (const foreignSlug of foreignSlugs) {
 const relPath = `${localePrefix[baseLocale]}/${sectionByLocale[baseLocale]}/${foreignSlug}`.replace(/\/+/g, '/');
 const relPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 // Active job wins if a live page already occupies this path.
 if (activeJobDirs.has(relPathKey)) continue;
 const outDir = np.join(distDir, relPath.replace(/^\//, ''));
 const indexFile = np.join(outDir, 'index.html');
 // Skip if any earlier phase (active, bridge, soft-landing) already wrote here.
 if (_writtenPaths.has(indexFile)) continue;
 _md(outDir);
 fs.writeFileSync(indexFile, bridgeHtml);
 _writtenPaths.add(indexFile);
 crossLocaleExpiredCount++;
 }
 }
 }
 if (crossLocaleExpiredCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${crossLocaleExpiredCount} cross-locale reconciliation pages for expired jobs`);
 }

 /* ── Full-content pages for previousSlugs of active jobs ────── */
 // Serve identical full-content pages at old URLs (bookmarks, search engines).
 // The only difference: <link rel="canonical"> points to the current slug URL,
 // and window.__BRIDGE_TARGET_SLUG__ tells the SPA to use the current slug.
 // No redirect, no countdown — user sees full job content immediately.
 //
 // Uses locale-aware previousSlugsByLocale when available:
 // - previousSlugsByLocale[locale] → bridge pages only under that locale's prefix
 // - Legacy flat previousSlugs → bridge pages under ALL locale prefixes (safe fallback)

 let bridgeCount = 0;
 for (const job of validJobs) {
 // Collect previous slugs that aren't locale-attributed (legacy flat entries)
 const localeAwareAll = new Set<string>();
 const pslByLocale = (job as any).previousSlugsByLocale;
 if (pslByLocale && typeof pslByLocale === 'object') {
 for (const arr of Object.values(pslByLocale)) {
 if (Array.isArray(arr)) for (const s of arr as string[]) localeAwareAll.add(s);
 }
 }
 const legacyOnly = Array.isArray(job.previousSlugs)
 ? job.previousSlugs.filter(s => !localeAwareAll.has(s))
 : [];
 // Check if there's anything to do
 if (localeAwareAll.size === 0 && legacyOnly.length === 0) continue;

 for (const locale of localeList) {
 const currentSlug = localizedSlug(job, locale);
 const cachedHtml = jobHtmlCache.get(`${locale}:${currentSlug}`);
 if (!cachedHtml) continue;

 // Locale-specific previous slugs + legacy (unknown locale → all locales)
 const prevSlugsForLocale = [
 ...new Set([
 ...(pslByLocale && Array.isArray(pslByLocale[locale]) ? pslByLocale[locale] : []),
 ...legacyOnly,
 ]),
 ];

 for (const oldSlug of prevSlugsForLocale) {
 if (oldSlug === currentSlug) continue;
 const oldPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${oldSlug}`.replace(/\/+/g, '/');
 const oldRelPath = oldPath.replace(/^\//, '');
 // Skip if an active job page already occupies this path (buffered writes
 // are invisible to fs.existsSync — use the activeJobDirs set instead).
 if (activeJobDirs.has(oldRelPath.replace(/\/+$/, ''))) continue;
 const outDir = np.join(distDir, oldRelPath);
 const targetFile = np.join(outDir, 'index.html');
 // Always generate bridge pages — they take priority over any compat/legacy
 // page that another plugin (e.g. legacyRedirectsPlugin) may have written
 // at the same path via fs.writeFileSync during concurrent closeBundle.

 // Reuse the full active page HTML — canonical already points to the
 // current slug URL. Inject __BRIDGE_TARGET_SLUG__ so the SPA knows to
 // use the current slug for data lookup instead of parsing the old URL.
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(currentSlug)};</script>`;
 const bridgeHtml = cachedHtml.replace('</head>', ` ${bridgeScript}\n </head>`);

 _md(outDir);
 _qw(np.join(outDir, 'index.html'), bridgeHtml);

 const flatFile = np.join(distDir, oldPath.replace(/^\//, '') + '.html');
 _md(np.dirname(flatFile));
 _qw(flatFile, bridgeHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
 bridgeCount++;
 }
 }
 }
 if (bridgeCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${bridgeCount} previousSlugs full-content pages`);
 }

 /* ── Cross-locale reconciliation bridge pages ──────────────── */
 // When a job has different slugs per locale (e.g. AI translation landed
 // the French slug under the Italian base URL before the Italian slug
 // was generated), a direct hit on `/cerca-lavoro-ticino/<slug-fr>` would
 // otherwise render nothing until the client-side slug map loads.
 // Generate a full-content bridge page at every (baseLocale × foreignSlug)
 // combination where the foreign-locale slug differs from the base-locale
 // slug. Content is served in the base URL's locale; canonical points to
 // the base locale's current slug URL. No redirect, no countdown.
 let crossLocaleCount = 0;
 for (const job of validJobs) {
 const slugPerLocale: Record<string, string> = {};
 for (const locale of localeList) {
 const s = localizedSlug(job, locale);
 if (s) slugPerLocale[locale] = s;
 }
 // Previous slugs grouped by locale (used to cover cross-locale legacy slugs,
 // e.g. a German previous slug indexed under the Italian base URL).
 const pslByLocaleTyped = (job as { previousSlugsByLocale?: Record<string, unknown> }).previousSlugsByLocale;
 const prevSlugsByLocale: Record<string, string[]> = {};
 if (pslByLocaleTyped && typeof pslByLocaleTyped === 'object') {
 for (const [l, arr] of Object.entries(pslByLocaleTyped)) {
 if (Array.isArray(arr)) prevSlugsByLocale[l] = (arr as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0);
 }
 }
 for (const baseLocale of localeList) {
 const baseSlug = slugPerLocale[baseLocale];
 if (!baseSlug) continue;
 const cachedHtml = jobHtmlCache.get(`${baseLocale}:${baseSlug}`);
 if (!cachedHtml) continue;
 const foreignSlugs = new Set<string>();
 for (const otherLocale of localeList) {
 if (otherLocale === baseLocale) continue;
 // Other locale's current slug
 const s = slugPerLocale[otherLocale];
 if (s && s !== baseSlug) foreignSlugs.add(s);
 // Other locale's previous slugs (covers legacy renames per locale)
 for (const ps of prevSlugsByLocale[otherLocale] || []) {
 if (ps && ps !== baseSlug) foreignSlugs.add(ps);
 }
 }
 if (foreignSlugs.size === 0) continue;
 // Compute once per (job, baseLocale) — same HTML is written at every foreign slug path.
 const bridgeScript = `<script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(baseSlug)};</script>`;
 const bridgeHtml = cachedHtml.replace('</head>', ` ${bridgeScript}\n </head>`);
 for (const foreignSlug of foreignSlugs) {
 const relPath = `${localePrefix[baseLocale]}/${sectionByLocale[baseLocale]}/${foreignSlug}`.replace(/\/+/g, '/');
 const relPathKey = relPath.replace(/^\//, '').replace(/\/+$/, '');
 // Skip if an active job page already occupies this path (another
 // job's slug happens to collide across locales — active wins).
 if (activeJobDirs.has(relPathKey)) continue;
 const outDir = np.join(distDir, relPath.replace(/^\//, ''));
 const indexFile = np.join(outDir, 'index.html');
 // Skip if a previousSlugs bridge already covered this path for
 // this job (same content would be written again).
 if (_writtenPaths.has(indexFile)) continue;
 _md(outDir);
 fs.writeFileSync(indexFile, bridgeHtml);
 _writtenPaths.add(indexFile);
 // Note: skip the flat `.html` variant — GH Pages serves
 // /dir/index.html for direct URL hits and the flat variant
 // would double disk usage for ~27k bridge pages.
 crossLocaleCount++;
 }
 }
 }
 if (crossLocaleCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${crossLocaleCount} cross-locale reconciliation pages`);
 }

 /* ── Self-healing: cover any tracking paths not yet written ──── */
 // Safety net: any tracking path that wasn't covered by active, soft-landing,
 // or bridge pages gets a minimal redirect page pointing to the job listing.
 // This handles edge cases like locale-variant tracking keys that match a
 // currentSlug value but whose locale paths differ from the active job paths.
 let healedCount = 0;
 for (const [, paths] of Object.entries(tracking) as [string, Record<string, string>][]) {
 for (const locale of localeList) {
 const relPath = paths?.[locale];
 if (!relPath) continue;
 const absFile = np.join(distDir, relPath.replace(/^\//, ''), 'index.html');
 if (_writtenPaths.has(absFile)) continue;

 const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/');
 const listingUrl = `${BASE_URL}${withSlash(listingPath)}`;
 const localeCopy = {
 it: { title: 'Offerta di lavoro aggiornata', body: 'Questa posizione è stata aggiornata o rimossa. Consulta le offerte disponibili.', cta: 'Vedi tutte le offerte' },
 en: { title: 'Job listing updated', body: 'This position has been updated or removed. Browse available listings.', cta: 'View all listings' },
 de: { title: 'Stellenangebot aktualisiert', body: 'Diese Stelle wurde aktualisiert oder entfernt. Durchsuchen Sie die verfügbaren Angebote.', cta: 'Alle Angebote ansehen' },
 fr: { title: 'Offre d\'emploi mise à jour', body: 'Cette offre a été mise à jour ou supprimée. Consultez les offres disponibles.', cta: 'Voir toutes les offres' },
 };
 const copy = localeCopy[locale] ?? localeCopy.it;
 const html = buildCanonicalBridgePage({
 canonicalUrl: listingUrl,
 pathLabel: listingPath,
 title: `${copy.title} | Frontaliere Ticino`,
 description: copy.body,
 body: copy.body,
 ctaLabel: copy.cta,
 lang: locale,
 noindex: true,
 });
 writeSoftLandingPage(relPath.replace(/^\//, ''), html);
 healedCount++;
 }
 }
 if (healedCount > 0) {
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Self-healed ${healedCount} tracking paths with no prior coverage`);
 }

 /* ── Flush all buffered writes in parallel batches ── */
 const t0 = Date.now();
 const written = await collector.flush();
 const skipped = collector.skippedByHash;
 console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
 (skipped > 0 ? ` (${skipped} skipped by content hash)` : ''));
 },
 };
}