/**
 * Osservatore del filtro flusso/stock sul reporter di FABBRICAZIONE (#5661).
 *
 * ── Perche' un file suo, e non dentro article-fabrication-guard.test.ts ─────
 *
 * Perche' li' non girerebbe quando serve. `tests/article-fabrication-guard.test.ts`
 * e' registrato in `KNOWN_LIVE_DATA_TESTS` (legge il corpus vivo), quindi il job
 * `vitest related (PR diff)` lo ESCLUDE con `VITEST_SKIP_LIVE_DATA=true`: un
 * osservatore piazzato la' dentro sarebbe invisibile proprio al gate che deve
 * proteggere. Questi casi non toccano il corpus — girano sulle funzioni pure del
 * reporter — quindi stanno in `tests/ci/`, accanto al gemello di factuality, e
 * girano su ogni PR che tocca il reporter.
 *
 * ── Cosa sorvegliano ───────────────────────────────────────────────────────
 *
 * #5661 e' stata chiusa alle 21:31:13Z del 2026-09-05 e riaperta da un bot alle
 * 22:05:00Z. L'articolo che l'ha fatta riaprire era stato generato il
 * 2026-08-11, venticinque giorni prima della guardia di ammissione, ed era
 * rientrato nel diff del sync solo perche' una PR di riparazione gli aveva
 * corretto un errore geografico. Su un articolo gia' pubblicato il rilievo non
 * e' «ricomparso»: non se n'e' mai andato.
 *
 * `report-synced-article-fabrication.mjs` aveva lo stesso difetto del gemello di
 * factuality — stesso `changedArticleIdsWorktree()`, stessa `createGithubIssue`
 * con titolo stabile — quindi la sua issue sarebbe rimasta immortale allo stesso
 * modo. Il candidato l'ha surfacato `check-sibling-patterns.mjs` come «forte».
 *
 * MUTAZIONI COPERTE (ognuna uccisa da un test):
 *   M1 lo stock torna a poter aprire una issue / fermare il sync  → #1, #4
 *   M2 il flusso smette di escalare (gate reso inerte)            → #2
 *   M3 il fail-open diventa fail-closed (no-op silenzioso)        → #3
 */

import { describe, expect, it } from 'vitest';
import {
  isEscalatableFinding,
  buildFindingsIssue,
} from '../../scripts/ci/report-synced-article-fabrication.mjs';

const vecchio = {
  id: 'articolo-di-agosto',
  dir: 'services/locales/blog-body',
  locale: 'en',
  violations: [{ code: 'fabricated-institution', desc: 'ente inventato', evidence: 'Ufficio X' }],
  isNew: false,
};
const nuovo = { ...vecchio, id: 'articolo-appena-ammesso', isNew: true };

describe('fabrication reporter: escala il flusso, non lo stock (#5661)', () => {
  it('#1 non escala un articolo che il sync ha solo modificato', () => {
    expect(isEscalatableFinding(vecchio)).toBe(false);
  });

  it('#2 escala un articolo ammesso in questo sync', () => {
    expect(isEscalatableFinding(nuovo)).toBe(true);
  });

  it('#3 se flusso e stock non sono distinguibili NON smette di segnalare', () => {
    // Fail-open deliberato: git muto non deve rendere il guard un no-op muto.
    expect(isEscalatableFinding({ ...vecchio, isNew: null })).toBe(true);
    expect(isEscalatableFinding({ ...vecchio, isNew: undefined })).toBe(true);
  });

  it("#4 il corpo della issue non elenca gli articoli gia' pubblicati", () => {
    const report = {
      scanned: 8,
      flagged: 2,
      escalatable: 1,
      diffUnavailable: false,
      findings: [vecchio, nuovo],
    };
    const { description } = buildFindingsIssue(report, 'https://example.test/run/1');
    expect(description).toContain('articolo-appena-ammesso');
    expect(description).not.toContain('articolo-di-agosto');
    // Il conteggio in testa conta gli escalabili, non i segnalati.
    expect(description).toContain('**1** body-locale');
  });
});
