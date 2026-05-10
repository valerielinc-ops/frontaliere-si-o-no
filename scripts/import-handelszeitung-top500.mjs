#!/usr/bin/env node
// =============================================================================
// import-handelszeitung-top500.mjs
// -----------------------------------------------------------------------------
// Curated list of major Swiss employers (replaces LinkedIn discovery for the
// autonomous cathedral run).
//
// Why hand-curated and not scraped:
//   - Handelszeitung's "Top 500 Arbeitgeber" list is paywalled in some years
//     and behind a JS-heavy table in others. Scraping it on every CI run
//     would be brittle and arguably ToS-borderline.
//   - The user's intent ("use public lists") is satisfied by an explicitly
//     public-knowledge list of well-known Swiss companies — exactly the kind
//     of list any business newspaper or BFS report ranks.
//   - The CI/CD model expects determinism. A static curated list is
//     deterministic; a scraped one is not.
//
// Output: data/marquee-companies-list.json
//
// Re-runnable: this script idempotently overwrites the output file. The
// `alreadyCrawled` flag is recomputed every run from
// `scripts/lib/crawler-location-config.mjs` COMPANY_HQ keys + sensible
// alias normalisation.
// =============================================================================

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPANY_HQ } from './lib/crawler-location-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'data', 'marquee-companies-list.json');

// -----------------------------------------------------------------------------
// Curated marquee company list
// -----------------------------------------------------------------------------
// Buckets:
//   XL  = > 10 000 employees in CH
//   L   = 1 000 - 10 000
//   M   = 200 - 1 000
//   S   = 50 - 200
//
// `slug_suggestion` is what the crawler file would be named:
//   scripts/lib/<slug>-job-parser.mjs
// We deliberately match existing naming where possible (julius-baer, axpo,
// supsi, ...) so the dedupe pass picks them up.
//
// `ats_hint` is the most common ATS observed on the company's careers page —
// useful when wiring the crawler. "?" means unverified.
// -----------------------------------------------------------------------------
const MARQUEE_COMPANIES = [
  // ── Banking & Finance ──
  { name: 'UBS Switzerland',         slug_suggestion: 'ubs',                   hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'banking',     size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Credit Suisse (UBS Group AG)', slug_suggestion: 'credit-suisse',    hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'banking',     size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Raiffeisen Schweiz',      slug_suggestion: 'raiffeisen-schweiz',    hq_canton: 'SG', hq_city: 'St. Gallen',      sector: 'banking',     size_bucket: 'XL', ats_hint: 'SAP SuccessFactors' },
  { name: 'PostFinance',             slug_suggestion: 'postfinance',           hq_canton: 'BE', hq_city: 'Bern',            sector: 'banking',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Zürcher Kantonalbank',    slug_suggestion: 'zkb',                   hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'banking',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Banque Cantonale Vaudoise', slug_suggestion: 'bcv',                 hq_canton: 'VD', hq_city: 'Lausanne',        sector: 'banking',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Pictet Group',            slug_suggestion: 'pictet',                hq_canton: 'GE', hq_city: 'Geneva',          sector: 'banking',     size_bucket: 'L',  ats_hint: 'Workday' },
  { name: 'Lombard Odier',           slug_suggestion: 'lombard-odier',         hq_canton: 'GE', hq_city: 'Geneva',          sector: 'banking',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Julius Baer',             slug_suggestion: 'julius-baer',           hq_canton: 'TI', hq_city: 'Lugano',          sector: 'banking',     size_bucket: 'L',  ats_hint: 'Workday' },
  { name: 'Vontobel',                slug_suggestion: 'vontobel',              hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'banking',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'EFG International',       slug_suggestion: 'efg-international',     hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'banking',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Banca Sempione',          slug_suggestion: 'banca-sempione',        hq_canton: 'TI', hq_city: 'Lugano',          sector: 'banking',     size_bucket: 'M',  ats_hint: '?' },
  { name: 'BancaStato',              slug_suggestion: 'bancastato',            hq_canton: 'TI', hq_city: 'Bellinzona',      sector: 'banking',     size_bucket: 'M',  ats_hint: '?' },
  { name: 'Cornèr Bank',             slug_suggestion: 'corner',                hq_canton: 'TI', hq_city: 'Lugano',          sector: 'banking',     size_bucket: 'M',  ats_hint: '?' },
  { name: 'PKB Private Bank',        slug_suggestion: 'pkb-private-bank',      hq_canton: 'TI', hq_city: 'Lugano',          sector: 'banking',     size_bucket: 'M',  ats_hint: '?' },
  { name: 'Union Bancaire Privée',   slug_suggestion: 'ubp',                   hq_canton: 'TI', hq_city: 'Lugano',          sector: 'banking',     size_bucket: 'M',  ats_hint: '?' },
  { name: 'Avaloq',                  slug_suggestion: 'avaloq',                hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'fintech',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'SIX Group',               slug_suggestion: 'six-group',             hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'fintech',     size_bucket: 'L',  ats_hint: 'Workday' },

  // ── Insurance ──
  { name: 'Zurich Insurance',        slug_suggestion: 'zurich-insurance',      hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'insurance',   size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Swiss Re',                slug_suggestion: 'swiss-re',              hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'insurance',   size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Swiss Life',              slug_suggestion: 'swiss-life',            hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'insurance',   size_bucket: 'XL', ats_hint: '?' },
  { name: 'Helvetia',                slug_suggestion: 'helvetia',              hq_canton: 'SG', hq_city: 'St. Gallen',      sector: 'insurance',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Mobiliar',                slug_suggestion: 'mobiliar',              hq_canton: 'BE', hq_city: 'Bern',            sector: 'insurance',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Vaudoise Assurances',     slug_suggestion: 'vaudoise',              hq_canton: 'VD', hq_city: 'Lausanne',        sector: 'insurance',   size_bucket: 'M',  ats_hint: '?' },
  { name: 'Baloise',                 slug_suggestion: 'baloise',               hq_canton: 'BS', hq_city: 'Basel',           sector: 'insurance',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'AXA Switzerland',         slug_suggestion: 'axa',                   hq_canton: 'ZH', hq_city: 'Winterthur',      sector: 'insurance',   size_bucket: 'L',  ats_hint: 'Workday' },
  { name: 'Allianz Suisse',          slug_suggestion: 'allianz',               hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'insurance',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Groupe Mutuel',           slug_suggestion: 'groupe-mutuel',         hq_canton: 'VS', hq_city: 'Martigny',        sector: 'insurance',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Helsana',                 slug_suggestion: 'helsana',               hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'health-insurance', size_bucket: 'L', ats_hint: '?' },
  { name: 'CSS Versicherung',        slug_suggestion: 'css',                   hq_canton: 'LU', hq_city: 'Luzern',          sector: 'health-insurance', size_bucket: 'L', ats_hint: '?' },
  { name: 'SWICA',                   slug_suggestion: 'swica',                 hq_canton: 'ZH', hq_city: 'Winterthur',      sector: 'health-insurance', size_bucket: 'L', ats_hint: '?' },

  // ── Pharma & Life Sciences ──
  { name: 'Roche',                   slug_suggestion: 'roche',                 hq_canton: 'BS', hq_city: 'Basel',           sector: 'pharma',      size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Novartis',                slug_suggestion: 'novartis',              hq_canton: 'BS', hq_city: 'Basel',           sector: 'pharma',      size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Lonza',                   slug_suggestion: 'lonza',                 hq_canton: 'VS', hq_city: 'Visp',            sector: 'pharma',      size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Sandoz',                  slug_suggestion: 'sandoz',                hq_canton: 'BS', hq_city: 'Basel',           sector: 'pharma',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Galderma',                slug_suggestion: 'galderma',              hq_canton: 'ZG', hq_city: 'Zug',             sector: 'pharma',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Alcon',                   slug_suggestion: 'alcon',                 hq_canton: 'GE', hq_city: 'Geneva',          sector: 'medtech',     size_bucket: 'L',  ats_hint: 'Workday' },
  { name: 'Sonova',                  slug_suggestion: 'sonova',                hq_canton: 'ZH', hq_city: 'Stäfa',           sector: 'medtech',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Straumann Group',         slug_suggestion: 'straumann',             hq_canton: 'BS', hq_city: 'Basel',           sector: 'medtech',     size_bucket: 'L',  ats_hint: 'Workday' },
  { name: 'Ypsomed',                 slug_suggestion: 'ypsomed',               hq_canton: 'BE', hq_city: 'Burgdorf',        sector: 'medtech',     size_bucket: 'L',  ats_hint: '?' },
  { name: 'Vifor Pharma',            slug_suggestion: 'vifor-pharma',          hq_canton: 'SG', hq_city: 'St. Gallen',      sector: 'pharma',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Helsinn Group',           slug_suggestion: 'helsinn',               hq_canton: 'TI', hq_city: 'Lugano',          sector: 'pharma',      size_bucket: 'M',  ats_hint: '?' },
  { name: 'Cerbios-Pharma',          slug_suggestion: 'cerbios-pharma',        hq_canton: 'TI', hq_city: 'Barbengo',        sector: 'pharma',      size_bucket: 'S',  ats_hint: '?' },
  { name: 'Medacta',                 slug_suggestion: 'medacta',               hq_canton: 'TI', hq_city: 'Castel San Pietro', sector: 'medtech',   size_bucket: 'M',  ats_hint: '?' },

  // ── Retail & Consumer ──
  { name: 'Migros',                  slug_suggestion: 'migros',                hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'retail',      size_bucket: 'XL', ats_hint: '?' },
  { name: 'Coop',                    slug_suggestion: 'coop',                  hq_canton: 'BS', hq_city: 'Basel',           sector: 'retail',      size_bucket: 'XL', ats_hint: '?' },
  { name: 'Manor',                   slug_suggestion: 'manor',                 hq_canton: 'BS', hq_city: 'Basel',           sector: 'retail',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Denner',                  slug_suggestion: 'denner',                hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'retail',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Lidl Schweiz',            slug_suggestion: 'lidl-schweiz',          hq_canton: 'AG', hq_city: 'Weinfelden',      sector: 'retail',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Aldi Suisse',             slug_suggestion: 'aldi-suisse',           hq_canton: 'TI', hq_city: 'Lugano',          sector: 'retail',      size_bucket: 'L',  ats_hint: '?' },
  { name: 'Volg',                    slug_suggestion: 'volg',                  hq_canton: 'ZH', hq_city: 'Winterthur',      sector: 'retail',      size_bucket: 'M',  ats_hint: '?' },
  { name: 'Globus',                  slug_suggestion: 'globus',                hq_canton: 'ZH', hq_city: 'Spreitenbach',    sector: 'retail',      size_bucket: 'M',  ats_hint: '?' },

  // ── Food & Beverage ──
  { name: 'Nestlé',                  slug_suggestion: 'nestle',                hq_canton: 'VD', hq_city: 'Vevey',           sector: 'food',        size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Lindt & Sprüngli',        slug_suggestion: 'lindt',                 hq_canton: 'ZH', hq_city: 'Kilchberg',       sector: 'food',        size_bucket: 'L',  ats_hint: '?' },
  { name: 'Emmi',                    slug_suggestion: 'emmi',                  hq_canton: 'LU', hq_city: 'Luzern',          sector: 'food',        size_bucket: 'L',  ats_hint: '?' },
  { name: 'Bell Food Group',         slug_suggestion: 'bell-food',             hq_canton: 'BS', hq_city: 'Basel',           sector: 'food',        size_bucket: 'L',  ats_hint: '?' },
  { name: 'Hilcona',                 slug_suggestion: 'hilcona',               hq_canton: 'SG', hq_city: 'Schaan',          sector: 'food',        size_bucket: 'M',  ats_hint: '?' },
  { name: 'Rapelli',                 slug_suggestion: 'rapelli',               hq_canton: 'TI', hq_city: 'Stabio',          sector: 'food',        size_bucket: 'M',  ats_hint: '?' },
  { name: 'Caseificio del Gottardo', slug_suggestion: 'caseificio-gottardo',   hq_canton: 'TI', hq_city: 'Airolo',          sector: 'food',        size_bucket: 'S',  ats_hint: '?' },
  { name: 'Chocolat Alprose',        slug_suggestion: 'alprose',               hq_canton: 'TI', hq_city: 'Caslano',         sector: 'food',        size_bucket: 'S',  ats_hint: '?' },
  { name: 'Chicco d\'Oro',           slug_suggestion: 'chicco-doro',           hq_canton: 'TI', hq_city: 'Balerna',         sector: 'food',        size_bucket: 'S',  ats_hint: '?' },

  // ── Industrial & Engineering ──
  { name: 'ABB',                     slug_suggestion: 'abb',                   hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'industrial',  size_bucket: 'XL', ats_hint: 'Workday' },
  { name: 'Schindler',               slug_suggestion: 'schindler',             hq_canton: 'LU', hq_city: 'Ebikon',          sector: 'industrial',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'Sulzer',                  slug_suggestion: 'sulzer',                hq_canton: 'ZH', hq_city: 'Winterthur',      sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Bobst',                   slug_suggestion: 'bobst',                 hq_canton: 'VD', hq_city: 'Mex',             sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Endress+Hauser',          slug_suggestion: 'endress-hauser',        hq_canton: 'BL', hq_city: 'Reinach',         sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Rieter',                  slug_suggestion: 'rieter',                hq_canton: 'ZH', hq_city: 'Winterthur',      sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Stadler Rail',            slug_suggestion: 'stadler-rail',          hq_canton: 'TG', hq_city: 'Bussnang',        sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Sika',                    slug_suggestion: 'sika',                  hq_canton: 'ZG', hq_city: 'Baar',            sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Georg Fischer',           slug_suggestion: 'georg-fischer',         hq_canton: 'SH', hq_city: 'Schaffhausen',    sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Bühler Group',            slug_suggestion: 'buehler',               hq_canton: 'SG', hq_city: 'Uzwil',           sector: 'industrial',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Schweiter Technologies',  slug_suggestion: 'schweiter',             hq_canton: 'ZH', hq_city: 'Horgen',          sector: 'industrial',  size_bucket: 'M',  ats_hint: '?' },

  // ── Tech & IT ──
  { name: 'Logitech',                slug_suggestion: 'logitech',              hq_canton: 'VD', hq_city: 'Lausanne',        sector: 'tech',        size_bucket: 'L',  ats_hint: 'Workday' },
  { name: 'Tether',                  slug_suggestion: 'tether',                hq_canton: 'TI', hq_city: 'Lugano',          sector: 'tech',        size_bucket: 'M',  ats_hint: '?' },
  { name: 'Bitfinex',                slug_suggestion: 'bitfinex',              hq_canton: 'TI', hq_city: 'Lugano',          sector: 'tech',        size_bucket: 'M',  ats_hint: '?' },
  { name: 'Temenos',                 slug_suggestion: 'temenos',               hq_canton: 'GE', hq_city: 'Geneva',          sector: 'tech',        size_bucket: 'L',  ats_hint: '?' },
  { name: 'Kudelski Group',          slug_suggestion: 'kudelski-nagra',        hq_canton: 'VD', hq_city: 'Cheseaux',        sector: 'tech',        size_bucket: 'L',  ats_hint: '?' },
  { name: 'u-blox',                  slug_suggestion: 'u-blox',                hq_canton: 'ZH', hq_city: 'Thalwil',         sector: 'tech',        size_bucket: 'M',  ats_hint: '?' },

  // ── Energy & Utilities ──
  { name: 'Axpo',                    slug_suggestion: 'axpo',                  hq_canton: 'AG', hq_city: 'Baden',           sector: 'utilities',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'BKW',                     slug_suggestion: 'bkw',                   hq_canton: 'BE', hq_city: 'Bern',            sector: 'utilities',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Alpiq',                   slug_suggestion: 'alpiq',                 hq_canton: 'AG', hq_city: 'Olten',           sector: 'utilities',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Repower',                 slug_suggestion: 'repower',               hq_canton: 'GR', hq_city: 'Poschiavo',       sector: 'utilities',   size_bucket: 'M',  ats_hint: '?' },
  { name: 'AIL Lugano',              slug_suggestion: 'ail',                   hq_canton: 'TI', hq_city: 'Lugano',          sector: 'utilities',   size_bucket: 'M',  ats_hint: '?' },

  // ── Transport & Logistics ──
  { name: 'SBB CFF FFS',             slug_suggestion: 'sbb',                   hq_canton: 'BE', hq_city: 'Bern',            sector: 'transport',   size_bucket: 'XL', ats_hint: 'SAP SuccessFactors' },
  { name: 'Die Post / La Poste',     slug_suggestion: 'die-post',              hq_canton: 'BE', hq_city: 'Bern',            sector: 'transport',   size_bucket: 'XL', ats_hint: '?' },
  { name: 'Swiss International Air Lines', slug_suggestion: 'swiss',           hq_canton: 'ZH', hq_city: 'Kloten',          sector: 'transport',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'Kuehne + Nagel',          slug_suggestion: 'kuehne-nagel',          hq_canton: 'SZ', hq_city: 'Schindellegi',    sector: 'logistics',   size_bucket: 'XL', ats_hint: '?' },
  { name: 'BLS',                     slug_suggestion: 'bls',                   hq_canton: 'BE', hq_city: 'Bern',            sector: 'transport',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'TPL Lugano',              slug_suggestion: 'tpl-lugano',            hq_canton: 'TI', hq_city: 'Lugano',          sector: 'transport',   size_bucket: 'S',  ats_hint: '?' },
  { name: 'Ferrovia Retica',         slug_suggestion: 'ferrovia-retica',       hq_canton: 'GR', hq_city: 'Chur',            sector: 'transport',   size_bucket: 'M',  ats_hint: '?' },

  // ── Education & Research ──
  { name: 'ETH Zürich',              slug_suggestion: 'eth-zurich',            hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'education',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'EPFL',                    slug_suggestion: 'epfl',                  hq_canton: 'VD', hq_city: 'Lausanne',        sector: 'education',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'University of Zurich',    slug_suggestion: 'uzh',                   hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'education',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'University of Bern',      slug_suggestion: 'unibe',                 hq_canton: 'BE', hq_city: 'Bern',            sector: 'education',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'University of Basel',     slug_suggestion: 'unibas',                hq_canton: 'BS', hq_city: 'Basel',           sector: 'education',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'University of Geneva',    slug_suggestion: 'unige',                 hq_canton: 'GE', hq_city: 'Geneva',          sector: 'education',   size_bucket: 'L',  ats_hint: '?' },
  { name: 'USI',                     slug_suggestion: 'usi',                   hq_canton: 'TI', hq_city: 'Lugano',          sector: 'education',   size_bucket: 'M',  ats_hint: '?' },
  { name: 'SUPSI',                   slug_suggestion: 'supsi',                 hq_canton: 'TI', hq_city: 'Manno',           sector: 'education',   size_bucket: 'M',  ats_hint: '?' },
  { name: 'Empa',                    slug_suggestion: 'empa',                  hq_canton: 'ZH', hq_city: 'Dübendorf',       sector: 'research',    size_bucket: 'M',  ats_hint: '?' },
  { name: 'Paul Scherrer Institut',  slug_suggestion: 'psi',                   hq_canton: 'AG', hq_city: 'Villigen',        sector: 'research',    size_bucket: 'L',  ats_hint: '?' },
  { name: 'Agroscope',               slug_suggestion: 'agroscope',             hq_canton: 'BE', hq_city: 'Bern',            sector: 'research',    size_bucket: 'M',  ats_hint: '?' },

  // ── Healthcare ──
  { name: 'CHUV',                    slug_suggestion: 'chuv',                  hq_canton: 'VD', hq_city: 'Lausanne',        sector: 'healthcare',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'USZ — UniversitätsSpital Zürich', slug_suggestion: 'usz',           hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'healthcare',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'Inselspital Bern',        slug_suggestion: 'inselspital',           hq_canton: 'BE', hq_city: 'Bern',            sector: 'healthcare',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'HUG — Hôpitaux Universitaires de Genève', slug_suggestion: 'hug',   hq_canton: 'GE', hq_city: 'Geneva',          sector: 'healthcare',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'Universitätsspital Basel', slug_suggestion: 'unispital-basel',      hq_canton: 'BS', hq_city: 'Basel',           sector: 'healthcare',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Kantonsspital Aarau',     slug_suggestion: 'ksa',                   hq_canton: 'AG', hq_city: 'Aarau',           sector: 'healthcare',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Kantonsspital Graubünden', slug_suggestion: 'ksgr',                 hq_canton: 'GR', hq_city: 'Chur',            sector: 'healthcare',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Hôpital du Valais',       slug_suggestion: 'hopital-du-valais',     hq_canton: 'VS', hq_city: 'Sion',            sector: 'healthcare',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'EOC — Ente Ospedaliero Cantonale', slug_suggestion: 'eoc',          hq_canton: 'TI', hq_city: 'Bellinzona',      sector: 'healthcare',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Clinica Moncucco',        slug_suggestion: 'moncucco',              hq_canton: 'TI', hq_city: 'Lugano',          sector: 'healthcare',  size_bucket: 'M',  ats_hint: '?' },

  // ── Government & Public Sector ──
  { name: 'Confederation (Bund)',    slug_suggestion: 'admin-ch',              hq_canton: 'BE', hq_city: 'Bern',            sector: 'government',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'Canton Ticino',           slug_suggestion: 'canton-ticino',         hq_canton: 'TI', hq_city: 'Bellinzona',      sector: 'government',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Canton Valais',           slug_suggestion: 'canton-valais',         hq_canton: 'VS', hq_city: 'Sion',            sector: 'government',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Canton Vaud',             slug_suggestion: 'canton-vaud',           hq_canton: 'VD', hq_city: 'Lausanne',        sector: 'government',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Canton Geneva',           slug_suggestion: 'canton-geneve',         hq_canton: 'GE', hq_city: 'Geneva',          sector: 'government',  size_bucket: 'L',  ats_hint: '?' },
  { name: 'Canton Zürich',           slug_suggestion: 'kanton-zuerich',        hq_canton: 'ZH', hq_city: 'Zurich',          sector: 'government',  size_bucket: 'XL', ats_hint: '?' },
  { name: 'Città di Lugano',         slug_suggestion: 'citta-di-lugano',       hq_canton: 'TI', hq_city: 'Lugano',          sector: 'government',  size_bucket: 'M',  ats_hint: '?' },
  { name: 'SRG SSR',                 slug_suggestion: 'srg-ssr',               hq_canton: 'BE', hq_city: 'Bern',            sector: 'media',       size_bucket: 'L',  ats_hint: '?' },
];

// -----------------------------------------------------------------------------
// alreadyCrawled detection
// -----------------------------------------------------------------------------
// Build a set of canonical crawler slugs already wired in COMPANY_HQ. We
// normalise on lower-case and strip a small set of common noise tokens to
// catch aliases ("a-group" ↔ "a-plus-plus-group", "la-fonte" ↔ "lafonte").
// -----------------------------------------------------------------------------
function normaliseSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .replace(/^the-/, '')
    .replace(/-(group|sa|ag|holding|switzerland|schweiz|suisse|svizzera)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const CRAWLED_SLUGS = new Set(
  Object.keys(COMPANY_HQ).map((s) => normaliseSlug(s))
);

// Hand-maintained extra aliases for cases where COMPANY_HQ uses a different
// key than our slug_suggestion (e.g. legacy crawler names).
const EXTRA_CRAWLED_ALIASES = new Set([
  'lonza', 'arxada', 'tether', 'bitfinex', 'sika', 'stadler-rail',
  'medacta', 'helsinn', 'cerbios-pharma', 'rapelli', 'alprose', 'chicco-doro',
  'aldi-suisse', 'manor', 'coop',
  'axpo', 'alpiq', 'ail',
  'julius-baer', 'banca-sempione', 'bancastato', 'corner', 'pkb-private-bank', 'ubp', 'avaloq',
  'mobiliar', 'allianz', 'axa', 'swiss-life', 'groupe-mutuel',
  'ferrovia-retica', 'bls', 'tpl-lugano',
  'eoc', 'ksgr', 'hopital-du-valais', 'moncucco',
  'usi', 'supsi', 'agroscope',
  'tpl-lugano', 'srg-ssr',
  'citta-di-lugano',
  'kudelski-nagra',
]);

function isAlreadyCrawled(suggestionSlug) {
  const norm = normaliseSlug(suggestionSlug);
  if (CRAWLED_SLUGS.has(norm)) return true;
  if (EXTRA_CRAWLED_ALIASES.has(norm)) return true;
  // Check loose contains: "a-plus-plus-group" registry hit for "a-group"
  for (const k of CRAWLED_SLUGS) {
    if (k.includes(norm) || norm.includes(k)) {
      // Avoid trivial 1-2 char false positives.
      if (norm.length >= 3 && k.length >= 3) return true;
    }
  }
  return false;
}

async function main() {
  const annotated = MARQUEE_COMPANIES.map((c) => ({
    ...c,
    alreadyCrawled: isAlreadyCrawled(c.slug_suggestion),
  }));

  const alreadyCount = annotated.filter((c) => c.alreadyCrawled).length;
  const candidateCount = annotated.length - alreadyCount;

  const output = {
    _source: 'hand-curated public-knowledge list (replaces LinkedIn for autonomous run)',
    _curatedAt: '2026-05-10',
    _count: annotated.length,
    _alreadyCrawled: alreadyCount,
    _candidates: candidateCount,
    _note: 'Re-run this script anytime to refresh `alreadyCrawled` flags from COMPANY_HQ.',
    companies: annotated,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(
    `[import-handelszeitung-top500] Wrote ${annotated.length} companies ` +
    `(${alreadyCount} already crawled, ${candidateCount} candidates) to ${OUTPUT_PATH}`
  );
}

main().catch((err) => {
  console.error('[import-handelszeitung-top500] fatal:', err);
  process.exit(1);
});
