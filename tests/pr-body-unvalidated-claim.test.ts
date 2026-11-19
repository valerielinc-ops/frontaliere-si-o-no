/**
 * Claim di prestazione senza prova nel body della PR (escalation #11675,
 * bucket `reviewer-finding/unvalidated-claim`). Le fixture positive sono le
 * frasi di `## Implementato` dei body che il reviewer ha bocciato con un 🔴
 * (versione del body in vigore alla prima review); le negative sono le forme di
 * prova che il reviewer accetta e numeri che non sono prestazioni.
 */

import { describe, it, expect } from 'vitest';
import {
  checkPrBodySections,
  extractCodeSpanEvidence,
  isConcreteJobWorkflowReference,
  parseDeferredPerfEvidence,
  unvalidatedPerfClaims,
} from '../scripts/lib/pr-body-sections-check.mjs';

function body(impl: string, nonImpl = 'Nessuno.') {
  return `## Implementato\n\n${impl}\n\n## Non implementato (ancora)\n\n${nonImpl}\n`;
}

function strict(text: string) {
  return checkPrBodySections(text, { strictDecisionDeferrals: true });
}

const isClaimViolation = (v: { type: string }) => v.type === 'unvalidated-perf-claim';
const isIoWarning = (w: { type: string }) => w.type === 'unvalidated-io-bound-claim';

// PR 10292, 11641, 10464, 9959: il reviewer ha chiesto la misura pre/post.
const BLOCKING_EXAMPLES: Record<string, string> = {
  '10292': '- Le due fasi condividono una sola chiamata di briefing per lingua. Con le corsie parallele del broker (#10290) i soggetti occupano le corsie che i 4 briefing lasciano ferme: con 3 corsie, circa 30 s in meno per run, senza nessuna chiamata o token in più.',
  '11641': '- `deploy-it-pages-prep.sh` passa il budget alle due chiamate del purge: 45 s sotto il `timeout` esterno (255 s su 300). Con ~12.500 chiavi per deploy il bundle converge in tre deploy, poi si torna ai ~550 purge per deploy delle run ordinarie.',
  '10464': '- `scripts/lib/git-push-with-retry.sh` usa un pack non-thin con ricerca delta disabilitata (`pack.window=0`, `pack.threads=1`) per i checkout shallow di Actions, evitando che il push consumi il margine del job come nel run 36676022222; scelta reversibile, misurata e osservabile secondo VISION D1 — `in questa PR`',
  '9959': '- Corretto `.github/workflows/tests.yml`: quando il compare API raggiunge il cap, il diff locale ricostruito dagli SHA viene marcato `complete` anche se supera 300 path. Questo evita che un diff esatto di 404 file promuova inutilmente la suite completa.',
};

// PR 9950, 11053: lavoro di I/O limitato senza misura. Livello advisory.
const ADVISORY_EXAMPLES: Record<string, string> = {
  '9950': '- Limitato il preflight live-link ai candidati della shortlist di ranking (massimo 10 card), mantenendo il reranking solo quando una pagina della shortlist risulta morta.',
  '11053': '- Corretto il root cause del leak di accounting in `scripts/lib/rehydrate-section-shards.sh`: i marker di release ora vivono fuori dalla directory dello zip; una sezione già completa che rilascia prima del primo download non perde più il proprio riferimento e lo zip viene eliminato quando l\'ultimo lettore termina.',
};

describe('unvalidated-perf-claim: i body bocciati dal reviewer (#11675)', () => {
  for (const [pr, impl] of Object.entries(BLOCKING_EXAMPLES)) {
    it(`PR ${pr}: claim senza prova → violazione`, () => {
      const res = strict(body(impl));
      expect(res.ok).toBe(false);
      expect(res.violations.some(isClaimViolation)).toBe(true);
    });
  }

  for (const [pr, impl] of Object.entries(ADVISORY_EXAMPLES)) {
    it(`PR ${pr}: I/O limitato senza misura → warning, non violazione`, () => {
      const res = strict(body(impl));
      expect(res.violations.some(isClaimViolation)).toBe(false);
      expect(res.warnings.some(isIoWarning)).toBe(true);
    });
  }
});

describe('unvalidated-perf-claim: le prove accettate e i numeri che non sono prestazioni', () => {
  const claim = BLOCKING_EXAMPLES['10292'];

  it('link a una run Actions', () => {
    const res = strict(body(`${claim} Misurato su https://github.com/o/r/actions/runs/36385271711.`));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it('riga «Misura:» con l\'output', () => {
    const res = strict(body(`${claim} Misura: \`node scripts/measure.mjs --lanes 3\` → 64 s prima, 34 s dopo.`));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it('coppia di quantità confrontate', () => {
    const res = strict(body('- Ridotta la memoria del parser: 308 MB RSS nel riferimento contro circa 203 MB RSS.'));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it('claim dichiarato non validato pre-merge con trigger di revert', () => {
    const res = strict(body(
      `${claim} Stima **non validata pre-merge**.`,
      '- Riduzione dei tempi, blocked: misura post-merge sulla run `tests.yml`. **Trigger di revert:** wall-time del job oltre 20 minuti nel primo run → revert di questa PR.',
    ));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it('non considera una stima pre-merge non validata una prova da sola', () => {
    const res = strict(body(
      '- Il nuovo timeout di 30 minuti è una stima pre-merge non ancora validata.',
    ));
    expect(res.violations.some(isClaimViolation)).toBe(true);
  });

  it('non considera sufficiente un trigger scritto nello stesso bullet del claim', () => {
    const res = strict(body(
      '- La riduzione wall-clock non è validata pre-merge. Trigger di revert: se il job supera 30 minuti, revert di questa PR.',
    ));
    expect(res.violations.some(isClaimViolation)).toBe(true);
  });

  it('accetta le varianti linguistiche solo con tracking post-merge completo', () => {
    const res = strict(body(
      '- La riduzione wall-clock non è validata pre-merge.',
      '- blocked: misura post-merge sulla run `tests.yml`; soglia 30 minuti. **Trigger di revert:** se il job supera 30 minuti, revert di questa PR.',
    ));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it('preserva soglia e azione di rollback espresse in code span', () => {
    const residual = '- blocked: verifica post-merge sul workflow `tests.yml`; soglia `30 minuti`. **Trigger di revert:** `rollback` di questa PR.';
    const res = strict(body('- La riduzione wall-clock non è validata pre-merge.', residual));
    expect(extractCodeSpanEvidence(residual)).toEqual(['30 minuti', 'rollback']);
    expect(parseDeferredPerfEvidence(residual)).toMatchObject({
      blocked: true,
      hasRevertAction: true,
      hasThreshold: true,
      hasJobOrWorkflow: true,
      complete: true,
    });
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it.each([
    'blocked: misurazione dopo il merge sul workflow tests.yml; soglia 30 minuti. Trigger di revert: rollback.',
    'blocked: post-merge measurement on workflow tests.yml; threshold 30 min. Revert-trigger: rollback.',
    'blocked: post-merge validation on job build-test; threshold 2 GB. Rollback-trigger: revert.',
  ])('normalizza una variante ammessa della misura differita: %s', (residual) => {
    expect(parseDeferredPerfEvidence(residual).complete).toBe(true);
    const res = strict(body('- La memoria del build non è stata misurata pre-merge.', `- ${residual}`));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it.each([
    'blocked: nessuna misura post-merge sul workflow tests.yml; soglia 30 minuti. Trigger di revert: rollback.',
    'blocked: misura pre-merge sul workflow tests.yml; soglia 30 minuti. Trigger di revert: rollback.',
    'blocked: post-merge measurement on workflow tests.yml; threshold pending. Revert-trigger: rollback.',
    'blocked: post-merge measurement on workflow tests.yml; threshold 30 min. Revert-trigger: osservare.',
  ])('rifiuta una misura differita ambigua o incompleta: %s', (residual) => {
    expect(parseDeferredPerfEvidence(residual).complete).toBe(false);
  });

  it('non usa un code span di rollback estraneo al testo del trigger', () => {
    const residual = 'blocked: post-merge measurement on workflow tests.yml; threshold 30 min. Revert-trigger: observe only; unrelated note: `rollback`.';
    expect(extractCodeSpanEvidence(residual)).toEqual(['rollback']);
    expect(parseDeferredPerfEvidence(residual)).toMatchObject({
      blocked: true,
      hasRevertAction: false,
      hasThreshold: true,
      hasJobOrWorkflow: true,
      complete: false,
    });
  });

  it('riconosce gli ausiliari stato e been nei claim non misurati pre-merge', () => {
    for (const claim of [
      '- Il tempo di build non è stato misurato pre-merge.',
      '- The build time has not been measured pre-merge.',
    ]) {
      const missingPlan = strict(body(claim));
      expect(missingPlan.violations.some(isClaimViolation), `${claim} senza piano`).toBe(true);

      const tracked = strict(body(
        claim,
        '- blocked: misura post-merge sulla run `tests.yml`; soglia 30 minuti. **Trigger di revert:** se il job supera 30 minuti, revert di questa PR.',
      ));
      expect(tracked.violations.some(isClaimViolation), `${claim} con piano`).toBe(false);
    }
  });

  it('non tratta una parola generica come identificatore di job o workflow', () => {
    const res = strict(body(
      '- La riduzione wall-clock non è validata pre-merge.',
      '- blocked: misura post-merge; ci sarà una soglia di 80 MB; **Trigger di revert:** rollback oltre 80 MB.',
    ));
    expect(res.violations.some(isClaimViolation)).toBe(true);
  });

  it('non tratta un file YAML citato dopo prosa come workflow concreto', () => {
    const res = strict(body(
      '- La riduzione wall-clock non è validata pre-merge.',
      '- blocked: misura post-merge; workflow is monitored by `tests.yml`; soglia 30 minuti. **Trigger di revert:** se il job supera 30 minuti, revert di questa PR.',
    ));
    expect(res.violations.some(isClaimViolation)).toBe(true);
  });

  it('numeri che non sono prestazioni («3 file», «12 test»)', () => {
    const res = strict(body('- Aggiornati 3 file del crawler e aggiunti 12 test; il parser evita i duplicati di slug.'));
    expect(res.ok).toBe(true);
    expect(res.violations.some(isClaimViolation)).toBe(false);
    expect(res.warnings.some(isIoWarning)).toBe(false);
  });

  it('i criteri di un gate di qualità non sono un claim («pagine di dettaglio» non è «taglio»)', () => {
    // Frase generata da scripts/prospect-promote.mjs (buildPromotionPrBody).
    const res = strict(body("- **in questa PR** — crawler promossi dal prospector. Ognuno ha superato il gate: qualita' >= 0.9 contro la pagina ufficiale del datore, su almeno 3 pagine di dettaglio, con **2 validazioni buone su 2 giorni** — e con almeno il 85% delle pagine di dettaglio che **legge come un annuncio di lavoro**."));
    expect(res.violations.some(isClaimViolation)).toBe(false);
    expect(res.warnings.some(isIoWarning)).toBe(false);
  });

  it('un claim citato solo dentro un blocco di codice non conta', () => {
    const res = strict(body('- Aggiornato il template:\n```\ncirca 30 s in meno per run\n```'));
    expect(res.violations.some(isClaimViolation)).toBe(false);
  });

  it('fuori dalla modalità strict (lettori storici, contratto del corpus) il controllo non gira', () => {
    const res = checkPrBodySections(body(claim));
    expect(res.violations.some(isClaimViolation)).toBe(false);
    expect(res.ok).toBe(true);
  });
});

describe('unvalidated-perf-claim: riconoscimento del riferimento workflow/job', () => {
  it('richiede un nome concreto subito dopo workflow o job', () => {
    expect(isConcreteJobWorkflowReference('workflow is monitored by tests.yml')).toBe(false);
    expect(isConcreteJobWorkflowReference('job is pending; see deploy.yml')).toBe(false);
    expect(isConcreteJobWorkflowReference('workflow tests.yml')).toBe(true);
    expect(isConcreteJobWorkflowReference('job build-test')).toBe(true);
    expect(isConcreteJobWorkflowReference('run https://github.com/o/r/actions/runs/123')).toBe(true);
  });

  it('accetta un nome esplicito quoted ma non un prefisso di prosa camuffato', () => {
    expect(isConcreteJobWorkflowReference('workflow "Release pages"')).toBe(true);
    expect(isConcreteJobWorkflowReference('workflow is-active')).toBe(false);
  });

  it('non tratta i parametri di query di un URL arbitrario come riferimenti concreti', () => {
    for (const owner of ['workflow', 'job', 'run', 'deploy']) {
      expect(isConcreteJobWorkflowReference(`blocked: misura post-merge; https://example.test/${owner}=build-1; soglia 2s; trigger di revert: rollback`), owner).toBe(false);
      expect(isConcreteJobWorkflowReference(`blocked: misura post-merge; https://example.test/${owner}="build-1"; soglia 2s; trigger di revert: rollback`), `${owner} quoted`).toBe(false);
    }
    expect(isConcreteJobWorkflowReference('blocked: misura post-merge; https://example.test/job=build-1; soglia 2s; trigger di revert: rollback')).toBe(false);
  });

  it('mantiene valide le URL Actions riconosciute', () => {
    expect(isConcreteJobWorkflowReference('workflow https://github.com/o/r/actions/workflows/build.yml')).toBe(true);
    expect(isConcreteJobWorkflowReference('run https://github.com/o/r/actions/runs/123')).toBe(true);
  });
});

describe('unvalidated-perf-claim: l\'evidenza è sostanziale e locale al bullet', () => {
  it('non accetta una riga Misura vuota', () => {
    const res = unvalidatedPerfClaims(body('- Riduce la memoria del build.\n- Misura:'));
    expect(res.blocking).toContain('Riduce la memoria del build.');
  });

  it('non accetta una baseline senza valore', () => {
    const res = unvalidatedPerfClaims(body('- Riduce la memoria del build.\n- baseline'));
    expect(res.blocking).toContain('Riduce la memoria del build.');
  });

  it('non lascia che la misura di un bullet autorizzi un claim indipendente', () => {
    const res = unvalidatedPerfClaims(body(
      '- Riduce la memoria del build.\n- Accelera la pipeline. Misura: 120 s prima, 90 s dopo.',
    ));
    expect(res.blocking).toContain('Riduce la memoria del build.');
    expect(res.blocking).not.toContain('Accelera la pipeline.');
  });

  it('tratta CI, build e pipeline come risorse di prestazione', () => {
    for (const resource of ['CI', 'build', 'pipeline']) {
      const res = unvalidatedPerfClaims(body(`- Accelera la ${resource}.`));
      expect(res.blocking, resource).toContain(`Accelera la ${resource}.`);
    }
  });
});
