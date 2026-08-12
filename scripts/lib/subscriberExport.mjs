/**
 * subscriberExport.mjs — rende consegnabile all'interessato tutto ciò che
 * conserviamo su un indirizzo email (art. 25 LPD).
 *
 * PERCHÉ ESISTE (issue #5680)
 * ───────────────────────────
 * Rispondere alla prima richiesta di accesso ha richiesto tre script monouso
 * scritti a mano contro Firestore con il service account di produzione. Il
 * destinatario non è un tecnico: riceve un documento, non un dump JSON.
 *
 * PURO. Nessun I/O, nessun `Date.now()`: `generatedAt` è un argomento, come in
 * scripts/lib/dailyBriefCadence.mjs. È questo a renderlo testabile senza rete e
 * senza credenziali di produzione.
 *
 * DICE ANCHE QUELLO CHE NON ABBIAMO. La sezione «cosa non abbiamo registrato»
 * è calcolata, non scritta a mano: se un campo manca lo dichiara. Un'estrazione
 * che tace sui buchi si legge come una reticenza, ed è esattamente la
 * contestazione da cui nasce questa issue — l'IP di iscrizione non esiste per
 * nessuno dei nostri iscritti (#5676) e il testo del consenso esiste per il
 * 1,2% (#5678). Meglio dirlo noi.
 */

/** Firestore Timestamp | Date | ISO string | millis → ISO string, oppure null. */
export function toIso(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis()).toISOString();
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000).toISOString();
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Etichette leggibili per i tipi di evento che i webhook dei provider e le
 * Cloud Function scrivono. Un tipo sconosciuto non viene nascosto: viene
 * mostrato grezzo, perché l'interessato ha diritto al dato anche quando noi
 * non abbiamo ancora un'etichetta per esso.
 */
export const EVENT_LABELS = Object.freeze({
  subscribe_completed: 'Iscrizione registrata',
  confirmation_email_sent: 'Email di conferma inviata',
  confirm: 'Iscrizione confermata dal destinatario',
  send: 'Email inviata',
  delivered: 'Email consegnata',
  open: 'Email aperta',
  click: 'Click su un link',
  bounce: 'Consegna respinta dal server destinatario',
  bounce_reactivated: 'Riattivato dopo un respingimento',
  suppressed: 'Invio sospeso dal fornitore',
  unsubscribe: 'Disiscrizione',
  unsubscribed: 'Disiscrizione',
  complaint: 'Segnalazione come indesiderata',
  autologin_enabled: 'Accesso automatico attivato',
  autologin_disabled: 'Accesso automatico disattivato',
});

export function labelForEvent(type) {
  const key = String(type || '').trim();
  return EVENT_LABELS[key] || (key ? `Evento «${key}»` : 'Evento senza tipo');
}

/** Una riga di cronologia: data, cosa è successo, e i dettagli tecnici utili. */
export function describeEvent(event) {
  const when = toIso(event?.occurred_at) || toIso(event?.timestamp) || '(data non registrata)';
  const parts = [labelForEvent(event?.event_type)];
  if (event?.campaign_id) parts.push(`campagna: ${event.campaign_id}`);
  if (event?.provider) parts.push(`fornitore: ${event.provider}`);
  const meta = event?.metadata || {};
  if (meta.original_url || meta.url) parts.push(`link: ${decodeURIComponent(meta.original_url || meta.url)}`);
  if (meta.ip) parts.push(`IP: ${meta.ip}`);
  if (meta.user_agent) parts.push(`browser: ${meta.user_agent}`);
  return { when, text: parts.join(' · ') };
}

/**
 * I buchi noti, calcolati sul documento reale invece che elencati a mano.
 * @returns {string[]} descrizioni in italiano di ciò che non risulta registrato
 */
export function missingData(subscriber, events = []) {
  const s = subscriber || {};
  const gaps = [];

  const hasConsentIp = Object.entries(s).some(
    ([k, v]) => /(^|_)ip($|_)|consent_ip|signup_ip/i.test(k) && !/unsubscribe/i.test(k) && v,
  );
  if (!hasConsentIp) {
    gaps.push("L'indirizzo IP al momento dell'iscrizione: non viene registrato dai nostri sistemi, quindi non esiste.");
  }
  if (!s.consent_text) {
    gaps.push('Il testo del consenso mostrato e accettato: non risulta salvato per questa iscrizione.');
  }
  const referrerKeys = Object.keys(s).filter((k) => /referrer/i.test(k));
  if (referrerKeys.length === 0) {
    gaps.push("Il referrer completo della pagina di provenienza: non viene registrato (restano i parametri UTM, se presenti).");
  }
  if (!s.geo_country && !s.geo_city && (!s.geo_source || s.geo_source === 'none')) {
    gaps.push('La geolocalizzazione: non è stata catturata per questa iscrizione.');
  }
  const confirmed = s.confirmed_at || s.confirmedAt
    || events.some((e) => String(e?.event_type) === 'confirm');
  if (!confirmed) {
    gaps.push('Una conferma del doppio opt-in: non risulta alcun click di conferma registrato.');
  }
  return gaps;
}

const line = (label, value) => `- **${label}:** ${value === null || value === undefined || value === '' ? '(non registrato)' : value}`;

/**
 * Costruisce il documento consegnabile.
 *
 * @param {object} data
 * @param {string} data.email
 * @param {object|null} data.subscriber        newsletter_subscribers/{email}
 * @param {object[]} data.events               la sua sottocollezione events
 * @param {object[]} data.deliveries           la sua sottocollezione campaign_deliveries
 * @param {object|null} data.jobAlert          job_alert_subscribers/{email}
 * @param {object[]} data.alerts               le sue ricerche salvate
 * @param {object} opts
 * @param {string} opts.generatedAt            ISO string — mai Date.now() qui dentro
 * @param {string} [opts.controller]           titolare del trattamento
 * @param {string} [opts.controllerContact]    suo recapito
 * @returns {string} markdown
 */
export function buildSubscriberExport(data, opts) {
  const { email, subscriber, events = [], deliveries = [], jobAlert, alerts = [] } = data || {};
  const generatedAt = opts?.generatedAt;
  if (!email) throw new Error('email mancante');
  if (!generatedAt) throw new Error('generatedAt mancante — questo modulo non legge l\'orologio');
  const controller = opts?.controller || 'Valerie Linc';
  const contact = opts?.controllerContact || 'valerie@frontaliereticino.ch';

  const out = [];
  out.push(`# Estrazione dei dati personali — ${email}`);
  out.push('');
  out.push(`Documento generato il ${generatedAt} su richiesta dell'interessato, ai sensi dell'art. 25 LPD.`);
  out.push(`Titolare del trattamento: ${controller} — ${contact}`);
  out.push('');

  if (!subscriber && !jobAlert) {
    out.push('## Esito');
    out.push('');
    out.push('**Non conserviamo alcun dato associato a questo indirizzo.** Nessuna iscrizione alla newsletter, nessun avviso di lavoro.');
    out.push('');
    return out.join('\n');
  }

  const s = subscriber || {};

  out.push("## 1. Il consenso registrato");
  out.push('');
  out.push(line('Data di iscrizione', toIso(s.subscribed_at) || toIso(s.subscribedAt) || toIso(s.created_at)));
  out.push(line('Consenso dichiarato', s.consent_given === true ? 'sì' : s.consent_given === false ? 'no' : null));
  out.push(line('Data del consenso', toIso(s.consent_given_at)));
  out.push(line('Testo accettato', s.consent_text ? `«${s.consent_text}»` : null));
  out.push(line('Modalità', s.consent_method));
  out.push(line('Pagina di provenienza', s.consent_source_url || s.source_page));
  out.push(line('Browser dichiarato', s.consent_user_agent));
  out.push(line('Canale', [s.source, s.source_channel, s.source_component].filter(Boolean).join(' / ') || null));
  const utm = s.source_utm || {};
  const utmParts = ['source', 'medium', 'campaign', 'term', 'content']
    .map((k) => (utm[k] ? `utm_${k}=${utm[k]}` : null)).filter(Boolean);
  out.push(line('Parametri UTM', utmParts.length ? utmParts.join(', ') : null));
  out.push(line('Lingua del browser', s.signup_locale || s.locale));
  out.push(line('Email di conferma inviata il', toIso(s.confirmation_sent_at)));
  out.push(line('Conferma ricevuta il', toIso(s.confirmed_at) || toIso(s.confirmedAt)));
  out.push('');

  out.push('## 2. Stato attuale');
  out.push('');
  out.push(line('Stato', s.status));
  out.push(line('Iscrizione attiva', s.active === true || s.isActive === true ? 'sì' : 'no'));
  out.push(line('Disiscritto il', toIso(s.unsubscribed_at) || toIso(s.unsubscribedAt)));
  out.push(line('Soppressione permanente', s.suppression_permanent === true ? 'sì' : null));
  out.push(line('Email ricevute (contatore)', s.send_count ?? s.sendCount ?? null));
  out.push(line('Aperture registrate', s.open_count ?? null));
  out.push(line('Click registrati', s.click_count ?? null));
  out.push(line('Ultimo invio', toIso(s.last_sent_at)));
  out.push('');

  const gaps = missingData(s, events);
  out.push('## 3. Cosa non abbiamo registrato');
  out.push('');
  if (gaps.length === 0) {
    out.push('Nessuna lacuna nota: tutti i campi previsti risultano presenti.');
  } else {
    out.push('Per completezza, ecco i dati che potrebbe aspettarsi e che **non** possiamo fornirle, perché non sono mai stati raccolti:');
    out.push('');
    for (const g of gaps) out.push(`- ${g}`);
  }
  out.push('');

  const sorted = [...events]
    .map((e) => describeEvent(e))
    .sort((a, b) => String(a.when).localeCompare(String(b.when)));
  out.push(`## 4. Cronologia completa (${sorted.length} eventi)`);
  out.push('');
  if (sorted.length === 0) {
    out.push('(nessun evento registrato)');
  } else {
    for (const r of sorted) out.push(`- \`${r.when}\` — ${r.text}`);
  }
  out.push('');

  if (deliveries.length) {
    out.push(`## 5. Consegne per campagna (${deliveries.length})`);
    out.push('');
    const rows = deliveries
      .map((d) => ({ when: toIso(d.sent_at) || '(data non registrata)', id: d.campaign_id || '(senza identificativo)', provider: d.provider || '' }))
      .sort((a, b) => String(a.when).localeCompare(String(b.when)));
    for (const r of rows) out.push(`- \`${r.when}\` — ${r.id}${r.provider ? ` (${r.provider})` : ''}`);
    out.push('');
  }

  out.push('## 6. Avvisi di lavoro');
  out.push('');
  if (!jobAlert && alerts.length === 0) {
    out.push('Nessun avviso di lavoro associato a questo indirizzo.');
  } else {
    out.push(line('Stato', jobAlert?.status));
    out.push(line('Ricerche salvate', alerts.length));
    for (const a of alerts) {
      const kw = Array.isArray(a.keywords) ? a.keywords.join(', ') : a.keywords;
      out.push(`  - \`${a.id || '(senza id)'}\` — parole chiave: ${kw || '(nessuna)'}; luoghi: ${(a.locations || []).join(', ') || '(nessuno)'}; frequenza: ${a.frequency || '(non impostata)'}; creata il ${toIso(a.createdAt) || '(data non registrata)'}`);
    }
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push(`Per qualsiasi chiarimento o per chiedere la cancellazione dei dati, scriva a ${contact}.`);
  out.push('');
  return out.join('\n');
}
