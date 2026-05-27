/**
 * Banca Raiffeisen Vedeggio Cassarate — detail page parser
 *
 * Job detail pages are hosted on the Prospective career center at
 * https://jobs.raiffeisen.ch/posti-vacanti/{slug}/{uuid}
 *
 * HTML structure of a detail page (relevant sections):
 *   <section id="titleAndVisual">
 *     <h1>Job Title<br>100%</h1>
 *   </section>
 *   <section id="intro">
 *     <span class="mainSubTitle">Entra a far parte del nostro team!</span>
 *     <p class="introductionText">…intro paragraph…</p>
 *   </section>
 *   <section id="tasksAndSkills">
 *     <div id="tasks" itemprop="responsibilities">
 *       <h2>Cosa ti aspetta?</h2>
 *       <ul><li>…</li>…</ul>
 *     </div>
 *     <div id="skills" itemprop="qualifications">
 *       <h2>Cosa offri?</h2>
 *       <ul><li>…</li>…</ul>
 *     </div>
 *   </section>
 *   <!-- generic sections below — excluded from description -->
 *   <section id="benefits">Perché Raiffeisen?…</section>
 *   <section id="contact">Hai domande?…</section>
 *   <section id="ctaBig">…</section>
 *   <section id="awards">…</section>
 *   <section id="similarJobs">…</section>
 *
 * The parser:
 *   1. Reads intro paragraph from `section#intro p.introductionText`
 *      (or any intro paragraph when the class is absent)
 *   2. Reads tasksAndSkills from `section#tasksAndSkills`
 *   3. Combines into a single plain-text description
 *   4. Guards: description must be >= MIN_DESC_LENGTH
 *              if a `#tasksAndSkills` section exists but its text is < MIN_TASKS_LENGTH
 *              (relative-body-length guard), a warning is emitted
 *
 * Fallback: if `#tasksAndSkills` is absent, the parser tries to extract any
 * content from `<main>` before the first generic section (benefits, contact, etc.)
 */

import { JSDOM } from 'jsdom';

/** Minimum plain-text description length to accept (characters). */
export const MIN_DESC_LENGTH = 350;

/**
 * Minimum length expected from #tasksAndSkills when the section exists.
 * Shorter content indicates a partial parse / structural change.
 */
const MIN_TASKS_LENGTH = 100;

/** Section IDs that mark the start of generic (non-job-specific) content. */
const GENERIC_SECTION_IDS = new Set(['benefits', 'contact', 'ctaBig', 'awards', 'similarJobs']);

export function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML to plain text, preserving block-level paragraph structure.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .reduce((acc, line) => {
      if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') return acc;
      acc.push(line);
      return acc;
    }, /** @type {string[]} */ ([]))
    .join('\n')
    .trim();
}

/**
 * Parse a Raiffeisen Prospective detail page and extract the job body.
 *
 * @param {string} html - Full HTML of the detail page
 * @returns {{
 *   title: string,
 *   workload: string,
 *   introText: string,
 *   tasksText: string,
 *   skillsText: string,
 *   descriptionText: string,
 *   valid: boolean,
 *   warnings: string[]
 * }}
 */
export function parseRaiffeisenDetailPage(html) {
  const warnings = /** @type {string[]} */ ([]);

  const empty = {
    title: '', workload: '', introText: '', tasksText: '', skillsText: '',
    descriptionText: '', valid: false, warnings,
  };

  if (!html) return empty;

  const document = new JSDOM(html).window.document;

  // ── Title ────────────────────────────────────────────────────────────────
  const h1 = document.querySelector('section#titleAndVisual h1');
  let rawTitle = h1 ? (h1.textContent || '') : '';
  // Separate workload percentage from title: "Consulente Clientela Aziendale\n100%"
  const workloadMatch = rawTitle.match(/(\d+(?:[–\-]\d+)?%)/);
  const workload = workloadMatch ? workloadMatch[1].trim() : '';
  if (workload) rawTitle = rawTitle.replace(workload, '');
  const title = normalizeSpace(rawTitle);

  // ── Intro paragraph ───────────────────────────────────────────────────────
  const introEl = document.querySelector('section#intro p.introductionText') ||
                  document.querySelector('section#intro p');
  const introText = introEl ? htmlToText(introEl.innerHTML) : '';

  // ── Tasks & Skills (Cosa ti aspetta? / Cosa offri?) ───────────────────────
  const tasksAndSkills = document.querySelector('section#tasksAndSkills');

  let tasksText = '';
  let skillsText = '';

  if (tasksAndSkills) {
    const taskEl = tasksAndSkills.querySelector('#tasks, [itemprop="responsibilities"]');
    const skillEl = tasksAndSkills.querySelector('#skills, [itemprop="qualifications"]');

    if (taskEl) {
      tasksText = htmlToText(taskEl.innerHTML);
    }
    if (skillEl) {
      skillsText = htmlToText(skillEl.innerHTML);
    }

    // Relative-body-length guard: if the whole section is too short, warn
    const tasksBodyText = normalizeSpace(tasksAndSkills.textContent || '');
    if (tasksBodyText.length < MIN_TASKS_LENGTH) {
      warnings.push(
        `#tasksAndSkills section found but content is very short ` +
        `(${tasksBodyText.length} chars < ${MIN_TASKS_LENGTH}) — ` +
        `page structure may have changed`
      );
    }
  } else {
    // Fallback: try to extract content from <main> before the first generic section
    const main = document.querySelector('main');
    if (main) {
      let fallbackHtml = '';
      for (const child of main.children) {
        if (GENERIC_SECTION_IDS.has(child.id)) break;
        // Skip purely decorative sections
        if (child.classList.contains('hiddenPrint') && !child.querySelector('p, li, h2')) continue;
        fallbackHtml += child.innerHTML || '';
      }
      if (fallbackHtml) {
        tasksText = htmlToText(fallbackHtml);
        warnings.push(
          '#tasksAndSkills section not found — fell back to <main> content before generic sections'
        );
      }
    }
  }

  // ── Build description text ─────────────────────────────────────────────────
  const parts = [introText, tasksText, skillsText].filter(Boolean);
  const descriptionText = parts.join('\n\n').trim();

  // ── Minimum length guard ───────────────────────────────────────────────────
  if (descriptionText.length < MIN_DESC_LENGTH) {
    warnings.push(
      `Extracted description too short (${descriptionText.length} chars < ${MIN_DESC_LENGTH})`
    );
    return { title, workload, introText, tasksText, skillsText, descriptionText, valid: false, warnings };
  }

  return { title, workload, introText, tasksText, skillsText, descriptionText, valid: true, warnings };
}
