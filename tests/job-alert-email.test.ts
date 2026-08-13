import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAlertEmail,
  mailerooMetaOnSent,
  __setFirestoreAdminForTest,
} from '../scripts/send-job-alerts.mjs';

// Minimal Firestore fake capturing .collection().doc().collection().doc().set() chains,
// recording the final docId + payload so the maileroo-meta writer can be asserted.
function createMetaFakeDb() {
  const sets: Array<{ docId: string; data: any; merge: boolean }> = [];
  const docNode = (id: string): any => ({
    collection: () => collectionNode(),
    set: (data: any, opts: any) => {
      sets.push({ docId: id, data, merge: !!opts?.merge });
      return Promise.resolve();
    },
  });
  const collectionNode = (): any => ({ doc: (id: string) => docNode(id) });
  return { db: { collection: () => collectionNode() }, sets };
}

const fixtureAlert = (locale: 'it' | 'en' | 'de' | 'fr') => ({
  id: 'alert-test-1',
  email: 'test@example.com',
  locale,
  keywords: ['Software Engineer'],
  locations: ['Lugano'],
  sectors: [],
});

const fixtureJob = (overrides = {}) => ({
  title: 'Senior Software Engineer',
  company: 'Acme Corp',
  location: 'Lugano',
  contract: 'Full-time',
  slug: 'senior-software-engineer-acme-corp-lugano',
  slugByLocale: {},
  titleByLocale: {},
  firstSeenAt: new Date().toISOString(),
  ...overrides,
});

describe('job alert email — subject personalization', () => {
  it('IT: single job → uses Italian preposition "presso"', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.subject).toMatch(/^🔔.*Senior Software Engineer.*presso.*Acme Corp/);
    expect(result.subject.length).toBeLessThanOrEqual(78);
  });

  it('EN: 5 jobs → "Title at Company (+4 more)"', () => {
    const jobs = Array.from({ length: 5 }, (_, i) => fixtureJob({ title: `Job ${i + 1}` }));
    const result = buildAlertEmail(fixtureAlert('en'), jobs, true);
    expect(result.subject).toMatch(/^🔔 Job 1 at Acme Corp \(\+4 more\)$/);
  });

  it('DE: uses "bei" + "weitere"', () => {
    const jobs = [fixtureJob(), fixtureJob({ title: 'Other' })];
    const result = buildAlertEmail(fixtureAlert('de'), jobs, true);
    expect(result.subject).toMatch(/bei Acme Corp \(\+1 weitere\)$/);
  });

  it('FR: uses "chez" + "autres"', () => {
    const jobs = [fixtureJob(), fixtureJob({ title: 'Other' })];
    const result = buildAlertEmail(fixtureAlert('fr'), jobs, true);
    expect(result.subject).toMatch(/chez Acme Corp \(\+1 autres\)$/);
  });

  it('truncates very long job titles to keep subject under 78 chars', () => {
    const job = fixtureJob({
      title: 'Extremely Long Job Title That Goes On And On And On To Trigger Truncation',
    });
    const result = buildAlertEmail(fixtureAlert('en'), [job], true);
    expect(result.subject.length).toBeLessThanOrEqual(78);
    // either the title was truncated OR the rest was preserved — but never longer
  });
});

describe('job alert email — headline-locale backstop (second line of defense)', () => {
  // Live regression (2026-07-27): an 'it' subscriber's subject AND lead card
  // were built from the top-ranked job's title, which was 100% untranslated
  // German ("Fachperson Gesundheit Universitäre Klinik per Altersmedizin",
  // employer Stadtspital Zürich) — even though a lower-ranked job in the SAME
  // email had a correctly-localized Italian title. The upstream
  // needsRetranslation flag is *supposed* to exclude untranslated titles
  // before they reach buildAlertEmail, but has real detection gaps by
  // construction. buildAlertEmail must not trust shownJobs[0]'s title blindly:
  // it now headlines the first job whose title reliably reads as the alert's
  // locale (via detectJobTitleLocaleDetails, same 0.55 confidence bar as the
  // upstream gate). Fixture mirrors the real title/employer, swapping in a
  // stronger German dictionary word ("Fachfrau" instead of "Fachperson", which
  // isn't in the detector's DE hint list) so it deterministically crosses the
  // 0.55 bar in this test — the literal live-bug string itself only scored
  // ~0.45, illustrating that even this backstop can't catch every case.
  const wrongLocaleJob = () => fixtureJob({
    title: 'Fachfrau Gesundheit Universitäre Klinik für Altersmedizin',
    company: 'Stadtspital Zürich',
  });
  const correctLocaleJob = () => fixtureJob({
    title: 'Infermiere di reparto medicina interna',
    company: 'Ospedale Regionale',
  });

  it('headlines the correctly-localized job when the top-ranked job is untranslated', () => {
    // Rank order matters: index 0 is the "best match" per scoreJobForAlert —
    // deliberately the untranslated German job here, mirroring the live bug.
    const jobs = [wrongLocaleJob(), correctLocaleJob()];
    const result = buildAlertEmail(fixtureAlert('it'), jobs, true);

    // (a) subject is derived from the correctly-localized job, not the German one.
    expect(result.subject).toContain('Infermiere');
    expect(result.subject).not.toContain('Fachfrau');

    // (b) the correctly-localized job is the first rendered card, in both
    // the HTML and plaintext alternatives.
    expect(result.html.indexOf('Infermiere')).toBeGreaterThan(-1);
    expect(result.html.indexOf('Fachfrau')).toBeGreaterThan(-1);
    expect(result.html.indexOf('Infermiere')).toBeLessThan(result.html.indexOf('Fachfrau'));
    expect(result.text.indexOf('Infermiere')).toBeGreaterThan(-1);
    expect(result.text.indexOf('Fachfrau')).toBeGreaterThan(-1);
    expect(result.text.indexOf('Infermiere')).toBeLessThan(result.text.indexOf('Fachfrau'));

    // (c) the German-titled job is demoted, NOT dropped — unlike
    // needsRetranslation (which excludes a flagged job entirely), it still
    // appears further down (its salary/location/company data is still valid).
    expect(result.html).toContain('Fachfrau');
    expect(result.text).toContain('Fachfrau');
  });

  it('falls back to the top-ranked job when NO job passes the locale check (never breaks a send)', () => {
    // Edge case: a single-job alert whose only job is untranslated. There is
    // no better option to headline — the email must still build successfully,
    // with a non-empty subject, rather than crash or send blank.
    const result = buildAlertEmail(fixtureAlert('it'), [wrongLocaleJob()], true);
    expect(result.subject).toBeTruthy();
    expect(result.subject.length).toBeGreaterThan(0);
    expect(result.subject).toContain('Fachfrau');
    expect(result.html).toContain('Fachfrau');
    expect(result.text).toContain('Fachfrau');
  });
});

describe('job alert email — honest counts (shown jobs, never the raw pool size)', () => {
  // Live regression (July 2026): "🔔 186 nuove offerte per te" on an email
  // rendering 10 cards. The candidate pool is a rolling crawledAt window that
  // re-admits the whole re-crawled inventory daily (~16k jobs, only ~400
  // genuinely new), so the raw match count is meaningless as a "new" claim.
  // Every stated count must describe what the email actually shows.
  it('hero and preheader count the rendered cards (max 10), not all matches', () => {
    const jobs = Array.from({ length: 186 }, (_, i) => fixtureJob({ title: `Job ${i + 1}` }));
    const result = buildAlertEmail(fixtureAlert('it'), jobs, true);
    expect(result.html).toContain('10 nuove offerte per te');
    expect(result.html).not.toContain('186 nuove');
    // Preheader too.
    expect(result.html).toContain('10 nuove offerte:');
    // Plaintext hero line.
    expect(result.text).toContain('10 nuove offerte per te');
  });

  it('subject "+N more" counts the other rendered cards, not the pool', () => {
    const jobs = Array.from({ length: 186 }, (_, i) => fixtureJob({ title: `Job ${i + 1}` }));
    const result = buildAlertEmail(fixtureAlert('en'), jobs, true);
    expect(result.subject).toContain('(+9 more)');
    expect(result.subject).not.toContain('185');
  });

  it('counts stay exact when fewer than 10 jobs match', () => {
    const jobs = Array.from({ length: 3 }, (_, i) => fixtureJob({ title: `Job ${i + 1}` }));
    const result = buildAlertEmail(fixtureAlert('it'), jobs, true);
    expect(result.html).toContain('3 nuove offerte per te');
    expect(result.subject).toContain('(+2 altre offerte)');
  });
});

describe('job alert email — ✨ NUOVA badge keyed on firstSeenAt (48h)', () => {
  it('badges a job first seen within 48h', () => {
    const job = fixtureJob({ firstSeenAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toContain('✨ NUOVA');
  });

  it('does NOT badge a job first seen 5 days ago, even if just re-crawled', () => {
    const job = fixtureJob({
      firstSeenAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      crawledAt: new Date().toISOString(), // re-crawl must not fake novelty
    });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toContain('✨ NUOVA');
  });

  it('does NOT badge a job with no firstSeenAt at all', () => {
    const job = fixtureJob({ firstSeenAt: undefined });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toContain('✨ NUOVA');
  });
});

describe('job alert email — plaintext alternative', () => {
  it('returns text alongside html', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(50);
  });

  it('plaintext contains the job title and url', () => {
    const job = fixtureJob({ title: 'Unique Test Title XYZ' });
    const result = buildAlertEmail(fixtureAlert('en'), [job], true);
    expect(result.text).toContain('Unique Test Title XYZ');
    expect(result.text).toMatch(/frontaliereticino\.ch/);
  });

  it('plaintext does NOT contain HTML tags', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    expect(result.text).not.toMatch(/<[a-z]+/i);
  });
});

describe('job alert email — identity footer', () => {
  it('html contains the recipient email and alert filters', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    expect(result.html).toContain('test@example.com');
    // filterLabel includes keyword + locations
    expect(result.html).toMatch(/(Software Engineer|Lugano)/);
  });

  it('IT identity footer uses Italian phrasing', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.html).toMatch(/inviata\s+a\s+test@example\.com/);
  });
});

describe('job alert email — top-bar manage alerts CTA', () => {
  it('all-jobs button points to the Switzerland-wide aggregate board, not a single canton', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    // "View all jobs" has no single canton to resolve — it must land on the
    // aggregate board (/en/find-jobs-switzerland/), not the fixture job's own
    // canton (Lugano → Ticino) or any other single-canton section.
    expect(result.html).toMatch(/href="[^"]*\/en\/find-jobs-switzerland\/?\?[^"]*"/);
    expect(result.html).not.toMatch(/href="[^"]*\/en\/find-jobs-ticino\/?\?[^"]*"/);
  });
});

describe('job alert email — Feedback-ID header (source check)', () => {
  it('send-job-alerts.mjs sets a Feedback-ID header in the cascade payload', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    expect(src).toMatch(/'Feedback-ID':\s*`job-alert:/);
  });

  it('send-job-alerts.mjs passes plaintext (text field) into the cascade payload', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    expect(src).toMatch(/text:\s*e\.text|payload:\s*\{[^}]*text:/s);
  });
});

describe('job alert email — locale-aware URLs', () => {
  // Regression: send-job-alerts.mjs previously hardcoded IT slug `/preferenze-newsletter`
  // and built job board URLs without the `/{locale}/` prefix for non-IT locales.
  // Mirror the bugs we fixed in send-newsletter.mjs.

  it('IT preferences URL uses IT slug without locale prefix', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/preferenze-newsletter\?email=/);
  });

  it('EN preferences URL uses EN slug with /en/ prefix', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/en\/newsletter-preferences\?email=/);
    expect(result.html).not.toMatch(/\/preferenze-newsletter\?/);
  });

  it('DE preferences URL uses DE slug with /de/ prefix', () => {
    const result = buildAlertEmail(fixtureAlert('de'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/de\/newsletter-einstellungen\?email=/);
  });

  it('FR preferences URL uses FR slug with /fr/ prefix', () => {
    const result = buildAlertEmail(fixtureAlert('fr'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/fr\/preferences-newsletter\?email=/);
  });

  it('IT job board URLs have no locale prefix', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\//);
  });

  it('EN job board URLs are /en/find-jobs-ticino prefixed', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/en\/find-jobs-ticino\//);
    // Must NOT contain unprefixed /find-jobs-ticino/ (job board path without locale)
    expect(result.html).not.toMatch(/https:\/\/frontaliereticino\.ch\/find-jobs-ticino\//);
  });

  it('DE job board URLs are /de/jobs-im-tessin prefixed', () => {
    const result = buildAlertEmail(fixtureAlert('de'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/de\/jobs-im-tessin\//);
    expect(result.html).not.toMatch(/https:\/\/frontaliereticino\.ch\/jobs-im-tessin\//);
  });

  it('FR job board URLs are /fr/trouver-emploi-tessin prefixed', () => {
    const result = buildAlertEmail(fixtureAlert('fr'), [fixtureJob()], true);
    expect(result.html).toMatch(/https:\/\/frontaliereticino\.ch\/fr\/trouver-emploi-tessin\//);
    expect(result.html).not.toMatch(/https:\/\/frontaliereticino\.ch\/trouver-emploi-tessin\//);
  });

  it('plaintext alternative also uses locale-prefixed URLs (EN)', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    expect(result.text).toMatch(/\/en\/find-jobs-ticino\//);
    expect(result.text).not.toMatch(/frontaliereticino\.ch\/find-jobs-ticino\//);
  });
});

describe('job alert email — subject truncation polish', () => {
  // Live regression: the email had "🔔 Revisori dei conti, esperti tecnici… presso MTIC Group (+57 altre offerte)"
  // — truncation cut mid-thought after a comma, leaving a dangling comma in place.
  // New strategy: drop the company before truncating the title — the full title is
  // more informative than "title… presso CompanyName".
  it('keeps the full title intact by dropping company when subject would overflow', () => {
    const job = {
      ...fixtureJob(),
      title: 'Revisori dei conti, esperti tecnici e clinici',
      company: 'MTIC Group',
    };
    const jobs = [job, ...Array.from({ length: 57 }, () => fixtureJob({ title: 'Filler' }))];
    const result = buildAlertEmail(fixtureAlert('it'), jobs, true);
    expect(result.subject.length).toBeLessThanOrEqual(78);
    // No dangling punctuation directly before the ellipsis.
    expect(result.subject).not.toMatch(/[,;:\-]\u2026/);
    // Full title preserved (+9 altre offerte: honest shown-count, 10 cards
    // rendered — never the raw match-pool size) — company was dropped.
    expect(result.subject).toContain('Revisori dei conti, esperti tecnici e clinici');
    expect(result.subject).toContain('(+9 altre offerte)');
    // No "presso ..." segment when company was dropped.
    expect(result.subject).not.toMatch(/\bpresso\b/);
  });

  it('truncates the title at a word boundary only when even the no-company subject overflows', () => {
    const job = {
      ...fixtureJob(),
      // 67-char title — exceeds 78-char cap on its own with " (+1 altre offerte)" suffix.
      title: 'Senior Software Engineering Manager — Distributed Backend Platforms',
      company: 'Acme Corporation International Holdings',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job, fixtureJob()], true);
    expect(result.subject.length).toBeLessThanOrEqual(78);
    // Company dropped → no "presso".
    expect(result.subject).not.toMatch(/\bpresso\b/);
    // Subject must contain an ellipsis (truncation happened).
    expect(result.subject).toMatch(/\u2026/);
    // Word-boundary truncation: the chars immediately before the ellipsis are
    // part of a word ≥3 letters long (no dangling 1-2 letter fragments at the cut).
    // Capture: a space (or start), then a 1-2 letter sequence, then ellipsis.
    expect(result.subject).not.toMatch(/(?:^|\s)[a-zA-Z]{1,2}\u2026/);
    // No dangling punctuation directly before the ellipsis.
    expect(result.subject).not.toMatch(/[,;:\-]\u2026/);
  });

  it('keeps the company segment when the full subject already fits', () => {
    const job = { ...fixtureJob(), title: 'QA Engineer', company: 'Tiny Co' };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    // Short title + short company + no extras: the standard subject form.
    expect(result.subject).toBe('🔔 QA Engineer presso Tiny Co');
  });
});

describe('job alert email — subject title noise (Pensum / gender markers)', () => {
  // Live regression: "🔔 Senior Technical Product Manager - Portafogli (100%… (+48 altre offerte)"
  // — the "(100%)" Pensum overflowed the cap and was truncated mid-token, leaving
  // a dangling unbalanced "(100%…". The subject must drop the Pensum entirely.
  it('strips a trailing workload "(100%)" from the subject title (no dangling paren)', () => {
    // Title reworded to a reliably-Italian phrasing (was originally an
    // English-loanword-heavy title) so this fixture — which is testing
    // Pensum-stripping/truncation, NOT headline-locale selection — doesn't
    // collide with the headline-locale backstop (see the dedicated describe
    // block below): "Senior Technical Product Manager" scores confidence 0.85
    // as 'en' via detectJobTitleLocaleDetails and would otherwise get
    // demoted below a "Filler" job, which is not what this test is about.
    const job = { ...fixtureJob(), title: 'Responsabile Tecnico Prodotto - Gestione Portafogli (100%)', company: 'Helvetia' };
    const jobs = [job, ...Array.from({ length: 48 }, () => fixtureJob({ title: 'Filler' }))];
    const result = buildAlertEmail(fixtureAlert('it'), jobs, true);
    expect(result.subject.length).toBeLessThanOrEqual(78);
    expect(result.subject).not.toContain('100%');
    expect(result.subject).not.toContain('(100%');
    // No unbalanced "(" left anywhere in the subject.
    expect((result.subject.match(/\(/g) || []).length).toBe((result.subject.match(/\)/g) || []).length);
    expect(result.subject).toContain('Responsabile Tecnico Prodotto - Gestione Portafogli');
    // Honest shown-count: 10 cards rendered → +9, not the raw pool size (+48).
    expect(result.subject).toContain('(+9 altre offerte)');
  });

  it('strips range Pensum "(80-100%)" and gender markers "(m/w/d)"', () => {
    const a = buildAlertEmail(fixtureAlert('de'), [{ ...fixtureJob(), title: 'Pflegefachfrau HF (80-100%)' }], true);
    expect(a.subject).not.toContain('%');
    expect(a.subject).toContain('Pflegefachfrau HF');
    const b = buildAlertEmail(fixtureAlert('de'), [{ ...fixtureJob(), title: 'Projektleiter (m/w/d)' }], true);
    expect(b.subject).not.toMatch(/\(m\/w\/d\)/i);
    expect(b.subject).toContain('Projektleiter');
  });

  it('truncateAtWord never leaves an unbalanced bracket even without Pensum stripping', () => {
    // A long parenthetical that is NOT a Pensum/gender marker (so stripTitleNoise
    // leaves it) must still not be cut mid-paren into a dangling "(".
    const job = {
      ...fixtureJob(),
      title: 'Responsabile Vendite Area Nord (Lombardia, Piemonte e Valle d Aosta region)',
      company: 'Distribuzione SA',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job, fixtureJob()], true);
    expect(result.subject.length).toBeLessThanOrEqual(78);
    expect((result.subject.match(/\(/g) || []).length).toBe((result.subject.match(/\)/g) || []).length);
  });

  it('leaves a clean title untouched (no false positives)', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [{ ...fixtureJob(), title: 'Data Analyst', company: 'Tiny Co' }], true);
    expect(result.subject).toBe('🔔 Data Analyst presso Tiny Co');
  });
});

describe('job alert email — UTM hygiene', () => {
  it('utm_medium is "email" (not "job_alert" duplicating utm_source)', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.html).toMatch(/utm_source=job_alert/);
    expect(result.html).toMatch(/utm_medium=email/);
    expect(result.html).not.toMatch(/utm_medium=job_alert/);
  });

  it('plaintext URLs also use utm_medium=email', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.text).toMatch(/utm_medium=email/);
    expect(result.text).not.toMatch(/utm_medium=job_alert/);
  });
});

describe('job alert email — Manage alerts URL points to preferences', () => {
  it('IT manage URL uses /preferenze-newsletter (not the job board)', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    // Top-bar Manage link should land on the preferences page, not just the job board.
    // We assert that at least one occurrence of /preferenze-newsletter is referenced
    // outside the footer "Gestisci preferenze" line.
    const occurrences = (result.html.match(/\/preferenze-newsletter\?/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('EN manage URL uses /en/newsletter-preferences', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    const occurrences = (result.html.match(/\/en\/newsletter-preferences\?/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('job alert sorting — score tiebreak by recency', () => {
  it('sort logic in source uses firstSeenAt as secondary key', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    // Confirms the tiebreak exists in the matching loop (regression guard).
    expect(src).toMatch(/firstSeenAt[\s\S]{0,400}bTime\s*-\s*aTime/);
  });
});

describe('preferences page integration (source check)', () => {
  it('NewsletterPreferences uses SubscriptionPreferencesController in token mode', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../components/pages/NewsletterPreferences.tsx'),
      'utf8',
    );
    expect(src).toMatch(/SubscriptionPreferencesController/);
    expect(src).toMatch(/mode="token"/);
  });
  it('UserProfile embeds SubscriptionPreferencesController in auth mode', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../components/pages/UserProfile.tsx'),
      'utf8',
    );
    expect(src).toMatch(/SubscriptionPreferencesController/);
    expect(src).toMatch(/mode="auth"/);
  });
});

describe('job alert email — brand logo + salary chip', () => {
  it('renders an <img> avatar when a matching brand logo bundle exists', () => {
    const job = fixtureJob({ company: 'EOC \u2013 Ente Ospedaliero Cantonale' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    // Slug = eoc-ente-ospedaliero-cantonale; bundle is public/images/brands/eoc-ente-ospedaliero-cantonale.png
    // Brand logos are served from the CDN (offloaded #1705), not the origin.
    expect(result.html).toMatch(/<img\s+src="https:\/\/cdn\.frontaliereticino\.ch\/images\/brands\/eoc-ente-ospedaliero-cantonale\.png"/);
  });

  it('falls back to an initial-letter avatar when no logo bundle matches', () => {
    const job = fixtureJob({ company: 'Nonexistent Company XYZ' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    // No logo file → no img tag in the avatar position; initial 'N' div instead.
    expect(result.html).not.toMatch(/\/images\/brands\/nonexistent-company-xyz/);
    expect(result.html).toMatch(/font-size:18px;font-weight:800;color:#f97316;">N<\/div>/);
  });

  it('renders a salary chip when the job has salaryMin and salaryMax (annual)', () => {
    const job = fixtureJob({
      company: 'Acme Corp',
      salaryMin: 49500,
      salaryMax: 75000,
      currency: 'CHF',
      baseSalary: { value: { unitText: 'YEAR' } },
    });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    // IT period suffix = /anno; range with en-dash separator.
    expect(result.html).toContain('CHF 49.5K\u201375K/anno');
  });

  it('salary chip uses locale-correct period suffix (EN /year, DE /Jahr, FR /an)', () => {
    const job = fixtureJob({
      company: 'Acme Corp',
      salaryMin: 80000,
      salaryMax: 100000,
      currency: 'CHF',
      baseSalary: { value: { unitText: 'YEAR' } },
    });
    expect(buildAlertEmail(fixtureAlert('en'), [job], true).html).toContain('CHF 80K\u2013100K/year');
    expect(buildAlertEmail(fixtureAlert('de'), [job], true).html).toContain('CHF 80K\u2013100K/Jahr');
    expect(buildAlertEmail(fixtureAlert('fr'), [job], true).html).toContain('CHF 80K\u2013100K/an');
  });

  it('omits the salary chip entirely when the job has no salary data', () => {
    const job = fixtureJob({ company: 'Acme Corp' }); // no salaryMin/Max
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toMatch(/CHF\s+\d/);
  });

  it('formats hourly rate with /ora (IT)', () => {
    const job = fixtureJob({
      company: 'Acme Corp',
      salaryMin: 35,
      salaryMax: 0,
      currency: 'CHF',
      baseSalary: { value: { unitText: 'HOUR' } },
    });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toContain('CHF 35/ora');
  });
});

describe('job alert email — contract chip translation', () => {
  it('IT contract chip: "internship" → "Stage"', () => {
    const job = fixtureJob({ contract: 'internship' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toContain('>Stage<');
    expect(result.html).not.toMatch(/>internship</i);
  });
  it('EN contract chip: "internship" stays "Internship"', () => {
    const job = fixtureJob({ contract: 'internship' });
    const result = buildAlertEmail(fixtureAlert('en'), [job], true);
    expect(result.html).toMatch(/>Internship</);
  });
  it('IT contract chip: "full-time" → "Tempo pieno"', () => {
    const job = fixtureJob({ contract: 'full-time' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toContain('>Tempo pieno<');
  });
  it('DE contract chip: "part-time" → "Teilzeit"', () => {
    const job = fixtureJob({ contract: 'part-time' });
    const result = buildAlertEmail(fixtureAlert('de'), [job], true);
    expect(result.html).toContain('>Teilzeit<');
  });
});

describe('job alert email — brand alias logo lookup', () => {
  it('"Coop Genossenschaft" resolves to coop-ticino logo via alias', () => {
    const job = fixtureJob({ company: 'Coop Genossenschaft' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/\/images\/brands\/coop-ticino\.png/);
  });
});

describe('job alert dedup — per-company cap', () => {
  it('source contains a per-company cap that allows max 2 jobs per company before overflow', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    expect(src).toMatch(/PER_COMPANY_CAP\s*=\s*2/);
    expect(src).toMatch(/perCompany\.get\(key\)\s*\|\|\s*0/);
  });
});

describe('job alert email — initial-letter avatar fallback (no grey globe)', () => {
  // When no bundled brand file matches, the email renders a coloured
  // initial-letter avatar. We deliberately do NOT fall back to a Google favicon
  // (grey globe for unknown domains, wrong logo for aggregator hosts) — both
  // look broken in an inbox.
  it('renders an initial-letter avatar (never a Google favicon) when no bundled logo exists', () => {
    // A long-tail employer NOT in our 72-brand bundle and with no alias mapping
    // in scripts/send-job-alerts.mjs — so tier 1 (bundled) fails and the avatar
    // must fall through to the initial letter, never the grey globe.
    const job = {
      ...fixtureJob(),
      company: 'Nonsense Long Tail Employer XYZ',
      companyKey: 'nonsense-long-tail-employer-xyz',
      url: 'https://nonsense-long-tail-employer-xyz.example/careers/job-1',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toMatch(/google\.com\/s2\/favicons/);
    expect(result.html).toMatch(/font-size:18px;font-weight:800;color:#f97316;">N<\/div>/);
  });

  it('renders the initial letter (no favicon) even when the job URL has a company subdomain', () => {
    const job = {
      ...fixtureJob(),
      company: 'Ticino Premium Properties SA',
      url: 'https://careers.ticinopremium.ch/jobs/consulente-100',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toMatch(/google\.com\/s2\/favicons/);
    expect(result.html).toMatch(/font-size:18px;font-weight:800;color:#f97316;">T<\/div>/);
  });

  it('does NOT fall back to a favicon when the job URL is on a job-board aggregator', () => {
    const job = {
      ...fixtureJob(),
      company: 'Tether Operations Limited',
      url: 'https://www.linkedin.com/comm/jobs/view/4337083572/',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    // Initial-letter avatar should render; no LinkedIn favicon hijack.
    expect(result.html).not.toMatch(/google\.com\/s2\/favicons.*linkedin\.com/);
    expect(result.html).toMatch(/font-size:18px;font-weight:800;color:#f97316;">T<\/div>/);
  });

  it('does NOT fall back to a favicon when the job URL is our own domain', () => {
    const job = {
      ...fixtureJob(),
      company: 'Some Company',
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toMatch(/google\.com\/s2\/favicons.*frontaliereticino/);
    expect(result.html).toMatch(/">S<\/div>/);
  });

  it('bundled logo still wins over the favicon fallback', () => {
    const job = {
      ...fixtureJob(),
      company: 'EOC \u2013 Ente Ospedaliero Cantonale',
      url: 'https://eoc.ch/careers/...',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/\/images\/brands\/eoc-ente-ospedaliero-cantonale\.png/);
    expect(result.html).not.toMatch(/google\.com\/s2\/favicons/);
  });
});

describe('job alert email — broader brand logo matching', () => {
  it('matches via job.companyKey when set, even if display name slug differs', () => {
    const job = {
      ...fixtureJob(),
      company: 'Cornèr Banca SA',
      companyKey: 'corner-banca',
    };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/\/images\/brands\/corner-banca\.png/);
  });

  it('strips legal suffix "AG" so "Banca Cler AG" maps to banca-cler.png', () => {
    const job = { ...fixtureJob(), company: 'Banca Cler AG' };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/\/images\/brands\/banca-cler\.png/);
  });

  it('strips legal suffix "SA" so "Banca Sempione SA" maps to banca-sempione.png', () => {
    const job = { ...fixtureJob(), company: 'Banca Sempione SA' };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/\/images\/brands\/banca-sempione\.png/);
  });

  it('"Coop Genossenschaft" still resolves via alias map', () => {
    const job = { ...fixtureJob(), company: 'Coop Genossenschaft' };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/\/images\/brands\/coop-ticino\.png/);
  });

  it('falls back to initial-letter avatar when neither name, alias, nor stripped slug matches', () => {
    const job = { ...fixtureJob(), company: 'Acme Nonexistent SA' };
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).not.toMatch(/\/images\/brands\/acme/);
    expect(result.html).toMatch(/font-size:18px;font-weight:800;color:#f97316;">A<\/div>/);
  });
});

describe('job alert email — title cleanup', () => {
  // Live regression: titles arrived as "addetti/e pulizia urbana presso..."
  // (lowercase first letter from crawler) and "Posizione aperta: consulente
  // immobiliare..." (filler prefix). Both must be cleaned in the email.
  it('IT: capitalizes the first letter of a lowercased crawled title', () => {
    const job = fixtureJob({ title: 'addetti/e pulizia urbana presso il comune' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toMatch(/>Addetti\/e pulizia urbana presso il comune</);
    expect(result.html).not.toMatch(/>addetti\/e/);
  });

  it('IT: strips "Posizione aperta:" prefix and capitalizes the new first letter', () => {
    const job = fixtureJob({ title: 'Posizione aperta: consulente immobiliare 100% Lugano' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.html).toContain('>Consulente immobiliare 100% Lugano<');
    expect(result.html).not.toMatch(/Posizione aperta:/);
  });

  it('EN: strips "Open position:" prefix', () => {
    const job = fixtureJob({ title: 'Open position: Senior Backend Engineer' });
    const result = buildAlertEmail(fixtureAlert('en'), [job], true);
    expect(result.html).toContain('>Senior Backend Engineer<');
    expect(result.html).not.toMatch(/Open position:/);
  });

  it('cleanup is applied to subject as well as cards', () => {
    const job = fixtureJob({ title: 'addetti/e pulizia urbana', company: 'Acme' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.subject).toMatch(/^🔔\s+Addetti\/e/);
  });

  it('cleanup is applied to plaintext alternative as well', () => {
    const job = fixtureJob({ title: 'Posizione aperta: developer' });
    const result = buildAlertEmail(fixtureAlert('it'), [job], true);
    expect(result.text).toContain('Developer');
    expect(result.text).not.toMatch(/Posizione aperta:/);
  });
});

describe('job alert workflow — TARGET_EMAIL filter (source check)', () => {
  it('script reads TARGET_EMAIL env to build the allowlist', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    expect(src).toMatch(/process\.env\.TARGET_EMAIL/);
    expect(src).toMatch(/new Set\(\[TARGET_EMAIL_RAW\]\)/);
  });

  it('workflow exposes a target_email dispatch input', () => {
    const wf = fs.readFileSync(
      path.resolve(__dirname, '../.github/workflows/send-job-alerts.yml'),
      'utf8',
    );
    expect(wf).toMatch(/target_email:/);
    expect(wf).toMatch(/TARGET_EMAIL:\s*\$\{\{\s*inputs\.target_email\s*\}\}/);
  });

  it("functions/src/newsletterSubscriptionManagement.js implements update_alert + create_alert", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../functions/src/newsletterSubscriptionManagement.js'),
      'utf8',
    );
    expect(src).toMatch(/action === 'update_alert'/);
    expect(src).toMatch(/action === 'create_alert'/);
  });

  it('services/newsletterSubscribers.ts exports updateJobAlert + createJobAlert', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../services/newsletterSubscribers.ts'),
      'utf8',
    );
    expect(src).toMatch(/export\s+(?:async\s+)?function\s+updateJobAlert/);
    expect(src).toMatch(/export\s+(?:async\s+)?function\s+createJobAlert/);
  });
});

describe('job alert maileroo meta — open/click attribution writer (#1140)', () => {
  it('normalizes the email before keying the lookup record (mixed-case → orphan-free)', async () => {
    const { db, sets } = createMetaFakeDb();
    __setFirestoreAdminForTest(db);
    await mailerooMetaOnSent(
      { recipient: { email: '  Seeker@Example.COM ' } },
      { provider: 'maileroo', messageId: 'ref_mixed' },
    );
    __setFirestoreAdminForTest(null);

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      docId: 'ref_mixed',
      merge: true,
      data: { email: 'seeker@example.com', is_job_alert: true },
    });
    // The webhook uses meta.email directly as job_alert_subscribers/{email} doc id,
    // so it must be lowercased/trimmed to hit the real subscriber, not an orphan.
    expect(sets[0].data.email).toBe('seeker@example.com');
  });

  it('writes nothing for non-maileroo providers or missing messageId', async () => {
    const { db, sets } = createMetaFakeDb();
    __setFirestoreAdminForTest(db);
    await mailerooMetaOnSent({ recipient: { email: 'a@b.com' } }, { provider: 'resend', messageId: 'x' });
    await mailerooMetaOnSent({ recipient: { email: 'a@b.com' } }, { provider: 'maileroo' });
    await mailerooMetaOnSent({ recipient: {} }, { provider: 'maileroo', messageId: 'y' });
    __setFirestoreAdminForTest(null);
    expect(sets).toHaveLength(0);
  });

  it('the retry path (processRetryQueue) passes the same onSent so retried sends are attributed', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    // Both the first-send and retry sendEmailCascade calls must wire the same
    // composed callback (sendEmailCascade only accepts one onSent).
    const onSentWirings = src.match(/onSent:\s*onSentComposed/g) || [];
    expect(onSentWirings.length).toBeGreaterThanOrEqual(2);
    // Guard the retry call specifically.
    expect(src).toMatch(/sendEmailCascade\(retryEmails,\s*\{[^}]*onSent:\s*onSentComposed/s);
  });

  it('onSentComposed wires both maileroo meta persist and #3798 delivery persist', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
      'utf8',
    );
    const fnMatch = src.match(/async function onSentComposed\(item, sendResult\) \{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[1]).toMatch(/mailerooMetaOnSent\(item, sendResult\)/);
    expect(fnMatch[1]).toMatch(/persistJobAlertDelivery\(item, sendResult\)/);
  });
});

describe('job alert email — unsubscribe links match the sending domain (anti-spam)', () => {
  // Spam filters flag emails whose link host differs from the From domain
  // (alerts@frontaliereticino.ch). The unsubscribe links + List-Unsubscribe
  // header previously pointed at the raw Cloud Function host
  // (europe-west6-frontaliere-ticino.cloudfunctions.net) — a hard mismatch. They
  // now use an apex path (/disiscrivi-alert/) that the locale-router Worker
  // proxies to the function. The real proxy path is only emitted when
  // NEWSLETTER_SECRET is set (otherwise the builders return a canonical-domain
  // fallback), so exercise the signed path here.
  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret-for-unsub-urls';
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = prevSecret;
  });

  it('never links to the raw cloudfunctions.net host (HTML or plaintext)', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.html).not.toContain('cloudfunctions.net');
    expect(result.text).not.toContain('cloudfunctions.net');
    expect(result.unsubscribeUrl).not.toContain('cloudfunctions.net');
  });

  it('single-alert + all-alerts unsubscribe links use the apex /disiscrivi-alert/ path', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    // Single-alert unsubscribe (also the List-Unsubscribe header value).
    expect(result.html).toMatch(
      /https:\/\/frontaliereticino\.ch\/disiscrivi-alert\/\?alertId=[^"]*&token=/,
    );
    // All-alerts unsubscribe.
    expect(result.html).toMatch(
      /https:\/\/frontaliereticino\.ch\/disiscrivi-alert\/\?email=[^"]*&action=unsubscribe_all/,
    );
    expect(result.text).toMatch(/https:\/\/frontaliereticino\.ch\/disiscrivi-alert\//);
  });

  it('the List-Unsubscribe header value (unsubscribeUrl) is on the sending domain', () => {
    const result = buildAlertEmail(fixtureAlert('it'), [fixtureJob()], true);
    expect(result.unsubscribeUrl).toMatch(
      /^https:\/\/frontaliereticino\.ch\/disiscrivi-alert\//,
    );
  });

  it('jobAlertUnsubscribe reads identifiers from the query on POST (one-click works)', async () => {
    // RFC 8058 one-click POST carries alertId/email/token in the query string,
    // not the body — so the function MUST merge the query into POST params or the
    // one-click verifies an empty token (403) and never unsubscribes.
    //
    // #5746 moved that merge behind resolveRequestParams so a third source (the
    // Cloudflare Worker's private-params header, which keeps the address and the
    // credential out of Cloud Run's request log) could join it. Asserted on the
    // resolver's BEHAVIOUR, not on the shape of the expression: the invariant
    // was never the expression, it is that a POST still resolves what arrived on
    // the query. Its twin for newsletterManageSubscription lives in
    // tests/newsletter-unsubscribe-oneclick.test.ts and reads the same way.
    const { resolveRequestParams } = await import('../functions/src/lib/privateRequestParams.js');
    const resolved = resolveRequestParams({
      method: 'POST',
      query: { alertId: 'alert-1', email: 'user@example.com', token: 'sig' },
      body: { 'List-Unsubscribe': 'One-Click' },
      headers: {},
    });
    expect(resolved.alertId).toBe('alert-1');
    expect(resolved.email).toBe('user@example.com');
    expect(resolved.token).toBe('sig');

    const src = fs.readFileSync(
      path.resolve(__dirname, '../functions/index.js'),
      'utf8',
    );
    const handler = src.slice(src.indexOf('export const jobAlertUnsubscribe'));
    expect(handler).toContain('resolveRequestParams(req, res)');
  });

  it('the locale-router Worker proxies the same /disiscrivi-alert path (no drift)', () => {
    // Pairs the email path to the Worker proxy: if one changes without the other,
    // the apex link 404s. Lock both ends.
    const worker = fs.readFileSync(
      path.resolve(__dirname, '../infra/cloudflare-worker/locale-router.js'),
      'utf8',
    );
    // UNSUB_PROXIES maps the apex path → its Cloud Function origin.
    expect(worker).toMatch(/'\/disiscrivi-alert':\s*`?\$\{CF_FN_BASE\}\/jobAlertUnsubscribe`?/);
    expect(worker).toContain('jobAlertUnsubscribe');
    const wrangler = fs.readFileSync(
      path.resolve(__dirname, '../infra/cloudflare-worker/wrangler.toml'),
      'utf8',
    );
    // Route MUST be a wildcard (`*`): an exact route does not match URLs with a
    // query string, and every emitted unsub link carries `?alertId=…&token=…`.
    expect(wrangler).toContain('frontaliereticino.ch/disiscrivi-alert*');
  });
});

describe('job alert email — dirty locale normalization', () => {
  it('normalizes a regional locale (de-CH) to the German job board, not a broken /de-CH/ prefix', () => {
    const alert = { ...fixtureAlert('it'), locale: 'de-CH' };
    const result = buildAlertEmail(alert, [fixtureJob()], true);
    expect(result.html).not.toContain('/de-CH');
    expect(result.html).toContain('jobs-im-tessin');
  });

  it('normalizes an uppercase locale (FR) to the French job board', () => {
    const alert = { ...fixtureAlert('it'), locale: 'FR' };
    const result = buildAlertEmail(alert, [fixtureJob()], true);
    expect(result.html).toContain('trouver-emploi-tessin');
  });
});
