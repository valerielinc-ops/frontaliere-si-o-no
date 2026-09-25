#!/usr/bin/env node
/**
 * Lombard Odier job parser — Workday ATS (Swiss operations).
 *
 * Source: https://lombardodier.wd3.myworkdayjobs.com/Lombard_Odier_Careers
 *
 * Usa la factory Workday condivisa (`createWorkdaySwissParser`), come medtronic.
 * Il tenant è globale (Ginevra, Zurigo, Lussemburgo, Londra, Milano, Hong
 * Kong...) e rifiuta il facet paese con HTTP 400. La copia generata dal
 * vecchio scaffold leggeva quindi la listing intera e assegnava `GE` a
 * qualunque località non riconosciuta (`inferSwissTargetCanton(...) ||
 * 'GE'`), e `Geneva` a ogni roll-up: lo slice pubblicava Luxembourg ×12,
 * London, Milan e Hong Kong come vacancy ginevrine (issue 9842). La factory
 * ripiega sulla listing non filtrata con il gate CH rigoroso, legge la sede
 * PRIMARIA della requisition dal dettaglio e scarta ciò che non risolve a un
 * cantone svizzero: nessun ripiego sull'HQ.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLombardOdierJobs()  — Fetch and parse all Swiss jobs
 *   - isLombardOdierJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - LOMBARD_ODIER_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LOMBARD_ODIER_KEY = 'lombard-odier';
export const LOMBARD_ODIER_COMPANY_NAME = 'Lombard Odier';
export const LOMBARD_ODIER_COMPANY_DOMAIN = 'lombardodier.com';

const CAREER_URL = 'https://lombardodier.wd3.myworkdayjobs.com/Lombard_Odier_Careers';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Lombard Odier.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLombardOdierJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LOMBARD_ODIER_KEY ||
    key.startsWith('lombard-odier') ||
    company.includes('lombard odier') ||
    url.includes('lombardodier.com')
  );
}

/**
 * Validate that a URL belongs to Lombard Odier's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'lombardodier.com' ||
      host.endsWith('.lombardodier.com') ||
      host === 'lombardodier.wd3.myworkdayjobs.com' ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Workday fetcher ───────────────────────────────────────── */

const parser = createWorkdaySwissParser({
  companyKey: LOMBARD_ODIER_KEY,
  companyName: LOMBARD_ODIER_COMPANY_NAME,
  companyDomain: LOMBARD_ODIER_COMPANY_DOMAIN,
  tenantHost: 'lombardodier.wd3.myworkdayjobs.com',
  sitePath: 'Lombard_Odier_Careers',
  careerUrl: CAREER_URL,
  // Required by the factory's config contract only: the factory never uses
  // them to fill a vacancy's location or canton (see
  // resolveWorkdayPrimarySwissLocation).
  defaultCanton: 'GE',
  defaultCity: 'Geneva',
  sector: 'Banking',
  defaultSourceLang: 'en',
});

/**
 * Fetch all Lombard Odier jobs located in Switzerland.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export const fetchAllLombardOdierJobs = parser.fetchAllJobs;
