/**
 * RSBJ (Réseau Santé Balcon du Jura Vaudois) — offer-page body.
 *
 * Fixture: live Jalios offer page "Des médecins porteurs du titre fédéral
 * postgradué de Médecine Interne Générale (FMH)" (2026-09-29), minimized to
 * the header menu, one side-column `wysiwyg` block and the offer; contact
 * persons are placeholders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractRsbjDetailText, fetchAllRsbjJobs } from '../scripts/lib/rsbj-job-parser.mjs';

const DETAIL = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'rsbj', 'detail-medecins-fmh.html'),
  'utf8',
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('extractRsbjDetailText', () => {
  it('starts with the offer facts, not the header menu or the side column', () => {
    const text = extractRsbjDetailText(DETAIL);
    expect(text.startsWith('Type de Contrat : CDI\nTaux : 100 %\nDate d\'entrée : de suite ou à convenir')).toBe(true);
    expect(text).not.toMatch(/Horaires|Accès sécurisé|Référence/);
  });

  it('reads the whole ad, including the sections the 25-fragment cap used to cut', () => {
    const text = extractRsbjDetailText(DETAIL);
    expect(text).toContain('Vous…\n• Êtes au bénéfice d\'un doctorat en médecine');
    expect(text).toContain('Nous offrons…\n• L\'opportunité pour un médecin indépendant');
    expect(text).toContain('• Un travail en partenariat au sein d\'un collège médical régional');
    expect(text).toContain('Votre candidature avec curriculum vitae et documents usuels');
  });

  it('drops the apply button and stray punctuation-only paragraphs', () => {
    const text = extractRsbjDetailText(DETAIL);
    expect(text).not.toContain('Postuler');
    expect(text).not.toMatch(/^\s*\.\s*$/m);
  });

  it('returns an empty string for a page without an offer body', () => {
    expect(extractRsbjDetailText('<ul><li>Horaires</li></ul><div class="wysiwyg classic"><p>Menu</p></div>')).toBe('');
  });
});

describe('fetchAllRsbjJobs', () => {
  it('retries a transient listing 503 before failing the crawler', async () => {
    const listing = '<a href="jcms/rsbj_123/fr/infirmier" class="vignette-a" data-jalios-id=\'rsbj_123\'><div class="title">Infirmier diplômé<br>CDI 100%</div></a>';
    const detail = '<div class="fullDisplay"><div class="publication-metas">Date entrée 01.09.2026</div><div class="wysiwyg"><p>Le RSBJ recherche un-e infirmier-ère pour son équipe de soins.</p></div></div>';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(listing))
      .mockResolvedValueOnce(new Response(detail));

    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', fetcher);

    const jobs = await fetchAllRsbjJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ companyKey: 'rsbj', title: 'Infirmier diplômé' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
