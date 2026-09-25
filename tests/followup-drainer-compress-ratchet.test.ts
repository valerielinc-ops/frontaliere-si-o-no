/**
 * followup-drainer — detectCompressContractDocsRatchet pre-flight (#5523).
 *
 * `compress-contract-docs.yml` apre una singola issue a titolo fisso quando un doc
 * "hot" (AGENTS.md/REVIEW.md/ISSUES.md/FOLLOWUP.md) supera il compress-ceiling. In
 * 8 occorrenze storiche (#1112 #1113 #1569 #3039 #3641 #4136 #4567 #5507) il fixer
 * autonomo non l'ha mai chiusa — sempre una PR umana, spesso con scelte di
 * struttura (es. #5519 ha estratto un'appendice in un nuovo file). Questo detector
 * la intercetta PRIMA della promozione a `agent:fix`.
 */
import { describe, it, expect } from 'vitest';
import { detectCompressContractDocsRatchet } from '../scripts/ci/followup-drainer.mjs';

const RATCHET_TITLE = '📏 Contract docs over compress ceiling — gentle-compress needed';

describe('detectCompressContractDocsRatchet — issue del ratchet (park preemptivo)', () => {
  it('rileva il titolo esatto emesso dal ratchet', () => {
    expect(detectCompressContractDocsRatchet(RATCHET_TITLE)).toBe(true);
  });

  it('tollera whitespace incidentale attorno al titolo', () => {
    expect(detectCompressContractDocsRatchet(`  ${RATCHET_TITLE}  `)).toBe(true);
  });

  it('gestisce input vuoto/null senza throw', () => {
    expect(detectCompressContractDocsRatchet('')).toBe(false);
    expect(detectCompressContractDocsRatchet(undefined as unknown as string)).toBe(false);
  });
});

describe('detectCompressContractDocsRatchet — NON il ratchet (promuovi)', () => {
  it('NON scatta su un titolo simile ma diverso (nessun match parziale)', () => {
    expect(detectCompressContractDocsRatchet('Contract docs over compress ceiling')).toBe(false);
  });

  it('NON scatta su un altro monitor con emoji simile', () => {
    expect(detectCompressContractDocsRatchet('📏 Page size over budget')).toBe(false);
  });

  it('NON scatta su una issue normale', () => {
    expect(detectCompressContractDocsRatchet('fix(seo): canonical errato su /lavoro-zurigo-autista/')).toBe(false);
  });
});
