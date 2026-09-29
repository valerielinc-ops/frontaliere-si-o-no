import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSoliqueDetailContent } from '../scripts/lib/solique-common.mjs';
import { isSpitalMuriJob, isTrustedDomain, SPITAL_MURI_KEY } from '../scripts/lib/spital-muri-job-parser.mjs';

// Issue 5253: the crawler read the Umantis tenant 2997, whose only posting is
// «Teststelle RAV Schnittstelle» (an interface test online since 2021). The
// real board is the Solique iframe on spital-muri.ch; its detail pages use the
// introduction/tasks/profile/offer/benefits layout (real page, minimised).
describe('Spital Muri — Solique board, template (vii)', () => {
  const html = readFileSync(resolve(__dirname, 'fixtures', 'spital-muri', 'solique-detail-hr-4075871.html'), 'utf8');

  it('publishes lead, tasks, profile, offer and perks with list structure', () => {
    const text = extractSoliqueDetailContent(html, { tasksProfileBoard: true });
    expect(text.startsWith('In unserem lebendigen und persönlichen Spital')).toBe(true);
    expect(text).toContain('Ihre Aufgaben\n• Gesamtverantwortung für den HR-Lifecycle');
    expect(text).toContain('Ihr Profil\n• Abgeschlossene Ausbildung im HR-Bereich');
    expect(text.match(/Ihr Profil/g)).toHaveLength(1);
    expect(text).toContain('Ihre Chance\nMit Ihrem Stellenantritt am 1. Januar 2027');
    expect(text).toContain('Ihre Vorteile\n• Ferien: Sie profitieren von Ferien zwischen 25 und 30 Arbeitstagen');
    expect(text).toContain('• Sozialversicherungen: Wir legen Wert auf adäquate Sozialleistungen.');
    expect(text).not.toMatch(/Haben Sie Fragen|Jetzt bewerben|Link zu weiteren Benefits/);
  });

  it('is opt-in: without the flag the established templates run unchanged', () => {
    const text = extractSoliqueDetailContent(html, {});
    expect(text).not.toContain('Ihre Aufgaben');
  });

  it('identifies Solique and the hospital Umantis tenant as trusted', () => {
    expect(SPITAL_MURI_KEY).toBe('spital-muri');
    expect(isTrustedDomain('https://live.solique.ch/spital-muri/job/details/4075871')).toBe(true);
    expect(isTrustedDomain('https://recruitingapp-2997.umantis.com/Vacancies/1/Application/CheckLogin/1')).toBe(true);
    expect(isSpitalMuriJob({ url: 'https://live.solique.ch/spital-muri/job/details/4075871' })).toBe(true);
  });
});
