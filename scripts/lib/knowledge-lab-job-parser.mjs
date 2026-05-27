/**
 * Knowledge Lab — Freshteam job parser
 *
 * API: https://klab.freshteam.com/api/job_postings?status=published
 *   - Returns JSON array of all published jobs
 *   - Each job has: title, description (HTML), branch (city, state, country_code),
 *     department (name), type, applicant_apply_link
 *
 * No detail page fetching needed — all data in one API response.
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Parse the Freshteam API response.
 * @param {Array} jobs - JSON array from the Freshteam API
 * @returns {{ items: Array, totalResults: number }}
 */
export function parseKnowledgeLabListingJson(jobs = []) {
  const items = jobs
    .filter((j) => j?.title && !j?.deleted)
    .map((j) => {
      const branch = j.branch || {};
      const department = j.department || {};
      return {
        jobId: String(j.id),
        title: normalizeSpace(j.title),
        description: j.description ? stripHtml(j.description) : '',
        descriptionHtml: j.description || '',
        location: normalizeSpace(branch.city || ''),
        state: normalizeSpace(branch.state || ''),
        countryCode: normalizeSpace(branch.country_code || ''),
        department: normalizeSpace(department.name || ''),
        employmentType: normalizeSpace(j.type || 'full_time').replace(/_/g, '-'),
        applyUrl: normalizeSpace(j.applicant_apply_link || ''),
        remote: !!j.remote,
        postedDate: j.created_at ? j.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
      };
    });

  return { items, totalResults: items.length };
}

/**
 * Build localized content for a Knowledge Lab job.
 */
export function buildKnowledgeLabLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Switzerland';
  const description = String(job.description || '').trim();
  const department = String(job.department || '').trim();

  const deptClause = department ? ` nel reparto ${department}` : '';
  const itDesc = description
    || `Knowledge Lab cerca un/una ${title}${deptClause} con sede a ${location}. Soluzioni IT innovative per il settore bancario e assicurativo. Candidati tramite il portale ufficiale Knowledge Lab.`;
  const enDesc = description
    || `Knowledge Lab is hiring for the ${title} role based in ${location}. Innovative IT solutions for banking and insurance. Apply through the official Knowledge Lab careers page.`;
  const deDesc = description
    || `Knowledge Lab sucht derzeit für die Position ${title} am Standort ${location}. Innovative IT-Lösungen für Bank- und Versicherungswesen. Bewirb dich über die offizielle Karriereseite.`;
  const frDesc = description
    || `Knowledge Lab recrute actuellement pour le poste ${title} basé à ${location}. Solutions IT innovantes pour la banque et l'assurance. Postulez via le portail officiel.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} knowledge-lab ${location}`),
      en: slugify(`${title} knowledge-lab ${location}`),
      de: slugify(`${title} knowledge-lab ${location}`),
      fr: slugify(`${title} knowledge-lab ${location}`),
    },
  };
}

/**
 * Check whether a job is relevant to any target Swiss canton.
 */
export function isKnowledgeLabTicinoRelevant(job = {}) {
  const loc = normalizeSpace(`${job.location} ${job.state}`);
  if (!loc) return false;
  return isTargetSwissLocation(loc);
}

/**
 * Infer canton code from a job's branch info via the BFS municipality dataset.
 */
export function inferKnowledgeLabCanton(job = {}) {
  return inferAnyCanton(normalizeSpace(`${job.location} ${job.state}`)) || 'CH';
}
