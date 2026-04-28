import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAlertEmail } from '../scripts/send-job-alerts.mjs';

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
  it('all-jobs button still points to the job board', () => {
    const result = buildAlertEmail(fixtureAlert('en'), [fixtureJob()], true);
    // The "View all jobs" CTA continues to land on /en/find-jobs-ticino
    expect(result.html).toMatch(/href="[^"]*\/en\/find-jobs-ticino\/?\?[^"]*"/);
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
    // Full title preserved (+57 altre offerte) — company was dropped.
    expect(result.subject).toContain('Revisori dei conti, esperti tecnici e clinici');
    expect(result.subject).toContain('(+57 altre offerte)');
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
    expect(result.html).toMatch(/<img\s+src="https:\/\/frontaliereticino\.ch\/images\/brands\/eoc-ente-ospedaliero-cantonale\.png"/);
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
});
