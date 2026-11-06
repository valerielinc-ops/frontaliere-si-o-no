/**
 * Regole del confine Firebase→GA4 che proteggono l'attribuzione delle sessioni.
 *
 * GA4 legge i parametri evento `source`, `medium`, `campaign`, `term` e
 * `content` come sorgente di traffico. `traffic_attribution` e `funnel_step` li
 * usavano come semplici etichette: `(direct) / (none)` diventava `direct /
 * direct`, `utm_source=chatgpt.com` `chatgpt.com / direct` e `funnel_step`
 * `referral / (not set)`. Nessun gruppo di canali li riconosce, quindi circa il
 * 14% delle sessioni di ottobre 2026 e' finito in Unassigned. PostHog riceve i
 * nomi originali: `log()` lo alimenta prima di questo confine.
 */
const GA4_TRAFFIC_PARAM_RENAMES: Readonly<Record<string, string>> = {
 source: 'event_source',
 medium: 'event_medium',
 campaign: 'event_campaign',
 term: 'event_term',
 content: 'event_content',
};

export function neutralizeGa4TrafficParams<T extends Record<string, unknown>>(params: T): T {
 const renamed: Record<string, unknown> = {};
 for (const [key, value] of Object.entries(params)) {
  renamed[GA4_TRAFFIC_PARAM_RENAMES[key] ?? key] = value;
 }
 return renamed as T;
}

/**
 * Eventi emessi senza un'azione dell'utente, spesso su `pagehide`. Dopo la
 * scadenza di 30 minuti aprono una sessione nuova priva di `session_start`, che
 * GA4 riporta come `(not set)`. Il margine di un minuto copre lo scarto fra il
 * nostro orologio e quello di GA4.
 */
const GA4_PASSIVE_EVENTS: ReadonlySet<string> = new Set(['session_end', 'web_vitals', 'ad_page_diag']);
export const GA4_SESSION_IDLE_MS = 29 * 60 * 1000;

export function isStalePassiveGa4Event(eventName: string, lastEventAt: number | null, now: number): boolean {
 return GA4_PASSIVE_EVENTS.has(eventName) && lastEventAt !== null && now - lastEventAt >= GA4_SESSION_IDLE_MS;
}
