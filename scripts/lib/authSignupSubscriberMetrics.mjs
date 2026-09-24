/**
 * authSignupSubscriberMetrics.mjs — aritmetica pura del monitor
 * `auth-signup-subscriber-monitor` (scripts/check-auth-signup-subscribers.mjs).
 *
 * Nessun I/O qui dentro: lo script legge Firestore e Firebase Auth, questo
 * modulo classifica e decide. Separazione voluta, stessa forma di
 * unsubscribeCredentialMetrics.mjs: l'aritmetica si testa con dati sintetici,
 * la lettura di produzione si verifica col comando della scheda.
 *
 * ─── Il difetto che osserva (12-15 settembre 2026) ─────────────────────────
 *
 * Fra il deploy di #8341 (12/09) e quello di #8754 (15-16/09) il login non ha
 * piu' creato iscritti: le creazioni `newsletter_subscribers` con
 * `source_channel` `auth_*` sono passate da 60-77/giorno a 0-3/giorno per
 * quattro giorni, e nessuno se ne e' accorto finche' non e' stato letto il
 * dato a mano. Il job gate via email continuava: il totale del giorno non
 * crollava abbastanza da sembrare un guasto.
 *
 * ─── Due misure, perche' una sola mente ────────────────────────────────────
 *
 * 1. `authSubscribers`: documenti con `created_at` nella finestra e
 *    `source_channel` che inizia per `auth_`. E' la misura del dashboard e la
 *    soglia chiesta (< 10 in 24h). Da sola MENTE in due direzioni:
 *      - `created_at` si scrive solo quando il documento NON esiste
 *        (services/newsletterSubscribers.ts, ramo `existing.exists()`): un
 *        iscritto il cui documento era gia' nato come stub di profilo
 *        (solo `auth_uid`/`lastLoginAt`, scritto al login) non ha MAI
 *        `created_at`. Misurato sugli account creati il 12-15/09: 202 su 432
 *        sono oggi iscritti senza `created_at`, invisibili a questa misura.
 *      - un giorno senza traffico da' zero iscritti senza che nulla sia rotto.
 * 2. `accounts`: account Firebase Auth creati nella finestra, ciascuno
 *    confrontato col proprio documento `newsletter_subscribers/{email}`:
 *    `subscribed` (ha uno `status`), `stub` (esiste ma senza `status`: solo
 *    profilo, nessuna relazione di comunicazione) o `missing`. Questa e' la
 *    domanda vera — chi si e' registrato e' diventato iscritto? — ed e' anche
 *    il segnale di traffico: senza account nuovi la soglia 1 non si valuta.
 *
 * Baseline misurata in sola lettura il 2026-09-24 (account creati, quota
 * stub+missing sul totale):
 *   08-11/09  398 account, 13 scoperti (3,3%)
 *   12-15/09  432 account, 132 scoperti (30,6%; e 65 dei coperti lo sono
 *             diventati solo dopo il 16/09, con un nuovo login)
 *   16-19/09  372 account, 2 scoperti (0,5%)
 */

/** Prefisso dei canali di login (authService.ts: authProviderSourceChannel). */
export const AUTH_CHANNEL_PREFIX = 'auth_';

/** Soglia della scheda: meno di 10 iscritti `auth_*` creati in 24h. */
export const AUTH_SUBSCRIBER_FLOOR = 10;

/**
 * Traffico minimo perche' la soglia abbia senso: account Auth creati nella
 * finestra. Il minimo osservato fuori dall'incidente e' ~80/giorno.
 */
export const MIN_ACCOUNTS_FOR_FLOOR = 10;

/** Quota di account nuovi senza relazione di comunicazione oltre cui si allarma. */
export const UNCOVERED_SHARE_WARN = 0.2;

/** Account minimi per valutare la quota (sotto, rumore). */
export const MIN_ACCOUNTS_FOR_SHARE = 10;

/**
 * Classifica il documento `newsletter_subscribers/{email}` di un account.
 * @param {Record<string, unknown> | null | undefined} data  null = documento assente
 * @returns {'missing' | 'stub' | 'subscribed'}
 */
export function classifySubscriberDoc(data) {
  if (!data || typeof data !== 'object') return 'missing';
  const status = typeof data.status === 'string' ? data.status.trim() : '';
  return status ? 'subscribed' : 'stub';
}

/** @param {unknown} channel */
export function isAuthChannel(channel) {
  return typeof channel === 'string' && channel.startsWith(AUTH_CHANNEL_PREFIX);
}

/**
 * Normalizza il provider di un account Auth in una famiglia stabile.
 * Gli account LinkedIn nascono da custom token (nessun providerData).
 * @param {{ providerData?: Array<{ providerId?: string }> } | undefined} user
 */
export function providerFamily(user) {
  const ids = Array.isArray(user?.providerData)
    ? user.providerData.map((p) => String(p?.providerId || '').toLowerCase())
    : [];
  if (ids.some((id) => id.includes('google'))) return 'google';
  if (ids.some((id) => id.includes('facebook'))) return 'facebook';
  if (ids.some((id) => id.includes('linkedin'))) return 'linkedin';
  if (ids.some((id) => id === 'password' || id === 'emaillink')) return 'email';
  return 'custom';
}

/**
 * @param {object} input
 * @param {Array<{ source_channel?: unknown }>} input.subscriberRows  documenti con created_at nella finestra
 * @param {Array<{ provider: string, docClass: 'missing'|'stub'|'subscribed', hasCreatedAt?: boolean }>} input.accounts
 */
export function aggregate({ subscriberRows = [], accounts = [] } = {}) {
  const byChannel = {};
  let authSubscribers = 0;
  for (const row of subscriberRows) {
    const ch = typeof row?.source_channel === 'string' && row.source_channel ? row.source_channel : 'null';
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    if (isAuthChannel(ch)) authSubscribers++;
  }

  const accountClasses = { subscribed: 0, stub: 0, missing: 0 };
  const byProvider = {};
  let subscribedWithoutCreatedAt = 0;
  for (const a of accounts) {
    const cls = a.docClass in accountClasses ? a.docClass : 'missing';
    accountClasses[cls]++;
    const p = a.provider || 'custom';
    byProvider[p] = byProvider[p] || { subscribed: 0, stub: 0, missing: 0 };
    byProvider[p][cls]++;
    if (cls === 'subscribed' && a.hasCreatedAt === false) subscribedWithoutCreatedAt++;
  }
  const accountsTotal = accounts.length;
  const uncovered = accountClasses.stub + accountClasses.missing;
  return {
    subscribersCreated: subscriberRows.length,
    authSubscribers,
    byChannel,
    accountsTotal,
    accountClasses,
    byProvider,
    uncovered,
    uncoveredShare: accountsTotal > 0 ? uncovered / accountsTotal : null,
    subscribedWithoutCreatedAt,
  };
}

/**
 * @param {ReturnType<typeof aggregate>} agg
 * @param {Partial<{ floor: number, minAccountsForFloor: number, uncoveredShareWarn: number, minAccountsForShare: number }>} [opts]
 */
export function evaluate(agg, opts = {}) {
  const floor = opts.floor ?? AUTH_SUBSCRIBER_FLOOR;
  const minAccountsForFloor = opts.minAccountsForFloor ?? MIN_ACCOUNTS_FOR_FLOOR;
  const uncoveredShareWarn = opts.uncoveredShareWarn ?? UNCOVERED_SHARE_WARN;
  const minAccountsForShare = opts.minAccountsForShare ?? MIN_ACCOUNTS_FOR_SHARE;
  const findings = [];

  if (agg.accountsTotal === 0) {
    // Zero account nuovi in 24h non e' mai successo: o il login e' rotto per
    // tutti, o la lettura di Auth e' cieca. In entrambi i casi un verde
    // sarebbe falso.
    findings.push({
      code: 'no_auth_accounts',
      alert: true,
      priority: 2,
      message: 'nessun account Firebase Auth creato nella finestra: login rotto o lettura cieca, la soglia iscritti non e\' valutabile',
    });
  } else if (agg.accountsTotal < minAccountsForFloor) {
    findings.push({
      code: 'low_traffic',
      alert: false,
      priority: 3,
      message: `solo ${agg.accountsTotal} account creati (< ${minAccountsForFloor}): soglia iscritti non valutata`,
    });
  } else if (agg.authSubscribers < floor) {
    findings.push({
      code: 'auth_subscribers_below_floor',
      alert: true,
      priority: 1,
      message: `${agg.authSubscribers} iscritti \`auth_*\` creati (< ${floor}) a fronte di ${agg.accountsTotal} account nuovi: il login non sta creando iscritti`,
    });
  }

  if (agg.accountsTotal >= minAccountsForShare && agg.uncoveredShare != null && agg.uncoveredShare > uncoveredShareWarn) {
    findings.push({
      code: 'auth_accounts_without_subscription',
      alert: true,
      priority: 2,
      message: `${agg.uncovered} account nuovi su ${agg.accountsTotal} (${pct(agg.uncoveredShare)}) senza relazione di comunicazione (stub ${agg.accountClasses.stub}, assenti ${agg.accountClasses.missing}); soglia ${pct(uncoveredShareWarn)}`,
    });
  }

  if (agg.subscribedWithoutCreatedAt > 0) {
    findings.push({
      code: 'created_at_missing',
      alert: false,
      priority: 3,
      message: `${agg.subscribedWithoutCreatedAt} account nuovi sono iscritti ma senza \`created_at\`: invisibili ai conteggi per data di creazione`,
    });
  }

  const alerting = findings.filter((f) => f.alert);
  return {
    findings,
    alert: alerting.length > 0,
    priority: alerting.length ? Math.min(...alerting.map((f) => f.priority)) : null,
  };
}

/** @param {number | null | undefined} v */
export function pct(v) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  return `${(v * 100).toFixed(1)}%`;
}
