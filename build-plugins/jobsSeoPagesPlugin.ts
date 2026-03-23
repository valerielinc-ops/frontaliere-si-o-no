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
import { BASE_URL, buildCanonicalBridgePage, buildFlatRedirect, SPA_ACTION_REDIRECT_SCRIPT } from './constants';
import { CRAWLED_COMPANY_LOGOS } from '../services/jobDataNormalization';
import { deriveJobPostalCode } from '../services/jobLocationSnapshot';
import {
  buildJobCareVariantLandingModel,
  buildJobLocationLandingModel,
  buildJobLocationSectorLandingModel,
  buildJobLocationTypeLandingModel,
  buildJobNursesHubLandingModel,
  buildJobOfficialGazetteLandingModel,
  buildJobTodayLandingModel,
} from './jobEditorialLanding';

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

      /* ── Buffered write system: collect all writes, flush in parallel at the end ── */
      const _pendingWrites: { p: string; c: string }[] = [];
      const _ensuredDirs = new Set<string>();
      function _md(dir: string) {
        if (_ensuredDirs.has(dir)) return;
        fs.mkdirSync(dir, { recursive: true });
        _ensuredDirs.add(dir);
      }
      function _qw(filePath: string, content: string) {
        _md(np.dirname(filePath));
        _pendingWrites.push({ p: filePath, c: content });
      }
      async function _flushAllWrites() {
        const BATCH = 300;
        for (let i = 0; i < _pendingWrites.length; i += BATCH) {
          await Promise.all(
            _pendingWrites.slice(i, i + BATCH).map(w =>
              fs.promises.writeFile(w.p, w.c, 'utf-8')
            )
          );
        }
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
          suffix: 'Lavoro in Ticino',
          sectionName: 'Cerca lavoro in Ticino',
          descriptionLabel: 'Descrizione',
          applyNow: 'Vai alla candidatura',
          quickDetails: 'Dettagli rapidi',
          location: 'Località',
          canton: 'Cantone',
          contract: 'Contratto',
          relatedJobs: 'Annunci correlati',
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
          suffix: 'Jobs in Ticino',
          sectionName: 'Find jobs in Ticino',
          descriptionLabel: 'Description',
          applyNow: 'Apply now',
          quickDetails: 'Quick details',
          location: 'Location',
          canton: 'Canton',
          contract: 'Contract',
          relatedJobs: 'Related jobs',
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
          suffix: 'Jobs im Tessin',
          sectionName: 'Jobs im Tessin',
          descriptionLabel: 'Beschreibung',
          applyNow: 'Jetzt bewerben',
          quickDetails: 'Kurzdaten',
          location: 'Ort',
          canton: 'Kanton',
          contract: 'Vertrag',
          relatedJobs: 'Ähnliche Stellen',
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
          suffix: 'Emplois au Tessin',
          sectionName: 'Trouver un emploi au Tessin',
          descriptionLabel: 'Description',
          applyNow: 'Postuler',
          quickDetails: 'Détails rapides',
          location: 'Lieu',
          canton: 'Canton',
          contract: 'Contrat',
          relatedJobs: 'Offres liées',
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
        .filter((j: any) => j?.title && j?.company && j?.location && j?.description)
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
        'eoc-ente-ospedaliero-cantonale':            { streetAddress: 'Viale Officina 3',        postalCode: '6500', addressLocality: 'Bellinzona' },
        'ente-ospedaliero-cantonale-eoc':            { streetAddress: 'Viale Officina 3',        postalCode: '6500', addressLocality: 'Bellinzona' },
        'lis-lugano-istituti-sociali':               { streetAddress: 'Via alla Bozzoreda 15',   postalCode: '6963', addressLocality: 'Pregassona' },
        'amministrazione-cantonale-ti':              { streetAddress: 'Piazza Governo',           postalCode: '6501', addressLocality: 'Bellinzona' },
        'migros-ticino':                             { streetAddress: 'Via Serrai 1',             postalCode: '6592', addressLocality: 'S. Antonino' },
        'coop-ticino':                               { streetAddress: 'Via Vedeggio 4',           postalCode: '6805', addressLocality: 'Mezzovico' },
        'vf-international-the-north-face-timberland':{ streetAddress: 'Via Laveggio 5',           postalCode: '6855', addressLocality: 'Stabio' },
        'zurich-insurance-sede-ticino':              { streetAddress: 'Via Pretorio 22',          postalCode: '6900', addressLocality: 'Lugano' },
        'banca-cler':                                { streetAddress: 'Piazza Grande 5',          postalCode: '6600', addressLocality: 'Locarno' },
        'ffs-officine-ferrovie-federali':            { streetAddress: 'Via Ludovico Benteler 12', postalCode: '6500', addressLocality: 'Bellinzona' },
        'ubs':                                      { streetAddress: 'Via G. Calgari 2',        postalCode: '6900', addressLocality: 'Lugano' },
        'corner-banca':                              { streetAddress: 'Via Canova 16',            postalCode: '6901', addressLocality: 'Lugano' },
        'helsinn':                                   { streetAddress: 'Via Pian Scairolo 9',     postalCode: '6912', addressLocality: 'Lugano' },
        'ibsa-institut-biochimique':                 { streetAddress: 'Via del Piano 29',         postalCode: '6926', addressLocality: 'Montagnola' },
        'medacta-international':                     { streetAddress: 'Strada Regina',            postalCode: '6874', addressLocality: 'Castel San Pietro' },
        'rsi-radiotelevisione-svizzera':             { streetAddress: 'Via Canevascini 7',       postalCode: '6903', addressLocality: 'Lugano' },
        'usi-universita-della-svizzera-italiana':    { streetAddress: 'Via G. Buffi 13',          postalCode: '6904', addressLocality: 'Lugano' },
        'supsi-dti':                                 { streetAddress: 'Via Cantonale 2c',         postalCode: '6928', addressLocality: 'Manno' },
        // Graubünden companies
        'kantonsspital-graubunden-ksgr':             { streetAddress: 'Loëstrasse 170',           postalCode: '7000', addressLocality: 'Chur' },
        'kantonsspital-graubunden':                  { streetAddress: 'Loëstrasse 170',           postalCode: '7000', addressLocality: 'Chur' },
        'tsmg':                                      { streetAddress: 'Masanserstrasse 2',        postalCode: '7000', addressLocality: 'Chur' },
        // Ticino companies missing from original list
        'board-international':                       { streetAddress: 'Corso San Gottardo 46',    postalCode: '6830', addressLocality: 'Chiasso' },
        'alten-switzerland':                         { streetAddress: 'Via Industria 1',          postalCode: '6855', addressLocality: 'Stabio' },
        'fincons-group':                             { streetAddress: 'Via Cantonale 2a',         postalCode: '6928', addressLocality: 'Manno' },
        'fondazione-la-fonte':                       { streetAddress: 'Via Trevano 55',           postalCode: '6900', addressLocality: 'Lugano' },
        'bracco-suisse-s-a':                         { streetAddress: 'Via del Piano 29',         postalCode: '6926', addressLocality: 'Montagnola' },
        'bracco-suisse':                             { streetAddress: 'Via del Piano 29',         postalCode: '6926', addressLocality: 'Montagnola' },
        'bracco':                                    { streetAddress: 'Via del Piano 29',         postalCode: '6926', addressLocality: 'Montagnola' },
        'schindler':                                 { streetAddress: 'Via Cantonale 1',          postalCode: '6532', addressLocality: 'Castione' },
        'abb-svizzera-sede-ticino':                  { streetAddress: 'Via Cantonale 32',         postalCode: '6572', addressLocality: 'Quartino' },
        'abb':                                       { streetAddress: 'Via Cantonale 32',         postalCode: '6572', addressLocality: 'Quartino' },
        'ruag-ag':                                   { streetAddress: 'Via Campagna 1',           postalCode: '6517', addressLocality: 'Arbedo' },
        'post-ch-ag':                                { streetAddress: 'Piazza Stazione 1',        postalCode: '6500', addressLocality: 'Bellinzona' },
        'postfinance-ag':                            { streetAddress: 'Piazza Stazione 1',        postalCode: '6500', addressLocality: 'Bellinzona' },
        'ariston-group':                             { streetAddress: 'Via Cantonale 31',         postalCode: '6930', addressLocality: 'Bedano' },
        'skyguide':                                  { streetAddress: 'Via Aeroporto',            postalCode: '6982', addressLocality: 'Agno' },
        'skyguide-sa':                               { streetAddress: 'Via Aeroporto',            postalCode: '6982', addressLocality: 'Agno' },
        'sunrise-communications-ag':                 { streetAddress: 'Via Cantonale 2c',         postalCode: '6928', addressLocality: 'Manno' },
        'zucchetti-switzerland-sa':                  { streetAddress: 'Via Dunant 7',             postalCode: '6828', addressLocality: 'Balerna' },
        'goline-sa':                                 { streetAddress: 'Via Industria 5',          postalCode: '6855', addressLocality: 'Stabio' },
        'avaloq':                                    { streetAddress: 'Via Cantonale 10',         postalCode: '6900', addressLocality: 'Lugano' },
        'lidl-svizzera':                             { streetAddress: 'Via Industria 6',          postalCode: '6593', addressLocality: 'Cadenazzo' },
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
        // Ginevra (per Bracco Plan-les-Ouates)
        'plan-les-ouates': 'Route de Saint-Julien 7',
      };

      /** Normalise a locality string to extract the core city name for lookup.
       *  Strips suffixes like ", Switzerland", ", Ticino", "TI + smart working", postal codes, etc. */
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
        'TI': 'Piazza Governo', 'GR': 'Bahnhofstrasse 1', 'GE': 'Route de Saint-Julien 7',
        'ZH': 'Bahnhofstrasse 1', 'BE': 'Bundesplatz 1', 'LU': 'Bahnhofstrasse 1',
        'VS': 'Place de la Planta 1', 'VD': 'Place de la Palud 2',
      };

      /** Derive streetAddress from job data, company HQ, or city generic.
       *  Always returns a street address (canton capital as last resort). */
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
        const canton = String(job.canton || job.addressRegion || 'TI').toUpperCase().trim();
        return CANTON_CAPITAL_ADDRESS[canton] || CANTON_CAPITAL_ADDRESS['TI'] || 'Piazza Governo';
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
      const searchPageCopy: Record<'it' | 'en' | 'de' | 'fr', {
        title: (name: string) => string;
        description: (name: string, count: number) => string;
        heading: (name: string) => string;
        openListing: string;
        editorial: string;
      }> = {
        it: {
          title: (name: string) => `Offerte di lavoro ${name} in Ticino | Frontaliere Ticino`,
          description: (name: string, count: number) => `Scopri ${count} annunci di lavoro attivi per ${name} in Ticino. Apri le offerte aggiornate, confronta aziende e vai subito alla candidatura.`,
          heading: (name: string) => `Lavoro ${name} in Ticino`,
          openListing: 'Apri il job board completo',
          editorial: 'Gli annunci di lavoro sono raccolti direttamente dai siti ufficiali delle aziende ticinesi e aggiornati quotidianamente. Ogni offerta rimanda alla pagina di candidatura originale del datore di lavoro. Il job board copre tutti i settori presenti in Ticino: sanità, finanza, tecnologia, ingegneria, commercio e amministrazione.',
        },
        en: {
          title: (name: string) => `${name} jobs in Ticino | Frontaliere Ticino`,
          description: (name: string, count: number) => `Browse ${count} active job listings for ${name} in Ticino. Open the latest roles, compare employers and jump to the original application page.`,
          heading: (name: string) => `${name} jobs in Ticino`,
          openListing: 'Open the full job board',
          editorial: 'Job listings are sourced directly from official company career pages in Ticino and refreshed daily. Every listing links to the employer\'s original application page. The job board covers all sectors present in Ticino: healthcare, finance, technology, engineering, retail, and administration.',
        },
        de: {
          title: (name: string) => `${name} Jobs im Tessin | Frontaliere Ticino`,
          description: (name: string, count: number) => `Entdecke ${count} aktive Stellenanzeigen fur ${name} im Tessin. Offne aktuelle Jobs, vergleiche Arbeitgeber und springe direkt zur Bewerbung.`,
          heading: (name: string) => `${name} Jobs im Tessin`,
          openListing: 'Komplettes Job Board offnen',
          editorial: 'Stellenanzeigen werden direkt von den offiziellen Karriereseiten der Tessiner Unternehmen bezogen und täglich aktualisiert. Jedes Inserat verlinkt zur originalen Bewerbungsseite des Arbeitgebers. Das Job Board deckt alle im Tessin vertretenen Branchen ab: Gesundheit, Finanzen, Technologie, Ingenieurwesen, Handel und Verwaltung.',
        },
        fr: {
          title: (name: string) => `Offres d'emploi ${name} au Tessin | Frontaliere Ticino`,
          description: (name: string, count: number) => `Consultez ${count} offres d'emploi actives pour ${name} au Tessin. Ouvrez les annonces a jour, comparez les employeurs et accedez directement a la candidature.`,
          heading: (name: string) => `Emploi ${name} au Tessin`,
          openListing: 'Ouvrir le job board complet',
          editorial: 'Les offres d\'emploi proviennent directement des portails carrière officiels des entreprises tessinoises et sont actualisées quotidiennement. Chaque annonce renvoie à la page de candidature originale de l\'employeur. Le job board couvre tous les secteurs présents au Tessin : santé, finance, technologie, ingénierie, commerce et administration.',
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
       *  so that expired soft-landing pages never overwrite a live job page. */
      const activeJobDirs = new Set<string>();

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
          const title = `${localizedTitle} — ${job.company} | ${localeCopy[locale].suffix}`;
          const localizedDescriptionRaw = String(job?.descriptionByLocale?.[locale] || job.description || '');
          const localizedDescription = normalizeText(localizedDescriptionRaw);
          const cleanDesc = cleanMetaDescription(localizedDescriptionRaw);
          // Build an SEO-friendly meta description: "{title} presso {company} a {location}. {clean body}"
          const metaIntro = locale === 'de'
            ? `${localizedTitle} bei ${job.company} in ${job.location || 'Ticino'}.`
            : locale === 'fr'
              ? `${localizedTitle} chez ${job.company} à ${job.location || 'Ticino'}.`
              : locale === 'en'
                ? `${localizedTitle} at ${job.company} in ${job.location || 'Ticino'}.`
                : `${localizedTitle} presso ${job.company} a ${job.location || 'Ticino'}.`;
          const metaBody = cleanDesc.length > 40 ? ` ${cleanDesc}` : '';
          const description = `${metaIntro}${metaBody}`.slice(0, 320);
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
          const fallbackParagraphs = localeCopy[locale].practicalNotes;
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
              return `<li style="margin:0 0 8px 0"><a href="${href}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(relatedTitle)}</a><div style="font-size:12px;color:#64748b">${esc(r.company)} · ${esc(r.location)}</div></li>`;
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
          const addressLocality = isValidAddress(rawLocality) ? rawLocality : String(job.location || 'Ticino');
          const addressRegion = String(job.canton || 'TI');
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
            ...alternates.map((h) => `    <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
            ...(xDefaultHref ? [`    <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`] : []),
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
              ? localizedDescription.slice(0, 5000)
              : `${metaIntro} ${localizedDescription}`.trim().slice(0, 5000));
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
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                ...(streetAddress ? { streetAddress } : {}),
                addressLocality,
                addressRegion,
                addressCountry,
                ...(postalCode ? { postalCode } : {}),
              },
            },
            ...(Number.isFinite(salaryMin) ? {
              baseSalary: {
                '@type': 'MonetaryAmount',
                currency: salaryCurrency,
                value: {
                  '@type': 'QuantitativeValue',
                  minValue: salaryMin,
                  ...(Number.isFinite(salaryMax) ? { maxValue: salaryMax } : {}),
                  unitText: 'YEAR',
                },
              },
            } : {}),
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
              { '@type': 'ListItem', position: 2, name: localeCopy[locale].sectionName, item: `${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}` },
              { '@type': 'ListItem', position: 3, name: localizedTitle, item: canonicalUrl },
            ],
          });

          const outDir = np.join(distDir, canonicalPath.slice(1));
          activeJobDirs.add(canonicalPath.slice(1).replace(/\/+$/, ''));
          _md(outDir, { recursive: true });
          const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${logoUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:image" content="${logoUrl}">
    <link rel="canonical" href="${canonicalUrl}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preload" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" as="style" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap" media="print" onload="this.media='all'"><noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&family=Outfit:wght@700;800&display=swap"></noscript>
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
${jobLd ? `    <script type="application/ld+json">${jobLd}</script>\n` : ''}    <script type="application/ld+json">${breadcrumbLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
  </head>
  <body>
    <div id="root">
    <main class="static-job-page">
      <article class="proposal">
        <section class="hero">
          <h1 class="hero-title">${esc(localizedTitle)}</h1>
          <div class="hero-sub">${esc(job.company)} · ${esc(job.location)} (${esc(job.canton || 'TI')})</div>
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
      ${related.length > 0 ? `<section class="related"><h2>${esc(localeCopy[locale].relatedJobs)}</h2><ul style="list-style:none;padding:0;margin:0">${relatedHtml}</ul></section>` : ''}
    </main>
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
          _qw(np.join(outDir, 'index.html'), html);
          // Also write flat .html so /slug serves 200 (avoids GitHub Pages 301 redirect)
          // Uses a canonical bridge page instead of a noindex/meta-refresh alias
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            _md(np.dirname(flatFile), { recursive: true });
            _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
              noindex: true,
            });
            const legacyDir = np.join(distDir, legacyRel);
            if (!fs.existsSync(np.join(legacyDir, 'index.html'))) {
              _md(legacyDir, { recursive: true });
              _qw(np.join(legacyDir, 'index.html'), legacyHtml);
            }
            const legacyFlat = np.join(distDir, legacyRel + '.html');
            if (!fs.existsSync(legacyFlat)) {
              _md(np.dirname(legacyFlat), { recursive: true });
              _qw(legacyFlat, legacyHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
            }
          }
        }
      }

      /* ── Company landing pages ────────────────────────────────── */
      const companyRoutePrefix: Record<'it' | 'en' | 'de' | 'fr', string> = {
        it: 'azienda',
        en: 'company',
        de: 'unternehmen',
        fr: 'entreprise',
      };
      const companyCopy: Record<'it' | 'en' | 'de' | 'fr', {
        title: (companyName: string) => string;
        description: (companyName: string, count: number) => string;
        heading: (companyName: string) => string;
        viewAll: string;
        sectionName: string;
        editorial: string;
      }> = {
        it: {
          title: (companyName: string) => `Offerte di lavoro ${companyName} in Ticino | Frontaliere Ticino`,
          description: (companyName: string, count: number) => `Scopri ${count} posizioni aperte presso ${companyName} in Ticino. Consulta gli annunci attivi, sedi e link ufficiali di candidatura.`,
          heading: (companyName: string) => `${companyName} - offerte di lavoro in Ticino`,
          viewAll: 'Vedi tutte le offerte',
          sectionName: 'Cerca lavoro in Ticino',
          editorial: 'Questa pagina raccoglie le posizioni aperte pubblicate direttamente sul sito aziendale. Gli annunci vengono aggiornati quotidianamente dal nostro crawler automatico e collegano alla pagina di candidatura ufficiale. Se non trovi posizioni attive, l\'azienda potrebbe non avere ruoli aperti in Ticino al momento — salva la pagina per ricevere aggiornamenti.',
        },
        en: {
          title: (companyName: string) => `${companyName} jobs in Ticino | Frontaliere Ticino`,
          description: (companyName: string, count: number) => `Browse ${count} open roles at ${companyName} in Ticino. Review active listings, locations and official application links.`,
          heading: (companyName: string) => `${companyName} jobs in Ticino`,
          viewAll: 'View all jobs',
          sectionName: 'Find jobs in Ticino',
          editorial: 'This page lists positions published directly on the company\'s career portal. Listings are refreshed daily by our automated crawler and link to the official application page. If no roles are shown, the company may not have open positions in Ticino right now — bookmark this page to stay updated.',
        },
        de: {
          title: (companyName: string) => `${companyName} Jobs im Tessin | Frontaliere Ticino`,
          description: (companyName: string, count: number) => `Entdecke ${count} offene Stellen bei ${companyName} im Tessin. Sieh aktive Jobs, Standorte und offizielle Bewerbungslinks.`,
          heading: (companyName: string) => `${companyName} Jobs im Tessin`,
          viewAll: 'Alle Stellen ansehen',
          sectionName: 'Jobs im Tessin',
          editorial: 'Auf dieser Seite finden Sie Stellen, die direkt auf der Karriereseite des Unternehmens veröffentlicht wurden. Die Angebote werden täglich von unserem automatischen Crawler aktualisiert und verlinken zur offiziellen Bewerbungsseite. Wenn keine Stellen angezeigt werden, gibt es derzeit möglicherweise keine offenen Positionen im Tessin.',
        },
        fr: {
          title: (companyName: string) => `Offres d'emploi ${companyName} au Tessin | Frontaliere Ticino`,
          description: (companyName: string, count: number) => `Consultez ${count} postes ouverts chez ${companyName} au Tessin. Retrouvez les annonces actives, lieux et liens officiels de candidature.`,
          heading: (companyName: string) => `${companyName} - offres d'emploi au Tessin`,
          viewAll: 'Voir toutes les offres',
          sectionName: 'Trouver un emploi au Tessin',
          editorial: 'Cette page rassemble les postes publiés directement sur le portail carrière de l\'entreprise. Les annonces sont actualisées quotidiennement par notre robot et renvoient à la page de candidature officielle. Si aucun poste n\'est affiché, l\'entreprise n\'a peut-être pas de postes ouverts au Tessin actuellement.',
        },
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
          const copy = companyCopy[locale];
          const title = copy.title(companyName);
          const description = copy.description(companyName, companyJobs.length);

          const alternates = localeList.map((l) => {
            const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
            const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
            return { lang: l, href: `${BASE_URL}${withSlash(p)}` };
          });
          const xDefaultHrefC = (alternates.find((h) => h.lang === 'it') || alternates[0])?.href || '';
          const hreflangHtml = [
            ...alternates.map((h) => `    <link rel="alternate" hreflang="${h.lang}" href="${h.href}">`),
            ...(xDefaultHrefC ? [`    <link rel="alternate" hreflang="x-default" href="${xDefaultHrefC}">`] : []),
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

          const companyHtml = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <link rel="canonical" href="${canonicalUrl}">
${hreflangHtml}
    <script type="application/ld+json">${breadcrumbLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
  </head>
  <body>
    <div id="root">
    <main class="static-job-page">
      <h1>${esc(copy.heading(companyName))}</h1>
      <p>${esc(description)}</p>
      <ul style="list-style:none;padding:0;margin:16px 0">${jobListHtml}</ul>
      <p><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionSlug}`.replace(/\/+/g, '/'))}">${esc(copy.viewAll)}</a></p>
      <p style="margin-top:16px;font-size:14px;color:#475569;line-height:1.6">${esc(copy.editorial)}</p>
    </main>
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

          const outDir = np.join(distDir, canonicalPath.slice(1));
          _md(outDir, { recursive: true });
          _qw(np.join(outDir, 'index.html'), companyHtml);
          // Flat .html variant
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            _md(np.dirname(flatFile), { recursive: true });
            _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
              noindex: true,
            });
            const rawDir = np.join(distDir, rawRelPath);
            if (!fs.existsSync(np.join(rawDir, 'index.html'))) {
              _md(rawDir, { recursive: true });
              _qw(np.join(rawDir, 'index.html'), redirectHtml);
            }
            const rawFlat = np.join(distDir, rawRelPath + '.html');
            if (!fs.existsSync(rawFlat)) {
              _md(np.dirname(rawFlat), { recursive: true });
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

        for (const locale of localeList) {
          const model = buildJobTodayLandingModel({
            jobs: validJobs,
            locale,
            now: new Date().toISOString(),
            localizedSlug,
            baseUrl: BASE_URL,
            sectionSlug: sectionByLocale[locale],
            localePrefix: localePrefix[locale],
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
              });
              const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
              return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
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
              { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
              { name: model.heading, item: canonicalUrl },
            ],
            items: [...model.sections.last24Hours.jobs, ...model.sections.last3Days.jobs, ...model.sections.partTime.jobs],
          });

          const editorialHtml = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

          const outDir = np.join(distDir, canonicalPath.slice(1));
          _md(outDir, { recursive: true });
          _qw(np.join(outDir, 'index.html'), editorialHtml);
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            _md(np.dirname(flatFile), { recursive: true });
            _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
          }
        }

        const pushEditorialSitemapEntry = (
          buildModel: (locale: typeof localeList[number]) => { slug: string },
          priority: string,
        ) => {
          const itModel = buildModel('it');
          const itPath = withSlash(`/${sectionByLocale.it}/${itModel.slug}`.replace(/\/+/g, '/'));
          const alternateLinks = localeList.map((locale) => {
            const localeModel = buildModel(locale);
            const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localeModel.slug}`.replace(/\/+/g, '/');
            return `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${withSlash(path)}" />`;
          }).join('\n');
          editorialSitemapEntries.push(`  <url>\n    <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`);
        };

        pushEditorialSitemapEntry((locale) => buildJobTodayLandingModel({
          jobs: validJobs,
          locale,
          now: new Date().toISOString(),
          localizedSlug,
          baseUrl: BASE_URL,
          sectionSlug: sectionByLocale[locale],
          localePrefix: localePrefix[locale],
        }), '0.8');

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
              return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
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
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}
    <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
          const outDir = np.join(distDir, canonicalPath.slice(1));
          _md(outDir, { recursive: true });
          _qw(np.join(outDir, 'index.html'), html);
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            _md(np.dirname(flatFile), { recursive: true });
            _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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

        for (const locale of localeList) {
          const model = buildJobNursesHubLandingModel({
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
              const altModel = buildJobNursesHubLandingModel({
                jobs: validJobs,
                locale: altLocale,
                now: new Date().toISOString(),
                localizedSlug,
                baseUrl: BASE_URL,
                sectionSlug: sectionByLocale[altLocale],
                localePrefix: localePrefix[altLocale],
              });
              const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
              return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
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
          const faqHtml = model.faq.map((entry) => `<details style="padding:16px 18px;border-radius:18px;border:1px solid #e2e8f0;background:#ffffff"><summary style="cursor:pointer;font-weight:700;color:#0f172a">${esc(entry.question)}</summary><p style="margin:12px 0 0;color:#475569;line-height:1.7">${esc(entry.answer)}</p></details>`).join('');
          const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}
    <script type="application/ld+json">${faqLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
          const outDir = np.join(distDir, canonicalPath.slice(1));
          _md(outDir, { recursive: true });
          _qw(np.join(outDir, 'index.html'), html);
          const flatPath = canonicalPath.replace(/\/+$/, '');
          if (flatPath) {
            const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
            _md(np.dirname(flatFile), { recursive: true });
            _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
        }), '0.77');

        for (const clusterKey of editorialCareKeys) {
          const italianCareModel = buildJobCareVariantLandingModel({
            jobs: validJobs,
            locale: 'it',
            clusterKey,
            now: new Date().toISOString(),
            localizedSlug,
            baseUrl: BASE_URL,
            sectionSlug: sectionByLocale.it,
            localePrefix: localePrefix.it,
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
                });
                const altPath = `${localePrefix[altLocale]}/${sectionByLocale[altLocale]}/${altModel.slug}`.replace(/\/+/g, '/');
                return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
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
                { name: locale === 'it' ? 'Cerca lavoro in Ticino' : locale === 'en' ? 'Find jobs in Ticino' : locale === 'de' ? 'Jobs im Tessin' : 'Trouver un emploi au Tessin', item: sectionRootUrl },
                { name: locale === 'it' ? 'Infermieri in Ticino' : locale === 'en' ? 'Nurses in Ticino' : locale === 'de' ? 'Pflege-Jobs im Tessin' : 'Infirmiers au Tessin', item: model.parentHubHref },
                { name: model.heading, item: canonicalUrl },
              ],
              items: [...model.feed.jobs, ...model.latestJobs],
            });
            const backLabel = locale === 'it' ? 'Torna all’hub infermieri in Ticino' : locale === 'en' ? 'Back to nurses in Ticino' : locale === 'de' ? 'Zuruck zum Pflege-Hub im Tessin' : 'Retour au hub infirmiers au Tessin';
            const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
            const outDir = np.join(distDir, canonicalPath.slice(1));
            _md(outDir, { recursive: true });
            _qw(np.join(outDir, 'index.html'), html);
            const flatPath = canonicalPath.replace(/\/+$/, '');
            if (flatPath) {
              const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
              _md(np.dirname(flatFile), { recursive: true });
              _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
          }), '0.71');
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
            const canonicalPath = withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}/${model.slug}`.replace(/\/+/g, '/'));
            const canonicalUrl = `${BASE_URL}${canonicalPath}`;
            const alternates = localeList
              .map((altLocale) => {
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
                return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
              })
              .join('\n');
            const typeLinks = model.relatedTypeLinks.length > 0
              ? model.relatedTypeLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#1d4ed8">${link.count}</span></a>`).join('')
              : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
            const sectorLinks = model.relatedSectorLinks.length > 0
              ? model.relatedSectorLinks.map((link) => `<a href="${link.href}" style="display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dcfce7;border-radius:16px;background:#f0fdf4;color:#0f172a;text-decoration:none;font-weight:600"><span>${esc(link.label)}</span><span style="color:#15803d">${link.count}</span></a>`).join('')
              : '<p style="margin:0;color:#64748b;font-size:14px">—</p>';
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
            const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
            const outDir = np.join(distDir, canonicalPath.slice(1));
            _md(outDir, { recursive: true });
            _qw(np.join(outDir, 'index.html'), html);
            const flatPath = canonicalPath.replace(/\/+$/, '');
            if (flatPath) {
              const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
              _md(np.dirname(flatFile), { recursive: true });
              _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
                  return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
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
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
              const outDir = np.join(distDir, canonicalPath.slice(1));
              _md(outDir, { recursive: true });
              _qw(np.join(outDir, 'index.html'), html);
              const flatPath = canonicalPath.replace(/\/+$/, '');
              if (flatPath) {
                const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
                _md(np.dirname(flatFile), { recursive: true });
                _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
                  return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
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
    <title>${esc(model.title)}</title>
    <meta name="description" content="${esc(model.description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(model.title)}">
    <meta property="og:description" content="${esc(model.description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(model.title)}">
    <meta name="twitter:description" content="${esc(model.description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${itemListLd ? `\n    <script type="application/ld+json">${itemListLd}</script>` : ''}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
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
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
              const outDir = np.join(distDir, canonicalPath.slice(1));
              _md(outDir, { recursive: true });
              _qw(np.join(outDir, 'index.html'), html);
              const flatPath = canonicalPath.replace(/\/+$/, '');
              if (flatPath) {
                const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
                _md(np.dirname(flatFile), { recursive: true });
                _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
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
                return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
              })
              .join('\n');
            const listHtml = matchingJobs.map((job: any) => {
              const slug = localizedSlug(job, locale);
              const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
              const href = `${BASE_URL}${withSlash(path)}`;
              const jobTitle = String(job?.titleByLocale?.[locale] || job.title || '');
              return `<li style="margin:0 0 10px 0"><a href="${href}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jobTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} · ${esc(job.location)}</div></li>`;
            }).join('');

            const searchHtml = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
  </head>
  <body>
    <div id="root">
    <main class="static-job-page">
      <h1>${esc(copy.heading(name))}</h1>
      <p>${esc(description)}</p>
      <ul style="list-style:none;padding:0;margin:16px 0">${listHtml}</ul>
      <p><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}">${esc(copy.openListing)}</a></p>
    </main>
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

            const outDir = np.join(distDir, canonicalPath.slice(1));
            _md(outDir, { recursive: true });
            _qw(np.join(outDir, 'index.html'), searchHtml);
            const flatPath = canonicalPath.replace(/\/+$/, '');
            if (flatPath) {
              const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
              _md(np.dirname(flatFile), { recursive: true });
              _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
            }
            searchPageCount++;
          }

          const itPath = withSlash(`/${sectionByLocale.it}/${searchRoutePrefix.it}-${key}`.replace(/\/+/g, '/'));
          const alternateLinks = localeList.map((locale) => {
            const slug = `${searchRoutePrefix[locale]}-${key}`;
            const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
            return `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${withSlash(path)}" />`;
          }).join('\n');
          searchSitemapEntries.push(`  <url>\n    <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.55</priority>\n  </url>`);
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
                return `    <link rel="alternate" hreflang="${altLocale}" href="${BASE_URL}${withSlash(altPath)}">`;
              })
              .join('\n');
            const listHtml = matchingJobs.map((job: any) => {
              const slug = localizedSlug(job, locale);
              const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
              const href = `${BASE_URL}${withSlash(path)}`;
              const jobTitle = String(job?.titleByLocale?.[locale] || job.title || '');
              return `<li style="margin:0 0 10px 0"><a href="${href}" style="text-decoration:none;color:#1e3a8a;font-weight:600">${esc(jobTitle)}</a><div style="font-size:13px;color:#64748b">${esc(job.company)} · ${esc(job.location)}</div></li>`;
            }).join('');

            const comboHtml = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(copy.title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="${localeOg[locale]}">
    <meta property="og:title" content="${esc(copy.title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <link rel="canonical" href="${canonicalUrl}">
${alternates}${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
  </head>
  <body>
    <div id="root">
    <main class="static-job-page">
      <h1>${esc(copy.heading)}</h1>
      <p>${esc(description)}</p>
      <ul style="list-style:none;padding:0;margin:16px 0">${listHtml}</ul>
      <p><a href="${BASE_URL}${withSlash(`${localePrefix[locale]}/${sectionByLocale[locale]}`.replace(/\/+/g, '/'))}">${esc(searchPageCopy[locale].openListing)}</a></p>
      <p style="margin-top:16px;font-size:14px;color:#475569;line-height:1.6">${esc(searchPageCopy[locale].editorial)}</p>
    </main>
    </div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

            const outDir = np.join(distDir, canonicalPath.slice(1));
            _md(outDir, { recursive: true });
            _qw(np.join(outDir, 'index.html'), comboHtml);
            const flatPath = canonicalPath.replace(/\/+$/, '');
            if (flatPath) {
              const flatFile = np.join(distDir, flatPath.slice(1) + '.html');
              _md(np.dirname(flatFile), { recursive: true });
              _qw(flatFile, buildFlatRedirect(canonicalUrl, canonicalPath));
            }
            searchPageCount++;
          }

          const itPath = withSlash(`/${sectionByLocale.it}/${searchRoutePrefix.it}-${comboKey}`.replace(/\/+/g, '/'));
          const alternateLinks = localeList.map((locale) => {
            const slug = `${searchRoutePrefix[locale]}-${comboKey}`;
            const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}`.replace(/\/+/g, '/');
            return `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${withSlash(path)}" />`;
          }).join('\n');
          searchSitemapEntries.push(`  <url>\n    <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.5</priority>\n  </url>`);
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
        return `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
      }).join('\n');
      const landingEntry = `  <url>\n    <loc>${BASE_URL}/cerca-lavoro-ticino/</loc>\n${landingAlternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/cerca-lavoro-ticino/" />\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`;

      const jobEntries = validJobs.map((job) => {
        const perLocaleSlugMap = {
          it: localizedSlug(job, 'it'),
          en: localizedSlug(job, 'en'),
          de: localizedSlug(job, 'de'),
          fr: localizedSlug(job, 'fr'),
        };
        const itPath = withSlash(`/${sectionByLocale.it}/${perLocaleSlugMap.it}`.replace(/\/+/g, '/'));
        const alternateLinks = localeList.map((l) => {
          const p = `${localePrefix[l]}/${sectionByLocale[l]}/${perLocaleSlugMap[l]}`.replace(/\/+/g, '/');
          return `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
        }).join('\n');
        const xDefault = `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
        const jobLastmod = job.crawledAt ? new Date(job.crawledAt).toISOString().slice(0, 10) : dateStamp;
        return `  <url>\n    <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n${xDefault}\n    <lastmod>${jobLastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
      }).join('\n');

      // Company sitemap entries
      const companyEntries = [...companyMap.keys()].map((cSlug) => {
        const itSlug = `${companyRoutePrefix.it}-${cSlug}`;
        const itPath = withSlash(`/${sectionByLocale.it}/${itSlug}`.replace(/\/+/g, '/'));
        const alternateLinks = localeList.map((l) => {
          const lSlug = `${companyRoutePrefix[l]}-${cSlug}`;
          const p = `${localePrefix[l]}/${sectionByLocale[l]}/${lSlug}`.replace(/\/+/g, '/');
          return `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
        }).join('\n');
        const xDefault = `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
        return `  <url>\n    <loc>${BASE_URL}${itPath}</loc>\n${alternateLinks}\n${xDefault}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
      }).join('\n');

      const sitemapJobs = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${landingEntry}\n${companyEntries}\n${searchEntries}\n${jobEntries}\n</urlset>\n`;
      fs.writeFileSync(np.join(distDir, 'sitemap-jobs.xml'), sitemapJobs, 'utf-8');

      const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
      if (fs.existsSync(sitemapIndexPath)) {
        let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
        if (!idx.includes('sitemap-jobs.xml')) {
          idx = idx.replace(
            '</sitemapindex>',
            `  <sitemap>\n    <loc>${BASE_URL}/sitemap-jobs.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`
          );
          fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
        }
      }

      console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${validJobs.length * 4} localized job pages and sitemap-jobs.xml`);

      /* ── Expired-job soft-landing pages ────────────────────────── */
      // 1. Read tracking file + merge current jobs
      const trackingPath = np.resolve(rootDir, 'data/all-known-job-slugs.json');
      let tracking: Record<string, Record<string, string>> = {};
      try {
        tracking = JSON.parse(fs.readFileSync(trackingPath, 'utf-8'));
      } catch { /* file missing or malformed — start fresh */ }

      const currentSlugs = new Set<string>();
      for (const job of validJobs) {
        currentSlugs.add(job.slug);
        if (!tracking[job.slug]) {
          tracking[job.slug] = {};
          for (const locale of localeList) {
            const relPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${localizedSlug(job, locale)}`.replace(/\/+/g, '/');
            tracking[job.slug][locale] = relPath;
          }
        }
      }
      fs.writeFileSync(trackingPath, JSON.stringify(tracking, null, 2) + '\n', 'utf-8');

      // 1b. Merge orphan indexed slugs (GSC-indexed URLs with no matching job)
      //     into the tracking so they get soft-landing pages too.
      const orphanSlugsPath = np.resolve(rootDir, 'data/orphan-indexed-job-slugs.json');
      try {
        const orphanSlugs: string[] = JSON.parse(fs.readFileSync(orphanSlugsPath, 'utf-8'));
        if (Array.isArray(orphanSlugs)) {
          let orphansMerged = 0;
          for (const slug of orphanSlugs) {
            if (!slug || tracking[slug]) continue;
            // Create IT-only tracking entry (we only know the Italian path)
            tracking[slug] = { it: `/cerca-lavoro-ticino/${slug}` };
            orphansMerged++;
          }
          if (orphansMerged > 0) {
            console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Merged ${orphansMerged} orphan GSC slugs into expired tracking`);
          }
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
      }

      // 3. Generate soft-landing pages for expired slugs
      // Pre-build a set of all previousSlugs from active jobs so we can exclude them from
      // expiredSlugs. These slugs will be handled as bridge pages (canonical → new URL) and
      // must NOT appear in the expired sitemap (which would cause validate-canonical failures
      // because bridge HTML has a non-self canonical). The all-writes-are-queued pattern means
      // fs.existsSync cannot guard against the bridge page overwriting the expired HTML, so
      // the cleanest fix is to exclude bridge slugs from expiredSlugs entirely.
      const bridgeSlugSet = new Set<string>();
      // Collect IT paths of all previous slugs so we can also exclude their
      // locale-variant tracking keys (e.g. EN/DE/FR slug for the same old job).
      // The tracking file stores one key per locale slug, all pointing to the
      // same IT path, so we must group by IT path to catch them all.
      const bridgeItPaths = new Set<string>();
      for (const job of validJobs) {
        const prevSlugs = Array.isArray(job.previousSlugs) ? job.previousSlugs : [];
        for (const s of prevSlugs) {
          bridgeSlugSet.add(s);
          const itPath = (tracking[s] as any)?.it;
          if (itPath) bridgeItPaths.add(itPath);
        }
      }
      // Expand: any tracking key whose IT path is the same as a bridge path is also a bridge
      for (const [key, paths] of Object.entries(tracking) as [string, any][]) {
        if (paths?.it && bridgeItPaths.has(paths.it)) bridgeSlugSet.add(key);
      }
      const expiredSlugs = Object.keys(tracking).filter((s) => !currentSlugs.has(s) && !bridgeSlugSet.has(s));

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


      let expiredCount = 0;
      let legacyCount = 0;
      const expiredSitemapEntries: string[] = [];

      const writeSoftLandingPage = (outRelPath: string, html: string) => {
        // Never overwrite an active job page — expired locale paths can
        // collide with active job locale paths when slugs diverge
        if (activeJobDirs.has(outRelPath.replace(/\/+$/, ''))) return;

        const outDir = np.join(distDir, outRelPath);
        // Overwrite bridge/compat pages (e.g. from legacyRedirectsPlugin)
        // but not active job pages (guarded above)
        _qw(np.join(outDir, 'index.html'), html);
        const flatFile = np.join(distDir, outRelPath + '.html');
        _qw(flatFile, html.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
      };

      for (const slug of expiredSlugs) {
        const paths = tracking[slug];
        const ejData = expiredBySlug.get(slug);

        // Build hreflang alternates for this expired slug (x-default → IT version)
        const hreflangLinks = [
          ...localeList.map((l) => {
            const p = paths[l];
            if (!p) return '';
            return `    <link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}">`;
          }).filter(Boolean),
          ...(paths.it ? [`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${withSlash(paths.it)}">`] : []),
        ].join('\n');

        for (const locale of localeList) {
          const relPath = paths[locale];
          if (!relPath) continue;
          const selfUrl = `${BASE_URL}${withSlash(relPath)}`;
          const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/`.replace(/\/+/g, '/');
          const copy = expiredBannerCopy[locale] ?? expiredBannerCopy.it;

          // Rich content from expired-jobs.json
          const jobTitle = String(ejData?.titleByLocale?.[locale] || ejData?.title || copy.title);
          const jobCompany = String(ejData?.company || '');
          const jobLocation = String(ejData?.location || ejData?.addressLocality || '');
          const jobDescription = String(ejData?.descriptionByLocale?.[locale] || '');

          // Title for <title> tag: use job title if available
          const pageTitle = ejData?.title
            ? `${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''} | Frontaliere Ticino`
            : `${esc(copy.title)} | Frontaliere Ticino`;

          const pageDesc = `${esc(jobTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}. ${esc(archiveRelatedLabel[locale] || archiveRelatedLabel.it)}.`;

          // Seed expired job data as window global so the SPA can render
          // rich content (title, company, description) without depending on
          // the runtime expired-jobs.json fetch (which only has recently expired jobs).
          const expiredWindowData = JSON.stringify({
            slug,
            title: ejData?.title || '',
            titleByLocale: ejData?.titleByLocale || {},
            company: ejData?.company || '',
            companyKey: ejData?.companyKey || '',
            location: ejData?.location || ejData?.addressLocality || '',
            descriptionByLocale: ejData?.descriptionByLocale || {},
            slugByLocale: ejData?.slugByLocale || {},
            sector: ejData?.sector || '',
            expiredAt: ejData?.expiredAt || '',
          });

          const softLandingHtml = `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${pageTitle}</title>
    <meta name="description" content="${pageDesc}">
    <link rel="canonical" href="${selfUrl}">
${hreflangLinks}
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Frontaliere Ticino', item: BASE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: localeCopy[locale].sectionName, item: `${BASE_URL}${listingPath}` },
        { '@type': 'ListItem', position: 3, name: jobTitle },
      ],
    })}</script>
    <script>window.__EXPIRED_JOB_DATA__=${expiredWindowData};</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
    ${SPA_ACTION_REDIRECT_SCRIPT}
  </head>
  <body>
    <div id="root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

          writeSoftLandingPage(relPath.slice(1), softLandingHtml);
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

        // Add expired slug to sitemap (one entry per slug, with hreflang alternates)
        const itPath = paths.it ? withSlash(paths.it) : '';
        if (itPath) {
          const altLinks = localeList.map((l) => {
            const p = paths[l];
            if (!p) return '';
            return `    <xhtml:link rel="alternate" hreflang="${l}" href="${BASE_URL}${withSlash(p)}" />`;
          }).filter(Boolean).join('\n');
          const xDefault = `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`;
          const lastmod = ejData?.expiredAt ? new Date(ejData.expiredAt).toISOString().slice(0, 10) : dateStamp;
          expiredSitemapEntries.push(`  <url>\n    <loc>${BASE_URL}${itPath}</loc>\n${altLinks}\n${xDefault}\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.3</priority>\n  </url>`);
        }
      }

      // Write expired jobs sitemap
      if (expiredSitemapEntries.length > 0) {
        const sitemapExpired = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${expiredSitemapEntries.join('\n')}\n</urlset>\n`;
        fs.writeFileSync(np.join(distDir, 'sitemap-jobs-expired.xml'), sitemapExpired, 'utf-8');

        // Register in sitemap index
        const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
        if (fs.existsSync(sitemapIndexPath)) {
          let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
          if (!idx.includes('sitemap-jobs-expired.xml')) {
            idx = idx.replace(
              '</sitemapindex>',
              `  <sitemap>\n    <loc>${BASE_URL}/sitemap-jobs-expired.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`
            );
            fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
          }
        }
      }

      if (expiredCount > 0) {
        console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${expiredCount} soft-landing pages for ${expiredSlugs.length} expired jobs${legacyCount > 0 ? ` (+ ${legacyCount} legacy slug bridges)` : ''}`);
      }

      /* ── Rich bridge pages for previousSlugs of active jobs ────── */
      // These pages serve users arriving via old URLs (bookmarks, search engines).

      let bridgeCount = 0;
      for (const job of validJobs) {
        const prevSlugs = Array.isArray(job.previousSlugs) ? job.previousSlugs : [];
        if (prevSlugs.length === 0) continue;

        for (const locale of localeList) {
          const currentSlug = localizedSlug(job, locale);
          const currentPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${currentSlug}`.replace(/\/+/g, '/');
          const canonicalUrl = `${BASE_URL}${withSlash(currentPath)}`;
          const listingPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/`.replace(/\/+/g, '/');

          for (const oldSlug of prevSlugs) {
            if (oldSlug === currentSlug) continue;
            const oldPath = `${localePrefix[locale]}/${sectionByLocale[locale]}/${oldSlug}`.replace(/\/+/g, '/');
            const outDir = np.join(distDir, oldPath.replace(/^\//, ''));
            if (fs.existsSync(np.join(outDir, 'index.html'))) continue;

            const localizedTitle = String(job.titleByLocale?.[locale] || job.title || '');
            const jobCompany = String(job.company || '');
            const jobLocation = String((job as any).addressLocality || (job as any).location || '');
            const pageTitle = `${esc(localizedTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''} | Frontaliere Ticino`;

            // Pre-inject job data and bridge target so the SPA can show JobBridgeView immediately.
            // JobBridgeView renders: adsbygoogle (AdSense) + Google Sign In + countdown redirect.
            const bridgeWindowData = JSON.stringify({
              title: localizedTitle,
              titleByLocale: job.titleByLocale,
              company: jobCompany,
              location: jobLocation,
            });

            const bridgeHtml = `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${pageTitle}</title>
    <meta name="description" content="${esc(localizedTitle)}${jobCompany ? ` — ${esc(jobCompany)}` : ''}.">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${canonicalUrl}">
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Frontaliere Ticino', item: BASE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: localeCopy[locale]?.sectionName || 'Job Board', item: `${BASE_URL}${listingPath}` },
        { '@type': 'ListItem', position: 3, name: localizedTitle },
      ],
    })}</script>
    ${(() => {
              // JobPosting for bridge pages — mirrors active page schema for SEO continuity
              const desc = String(job.descriptionByLocale?.[locale] || job.description || '');
              // Prefer HTML description for consistency with active page JobPosting
              const htmlDesc = desc.includes('<') ? desc.slice(0, 5000) : desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
              const pc = String((job as any).postalCode || '');
              // Only emit JobPosting if we have sufficient data (including postalCode)
              // to pass the quality guard tests — incomplete schemas are worse than none
              if (htmlDesc.length >= 30 && localizedTitle && jobCompany && pc) {
                const sa = String((job as any).streetAddress || '');
                const ar = String((job as any).addressRegion || (job as any).canton || '');
                const ac = String((job as any).addressCountry || 'CH');
                return `<script type="application/ld+json">${JSON.stringify({
                  '@context': 'https://schema.org',
                  '@type': 'JobPosting',
                  title: localizedTitle,
                  description: htmlDesc,
                  datePosted: toIsoDateTime(job.postedDate),
                  validThrough: toValidThrough(job.postedDate, job.crawledAt),
                  hiringOrganization: { '@type': 'Organization', name: jobCompany },
                  jobLocation: { '@type': 'Place', address: {
                    '@type': 'PostalAddress',
                    ...(sa ? { streetAddress: sa } : {}),
                    addressLocality: jobLocation || undefined,
                    ...(ar ? { addressRegion: ar } : {}),
                    addressCountry: ac,
                    ...(pc ? { postalCode: pc } : {}),
                  }},
                  url: canonicalUrl,
                })}</script>`;
              }
              return '';
            })()}
    <script>window.__BRIDGE_TARGET_SLUG__=${JSON.stringify(currentSlug)};window.__JOB_DATA__=${bridgeWindowData};</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
    ${SPA_ACTION_REDIRECT_SCRIPT}
  </head>
  <body>
    <div id="root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;

            _md(outDir, { recursive: true });
            _qw(np.join(outDir, 'index.html'), bridgeHtml);

            const flatFile = np.join(distDir, oldPath.replace(/^\//, '') + '.html');
            _md(np.dirname(flatFile), { recursive: true });
            _qw(flatFile, bridgeHtml.replace(SPA_ACTION_REDIRECT_SCRIPT, ''));
            bridgeCount++;
          }
        }
      }
      if (bridgeCount > 0) {
        console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Generated ${bridgeCount} previousSlugs bridge pages`);
      }

      /* ── Flush all buffered writes in parallel batches ── */
      const t0 = Date.now();
      await _flushAllWrites();
      console.log(`\x1b[36m[jobs-seo-pages]\x1b[0m Flushed ${_pendingWrites.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    },
  };
}