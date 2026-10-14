import { describe, expect, it } from 'vitest';
import {
  extractRhExpertChDetailFields,
  isRhExpertChJob,
  isTrustedDomain,
  RH_EXPERT_CH_KEY,
} from '../scripts/lib/rh-expert-ch-job-parser.mjs';
import { loadSpec } from '../scripts/lib/prospector/spec-crawler.mjs';

describe('RH-Expert source-backed detail extraction', () => {
  const detailUrl = 'https://rh-expert.ch/fr/offres-demploi/commis-de-salle';
  const taskText = '• Mise en place de la salle.• Assiste le chef de rang pendant la durée du service.• Effectue';
  const detailHtml = `<html lang="fr"><body><div class="page_emploi"><div class="inside"><div class="colcontainer">
    <div class="col col-9"><h1>Commis de salle</h1><p class="small">08/10/2026</p>
      <p>${taskText}</p><p>Lieu de travail : Genève et alentours.</p>
    </div><div class="col col-3"><p>1201 Genève</p></div>
  </div></div></div></body></html>`;

  it('uses the detail H1, actual role text and labelled workplace, not the listing CTA or office column', () => {
    const detail = extractRhExpertChDetailFields(detailHtml, detailUrl);
    expect(detail.title).toBe('Commis de salle');
    expect(detail.description).toContain(taskText);
    expect(detail.description).not.toContain('Lieu de travail');
    expect(detail.location).toBe('Genève et alentours');
    expect(detail.canton).toBe('GE');
    expect(detail.locationCandidates).toEqual([
      { location: 'Genève et alentours', addressRegion: 'GE' },
    ]);
  });

  it('drops a detail whose only heading is the source CTA and does not rescue its location from the office sidebar', () => {
    const detail = extractRhExpertChDetailFields(
      '<div class="page_emploi"><div class="col col-9"><h1>En savoir plus</h1><p>Lieu de travail : Genève.</p></div><div class="col col-3"><p>1201 Genève</p></div></div>',
      detailUrl,
    );
    expect(detail.title).toBe('');
    expect(detail.description).toBe('');
    expect(detail.locationCandidates).toEqual([]);
  });

  it('keeps the official RH-Expert spec and rejects marketplace URLs', () => {
    const spec = loadSpec(RH_EXPERT_CH_KEY);
    expect(spec.candidateKey).toBe('rh-expert@geneve');
    expect(spec.revalidateRejectedWithSourceAdapter).toBe(true);
    expect(spec.companyHost).toBe('rh-expert.ch');
    expect(spec.listingCandidateText).toBe('commis de salle');
    expect(spec.sampleTitles).toEqual(['Commis de salle']);
    expect(isRhExpertChJob({ companyKey: RH_EXPERT_CH_KEY })).toBe(true);
    expect(isTrustedDomain(detailUrl)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
  });
});
