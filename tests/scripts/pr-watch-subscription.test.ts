import { describe, expect, it } from 'vitest';

import {
  ARMED_WAIT_EXEMPT_STATUSES,
  REQUIRED_WAIT_FOR,
  armedSubscriptionIn,
  armedWaitCanReplaceBlock,
  coversTerminalStates,
  findCoordinatorCli,
  queryTargetSubscriptions,
  subscriptionIsArmed,
  waitIsArmed,
} from '../../scripts/ci/lib/pr-watch-subscription.mjs';

// Regressione del difetto osservato dal vivo il 2026-09-20: lo Stop hook
// `pr-watch-gate.mjs` istruiva a sottoscrivere l'evento con
// `bin/gh-frontaliere events subscribe` invece di fare polling, ma decideva
// guardando SOLO il registro locale delle PR — non consultava mai le
// subscription del coordinatore. Una sessione che eseguiva alla lettera il
// rimedio suggerito (subscription armata, listener vivo) veniva bloccata lo
// stesso al turno dopo, e a quello dopo. L'istruzione stampata era
// irraggiungibile: eseguirla non cambiava il verdetto.
//
// Misura pre-fix sulle 24h precedenti (transcript delle sessioni locali):
// 63 Stop bloccati, 41 dei quali avevano gia' un `events subscribe` emesso per
// TUTTE le PR bloccanti. Ognuno costa un turno intero piu' il cooldown.

const NOW = Date.parse('2026-09-20T06:13:42.724Z');

/** Il caso reale che ha prodotto la fix: PR #9356, agentId `fleet-V`. */
function subscriptionPr9356(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-8fb13ea2-ef67-4cb5-a9c1-a7b74da2995d',
    agentId: 'fleet-V',
    resource: 'pull_request',
    repo: 'valerielinc-ops/frontaliere-si-o-no',
    number: 9356,
    waitFor: ['merged', 'closed', 'failed', 'reviewed'],
    expiresAt: '2026-09-20T12:08:07.215Z',
    remainingMs: 21_264_491,
    waitState: 'waiting_external',
    listenerAttached: true,
    listenerAlive: true,
    listenerDead: false,
    ...overrides,
  };
}

function showPayload(subscriptions: unknown[]) {
  return { ok: true, subscriptions, pendingEvents: 0 };
}

describe('coversTerminalStates', () => {
  it('richiede merged, closed e reviewed', () => {
    expect(REQUIRED_WAIT_FOR).toEqual(['merged', 'closed', 'reviewed']);
    expect(coversTerminalStates(['merged', 'closed', 'reviewed'])).toBe(true);
    expect(coversTerminalStates(['merged', 'closed', 'failed', 'reviewed'])).toBe(true);
  });

  it('`approved` non sostituisce `reviewed`', () => {
    // Una review con un finding 🔴 non e' un'approvazione: con il solo
    // `approved` non arriverebbe nessun evento, e la sessione dormirebbe su un
    // 🔴 da leggere — l'incidente #6318 per cui il gate esiste.
    expect(coversTerminalStates(['merged', 'closed', 'approved'])).toBe(false);
  });

  it('una copertura parziale non basta', () => {
    expect(coversTerminalStates(['merged'])).toBe(false);
    expect(coversTerminalStates(['merged', 'reviewed'])).toBe(false);
    expect(coversTerminalStates([])).toBe(false);
  });

  it('tollera maiuscole e spazi, rifiuta i non-array', () => {
    expect(coversTerminalStates([' Merged ', 'CLOSED', 'Reviewed'])).toBe(true);
    expect(coversTerminalStates(undefined)).toBe(false);
    expect(coversTerminalStates('merged,closed,reviewed')).toBe(false);
    expect(coversTerminalStates([null, 42])).toBe(false);
  });
});

// I QUATTRO CASI DEL CONTRATTO.
describe('subscriptionIsArmed — i quattro casi', () => {
  it('1. attesa armata (il caso #9356) → armata, il turno puo` finire', () => {
    expect(subscriptionIsArmed(subscriptionPr9356(), NOW)).toEqual({
      armed: true,
      reason: 'attesa armata',
    });
  });

  it('2. nessuna subscription → non armata', () => {
    expect(subscriptionIsArmed(undefined, NOW).armed).toBe(false);
    expect(subscriptionIsArmed(null, NOW).armed).toBe(false);
    expect(armedSubscriptionIn(showPayload([]), NOW)).toEqual({
      armed: false,
      subscriptionId: null,
      reason: 'nessuna subscription',
    });
  });

  it('3. listener morto → non armata, la PR e` abbandonata', () => {
    expect(subscriptionIsArmed(subscriptionPr9356({ listenerAlive: false }), NOW)).toEqual({
      armed: false,
      reason: 'listener morto',
    });
    // `listenerDead` esplicito ha la precedenza anche se `listenerAlive` mente.
    expect(
      subscriptionIsArmed(subscriptionPr9356({ listenerAlive: true, listenerDead: true }), NOW).armed,
    ).toBe(false);
    // Campo assente = nessuna prova di un listener: non armata.
    const senzaCampo = subscriptionPr9356();
    delete (senzaCampo as Record<string, unknown>).listenerAlive;
    expect(subscriptionIsArmed(senzaCampo, NOW).armed).toBe(false);
  });

  it('4. subscription scaduta → non armata', () => {
    expect(
      subscriptionIsArmed(subscriptionPr9356({ remainingMs: 0 }), NOW),
    ).toEqual({ armed: false, reason: 'subscription scaduta' });
    expect(subscriptionIsArmed(subscriptionPr9356({ remainingMs: -1 }), NOW).armed).toBe(false);
    // Senza `remainingMs` si ricade su `expiresAt`, confrontato con `now`.
    const scaduta = subscriptionPr9356({ expiresAt: '2026-09-20T06:00:00.000Z' });
    delete (scaduta as Record<string, unknown>).remainingMs;
    expect(subscriptionIsArmed(scaduta, NOW).armed).toBe(false);
    const viva = subscriptionPr9356({ expiresAt: '2026-09-20T12:00:00.000Z' });
    delete (viva as Record<string, unknown>).remainingMs;
    expect(subscriptionIsArmed(viva, NOW).armed).toBe(true);
  });

  it('waitFor che non copre i terminali → non armata', () => {
    expect(subscriptionIsArmed(subscriptionPr9356({ waitFor: ['merged'] }), NOW)).toEqual({
      armed: false,
      reason: 'waitFor non copre gli stati terminali',
    });
  });

  it('nessuna scadenza leggibile → non armata (fail-closed sul dubbio)', () => {
    const senzaScadenza = subscriptionPr9356({ expiresAt: 'boh' });
    delete (senzaScadenza as Record<string, unknown>).remainingMs;
    expect(subscriptionIsArmed(senzaScadenza, NOW).armed).toBe(false);
  });
});

describe('armedSubscriptionIn', () => {
  it('basta UNA subscription armata fra piu` osservatori sullo stesso target', () => {
    const verdict = armedSubscriptionIn(
      showPayload([
        subscriptionPr9356({ id: 'sub-morta', listenerAlive: false }),
        subscriptionPr9356({ id: 'sub-viva' }),
      ]),
      NOW,
    );
    expect(verdict.armed).toBe(true);
    expect(verdict.subscriptionId).toBe('sub-viva');
  });

  it('tutte non armate → riporta la causa dell`ultima esaminata', () => {
    const verdict = armedSubscriptionIn(
      showPayload([subscriptionPr9356({ remainingMs: 0 })]),
      NOW,
    );
    expect(verdict).toEqual({
      armed: false,
      subscriptionId: null,
      reason: 'subscription scaduta',
    });
  });

  it('`ok:false` del coordinatore non e` una prova di armamento', () => {
    expect(armedSubscriptionIn({ ok: false, subscriptions: [subscriptionPr9356()] }, NOW).armed)
      .toBe(false);
  });

  it('payload illeggibile → non armata, mai un throw', () => {
    expect(armedSubscriptionIn(null, NOW).armed).toBe(false);
    expect(armedSubscriptionIn('{"ok":true}', NOW).armed).toBe(false);
    expect(armedSubscriptionIn({ ok: true }, NOW).armed).toBe(false);
  });
});

describe('armedWaitCanReplaceBlock — il confine con #6318', () => {
  it('`awaiting-review`: la review non e` ancora arrivata → l`attesa armata basta', () => {
    expect(armedWaitCanReplaceBlock('awaiting-review')).toBe(true);
  });

  it('`not-lgtm`: il 🔴 e` GIA` sull`ultimo commit → si blocca comunque', () => {
    // Nessun evento futuro risolve un finding gia` consegnato: la transizione
    // successiva richiede un commit DELL'AGENTE. Esentare anche questo stato
    // rimetterebbe in piedi #6318 (2026-08-24), il 🔴 Important reale rimasto
    // illetto per due ore. L'attesa armata qui non e` un'attesa, e` un rinvio.
    expect(armedWaitCanReplaceBlock('not-lgtm')).toBe(false);
  });

  it('nessuno stato sconosciuto entra per sbaglio nell`esenzione', () => {
    expect([...ARMED_WAIT_EXEMPT_STATUSES]).toEqual(['awaiting-review']);
    for (const status of ['merged', 'closed', 'lgtm', '', 'qualcosa-di-nuovo', undefined]) {
      expect(armedWaitCanReplaceBlock(status as string)).toBe(false);
    }
  });
});

describe('findCoordinatorCli', () => {
  const WS = '/ws';
  const SITE = '/ws/frontaliere-si-o-no';
  const HOOKS_WT = '/ws/frontaliere-si-o-no/.claude/worktrees/hooks-main';

  it('risale dal worktree `hooks-main` fino alla root del workspace', () => {
    // Il percorso reale in produzione: gli hook della root eseguono il gate da
    // qui, cinque livelli sotto la root che contiene `bin/gh-frontaliere`.
    const exists = (p: string) => p === `${WS}/bin/gh-frontaliere`;
    expect(findCoordinatorCli(HOOKS_WT, {}, exists)).toBe(`${WS}/bin/gh-frontaliere`);
    expect(findCoordinatorCli(SITE, {}, exists)).toBe(`${WS}/bin/gh-frontaliere`);
  });

  it('`WORKSPACE` ha la precedenza quando e` esportata', () => {
    const exists = (p: string) => p.endsWith('/bin/gh-frontaliere');
    expect(findCoordinatorCli('/altrove', { WORKSPACE: WS } as NodeJS.ProcessEnv, exists))
      .toBe(`${WS}/bin/gh-frontaliere`);
  });

  it('CLI assente → null, e il chiamante blocca come prima', () => {
    expect(findCoordinatorCli(HOOKS_WT, {}, () => false)).toBe(null);
  });

  it('un `exists` che lancia non fa fallire la ricerca', () => {
    let first = true;
    const exists = (p: string) => {
      if (first) { first = false; throw new Error('EACCES'); }
      return p === `${WS}/bin/gh-frontaliere`;
    };
    expect(findCoordinatorCli(HOOKS_WT, {}, exists)).toBe(`${WS}/bin/gh-frontaliere`);
  });
});

describe('queryTargetSubscriptions', () => {
  it('interroga il target con `events show`, non `events status --full`', () => {
    // `status --full` serializza TUTTE le subscription del daemon a ogni Stop
    // di ogni sessione; `status` filtrato e` compatto ma restituisce solo
    // contatori, senza `waitFor` ne` `expiresAt`. `show` filtrato per target
    // e` l'unica lettura locale che porta i campi che servono al verdetto.
    let seen: string[] = [];
    queryTargetSubscriptions(
      { owner: 'valerielinc-ops', repo: 'frontaliere-si-o-no', number: 9356 },
      {
        cli: '/ws/bin/gh-frontaliere',
        run: (_cmd: string, args: string[]) => {
          seen = args;
          return JSON.stringify(showPayload([subscriptionPr9356()]));
        },
      },
    );
    expect(seen).toEqual([
      'events', 'show',
      '--repo', 'valerielinc-ops/frontaliere-si-o-no',
      '--resource', 'pull_request',
      '--number', '9356',
    ]);
    expect(seen).not.toContain('--full');
  });

  it('timeout stretto di default, e nessuna chiamata a GitHub', () => {
    let opts: Record<string, unknown> = {};
    queryTargetSubscriptions(
      { owner: 'o', repo: 'r', number: 1 },
      {
        cli: '/ws/bin/gh-frontaliere',
        run: (_c: string, _a: string[], o: Record<string, unknown>) => {
          opts = o;
          return JSON.stringify(showPayload([]));
        },
      },
    );
    expect(opts.timeout).toBe(5_000);
  });

  it('CLI non trovata → null senza eseguire niente', () => {
    let called = false;
    const out = queryTargetSubscriptions(
      { owner: 'o', repo: 'r', number: 1 },
      { startDir: '/nowhere', env: {} as NodeJS.ProcessEnv, run: () => { called = true; return ''; } },
    );
    expect(out).toBe(null);
    expect(called).toBe(false);
  });

  it('daemon giu`, timeout o JSON monco → null, mai un throw', () => {
    const ref = { owner: 'o', repo: 'r', number: 1 };
    expect(queryTargetSubscriptions(ref, {
      cli: '/ws/bin/gh-frontaliere',
      run: () => { throw new Error('ETIMEDOUT'); },
    })).toBe(null);
    expect(queryTargetSubscriptions(ref, {
      cli: '/ws/bin/gh-frontaliere',
      run: () => '{"ok":true,"subscri',
    })).toBe(null);
  });
});

describe('waitIsArmed — fail-CLOSED sul dubbio, mai un crash', () => {
  const ref = { owner: 'valerielinc-ops', repo: 'frontaliere-si-o-no', number: 9356 };

  it('coordinatore che risponde con l`attesa armata → armata', () => {
    const verdict = waitIsArmed(ref, {
      cli: '/ws/bin/gh-frontaliere',
      now: NOW,
      run: () => JSON.stringify(showPayload([subscriptionPr9356()])),
    });
    expect(verdict.armed).toBe(true);
    expect(verdict.subscriptionId).toBe('sub-8fb13ea2-ef67-4cb5-a9c1-a7b74da2995d');
  });

  it('daemon giu` → non armata: il gate blocca esattamente come prima', () => {
    expect(waitIsArmed(ref, {
      cli: '/ws/bin/gh-frontaliere',
      now: NOW,
      run: () => { throw new Error('ECONNREFUSED'); },
    })).toEqual({ armed: false, subscriptionId: null, reason: 'coordinatore non interrogabile' });
  });

  it('un errore imprevisto resta dentro la funzione', () => {
    // Il gate gira a ogni Stop di ogni sessione: un'eccezione qui impedirebbe
    // alla sessione di finire, che e` piu` grave del turno sprecato che stiamo
    // togliendo. Nessun percorso di questa funzione propaga.
    expect(() => waitIsArmed(ref, {
      now: NOW,
      get cli(): string { throw new Error('boom'); },
    } as never)).not.toThrow();
  });
});
