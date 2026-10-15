/**
 * Regression test for the static job-detail timeline fallback.
 *
 * 100% of crawled jobs ship without `_canonical` (no AI pipeline produces
 * it today — translate-pending.yml only relocalises text). Before the
 * fallback wire-in in `build-plugins/jobsSeoPagesPlugin.ts`, every static
 * job page emitted an empty `<div class="timeline">` while the hydrated
 * SPA rendered the same content split into 6 sections.
 *
 * This test pins `buildFallbackCanonicalContent` — the shared splitter
 * the plugin now runs when `_canonical` is missing — by feeding it a
 * representative real-world description (Tether Senior Manager, scraped
 * Mar 2026, no canonical) and asserting the timeline buckets are
 * populated. If this test goes red, the static job HTML will silently
 * regress to "Panoramica only".
 */
import { describe, expect, it } from 'vitest';
import { buildFallbackCanonicalContent } from '@/services/jobs/canonicalFallback';

const TETHER_DESCRIPTION = `Unisciti a Tether e Forma il Futuro della Finanza Digitale A Tether, non stiamo solo costruendo prodotti, siamo pionieri di una rivoluzione finanziaria globale. Le nostre soluzioni all'avanguardia consentono alle aziende, dagli scambi e dai portafogli ai processori di pagamento e agli sportelli bancomat, di integrare senza soluzione di continuità i gettoni di riserva in blockchains. Imbragando la potenza della tecnologia blockchain, Tether consente di memorizzare, inviare e ricevere gettoni digitali istantaneamente, in modo sicuro e globale, il tutto ad una frazione del costo. La trasparenza è la base di tutto ciò che facciamo, garantendo fiducia in ogni transazione.

Responsabilità ● supervisiona il reporting di gestione patrimoniale su scala di portafoglio, compresi gli aggiornamenti delle prestazioni ricorrenti e i materiali di livello di bordo. ● Controllare i framework di reporting, le dashboard e le metriche di performance in allineamento con gli standard di asset management. ● Assicurare accuratezza, coerenza e tempestività dei dati del portafoglio attraverso le uscite di report. ● Consolidare le informazioni finanziarie e operative dai team di investimento in formati di report strutturati. ● Fornire analisi delle prestazioni, commento varianza e approfondimenti di tendenza per la leadership senior. ● Supporta la governance e i processi dei comitati attraverso la preparazione di report e materiali di analisi.

Requisiti: ● 7-12 anni di esperienza nella gestione degli asset, nel reporting del portafoglio, nell'analisi delle prestazioni o in un ruolo correlato all'interno di organizzazioni orientate agli investimenti. ● Forte esperienza nella produzione di report a livello di bordo, dashboard e materiali di performance ricorrenti. ● Eccellente capacità analitiche e alta attenzione ai dettagli. ● Alta competenza in Excel e strumenti di presentazione; l'esperienza con sistemi di reporting o strumenti BI è un vantaggio. ● Capacità di lavorare efficacemente in team e impegnarsi con fiducia con gli stakeholder senior.

Cosa ti offriamo: il nostro team è una potenza di talento globale, lavorando da remoto da ogni angolo del mondo. Tether Education: Democratizzazione dell'accesso all'apprendimento digitale di alto livello, forniamo agli individui di prosperare nelle economie digitali e di gig.

Informazioni importanti per i candidati: applicare solo attraverso i nostri canali ufficiali. Non utilizziamo piattaforme o agenzie di terze parti per il reclutamento, a meno che non sia chiaro. Tutti i ruoli aperti sono elencati nella nostra pagina di carriera ufficiale: https://tether.recruitee.com/`;

describe('canonicalFallback — static job timeline', () => {
 it('populates the timeline from a description with no _canonical', () => {
 const result = buildFallbackCanonicalContent(TETHER_DESCRIPTION, [], 'it');

 // Summary always present — used as Panoramica section.
 expect(result.summary.length).toBeGreaterThan(0);

 // At least three of the structured timeline buckets must be populated
 // so the static HTML emits multiple <div class="timeline-step"> blocks
 // (mansioni, competenze, cosa offre, contatti, ...) instead of the
 // single Panoramica that was shipped before this fallback.
 const populatedTimelineBuckets = [
 result.responsibilities.length > 0,
 result.requirements.length > 0,
 result.benefits.length > 0,
 result.process.length > 0,
 result.sections.length > 0,
 ].filter(Boolean).length;
 expect(populatedTimelineBuckets).toBeGreaterThanOrEqual(3);
 });

 it('handles an empty description gracefully without throwing', () => {
 const result = buildFallbackCanonicalContent('', [], 'it');
 expect(result.summary).toEqual([]);
 expect(result.responsibilities).toEqual([]);
 expect(result.sections).toEqual([]);
 expect(result.readingMinutes).toBeGreaterThanOrEqual(1);
 });

 it('keeps requirements when raw description is empty but requirements array is provided', () => {
 const result = buildFallbackCanonicalContent(
 '',
 [
 'Esperienza pluriennale come sviluppatore TypeScript in ambiente produzione',
 'Conoscenza approfondita di React 19 e dei suoi hook avanzati',
 ],
 'it',
 );
 expect(result.requirements.length).toBeGreaterThanOrEqual(2);
 });
});
