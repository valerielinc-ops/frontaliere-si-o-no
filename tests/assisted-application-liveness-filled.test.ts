import { describe, expect, it, vi } from 'vitest';
import { JOB_ACTIVE_IDS_URL, htmlToText } from '../functions/src/assistedApplicationAiJob.js';
import { applyControlsFromHtml, checkPostingLiveness, classifyLiveness, isHardClosed } from '../functions/src/assistedApplicationLiveness.js';

// Stadt Zürich's own posting page (jobs.stadt-zuerich.ch, SuccessFactors career site, read 2026-11-10) once
// the post is filled: the job body holds a single sentence. The structure of the real page, no candidate data.
const STZH_URL = 'https://jobs.stadt-zuerich.ch/job/Synthetic-Role/1000000001/';
const STZH_FILLED = `<!doctype html><html><head><title>Synthetic Role Stellendetails | STZH</title>
<script>var jobDisplay = {};</script></head><body>
<a href="#content" class="skip">Zum Hauptinhalt</a>
<header><nav><a href="/login">Login / Mein Profil</a><button type="button">Sprache</button>
<ul><li><a href="/?locale=de_DE">Deutsch</a></li></ul></nav></header>
<div class="jobDisplayShell" itemscope="itemscope"><div class="jobDisplay"><div class="content">
<div class="jobTitle">
</div>
<div class="job">
<p><strong>Diese Stelle wurde leider bereits besetzt.</strong></p>
</div>
<div class="clear clearfix"></div>
</div></div></div></body></html>`;

const pageOf = (html: string, url = STZH_URL) => classifyLiveness({
  status: 200, requestedUrl: url, finalUrl: url, bodyText: htmlToText(html), applyControls: applyControlsFromHtml(html),
});
const padding = (word: string) => `${word} `.repeat(160).trim();
const openPosting = (sentence: string) => `<main><h1>Sachbearbeiterin / Sachbearbeiter Synthetisch 80-100%</h1>
<p>${padding('Aufgaben')}</p>
<p>${sentence}</p>
<p>${padding('Profil')}</p>
<a href="/apply" class="btn">Jetzt bewerben</a></main>`;

describe('a posting whose post has been filled', () => {
  it('recognizes the standalone Italian apply label without treating ordinary prose as a control', () => {
    expect(classifyLiveness({ status: 200, bodyText: padding('Contenuto'), applyControls: ['Applica'] }))
      .toMatchObject({ result: 'active', code: 'apply_control_visible' });
    expect(classifyLiveness({ status: 200, bodyText: padding('Contenuto'), applyControls: ['Applica ora'] }))
      .toMatchObject({ result: 'active', code: 'apply_control_visible' });
    expect(classifyLiveness({ status: 200, bodyText: padding('Contenuto'), applyControls: ['Si applica il CCL'] }))
      .toMatchObject({ result: 'uncertain', code: 'no_apply_control' });
  });

  it('reads Stadt Zürich\'s filled posting page as a certain closure', () => {
    const page = pageOf(STZH_FILLED);
    expect(page).toMatchObject({ result: 'expired', code: 'expired_body' });
    expect(isHardClosed(page)).toBe(true);
  });

  it('closes the order\'s posting through the gate the runner and the functions run', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === JOB_ACTIVE_IDS_URL) return new Response(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), total: 1, ids: ['stzh-1'] }), { status: 200 });
      return new Response(STZH_FILLED, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
    });
    const liveness = await checkPostingLiveness({
      order: { jobId: 'stzh-1', jobUrl: STZH_URL }, posting: { postingUrl: STZH_URL }, fetchImpl, resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(liveness).toMatchObject({ page: { result: 'expired', code: 'expired_body' }, closed: true });
  });

  it.each([
    'Diese Stelle wurde leider bereits besetzt.',
    'Die Stelle ist leider schon vergeben.',
    'Leider ist diese Stelle bereits besetzt.',
    'Stelle bereits besetzt',
    'Es tut uns leid, die Stelle wurde bereits besetzt.',
    'Posizione già coperta.',
    'Il posto è stato assegnato.',
    'Ci dispiace, questa posizione è già stata coperta.',
    'Ce poste a déjà été pourvu.',
    'Poste pourvu',
    "L'offre a été pourvue.",
    'This position has been filled.',
    'Position has already been filled.',
    "We're sorry, this role has already been filled.",
  ])('closes on its own sentence «%s»', (sentence) => {
    const page = classifyLiveness({ status: 200, bodyText: `Synthetischer Arbeitgeber\n${sentence}\n${padding('Kontakt')}` });
    expect(page).toMatchObject({ result: 'expired', code: 'expired_body' });
    expect(isHardClosed(page)).toBe(true);
  });

  it.each([
    'Diese Stelle wurde leider bereits besetzt.',
    'This position has been filled.',
    'Ce poste a déjà été pourvu.',
    'Il posto è stato assegnato.',
  ])('a sentence that names the posting holds even beside an apply link of the site («%s»)', (sentence) => {
    const page = classifyLiveness({ status: 200, bodyText: `${sentence}\n${padding('Kontakt')}`, applyControls: ['Wie bewerben?'] });
    expect(page).toMatchObject({ result: 'expired', code: 'expired_body' });
  });

  it.each([
    'Die Stelle ist per sofort zu besetzen.',
    'Wir suchen per sofort eine Fachperson, um diese Stelle zu besetzen.',
    'Durch eine Pensionierung ist die Stelle neu zu besetzen.',
    'Wir möchten die Stelle neu besetzen und freuen uns auf Ihre Bewerbung.',
    'Weitere Stellen: Sachbearbeiter 80% – Stelle bereits besetzt',
    'Weitere Stellen, die bereits besetzt sind, finden Sie im Archiv.',
    'Stelle bereits besetzt',
    'Poste pourvu',
    'Posizione già coperta',
    'Position has already been filled',
    'La posizione è coperta da un contratto collettivo.',
    'Le poste est à pourvoir dès que possible.',
    'This position is to be filled as soon as possible.',
  ])('leaves an open posting open: «%s»', (sentence) => {
    const html = openPosting(sentence);
    const page = pageOf(html, 'https://careers.example.test/job/1000000002/');
    expect(page).toMatchObject({ result: 'active', code: 'apply_control_visible' });
    expect(isHardClosed(page)).toBe(false);
  });

  it('does not read a filled post out of a sentence about something else, even with no apply control', () => {
    for (const sentence of [
      'Die Stelle ist per sofort zu besetzen.',
      'Weitere Stellen: Sachbearbeiter 80% – Stelle bereits besetzt',
      'Le poste est à pourvoir dès que possible.',
    ]) {
      const page = classifyLiveness({ status: 200, bodyText: `${padding('Aufgaben')}\n${sentence}\n${padding('Profil')}` });
      expect(page.code).not.toBe('expired_body');
      expect(isHardClosed(page)).toBe(false);
    }
  });
});
