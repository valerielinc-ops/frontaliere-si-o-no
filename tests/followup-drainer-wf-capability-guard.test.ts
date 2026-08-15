/**
 * followup-drainer — il capability-guard WF-scope del PARKED-RETRY è CONDIZIONATO
 * alla capacità reale del token, non incondizionato (#5544).
 *
 * Il difetto: il drainer escludeva dal pool ogni candidata workflow-scoped **a
 * priori**, anche dopo che `workflows: write` è stato concesso sull'installazione
 * (2026-08-06) e verificato in run reali (`APP_TOKEN_WORKFLOWS: true`), mentre
 * `issue-fix.yml` aveva già smesso di bloccare a priori (#5288). Misurato: 13 run
 * consecutivi con `1 skip WF-scope` e **pool 0** per l'intera giornata.
 *
 * Le due direzioni sono DIVERSE e servono entrambe:
 *  1. capacità CONCESSA → la candidata workflow-scoped entra nel pool. Se questo
 *     test è verde con il guard incondizionato, non prova niente.
 *  2. capacità ASSENTE  → resta esclusa. Senza questo, «cancella il guard» sarebbe
 *     una fix accettabile — e non lo è: la protezione deve sopravvivere a una
 *     revoca del permesso.
 *
 * E il segnale gatato è `permissions.workflows == 'write'` LETTO dalla risposta API
 * del conio (`mint-app-token.mjs` → `APP_TOKEN_WORKFLOWS`), MAI la presenza del
 * token: il conio riesce (201) anche con `workflows` richiesto e mai approvato
 * (#5288). Confonderli rimetterebbe il difetto un piano più in là, quindi c'è un
 * test dedicato anche a quello.
 */
import { describe, it, expect } from 'vitest';
import {
  isCapabilityScoped,
  canPushWorkflowsFromEnv,
  isPermanentTracker,
  isReparkableCandidate,
  isAgeOutEligible,
} from '../scripts/ci/followup-drainer.mjs';

/** Una follow-up il cui fix tocca SOLO `.github/workflows/**` e nessun path di
 * codice: è la forma che `detectWorkflowScoped` riconosce come scoped. Nessuna
 * label secrets-scope, così il ramo #5057 non maschera il risultato. */
const WF_SCOPED_ISSUE = {
  number: 4242,
  labels: [{ name: 'fu-parked' }, { name: 'fu-prio:high' }],
};
const WF_SCOPED_DETAIL = {
  title: 'Follow-up: il gate `contract` resta rosso su uno step advisory',
  body: [
    '### 1. Lo step advisory non ha `continue-on-error`',
    'Suggested action: in `.github/workflows/pr-body-contract.yml`, aggiungere',
    '`continue-on-error: true` allo step advisory e i retry.',
  ].join('\n'),
  labels: [{ name: 'fu-parked' }],
};

/** Stessa forma, ma con una label secrets-scope: il SECONDO guard (#5057) è
 * incondizionato per costruzione e non deve muoversi con questa fix. */
const SECRETS_SCOPED_ISSUE = {
  number: 4243,
  labels: [{ name: 'fu-parked' }, { name: 'cloudflare-5xx' }],
};

/** `fetchIssue` iniettato: nessuna `gh issue view`, nessuna rete. Conta anche le
 * chiamate, per provare che il ramo secrets-label corto-circuita prima della fetch. */
function stubFetch(detail: unknown) {
  const calls: number[] = [];
  const fn = (num: number) => { calls.push(num); return detail; };
  return { fn, calls };
}

describe('#5544 — WF-scope entra nel pool quando la capacità è CONCESSA', () => {
  it('capacità concessa → una candidata workflow-scoped NON è capability-scoped', () => {
    const { fn } = stubFetch(WF_SCOPED_DETAIL);
    expect(
      isCapabilityScoped(WF_SCOPED_ISSUE, { fetchIssue: fn, canPushWorkflows: true }),
    ).toBe(false);
  });

  it('capacità concessa via process.env.APP_TOKEN_WORKFLOWS (wiring reale, non solo il parametro)', () => {
    const prev = process.env.APP_TOKEN_WORKFLOWS;
    process.env.APP_TOKEN_WORKFLOWS = 'true';
    try {
      const { fn } = stubFetch(WF_SCOPED_DETAIL);
      // Nessun `canPushWorkflows` esplicito: deve leggerlo dall'ambiente, con lo
      // stesso NOME che `mint-app-token.mjs` scrive su $GITHUB_ENV.
      expect(isCapabilityScoped(WF_SCOPED_ISSUE, { fetchIssue: fn })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.APP_TOKEN_WORKFLOWS;
      else process.env.APP_TOKEN_WORKFLOWS = prev;
    }
  });
});

describe('#5544 — il guard NON è stato cancellato: capacità ASSENTE → resta parked', () => {
  it('capacità assente → la stessa candidata resta capability-scoped', () => {
    const { fn } = stubFetch(WF_SCOPED_DETAIL);
    expect(
      isCapabilityScoped(WF_SCOPED_ISSUE, { fetchIssue: fn, canPushWorkflows: false }),
    ).toBe(true);
  });

  it('env non scritta → fail-closed (resta parked, come prima del 2026-08-06)', () => {
    const prev = process.env.APP_TOKEN_WORKFLOWS;
    delete process.env.APP_TOKEN_WORKFLOWS;
    try {
      const { fn } = stubFetch(WF_SCOPED_DETAIL);
      expect(isCapabilityScoped(WF_SCOPED_ISSUE, { fetchIssue: fn })).toBe(true);
    } finally {
      if (prev !== undefined) process.env.APP_TOKEN_WORKFLOWS = prev;
    }
  });
});

describe('#5544 — si gata sulla CAPACITÀ letta, mai sulla presenza del token (#5288)', () => {
  it.each([
    ['assente', undefined],
    ['stringa vuota', ''],
    ['false', 'false'],
    ['read (richiesto ma non approvato)', 'read'],
    ['un token che sembra valido', 'ghs_xxxxxxxxxxxxxxxxxxxx'],
    ['truthy ma non la capacità', '1'],
  ])('APP_TOKEN_WORKFLOWS=%s → capacità NON concessa', (_label, value) => {
    const env = value === undefined ? {} : { APP_TOKEN_WORKFLOWS: value };
    expect(canPushWorkflowsFromEnv(env as NodeJS.ProcessEnv)).toBe(false);
  });

  it("solo il letterale 'true' concede", () => {
    expect(canPushWorkflowsFromEnv({ APP_TOKEN_WORKFLOWS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('#5544 — il secrets-scope guard (#5057) resta INCONDIZIONATO', () => {
  it('capacità workflows concessa → una candidata secrets-scoped resta comunque esclusa', () => {
    const { fn, calls } = stubFetch(WF_SCOPED_DETAIL);
    expect(
      isCapabilityScoped(SECRETS_SCOPED_ISSUE, { fetchIssue: fn, canPushWorkflows: true }),
    ).toBe(true);
    // e corto-circuita sulla label: nessuna fetch pagata (invariante di costo #5838)
    expect(calls).toEqual([]);
  });
});

/**
 * Effetto collaterale chiuso insieme alla fix (#5544 / #5615).
 *
 * `#1951` («📊 Loop health report (tracker)», `agent:no-age-out`) era workflow-scoped
 * e quindi tenuto fuori dal pool SOLO dall'incondizionatezza del guard WF-scope:
 * rendendolo condizionato sarebbe entrato. E il buco era già più largo — 4 tracker
 * (#5617, #5429, #5323, #5321) entravano nel pool anche PRIMA, non essendo
 * workflow-scoped: `agent:no-age-out` era letto solo da `isAgeOutEligible`, cioè
 * proteggeva dalla chiusura e non dalla promozione.
 *
 * Un tracker promosso a `agent:fix` manda il fixer a «riparare» qualcosa che non ha
 * una causa singola: brucia un run e rischia che il tracker venga chiuso — l'opposto
 * del suo scopo. L'esclusione NON deve dipendere dalla capacità del token.
 */
const TRACKER = {
  number: 1951,
  title: '📊 Loop health report (tracker)',
  labels: [
    { name: 'agent:triaged' }, { name: 'fu-prio:low' }, { name: 'fu-parked' },
    { name: 'automation' }, { name: 'agent:no-age-out' },
  ],
};
/** La forma di #5888: follow-up vera, workflow-scoped, NON tracker → deve entrare. */
const REAL_FOLLOWUP = {
  number: 5888,
  title: 'follow-up(#5883): 1 item deferred — fold breadcrumb-coverage into audit-all',
  labels: [
    { name: 'follow-up' }, { name: 'funnel-seo' }, { name: 'agent:triaged' },
    { name: 'fu-prio:high' }, { name: 'fu-parked' },
  ],
};

describe('#5544 — un tracker permanente non entra MAI nel pool del parked-retry', () => {
  it('il tracker è riconosciuto dalla LABEL, non dal titolo', () => {
    expect(isPermanentTracker(TRACKER)).toBe(true);
    // stesso titolo, label tolta → non è più un tracker: la discriminante è la label
    // (i tracker non vanno rititolati, il dedup lavora sul titolo)
    expect(isPermanentTracker({ ...TRACKER, labels: [{ name: 'fu-parked' }] })).toBe(false);
    expect(isPermanentTracker(REAL_FOLLOWUP)).toBe(false);
    expect(isPermanentTracker({})).toBe(false);
  });

  it('escluso dal pool — ed è indipendente dalla capacità del token', () => {
    // Il pool si costruisce sulle sole label: nessun parametro di capacità lo tocca.
    expect(isReparkableCandidate(TRACKER)).toBe(false);
  });

  it('resta escluso anche con la capacità workflows CONCESSA (il caso che #5544 apriva)', () => {
    const prev = process.env.APP_TOKEN_WORKFLOWS;
    process.env.APP_TOKEN_WORKFLOWS = 'true';
    try {
      expect(isReparkableCandidate(TRACKER)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.APP_TOKEN_WORKFLOWS;
      else process.env.APP_TOKEN_WORKFLOWS = prev;
    }
  });

  it('i 4 tracker che entravano già prima della fix restano fuori (buco pre-esistente)', () => {
    for (const number of [5617, 5429, 5323, 5321]) {
      expect(isReparkableCandidate({
        number,
        title: 'weekly snapshot',
        labels: [{ name: 'bug' }, { name: 'fu-parked' }, { name: 'agent:no-age-out' }],
      })).toBe(false);
    }
  });

  it('#5888 — una follow-up VERA workflow-scoped entra comunque: la fix non ha chiuso troppo', () => {
    expect(isReparkableCandidate(REAL_FOLLOWUP)).toBe(true);
  });

  it('gli altri filtri di ammissione restano attivi', () => {
    const base = REAL_FOLLOWUP;
    expect(isReparkableCandidate({ ...base, labels: [...base.labels, { name: 'needs-human' }] })).toBe(false);
    expect(isReparkableCandidate({ ...base, labels: [...base.labels, { name: 'agent:fix' }] })).toBe(false);
    expect(isReparkableCandidate({ ...base, labels: [...base.labels, { name: 'agent:fix-queued' }] })).toBe(false);
    expect(isReparkableCandidate({ ...base, labels: [...base.labels, { name: 'fu-reparked:1' }] })).toBe(false);
  });

  it('la protezione dall\'age-out (#5615) non è regredita: stessa label, stesso verdetto', () => {
    const old = {
      title: 'follow-up vecchia',
      labels: [{ name: 'follow-up' }, { name: 'agent:no-age-out' }],
      createdAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    };
    const opts = { now: Date.now(), ageOutDays: 10, inactiveDays: 5 };
    expect(isAgeOutEligible(old, opts)).toBe(false);
    // senza la label, la stessa issue si chiuderebbe → la label è ciò che decide
    expect(isAgeOutEligible({ ...old, labels: [{ name: 'follow-up' }] }, opts)).toBe(true);
  });
});

describe('#5544 — fail-closed su errore, in entrambi i regimi di capacità', () => {
  it.each([true, false])('fetch che lancia → resta parked (canPushWorkflows=%s)', (cap) => {
    const boom = () => { throw new Error('gh: API rate limit exceeded'); };
    expect(isCapabilityScoped(WF_SCOPED_ISSUE, { fetchIssue: boom, canPushWorkflows: cap })).toBe(true);
  });
});
