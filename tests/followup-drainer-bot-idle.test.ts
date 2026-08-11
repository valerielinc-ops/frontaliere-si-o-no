/**
 * followup-drainer — il cooldown del PARKED-RETRY misura l'inattività
 * SIGNIFICATIVA, non `updatedAt`.
 *
 * Il difetto (misurato il 2026-08-11 sulle 35 issue aperte del sito): il filtro
 * di cooldown leggeva `minutesSince(iss.updatedAt)`, ma `updatedAt` si alza a
 * OGNI commento — compresi i «🔁 Recurrence on workflow run» che i monitor
 * postano ogni 2-3 ore proprio sulle issue che hanno aperto loro. Le issue più
 * sorvegliate non raggiungevano mai i 5 giorni di quiete e restavano fuori dal
 * ri-accodo PER SEMPRE: 19 candidate `fu-parked` superavano tutti gli altri
 * filtri, ZERO superavano il cooldown. Le vittime erano le `fu-prio:high` di SEO
 * (#5321 24 commenti/14gg, #5429 14, #5323 11, #5341 9).
 *
 * L'ironia che rendeva lo stato stabile: lo stesso `updatedAt` che le affamava
 * le proteggeva anche dall'age-out close (stesso campo) → limbo permanente.
 *
 * Questi test fissano il contratto:
 *   - un commento di bot AL GIORNO non rinvia più il cooldown: al giorno 5 la
 *     issue è eleggibile (è il caso reale, ed è il punto della fix);
 *   - un commento UMANO invece lo rinvia (la quiete deve essere vera);
 *   - un verdetto `FIX_OUTCOME`, anche se postato da un bot, conta come evento
 *     significativo: è il proxy del park e impedisce che «ignora i bot»
 *     degeneri in «ri-accoda un park di un'ora fa»;
 *   - il detector di bot regge ENTRAMBE le forme di login (GraphQL senza
 *     suffisso, REST con `[bot]`), perché la sorgente reale è la prima e la
 *     regola generale è la seconda.
 */

import { describe, it, expect } from 'vitest';
import {
  isBotLogin,
  isBotComment,
  lastSignificantActivityAt,
  isRetryCooldownElapsed,
  BOT_COMMENT_LOGINS,
} from '../scripts/ci/followup-drainer.mjs';

type Comment = {
  body?: string;
  createdAt?: string;
  created_at?: string;
  author?: { login?: string };
  user?: { login?: string; type?: string };
};

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-11T09:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

/** Il cooldown reale del drainer (`RETRY_COOLDOWN_DAYS`, default 5). */
const COOLDOWN_DAYS = 5;

const elapsed = (iss: { createdAt?: string }, comments: Comment[]) =>
  isRetryCooldownElapsed(iss, comments, { now: NOW, cooldownDays: COOLDOWN_DAYS });

describe('isBotLogin', () => {
  it('riconosce la forma GraphQL, senza suffisso (è quella che gh CLI restituisce)', () => {
    // `gh issue view --json comments` passa da GraphQL: l'attore Bot espone
    // `login` NUDO. Una regola basata solo sul suffisso `[bot]` sarebbe un
    // no-op silenzioso proprio sulla sorgente che il drainer legge.
    expect(isBotLogin('github-actions')).toBe(true);
    expect(isBotLogin('claude')).toBe(true);
  });

  it('riconosce la forma REST, col suffisso `[bot]`', () => {
    expect(isBotLogin('github-actions[bot]')).toBe(true);
    expect(isBotLogin('claude[bot]')).toBe(true);
  });

  it('riconosce per suffisso un bot che non è nell\'allowlist (robustezza ai bot futuri)', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(BOT_COMMENT_LOGINS.has('dependabot')).toBe(false);
  });

  it('NON classifica come bot un umano né un login assente', () => {
    expect(isBotLogin('valerielinc-ops')).toBe(false);
    expect(isBotLogin('')).toBe(false);
    expect(isBotLogin(undefined)).toBe(false);
  });
});

describe('isBotComment — il flag REST è autoritativo, l\'allowlist è solo il fallback', () => {
  it('crede a `user.type: "Bot"` anche per un bot che nessuno ha mai censito', () => {
    // È il punto: `frontaliere-automation[bot]` è comparso su questo repo senza
    // che nessuno lo aggiungesse a niente. Un bot non riconosciuto rimetterebbe
    // la sua issue in starvation IN SILENZIO, cioè il difetto che questa fix
    // chiude. Il flag di GitHub non richiede manutenzione.
    const c = { user: { login: 'un-bot-mai-visto[bot]', type: 'Bot' }, body: 'ping' };
    expect(isBotComment(c)).toBe(true);
    expect(BOT_COMMENT_LOGINS.has('un-bot-mai-visto')).toBe(false);
  });

  it('riconosce la forma GraphQL via allowlist quando `user.type` non c\'è', () => {
    expect(isBotComment({ author: { login: 'frontaliere-automation' } })).toBe(true);
    expect(isBotComment({ author: { login: 'github-actions' } })).toBe(true);
  });

  it('un utente REST resta umano', () => {
    expect(isBotComment({ user: { login: 'valerielinc-ops', type: 'User' } })).toBe(false);
    expect(isBotComment({})).toBe(false);
  });
});

describe('cooldown del parked-retry — il caso che bloccava la coda', () => {
  it('una issue che riceve UN COMMENTO BOT AL GIORNO è eleggibile al giorno 5', () => {
    // Esattamente la forma reale: monitor che ri-commenta la issue che ha
    // aperto. `updatedAt` sarebbe fermo a ieri → escluso per sempre.
    const iss = { createdAt: daysAgo(30), updatedAt: daysAgo(0.5) };
    const comments: Comment[] = [];
    for (let d = 5; d >= 1; d--) {
      comments.push({
        author: { login: 'github-actions' },
        body: '🔁 Recurrence on workflow run.\n\n**Workflow:** Post-deploy Publish',
        createdAt: daysAgo(d - 0.5),
      });
    }
    // Ultimo evento significativo = la creazione (30gg fa), non l'ultimo ping.
    expect(lastSignificantActivityAt(iss, comments)).toBe(Date.parse(iss.createdAt));
    expect(elapsed(iss, comments)).toBe(true);
  });

  it('lo stesso stream di ping bot NON rende eleggibile una issue parkata da 1 giorno', () => {
    // Il park lascia un verdetto FIX_OUTCOME: il cooldown riparte da lì, quindi
    // ignorare i bot non significa ri-accodare i park freschi.
    const iss = { createdAt: daysAgo(30), updatedAt: daysAgo(0.1) };
    const comments: Comment[] = [
      { author: { login: 'claude' }, body: 'diagnosi…\n\n<!-- FIX_OUTCOME: no-root-cause -->', createdAt: daysAgo(1) },
      { author: { login: 'github-actions' }, body: '🔁 Recurrence on workflow run.', createdAt: daysAgo(0.1) },
    ];
    expect(lastSignificantActivityAt(iss, comments)).toBe(Date.parse(daysAgo(1)));
    expect(elapsed(iss, comments)).toBe(false);
  });

  it('un verdetto FIX_OUTCOME di 6 giorni fa ha invece esaurito il cooldown', () => {
    const iss = { createdAt: daysAgo(30), updatedAt: daysAgo(0.1) };
    const comments: Comment[] = [
      { author: { login: 'claude' }, body: '<!-- FIX_OUTCOME: no-root-cause -->', createdAt: daysAgo(6) },
      { author: { login: 'github-actions' }, body: '🔁 Recurrence on workflow run.', createdAt: daysAgo(0.1) },
    ];
    expect(elapsed(iss, comments)).toBe(true);
  });

  it('un commento UMANO recente rinvia il cooldown (la quiete deve essere vera)', () => {
    const iss = { createdAt: daysAgo(30), updatedAt: daysAgo(0.1) };
    const comments: Comment[] = [
      { author: { login: 'github-actions' }, body: 'ping', createdAt: daysAgo(9) },
      { author: { login: 'valerielinc-ops' }, body: 'sto guardando io questa', createdAt: daysAgo(2) },
      { author: { login: 'github-actions' }, body: 'ping', createdAt: daysAgo(0.1) },
    ];
    expect(lastSignificantActivityAt(iss, comments)).toBe(Date.parse(daysAgo(2)));
    expect(elapsed(iss, comments)).toBe(false);
  });

  it('un commento umano VECCHIO non blocca nulla', () => {
    const iss = { createdAt: daysAgo(30), updatedAt: daysAgo(0.1) };
    const comments: Comment[] = [
      { author: { login: 'valerielinc-ops' }, body: 'nota', createdAt: daysAgo(20) },
      { author: { login: 'github-actions' }, body: 'ping', createdAt: daysAgo(0.1) },
    ];
    expect(elapsed(iss, comments)).toBe(true);
  });
});

describe('lastSignificantActivityAt — invarianti', () => {
  it('senza commenti torna la creazione', () => {
    const iss = { createdAt: daysAgo(3) };
    expect(lastSignificantActivityAt(iss, [])).toBe(Date.parse(iss.createdAt));
    expect(lastSignificantActivityAt(iss, undefined as unknown as Comment[])).toBe(Date.parse(iss.createdAt));
  });

  it('non è MAI più recente di updatedAt → il pool nuovo è un sovrainsieme del vecchio', () => {
    // Se il vecchio filtro (`updatedAt` fermo da ≥cooldown) faceva passare una
    // issue, il nuovo deve farla passare comunque: nessuna regressione possibile
    // sul pool esistente.
    const iss = { createdAt: daysAgo(40), updatedAt: daysAgo(7) };
    const comments: Comment[] = [
      { author: { login: 'valerielinc-ops' }, body: 'x', createdAt: daysAgo(7) },
    ];
    expect(lastSignificantActivityAt(iss, comments)!).toBeLessThanOrEqual(Date.parse(iss.updatedAt));
    expect(elapsed(iss, comments)).toBe(true);
  });

  it('legge la forma REST del commento (`user` + `created_at` snake_case)', () => {
    // È la forma che il drainer usa davvero per il cooldown (`issueCommentsRest`).
    const iss = { createdAt: daysAgo(30) };
    const comments: Comment[] = [
      { user: { login: 'github-actions[bot]', type: 'Bot' }, body: 'ping', created_at: daysAgo(0.1) },
      { user: { login: 'valerielinc-ops', type: 'User' }, body: 'nota', created_at: daysAgo(8) },
    ];
    expect(lastSignificantActivityAt(iss, comments)).toBe(Date.parse(daysAgo(8)));
    expect(elapsed(iss, comments)).toBe(true);
  });

  it('ignora le date illeggibili invece di lasciarle vincere', () => {
    const iss = { createdAt: daysAgo(10) };
    const comments: Comment[] = [
      { author: { login: 'valerielinc-ops' }, body: 'x', createdAt: 'non-una-data' },
    ];
    expect(lastSignificantActivityAt(iss, comments)).toBe(Date.parse(iss.createdAt));
  });

  it('null quando nessuna data è leggibile → nessun ri-accodo al buio', () => {
    expect(lastSignificantActivityAt({ createdAt: 'boh' }, [])).toBeNull();
    expect(isRetryCooldownElapsed({ createdAt: 'boh' }, [], { now: NOW, cooldownDays: COOLDOWN_DAYS })).toBe(false);
  });
});
