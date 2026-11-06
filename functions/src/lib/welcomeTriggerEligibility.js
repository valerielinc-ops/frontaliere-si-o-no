/**
 * welcomeTriggerEligibility.js — decide, guardando UNA scrittura su
 * newsletter_subscribers/{email}, se quella scrittura è il momento in cui va
 * mandata la welcome.
 *
 * PERCHÉ SERVE UN TRIGGER, misurato il 2026-08-21.
 *
 * Fino a qui la welcome partiva da una `fetch` fire-and-forget del BROWSER
 * (services/newsletterSubscribers.ts → requestWelcomeEmail, chiamata quando
 * l'upsert riporta `status: 'confirmed'` e il documento non era già attivo). Un
 * canale che dipende dalla pagina viva perde tutti i casi in cui la pagina non
 * lo è, e su un flusso OAuth — dove il browser sta seguendo un redirect — li
 * perde in massa. Sugli iscritti creati dal 29-07:
 *
 *   canale     confermati   con welcome
 *   google           166       165   (99,4%)
 *   altro          1.277     1.213   (95,0%)
 *   linkedin         259       148   (57,1%)   ← 111 persone senza benvenuto
 *
 * Chi la perde non resta senza posta: il cron giornaliero del drip gli manda lo
 * step 0, che è a sua volta un benvenuto — ma 13-27h dopo (mediana 18,3h,
 * contro 0,0h della welcome). Il trigger elimina quel ritardo alla radice,
 * perché osserva la conferma dal lato server, dove nessun redirect può
 * interrompere niente.
 *
 * QUESTO PREDICATO ESISTE PER NON COSTARE NULLA sul traffico che non c'entra.
 * Il documento dell'iscritto viene riscritto a ogni evento dei webhook di
 * consegna (delivered/open/click: ~87.000 consegne al mese sul solo Maileroo),
 * e ognuna di quelle scritture invoca il trigger. Le prime tre condizioni qui
 * sotto escono senza leggere nient'altro.
 *
 * NON è un riparatore retroattivo, ed è deliberato: agisce solo sulla scrittura
 * che PORTA la conferma. Un documento confermato ieri e rimasto senza welcome
 * non viene ripescato dal primo evento di apertura che passa — quello sarebbe
 * un invio a sorpresa, scatenato da un webhook, su un record che nessuno stava
 * guardando. Per gli arretrati la rete resta lo step 0 del drip.
 * Questo rende anche impossibile il ciclo: quando l'invio fallisce,
 * sendNewsletterWelcomeEmail cancella il claim `welcome_sent_at`, e quella
 * cancellazione è una scrittura che NON porta una conferma nuova — quindi non
 * si ri-innesca da sola.
 */

import { RECENCY_WINDOW_MS } from '../newsletterWelcomeEmail.js';

/** Millisecondi da un Timestamp Firestore, da una Date o da una stringa ISO. */
function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Entrambe le grafie del timestamp di conferma. `confirmedAt` è la gemella
 * camelCase che lo scrittore della SPA lascia su 458 documenti (#5673):
 * leggerne una sola qui significherebbe non accorgersi della conferma proprio
 * sui documenti scritti dal percorso client.
 */
function confirmationMillis(data) {
  if (!data) return null;
  return toMillis(data.confirmed_at) ?? toMillis(data.confirmedAt);
}

/**
 * @param {{ before?: object|null, after?: object|null, nowMs?: number }} args
 * @returns {boolean} true se questa scrittura merita un tentativo di welcome.
 */
export function shouldAttemptWelcome({ before, after, nowMs = Date.now() }) {
  // Documento cancellato.
  if (!after) return false;

  // Già inviata, o claim in volo: sendNewsletterWelcomeEmail scrive
  // `welcome_sent_at` in transazione PRIMA di chiamare il provider, quindi
  // questo copre anche l'invio in corso.
  if (after.welcome_sent_at) return false;

  const anchor = confirmationMillis(after);
  if (!anchor) return false;

  // Stessa finestra del sender: oltre, lui risponderebbe `too_old` e il
  // tentativo sarebbe solo un'invocazione sprecata.
  if (nowMs - anchor > RECENCY_WINDOW_MS) return false;

  // La conferma c'era già prima di questa scrittura: non è questa scrittura a
  // portarla. Vedi l'header — niente ripescaggi a sorpresa dai webhook.
  if (confirmationMillis(before) != null) return false;

  return true;
}

export { RECENCY_WINDOW_MS };
