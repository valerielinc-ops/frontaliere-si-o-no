// scripts/lib/bulk-send-throttle.mjs
//
// Throttle e concorrenza dei sender di email in blocco che passano da UNA sola
// chiamata a `sendEmailCascade` (perf-plan email senders, D2/E1/F1/F2). E' lo
// schema della jobalert (`JOB_ALERT_SEND_THROTTLE` in scripts/send-job-alerts.mjs) e
// della newsletter (`NEWSLETTER_SEND_THROTTLE`): 100 ms di spaziatura di base,
// backoff adattivo fino a 1 s sui 429/5xx espliciti, quattro worker.
//
// PERCHE'. Il default della cascade (`delayMs` 1000, `concurrency` 1) e' una
// spaziatura PER PROVIDER condivisa da tutti i worker: con ~99% degli invii su
// maileroo il tetto era 1 email/s qualunque fosse la concorrenza (run 35422626497
// della jobalert: 1.591 email in 26,5 min). I limiti dei provider restano garantiti
// dai pavimenti per provider (`BULK_PROVIDER_MIN_INTERVAL_MS`: cloudflare 1 s,
// resend 500 ms, maileroo al tetto orario dell'account Pro) e dal backoff adattivo.
//
// La dedup resta per item: la cascade prende ogni item una sola volta, e
// `beforeProviderAttempt` / `onSent` scrivono solo i documenti di quel destinatario.

export const BULK_SEND_THROTTLE = Object.freeze({
  concurrency: 4,
  delayMs: 100,
  adaptiveThrottle: Object.freeze({ stepMs: 100, maxDelayMs: 1000 }),
});

/**
 * Le opzioni di `sendEmailCascade` per un invio in blocco, dato il modulo della cascade
 * da cui l'entry script importa (lo shim `email-cascade.mjs` o la cascade base
 * `functions/src/emailCascade.js`). Usa `in`, non una lettura destrutturata: un
 * doppio parziale del modulo, come quelli dei test dei sender, semplicemente non ha i
 * pavimenti; il modulo vero li esporta sempre.
 */
export function bulkOptionsFor(cascadeModule, extra = {}) {
  const floors = cascadeModule && 'BULK_PROVIDER_MIN_INTERVAL_MS' in cascadeModule
    ? cascadeModule.BULK_PROVIDER_MIN_INTERVAL_MS
    : undefined;
  return {
    ...BULK_SEND_THROTTLE,
    ...(floors ? { providerMinIntervalMs: floors } : {}),
    ...extra,
  };
}

/**
 * Le stesse opzioni, con la cascade dello shim importata al momento dell'invio, per non
 * caricarla in un dry run.
 */
export async function bulkCascadeOptions(extra = {}) {
  return bulkOptionsFor(await import('./email-cascade.mjs'), extra);
}
