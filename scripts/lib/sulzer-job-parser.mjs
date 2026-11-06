#!/usr/bin/env node
/**
 * Sulzer job parser — Workday ATS (Swiss operations).
 *
 * Source: https://sulzer.wd502.myworkdayjobs.com/SulzerJobs
 *
 * Usa la factory Workday condivisa (`createWorkdaySwissParser`), come medtronic.
 * Il tenant è globale (~360 vacancy, 2 in Svizzera): la copia generata dal
 * vecchio scaffold leggeva la listing senza facet paese e assegnava `ZH` a
 * qualunque località non riconosciuta (`inferSwissTargetCanton(...) || 'ZH'`),
 * e `Winterthur` a ogni roll-up «N Locations». Lo slice pubblicava così Madrid,
 * Pune, Jundiai, Leeds come vacancy zurighesi, e 23 roll-up con sede primaria
 * a São Paulo, Laverton o Houston come «Winterthur» (issue 9842). La factory
 * applica il facet paese CH, legge la sede PRIMARIA della requisition dal
 * dettaglio e scarta ciò che non risolve a un cantone svizzero: nessun
 * ripiego sull'HQ.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSulzerJobs()  — Fetch and parse all Swiss jobs
 *   - isSulzerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - SULZER_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SULZER_KEY = 'sulzer';
export const SULZER_COMPANY_NAME = 'Sulzer';
export const SULZER_COMPANY_DOMAIN = 'sulzer.com';

const CAREER_URL = 'https://sulzer.wd502.myworkdayjobs.com/SulzerJobs';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Sulzer.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSulzerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SULZER_KEY ||
    key.startsWith('sulzer') ||
    company.includes('sulzer') ||
    url.includes('sulzer.com')
  );
}

/**
 * Validate that a URL belongs to Sulzer's domain.
 *
 * Sulzer uses Workday as its ATS — job apply URLs are hosted under
 * `sulzer.wd502.myworkdayjobs.com`, not `sulzer.com`. We trust the Sulzer
 * tenant on Workday as a first-party domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'sulzer.com' ||
      host.endsWith('.sulzer.com') ||
      host === 'sulzer.wd502.myworkdayjobs.com' ||
      host.endsWith('.sulzer.wd502.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Workday fetcher ───────────────────────────────────────── */

const parser = createWorkdaySwissParser({
  companyKey: SULZER_KEY,
  companyName: SULZER_COMPANY_NAME,
  companyDomain: SULZER_COMPANY_DOMAIN,
  tenantHost: 'sulzer.wd502.myworkdayjobs.com',
  sitePath: 'SulzerJobs',
  careerUrl: CAREER_URL,
  // Required by the factory's config contract only: the factory never uses
  // them to fill a vacancy's location or canton (see
  // resolveWorkdayPrimarySwissLocation).
  defaultCanton: 'ZH',
  defaultCity: 'Winterthur',
  sector: 'Industria',
  defaultSourceLang: 'en',
});

/**
 * Fetch all Sulzer jobs located in Switzerland.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export const fetchAllSulzerJobs = parser.fetchAllJobs;
