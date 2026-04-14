/**
 * LeadMagnetCTA — Contextual email capture with a free resource incentive
 *
 * Instead of"subscribe to newsletter" (low perceived value), this offers
 * a concrete deliverable: a free PDF checklist/guide relevant to what the
 * user is currently doing. The email is also subscribed to the newsletter.
 *
 * Variants adapt to context:
 * - 'tax_checklist' →"Scarica la checklist fiscale 2026"
 * - 'salary_guide' →"Guida gratuita: come negoziare lo stipendio"
 * - 'relocation' →"Checklist trasloco Italia→Svizzera"
 * - 'insurance' →"Guida LAMal: scegli l'assicurazione giusta"
 * - 'pension' →"Pianifica la pensione: guida AVS/LPP + INPS"
 * - 'generic' →"Guida completa del frontaliere 2026"
 *
 * Dismissed for 14 days. Does not show if already subscribed.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
 Download, Send, CheckCircle2, Loader2, AlertCircle,
 FileText, Shield, Gift, Users, X, ArrowRight,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import {
 upsertNewsletterSubscriber,
 markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { useAuth, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';

// ─── Types ───────────────────────────────────────────────────────────────

export type LeadMagnetVariant =
 | 'tax_checklist'
 | 'salary_guide'
 | 'relocation'
 | 'insurance'
 | 'pension'
 | 'generic';

interface LeadMagnetCTAProps {
 variant: LeadMagnetVariant;
 /** Delay in ms before showing (default: 0 = immediate) */
 delay?: number;
 /** Compact inline style vs. prominent card */
 compact?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────

const DISMISSED_KEY = 'lead_magnet_dismissed';
const SUBSCRIBED_KEY = 'newsletter_subscribed';
const DISMISS_DAYS = 14;

const VARIANT_ICONS: Record<LeadMagnetVariant, typeof FileText> = {
 tax_checklist: FileText,
 salary_guide: FileText,
 relocation: FileText,
 insurance: Shield,
 pension: FileText,
 generic: Gift,
};

const VARIANT_COLORS: Record<LeadMagnetVariant, { gradient: string; iconBg: string; iconText: string; border: string }> = {
 tax_checklist: {
 gradient: 'from-success-subtle to-info-subtle',
 iconBg: 'bg-success-subtle',
 iconText: 'text-success',
 border: 'border-success-border',
 },
 salary_guide: {
 gradient: 'from-accent-subtle to-accent-subtle',
 iconBg: 'bg-accent-subtle',
 iconText: 'text-accent',
 border: 'border-accent-border',
 },
 relocation: {
 gradient: 'from-warning-subtle to-warning-subtle',
 iconBg: 'bg-warning-subtle',
 iconText: 'text-warning',
 border: 'border-warning-border',
 },
 insurance: {
 gradient: 'from-info-subtle to-success-subtle',
 iconBg: 'bg-info-subtle',
 iconText: 'text-info',
 border: 'border-info-border',
 },
 pension: {
 gradient: 'from-info-subtle to-accent-subtle',
 iconBg: 'bg-info-subtle',
 iconText: 'text-info',
 border: 'border-info-border',
 },
 generic: {
 gradient: 'from-warning-subtle via-warning-subtle to-danger-subtle',
 iconBg: 'bg-warning-subtle',
 iconText: 'text-warning',
 border: 'border-warning-border',
 },
};

// ─── Firestore (lazy) ────────────────────────────────────────────────────

let firestoreDb: any = null;

const initFirestore = async () => {
 if (firestoreDb) return firestoreDb;
 try {
 const [{ getFirestore }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 firestoreDb = getFirestore(await getApp());
 return firestoreDb;
 } catch {
 return null;
 }
};

const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
 Promise.race([
 promise,
 new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms)),
 ]);

// ─── PDF Checklist Generator ─────────────────────────────────────────────

const CHECKLIST_CONTENT: Record<LeadMagnetVariant, { title: string; subtitle: string; intro: string; sections: { heading: string; items: string[] }[]; nextSteps: string[] }> = {
 tax_checklist: {
 title: 'Checklist Fiscale Frontaliere 2026',
 subtitle: 'Scadenze, deduzioni e obblighi per lavoratori frontalieri CH-IT',
 intro: 'Questa guida riassume tutti gli obblighi fiscali di un lavoratore frontaliere con permesso G in Canton Ticino. Aggiornata al Nuovo Accordo fiscale Italia-Svizzera entrato in vigore il 17 luglio 2023 e alle aliquote IRPEF 2026.',
 sections: [
 { heading: 'Calendario Scadenze Fiscali', items: [
 'Febbraio: Ricevi il Lohnausweis (certificato di salario) dal datore svizzero',
 'Marzo: Scarica il CU (Certificazione Unica) se hai redditi italiani',
 'Entro 30 aprile: Invio Modello 730 (dipendenti) o Redditi PF (autonomi)',
 'Entro 30 giugno: Versamento IRPEF a saldo anno precedente + 1° acconto (40%)',
 'Entro 30 settembre: Invio Modello Redditi PF per chi non usa il 730',
 'Entro 30 novembre: Versamento 2° acconto IRPEF (60%)',
 'Dicembre: Verifica conguaglio imposta alla fonte sul cedolino svizzero',
 ]},
 { heading: 'Deduzioni e Agevolazioni Fiscali', items: [
 'Franchigia di non imposizione: i primi EUR 10.000 di reddito svizzero sono esenti IRPEF (solo nuovi frontalieri dal 17/07/2023)',
 'Vecchi frontalieri (ante 17/07/2023): franchigia EUR 7.500 fino al 2033, poi EUR 10.000',
 'Credito d\'imposta estero: Art. 165 TUIR - le imposte alla fonte svizzere riducono l\'IRPEF dovuta in Italia',
 'Contributi AVS/AI/IPG (5.3%): deducibili integralmente dal reddito imponibile italiano',
 'Contributi AD (1.1%): deducibili dal reddito imponibile italiano',
 'Contributi LPP (2o pilastro): deducibili fino al limite previsto dalla normativa italiana',
 'Premio LAMal: deducibile come onere sanitario (quadro E del 730, rigo E1)',
 'Spese di trasporto: deducibili fino a EUR 2.500/anno (abbonamento treno, pedaggi, carburante)',
 'Pilastro 3a: i versamenti volontari (max CHF 7.056/anno) sono deducibili in Svizzera ma NON in Italia',
 ]},
 { heading: 'Imposta alla Fonte in Canton Ticino', items: [
 'Tabella A (80%): Celibi/nubili senza figli a carico',
 'Tabella B: Coniugati con un solo reddito (coniuge non lavora)',
 'Tabella C (80%): Coniugati con doppio reddito',
 'Tabella H: Famiglie monoparentali',
 'Riduzione per figli: circa 1-1.5% di riduzione dell\'aliquota per ogni figlio a carico',
 'Esempio: CHF 6.000/mese lordi, tabella A, 0 figli = circa 10.3% di imposta alla fonte',
 'L\'80% dell\'imposta alla fonte viene riversato ai comuni italiani di residenza come"ristorno"',
 ]},
 { heading: 'Documenti da Conservare (min. 5 anni)', items: [
 'Lohnausweis annuale (certificato di salario svizzero)',
 'Cedolini paga mensili con dettaglio trattenute',
 'Attestazione imposte alla fonte trattenute',
 'Ricevute versamenti LPP e Pilastro 3a',
 'Contratto di lavoro svizzero vigente',
 'Permesso G e relative ricevute di rinnovo',
 'Giustificativi spese di trasporto (abbonamenti, ricevute pedaggi, fatture carburante)',
 'Polizza LAMal e ricevute premi pagati',
 'Ricevuta dichiarazione redditi italiana con prospetto liquidazione',
 'Estratto conto contributi INPS e AVS',
 ]},
 { heading: 'Errori Fiscali Comuni da Evitare', items: [
 'NON dimenticare di dichiarare il reddito svizzero in Italia (e\' obbligatorio anche con il Nuovo Accordo)',
 'NON confondere franchigia EUR 10.000 con esenzione totale: sopra EUR 10.000 si paga IRPEF',
 'NON dimenticare di applicare il credito d\'imposta estero: senza, paghi le tasse DUE volte',
 'NON versare il Pilastro 3a pensando di dedurlo in Italia: e\' deducibile solo in Svizzera',
 'Verifica il codice fiscale corretto sul Lohnausweis: errori causano problemi con il 730',
 'Conserva TUTTO per almeno 5 anni: l\'Agenzia delle Entrate puo\' controllare retroattivamente',
 ]},
 ],
 nextSteps: [
 'Usa il calcolatore stipendio netto su frontaliereticino.ch per simulare la tua situazione',
 'Consulta un commercialista specializzato in fiscalita\' transfrontaliera',
 'Verifica i ristorni del tuo comune su frontaliereticino.ch/ristorni-comunali',
 'Iscriviti alla newsletter per ricevere avvisi sulle scadenze fiscali',
 ],
 },
 salary_guide: {
 title: 'Guida Stipendio Netto Frontaliere 2026',
 subtitle: 'Calcola, confronta e negozia il tuo stipendio in Svizzera',
 intro: 'Questa guida ti aiuta a capire quanto guadagnerai effettivamente come frontaliere in Canton Ticino. Include tutte le trattenute svizzere, l\'imposta alla fonte, e la tassazione italiana residua. Aggiornata alle aliquote 2026.',
 sections: [
 { heading: 'Contributi Sociali Svizzeri (a carico dipendente)', items: [
 'AVS/AI/IPG (1o pilastro previdenza): 5.3% dello stipendio lordo',
 'AD (Assicurazione Disoccupazione): 1.1% fino a CHF 148.200/anno',
 'AD supplementare: 0.5% sulla parte oltre CHF 148.200',
 'LAINF (Infortuni non professionali): 0.5-1.5% (varia per settore e azienda)',
 'IJM (Indennita\' giornaliera malattia): 0.5-1.5% (varia per contratto collettivo)',
 'LPP (2o pilastro - cassa pensione): varia per eta\' e piano aziendale',
 ' - 25-34 anni: circa 7% (3.5% dipendente + 3.5% datore)',
 ' - 35-44 anni: circa 10% (5% + 5%)',
 ' - 45-54 anni: circa 15% (7.5% + 7.5%)',
 ' - 55-65 anni: circa 18% (9% + 9%)',
 'TOTALE trattenute dipendente: dal 15% al 27% circa del lordo',
 ]},
 { heading: 'Esempio Pratico: CHF 6.000/mese lordi', items: [
 'Stipendio lordo mensile: CHF 6.000',
 'AVS/AI/IPG (5.3%): - CHF 318',
 'AD (1.1%): - CHF 66',
 'LAINF (0.7%): - CHF 42',
 'IJM (0.8%): - CHF 48',
 'LPP 35-44 anni (5%): - CHF 300',
 'Imposta alla fonte Tab. A (10.3%): - CHF 618',
 '= Netto svizzero: circa CHF 4.608/mese',
 'Convertito in EUR (tasso 0.94): circa EUR 4.332/mese',
 'Meno IRPEF residua italiana (dopo credito imposta): circa - EUR 150-300/mese',
 '= Netto finale effettivo: circa EUR 4.030-4.180/mese',
 ]},
 { heading: 'Tabelle Imposta alla Fonte - Aliquote Indicative', items: [
 'CHF 4.000/mese: Tab A ~6.5%, Tab B ~2.8%, Tab C ~5.2%',
 'CHF 5.000/mese: Tab A ~8.5%, Tab B ~4.5%, Tab C ~7.0%',
 'CHF 6.000/mese: Tab A ~10.3%, Tab B ~6.2%, Tab C ~8.5%',
 'CHF 7.000/mese: Tab A ~12.0%, Tab B ~7.8%, Tab C ~10.0%',
 'CHF 8.000/mese: Tab A ~13.5%, Tab B ~9.2%, Tab C ~11.5%',
 'CHF 10.000/mese: Tab A ~15.8%, Tab B ~11.5%, Tab C ~13.5%',
 'NOTA: le aliquote esatte dipendono da cantone, comune, chiesa e figli a carico',
 ]},
 { heading: 'Consigli per la Negoziazione Salariale', items: [
 'Confronta SEMPRE il netto, non il lordo: un CHF 7.000 lordo puo\' rendere meno di un CHF 6.500 con benefit migliori',
 'Verifica la 13esima: obbligatoria in molti CCL (Contratti Collettivi di Lavoro) svizzeri',
 'Chiedi il piano LPP aziendale: alcune aziende offrono contributi extra (sovraobbligatorio)',
 'Negozia rimborso spese di trasporto: CHF 100-200/mese per chi abita lontano dal confine',
 'Valuta i benefit non monetari: parcheggio aziendale, buoni pasto, formazione pagata',
 'Stipendio minimo di riferimento in Ticino: CHF 19.75/ora (contratto tipo dal 2021)',
 'Settori ben pagati per frontalieri: farmaceutico (mediana CHF 7.500), IT (CHF 7.000), finanza (CHF 8.000)',
 'Usa frontaliereticino.ch/confronta-stipendi per confrontare il tuo stipendio con il mercato',
 ]},
 ],
 nextSteps: [
 'Simula il tuo stipendio netto esatto su frontaliereticino.ch',
 'Confronta il potere d\'acquisto CH vs IT con il comparatore costo della vita',
 'Valuta se convenga il Permesso B (residente) vs Permesso G (frontaliere)',
 'Scarica il tuo report PDF personalizzato dopo la simulazione',
 ],
 },
 relocation: {
 title: 'Checklist Completa: Iniziare a Lavorare in Svizzera',
 subtitle: 'Guida passo-passo per nuovi frontalieri dall\'Italia',
 intro: 'Questa checklist copre tutto cio\' che devi fare prima, durante e dopo l\'inizio del tuo lavoro come frontaliere in Canton Ticino. Segui i passi in ordine per non dimenticare nulla.',
 sections: [
 { heading: 'FASE 1: Prima dell\'Inizio (2-4 settimane prima)', items: [
 'Firma il contratto di lavoro svizzero (verifica durata, preavviso, CCL applicato)',
 'Richiedi il Permesso G al Comune svizzero dove lavorerai (serve contratto + documento identita\')',
 'Verifica di risiedere in un comune di frontiera riconosciuto (entro 20 km dal confine)',
 'Apri un conto bancario svizzero (UBS, Credit Suisse, PostFinance, Raiffeisen, BancaStato)',
 'Documenti per il conto: passaporto/CI, permesso G, contratto di lavoro, prova di residenza italiana',
 'Comunica al tuo Comune italiano di residenza l\'inizio dell\'attivita\' frontaliera',
 'Richiedi la tessera TEAM (Tessera Europea Assicurazione Malattia) alla tua ASL',
 ]},
 { heading: 'FASE 2: Assicurazione Sanitaria (entro 3 mesi)', items: [
 'SCELTA CRUCIALE: LAMal svizzera oppure SSN italiano (diritto di opzione)',
 'La scelta e\' IRREVERSIBILE per tutta la durata del rapporto di lavoro attuale',
 'Se scegli LAMal svizzera:',
 ' - Confronta almeno 5 casse malati (i premi variano fino al 40%)',
 ' - Scegli il modello: Telmed (miglior rapporto qualita\'/prezzo, sconto 10-12%)',
 ' - Scegli la franchigia: CHF 2.500 se sei giovane e sano (risparmio max)',
 ' - Casse consigliate in Ticino: Assura, Helsana, CSS, Swica, Concordia',
 'Se scegli SSN italiano:',
 ' - Compila il modulo di esenzione dalla LAMal (presso il Cantone)',
 ' - Mantieni l\'iscrizione al SSN e paga il ticket regionale',
 ' - Cure in Svizzera coperte solo per urgenze con la TEAM',
 'CONSIGLIO: LAMal conviene se lavori a lungo in CH; SSN se hai famiglia in Italia',
 'Verifica copertura LAINF (infortuni): automatica tramite il datore di lavoro',
 ]},
 { heading: 'FASE 3: Trasporto e Logistica', items: [
 'Calcola il percorso ottimale: Google Maps al mattino alle 7:00 per tempi reali',
 'Valico di Chiasso/Brogeda: 30-60 min di coda nelle ore di punta (7:00-8:30)',
 'Valico di Ponte Tresa: generalmente meno trafficato',
 'Alternativa treno TILO: S10/S40 da Como/Varese, abbonamento mensile circa CHF 200-350',
 'Vignetta autostradale svizzera: CHF 40/anno (obbligatoria per autostrada)',
 'Pedaggio autostradale italiano: verifica il costo annuo sulla tua tratta',
 'Carpooling: cerca gruppi su BlaBlaCar Daily o Facebook"Frontalieri Carpooling"',
 'Costi medi pendolarismo auto: CHF 400-600/mese (carburante + pedaggi + usura)',
 'Parcheggio in Svizzera: CHF 100-250/mese in citta\'; gratuito in molte zone industriali',
 ]},
 { heading: 'FASE 4: Primi Giorni di Lavoro', items: [
 'Porta il Permesso G (originale) al datore il primo giorno',
 'Fornisci le coordinate bancarie svizzere per l\'accredito stipendio',
 'Verifica con HR: tabella imposta alla fonte corretta (A/B/C/H), numero figli, chiesa',
 'Chiedi il regolamento aziendale: orari, ferie, malattia, home office',
 'Attiva l\'app SwissCovid se richiesto e SuisseID per servizi online',
 'Conserva tutti i cedolini paga dal primo mese',
 ]},
 { heading: 'FASE 5: Dopo i Primi 3 Mesi', items: [
 'Verifica il primo cedolino: controlla che le trattenute corrispondano alla tua tabella',
 'Iscriviti al Pilastro 3a per il risparmio previdenziale agevolato (max CHF 7.056/anno)',
 'Apri un conto Wise o Revolut per il cambio CHF/EUR a tassi vantaggiosi',
 'Verifica i ristorni comunali: controlla quanto il tuo comune riceve dalla Svizzera',
 'Inizia a raccogliere i documenti per la dichiarazione redditi italiana',
 'Considera un commercialista specializzato per la prima dichiarazione',
 ]},
 ],
 nextSteps: [
 'Calcola il tuo stipendio netto su frontaliereticino.ch',
 'Confronta le casse malati con il comparatore LAMal su frontaliereticino.ch',
 'Consulta la mappa dei valichi e del traffico in tempo reale',
 'Leggi le esperienze di altri frontalieri nella sezione community',
 ],
 },
 insurance: {
 title: 'Guida Completa LAMal per Frontalieri 2026',
 subtitle: 'Come scegliere, confrontare e risparmiare sull\'assicurazione sanitaria svizzera',
 intro: 'La scelta dell\'assicurazione sanitaria e\' una delle decisioni piu\' importanti per un frontaliere. Questa guida ti aiuta a capire il sistema LAMal svizzero e a scegliere la soluzione migliore per la tua situazione.',
 sections: [
 { heading: 'Diritto di Opzione: LAMal vs SSN', items: [
 'Come frontaliere hai 3 MESI dall\'inizio lavoro per scegliere',
 'Opzione 1 - LAMal svizzera: paghi un premio mensile, copertura completa in CH',
 'Opzione 2 - SSN italiano: mantieni il servizio sanitario nazionale, limiti in CH',
 'ATTENZIONE: la scelta e\' IRREVERSIBILE per tutto il rapporto di lavoro attuale',
 'Se cambi datore, puoi cambiare scelta (nuovo diritto di opzione)',
 'Se non comunichi nulla entro 3 mesi: vieni assegnato d\'ufficio alla LAMal',
 ]},
 { heading: 'Quando Conviene la LAMal', items: [
 'Lavori a tempo pieno in Svizzera e ci passi la maggior parte della giornata',
 'Non hai patologie croniche che richiedono cure specialistiche in Italia',
 'Vuoi accesso diretto a ospedali e medici svizzeri (qualita\' alta, tempi brevi)',
 'Vuoi che anche le emergenze in Italia siano coperte (con la carta LAMal)',
 'Il tuo datore offre un contributo al premio assicurativo',
 ]},
 { heading: 'Quando Conviene il SSN Italiano', items: [
 'Hai figli piccoli che necessitano di pediatra e visite frequenti in Italia',
 'Hai patologie croniche seguite da specialisti italiani',
 'Il tuo stipendio e\' basso e il premio LAMal peserebbe troppo',
 'Lavori part-time e passi piu\' tempo in Italia che in Svizzera',
 'Tuo coniuge e\' gia\' iscritto al SSN e vuoi mantenere il nucleo familiare unito',
 ]},
 { heading: 'Modelli Assicurativi LAMal - Confronto Dettagliato', items: [
 'STANDARD (libera scelta medica):',
 ' Sconto: 0% | Pro: vai da chi vuoi | Contro: premio piu\' alto',
 'MEDICO DI FAMIGLIA (HMO):',
 ' Sconto: 10-15% | Pro: risparmio | Contro: DEVI passare dal medico base',
 'TELMED (consulenza telefonica):',
 ' Sconto: 8-12% | Pro: comodo, risparmio | Contro: devi chiamare prima di ogni visita',
 'FARMACIA (Rete):',
 ' Sconto: 5-10% | Pro: accesso senza appuntamento | Contro: limitato a farmacie convenzionate',
 'CONSIGLIO PER FRONTALIERI: Telmed e\' il miglior compromesso. La consulenza telefonica',
 ' e\' veloce e nella maggior parte dei casi ti indirizza subito allo specialista.',
 ]},
 { heading: 'Franchigie - Quale Scegliere', items: [
 'Franchigia = quanto paghi di tasca TUA prima che l\'assicurazione copra le spese',
 'CHF 300 (minima): premio mensile piu\' alto, ma quasi tutto coperto subito',
 ' Ideale per: famiglie con bambini, persone con malattie croniche',
 'CHF 500: leggermente meno, buon compromesso',
 'CHF 1.000: risparmio moderato sul premio',
 'CHF 1.500: risparmio significativo, per chi va poco dal medico',
 'CHF 2.000: solido risparmio per persone sane',
 'CHF 2.500 (massima): premio minimo, ma paghi tutto fino a CHF 2.500',
 ' Ideale per: giovani sani che vanno dal medico meno di 1-2 volte l\'anno',
 'CALCOLO: se spendi meno di CHF 2.000/anno in cure, la franchigia CHF 2.500 conviene',
 'Dopo la franchigia, paghi il 10% delle spese (aliquota) fino a max CHF 700/anno',
 ]},
 { heading: 'Casse Malati in Ticino - Premi Indicativi 2026', items: [
 'Assura: tra le piu\' economiche, buon servizio online (premio base da CHF 280/mese)',
 'Helsana: grande gruppo, rete capillare (premio base da CHF 310/mese)',
 'CSS: eccellente app e servizi digitali (premio base da CHF 295/mese)',
 'Swica: ottimo servizio clienti, in italiano (premio base da CHF 320/mese)',
 'Concordia: cooperativa, prezzi competitivi (premio base da CHF 285/mese)',
 'NOTA: i premi variano fino al 30-40% tra casse. Confronta SEMPRE prima di scegliere.',
 'Puoi cambiare cassa malati ogni anno entro il 30 novembre (effetto 1 gennaio)',
 'Usa il comparatore su frontaliereticino.ch per trovare il premio migliore per te',
 ]},
 ],
 nextSteps: [
 'Confronta i premi con il comparatore LAMal su frontaliereticino.ch',
 'Se hai gia\' la LAMal, verifica se puoi risparmiare cambiando cassa entro il 30 novembre',
 'Considera un\'assicurazione complementare per cure dentarie e occhiali',
 'Scarica il modulo di esenzione LAMal se scegli il SSN (disponibile sul sito cantonale)',
 ],
 },
 pension: {
 title: 'Guida Pensione Frontaliere: AVS + LPP + INPS',
 subtitle: 'Come funziona la previdenza tra Svizzera e Italia per lavoratori frontalieri',
 intro: 'Come frontaliere contribuisci a DUE sistemi previdenziali: quello svizzero (AVS + LPP) e quello italiano (INPS, se hai periodi lavorativi in Italia). Questa guida ti spiega come funzionano, come si coordinano, e come pianificare per la pensione.',
 sections: [
 { heading: '1o Pilastro: AVS/AI (Rendita Base Svizzera)', items: [
 'Contributo: 5.3% del lordo a carico tuo + 5.3% a carico del datore = 10.6% totale',
 'Rendita massima 2026: CHF 2.450/mese (per 44 anni di contributi completi)',
 'Rendita minima: CHF 1.225/mese (almeno 1 anno di contributi)',
 'Eta\' pensionabile: 65 anni (uomini); 64 anni e 3 mesi (donne, graduale aumento a 65 entro 2028)',
 'Pensione anticipata: possibile a 63 anni con riduzione del 6.8% per anno',
 'Pensione posticipata: possibile fino a 70 anni con aumento del 5.2-31.5%',
 'Se hai lavorato meno di 44 anni in Svizzera: rendita proporzionale (scala 44)',
 'Esempio: 20 anni di contributi AVS su scala 44 = circa CHF 1.114/mese (20/44 della rendita piena)',
 'La rendita AVS viene pagata mensilmente sul tuo conto anche se vivi in Italia',
 ]},
 { heading: '2o Pilastro: LPP (Cassa Pensione Aziendale)', items: [
 'Obbligatoria per stipendi > CHF 22.050/anno (soglia d\'ingresso 2026)',
 'Contributi a carico dipendente (meta\' del totale):',
 ' - 25-34 anni: 3.5% del salario coordinato',
 ' - 35-44 anni: 5.0%',
 ' - 45-54 anni: 7.5%',
 ' - 55-65 anni: 9.0%',
 'Il datore paga ALMENO l\'altra meta\' (molte aziende pagano di piu\')',
 'Il capitale e\' PERSONALE: puoi vedere il saldo sul certificato di previdenza annuale',
 'Rendimento minimo garantito: 1.25% annuo (parte obbligatoria)',
 'Riscatto volontario: puoi versare contributi extra per riempire"lacune" e dedurre dalle tasse',
 ]},
 { heading: 'Cosa Succede alla LPP Quando Lasci la Svizzera', items: [
 'Se torni in un paese UE/AELS (Italia):',
 ' - Parte OBBLIGATORIA: resta in Svizzera come rendita futura (non liquidabile)',
 ' - Parte SOVRAOBBLIGATORIA: puoi chiedere il versamento in contanti',
 'Se vai in un paese FUORI dall\'UE: puoi ritirare TUTTO il capitale LPP',
 'Il capitale viene trasferito su un conto di libero passaggio fino al momento del prelievo',
 'Tassazione del prelievo: aliquota agevolata cantonale (circa 5-10% a seconda del cantone)',
 'IMPORTANTE: anche la parte obbligatoria ti verra\' pagata come rendita quando raggiungi l\'eta\' pensionabile',
 'Puoi scegliere tra rendita mensile o prelievo in capitale (dipende dal regolamento della cassa)',
 ]},
 { heading: 'Pilastro 3a: Risparmio Previdenziale Volontario', items: [
 'Versamento massimo 2026: CHF 7.056/anno (per dipendenti con 2o pilastro)',
 'Completamente deducibile dal reddito imponibile SVIZZERO',
 'NON deducibile dal reddito imponibile italiano',
 'Prelievo possibile: 5 anni prima dell\'eta\' pensionabile, per acquisto abitazione, o se lasci la CH',
 'Investimento: puoi scegliere tra conto risparmio (tasso fisso) o fondi (rendimento variabile)',
 'Conviene se: hai un\'aliquota alla fonte alta (>12%) e vuoi ridurre le tasse svizzere',
 'Conti 3a consigliati: VIAC, Finpension, Frankly (basse commissioni, buoni rendimenti)',
 ]},
 { heading: 'Coordinamento con INPS Italia', items: [
 'TOTALIZZAZIONE: gli anni lavorati in Svizzera contano per raggiungere i requisiti pensionistici INPS',
 'Esempio: 15 anni INPS + 10 anni AVS = 25 anni totali (soddisfa il requisito di 20 anni INPS)',
 'Le rendite restano SEPARATE: riceverai una rendita AVS + una rendita INPS',
 'I contributi AVS NON vengono trasferiti all\'INPS (e viceversa)',
 'Per richiedere la totalizzazione: domanda all\'INPS con documentazione dei periodi svizzeri',
 'Richiedi ogni anno l\'estratto conto contributivo INPS per verificare la tua situazione',
 'Il formulario E205 (CH) attesta i periodi contributivi svizzeri per l\'INPS',
 'Attenzione: periodi sovrapposti (CH + IT) vengono contati una sola volta',
 ]},
 { heading: 'Simulazione Pensionistica - Esempio', items: [
 'Frontaliere, 40 anni, stipendio CHF 6.000/mese, lavora in CH da 10 anni:',
 'Se lavora in CH fino a 65 anni (totale 35 anni):',
 ' - AVS: circa CHF 1.950/mese (35/44 della rendita piena)',
 ' - LPP: capitale stimato CHF 350.000-450.000 (rendita o prelievo)',
 ' - INPS (se ha 10 anni Italia): rendita proporzionale circa EUR 300-500/mese',
 ' - Pilastro 3a (se versa CHF 7.056/anno per 25 anni): circa CHF 220.000',
 'TOTALE STIMATO: CHF 2.500-3.500/mese di rendita + capitale 3a',
 'Usa il simulatore pensione su frontaliereticino.ch per una stima personalizzata',
 ]},
 ],
 nextSteps: [
 'Simula la tua pensione futura su frontaliereticino.ch/simulatore-pensione',
 'Richiedi il certificato di previdenza LPP al tuo datore (aggiornamento annuale)',
 'Apri un conto Pilastro 3a se non l\'hai ancora fatto',
 'Richiedi l\'estratto conto INPS su inps.it per verificare i tuoi contributi italiani',
 'Valuta il riscatto LPP volontario per riempire eventuali lacune previdenziali',
 ],
 },
 generic: {
 title: 'Guida Completa del Frontaliere 2026',
 subtitle: 'Tutto quello che devi sapere per lavorare in Svizzera dall\'Italia',
 intro: 'Questa guida raccoglie tutte le informazioni essenziali per chi lavora o vuole lavorare come frontaliere in Canton Ticino. Copre tasse, stipendio, assicurazione sanitaria, pensione e vita quotidiana. Aggiornata al 2026.',
 sections: [
 { heading: 'Tasse e Fiscalita\'', items: [
 'Imposta alla fonte in Canton Ticino: dal 4% al 25%+ in base a stipendio e stato civile',
 'Tabelle: A (celibe), B (coniugato reddito unico), C (doppio reddito), H (monoparentale)',
 'Franchigia per nuovi frontalieri (dal 17/07/2023): EUR 10.000 di reddito esente IRPEF',
 'Vecchi frontalieri (ante 17/07/2023): franchigia EUR 7.500 (transitoria fino al 2033)',
 'Dichiarazione redditi italiana OBBLIGATORIA: Modello 730 entro il 30 aprile',
 'Credito d\'imposta estero: le imposte svizzere riducono l\'IRPEF (Art. 165 TUIR)',
 'I contributi AVS, AD e LPP sono deducibili dal reddito imponibile italiano',
 'Pilastro 3a: deducibile solo in Svizzera, NON in Italia',
 'Ristorni comunali: l\'80% dell\'imposta alla fonte viene riversato al tuo comune italiano',
 ]},
 { heading: 'Stipendio e Contributi', items: [
 'Contributi sociali a carico dipendente: dal 15% al 27% del lordo',
 'AVS/AI/IPG: 5.3% | AD: 1.1% | LAINF: 0.5-1.5% | IJM: 0.5-1.5%',
 'LPP (cassa pensione): 3.5-9% in base all\'eta\' (25-65 anni)',
 'Stipendio minimo in Ticino: CHF 19.75/ora (contratto tipo)',
 '13esima mensilita\': obbligatoria in molti Contratti Collettivi svizzeri',
 'Esempio: CHF 6.000 lordi = circa EUR 4.000-4.200 netti finali (dopo tutte le tasse IT+CH)',
 'Usa il calcolatore su frontaliereticino.ch per una stima precisa della tua situazione',
 ]},
 { heading: 'Assicurazione Sanitaria', items: [
 'Diritto di opzione: LAMal svizzera OPPURE SSN italiano (scelta irreversibile)',
 'Hai 3 mesi dall\'inizio lavoro per decidere',
 'LAMal: premio mensile CHF 280-350, copertura completa in CH',
 'Modello Telmed: miglior rapporto qualita\'/prezzo per frontalieri (sconto 10-12%)',
 'Franchigia CHF 2.500: massimo risparmio per giovani sani',
 'Puoi cambiare cassa malati ogni anno entro il 30 novembre',
 'Confronta sempre almeno 3-5 casse prima di scegliere',
 ]},
 { heading: 'Pensione e Previdenza', items: [
 'AVS (1o pilastro): rendita base, max CHF 2.450/mese, eta\' 65 anni',
 'LPP (2o pilastro): cassa pensione aziendale, capitale personale e portatile',
 'Pilastro 3a: risparmio volontario fino a CHF 7.056/anno, deducibile in CH',
 'Se torni in Italia: la parte obbligatoria LPP resta in Svizzera come rendita futura',
 'Totalizzazione INPS: gli anni svizzeri contano per i requisiti pensionistici italiani',
 'Riceverai DUE pensioni separate: una AVS (dalla Svizzera) + una INPS (dall\'Italia)',
 ]},
 { heading: 'Trasporto e Vita Quotidiana', items: [
 'Percorso e tempi: calcola con Google Maps alle 7:00 del mattino per tempi reali',
 'Valichi principali: Chiasso (30-60 min coda), Ponte Tresa (meno trafficato)',
 'Treno TILO: S10/S40 da Como e Varese, abbonamento CHF 200-350/mese',
 'Vignetta autostradale svizzera: CHF 40/anno (obbligatoria)',
 'Conto bancario svizzero: obbligatorio per accredito stipendio',
 'Cambio CHF/EUR: usa Wise o Revolut per tassi migliori della banca',
 'Carpooling: Facebook"Frontalieri Carpooling" o BlaBlaCar Daily',
 'Costi medi pendolarismo auto: CHF 400-600/mese tutto incluso',
 ]},
 { heading: 'Primi Passi per Nuovi Frontalieri', items: [
 '1. Firma il contratto di lavoro svizzero',
 '2. Richiedi il Permesso G al Comune svizzero',
 '3. Apri un conto bancario svizzero',
 '4. Scegli assicurazione sanitaria entro 3 mesi (LAMal o SSN)',
 '5. Comunica al Comune italiano l\'inizio attivita\' frontaliera',
 '6. Verifica il primo cedolino (trattenute e tabella imposta alla fonte)',
 '7. Raccogli documenti per la dichiarazione redditi italiana',
 '8. Considera un commercialista specializzato per la prima dichiarazione',
 ]},
 ],
 nextSteps: [
 'Calcola il tuo stipendio netto esatto su frontaliereticino.ch',
 'Confronta le casse malati LAMal con il comparatore assicurazioni',
 'Simula la tua pensione futura con il simulatore previdenziale',
 'Leggi gli articoli aggiornati sul blog per frontalieri',
 'Iscriviti alla newsletter per ricevere aggiornamenti settimanali',
 ],
 },
};

/** Lazy-load jsPDF and generate a branded PDF checklist for the given variant */
async function generateChecklistPDF(variant: LeadMagnetVariant): Promise<void> {
 const { default: jsPDF } = await import('jspdf');
 const content = CHECKLIST_CONTENT[variant];
 const doc = new jsPDF();
 const pageWidth = doc.internal.pageSize.getWidth();
 const pageHeight = doc.internal.pageSize.getHeight();
 const margin = 20;
 const contentWidth = pageWidth - margin * 2;
 const footerHeight = 20;
 const maxY = pageHeight - footerHeight - 5;
 let y = 0;

 const ensureSpace = (needed: number) => {
 if (y + needed > maxY) {
 doc.addPage();
 y = 25;
 }
 };

 // ── Header ──
 doc.setFillColor(30, 41, 59); // slate-800
 doc.rect(0, 0, pageWidth, 48, 'F');
 doc.setFillColor(79, 70, 229); // stripe-600
 doc.rect(0, 48, pageWidth, 3, 'F');

 doc.setTextColor(255, 255, 255);
 doc.setFontSize(20);
 doc.setFont('helvetica', 'bold');
 const titleLines = doc.splitTextToSize(content.title, contentWidth);
 doc.text(titleLines, margin, 20);
 doc.setFontSize(11);
 doc.setFont('helvetica', 'normal');
 doc.text(content.subtitle, margin, 36);

 // Date stamp
 doc.setFontSize(8);
 const dateStr = new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long' });
 doc.text(`Aggiornato: ${dateStr}`, pageWidth - margin - 45, 44);
 y = 62;

 // ── Branding line ──
 doc.setTextColor(100, 116, 139); // slate-500
 doc.setFontSize(8);
 doc.text('frontaliereticino.ch — La risorsa #1 per lavoratori frontalieri in Canton Ticino', margin, y);
 y += 10;

 // ── Introduction paragraph ──
 if (content.intro) {
 doc.setTextColor(51, 65, 85); // slate-700
 doc.setFontSize(10);
 doc.setFont('helvetica', 'italic');
 const introLines = doc.splitTextToSize(content.intro, contentWidth);
 doc.text(introLines, margin, y);
 y += introLines.length * 5 + 8;
 doc.setFont('helvetica', 'normal');

 // Divider line
 doc.setDrawColor(203, 213, 225); // slate-300
 doc.setLineWidth(0.3);
 doc.line(margin, y - 3, pageWidth - margin, y - 3);
 y += 4;
 }

 // ── Sections ──
 for (const section of content.sections) {
 ensureSpace(25);

 // Section heading with background
 doc.setFillColor(241, 245, 249); // slate-100
 doc.roundedRect(margin - 2, y - 5, contentWidth + 4, 10, 2, 2, 'F');
 doc.setTextColor(30, 41, 59); // slate-800
 doc.setFontSize(12);
 doc.setFont('helvetica', 'bold');
 doc.text(section.heading, margin, y + 2);
 y += 14;

 // Checklist items
 doc.setFont('helvetica', 'normal');
 doc.setFontSize(10);
 for (const item of section.items) {
 ensureSpace(12);

 const isIndented = item.startsWith(' ');
 const displayItem = isIndented ? item.trim() : item;
 const itemMargin = isIndented ? margin + 8 : margin;
 const itemWidth = isIndented ? contentWidth - 18 : contentWidth - 10;

 if (!isIndented) {
 // Checkbox square
 doc.setDrawColor(148, 163, 184); // slate-400
 doc.setLineWidth(0.4);
 doc.rect(margin, y - 3, 4, 4);
 } else {
 // Indented sub-item bullet
 doc.setTextColor(148, 163, 184);
 doc.setFontSize(8);
 doc.text('▸', itemMargin - 4, y);
 doc.setFontSize(10);
 }

 // Item text (with wrapping)
 doc.setTextColor(51, 65, 85); // slate-700
 const lines = doc.splitTextToSize(displayItem, itemWidth);
 doc.text(lines, isIndented ? itemMargin : margin + 8, y);
 y += lines.length * 5 + 3;
 }

 y += 6;
 }

 // ── Next Steps section ──
 if (content.nextSteps && content.nextSteps.length > 0) {
 ensureSpace(30);

 // Divider line
 doc.setDrawColor(79, 70, 229); // stripe-600
 doc.setLineWidth(0.5);
 doc.line(margin, y - 2, pageWidth - margin, y - 2);
 y += 6;

 // Heading
 doc.setFillColor(238, 242, 255); // stripe-50
 doc.roundedRect(margin - 2, y - 5, contentWidth + 4, 10, 2, 2, 'F');
 doc.setTextColor(67, 56, 202); // stripe-700
 doc.setFontSize(12);
 doc.setFont('helvetica', 'bold');
 doc.text('Prossimi Passi', margin, y + 2);
 y += 14;

 doc.setFont('helvetica', 'normal');
 doc.setFontSize(10);
 for (let i = 0; i < content.nextSteps.length; i++) {
 ensureSpace(12);

 // Numbered circle
 doc.setFillColor(79, 70, 229); // stripe-600
 doc.circle(margin + 2, y - 1, 3, 'F');
 doc.setTextColor(255, 255, 255);
 doc.setFontSize(8);
 doc.text(`${i + 1}`, margin + 0.8, y + 0.8);

 // Step text
 doc.setTextColor(51, 65, 85);
 doc.setFontSize(10);
 const stepLines = doc.splitTextToSize(content.nextSteps[i], contentWidth - 14);
 doc.text(stepLines, margin + 10, y);
 y += stepLines.length * 5 + 3;
 }
 }

 // ── CTA at the end ──
 ensureSpace(25);
 y += 5;
 doc.setFillColor(238, 242, 255); // stripe-50
 doc.roundedRect(margin - 2, y - 5, contentWidth + 4, 18, 3, 3, 'F');
 doc.setDrawColor(79, 70, 229);
 doc.setLineWidth(0.5);
 doc.roundedRect(margin - 2, y - 5, contentWidth + 4, 18, 3, 3, 'S');
 doc.setTextColor(67, 56, 202);
 doc.setFontSize(10);
 doc.setFont('helvetica', 'bold');
 doc.text('Visita frontaliereticino.ch per calcolatori, guide e strumenti gratuiti', margin + 4, y + 3);
 doc.setFont('helvetica', 'normal');
 doc.setFontSize(9);
 doc.setTextColor(100, 116, 139);
 doc.text('Confronta stipendi, pensioni, assicurazioni e costo della vita — tutto in un unico portale.', margin + 4, y + 10);

 // ── Footer on all pages ──
 const pageCount = doc.getNumberOfPages();
 for (let i = 1; i <= pageCount; i++) {
 doc.setPage(i);
 const ph = doc.internal.pageSize.getHeight();
 doc.setFillColor(241, 245, 249);
 doc.rect(0, ph - footerHeight, pageWidth, footerHeight, 'F');
 doc.setDrawColor(203, 213, 225);
 doc.setLineWidth(0.3);
 doc.line(0, ph - footerHeight, pageWidth, ph - footerHeight);
 doc.setTextColor(100, 116, 139);
 doc.setFontSize(8);
 doc.text(
 `© ${new Date().getFullYear()} Frontaliere Ticino — frontaliereticino.ch | Guida gratuita, non costituisce consulenza fiscale/legale`,
 margin,
 ph - 8,
 );
 doc.text(`${i}/${pageCount}`, pageWidth - margin - 8, ph - 8);
 }

 // ── Download ──
 const filename = `frontaliere-${variant.replace(/_/g, '-')}-2026.pdf`;
 doc.save(filename);
}

// ─── Component ───────────────────────────────────────────────────────────

const LeadMagnetCTA: React.FC<LeadMagnetCTAProps> = ({
 variant,
 delay = 0,
 compact = false,
}) => {
 const { t, locale } = useTranslation();
 const { user, signIn: googleSignIn } = useAuth();
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const googleButtonRef = useRef<HTMLDivElement>(null);
 const [visible, setVisible] = useState(() => {
 if (delay > 0) return false;
 if (typeof window === 'undefined') return false;
 if (localStorage.getItem(SUBSCRIBED_KEY) === 'true') return false;
 const dismissed = localStorage.getItem(DISMISSED_KEY);
 if (dismissed) {
 const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
 if (daysSince < DISMISS_DAYS) return false;
 }
 return true;
 });
 const [email, setEmail] = useState('');
 const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error' | 'exists'>('idle');
 const [errorMessage, setErrorMessage] = useState('');

 // Show after delay
 useEffect(() => {
 if (localStorage.getItem(SUBSCRIBED_KEY) === 'true') return;
 const dismissed = localStorage.getItem(DISMISSED_KEY);
 if (dismissed) {
 const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
 if (daysSince < DISMISS_DAYS) return;
 }

 if (delay > 0) {
 const timer = setTimeout(() => setVisible(true), delay);
 return () => clearTimeout(timer);
 } else {
 setVisible(true);
 }
 }, [delay]);

 useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);

 useEffect(() => {
 if (!visible || user) {
 if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
 setGoogleButtonReady(false);
 return;
 }
 let cancelled = false;
 const mount = async () => {
 if (!googleButtonRef.current || cancelled) return;
 try {
 const ready = await renderGoogleButtonWithReadiness(googleButtonRef.current, {
 theme: 'outline', size: 'large', text: 'continue_with', width: 280, locale,
 });
 if (!cancelled) setGoogleButtonReady(ready);
 } catch {
 if (!cancelled) setGoogleButtonReady(false);
 }
 };
 void mount();
 return () => { cancelled = true; };
 }, [visible, user, locale]);

 // Pre-fill from auth
 useEffect(() => {
 const tryAuth = async () => {
 try {
 const [{ getAuth }, { getApp }] = await Promise.all([
 import('firebase/auth'),
 import('@/services/firebase'),
 ]);
 const auth = getAuth(await getApp());
 const unsub = auth.onAuthStateChanged((u) => {
 if (u?.email && !email) setEmail(u.email);
 unsub();
 });
 } catch { /* silent */ }
 };
 tryAuth();
 }, []);

 const handleDismiss = useCallback(() => {
 localStorage.setItem(DISMISSED_KEY, String(Date.now()));
 setVisible(false);
 Analytics.trackUIInteraction('lead_magnet', 'banner', 'dismiss', variant);
 }, [variant]);

 const handleSubmit = useCallback(async (e: React.FormEvent) => {
 e.preventDefault();
 if (!validateEmailStrict(email).valid) {
 setErrorMessage(t('newsletter.invalidEmail'));
 setStatus('error');
 return;
 }

 setStatus('loading');
 Analytics.trackUIInteraction('lead_magnet', 'form', 'submit', variant);

 try {
 const firestore = await initFirestore();
 if (!firestore) {
 throw new Error(t('newsletter.subscribeError'));
 }

 const upsert = await withTimeout(
 upsertNewsletterSubscriber(firestore, {
 email,
 name: null,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 source: `lead_magnet_${variant}`,
 locale: navigator.language || 'it-IT',
 isActive: true,
 leadMagnet: variant,
 }),
 8000,
 'newsletter_upsert',
 );

 if (upsert.existed) {
 // Already subscribed — still show success (they get the guide)
 markNewsletterSubscribedLocally();
 setStatus('success');
 generateChecklistPDF(variant).catch(() => {});
 return;
 }

 markNewsletterSubscribedLocally();
 setStatus('success');
 generateChecklistPDF(variant).catch(() => {});
 unlockAchievement('newsletter_sub');
 Analytics.trackUIInteraction('lead_magnet', 'form', 'subscribe', `success_${variant}`);
 } catch (error: any) {
 setErrorMessage(error.message || t('newsletter.subscribeError'));
 setStatus('error');
 }
 }, [email, variant, t]);

 if (!visible || user || localStorage.getItem(SUBSCRIBED_KEY) === 'true') return null;

 const colors = VARIANT_COLORS[variant];
 const IconComponent = VARIANT_ICONS[variant];

 // ─── Success state ─────────────────────────────────────────────────
 if (status === 'success') {
 return (
 <div className={`mt-6 p-5 bg-gradient-to-r from-success-subtle to-info-subtle border border-success-border rounded-2xl text-center`}>
 <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
 <p className="font-bold text-strong">{t('leadMagnet.success.title')}</p>
 <p className="text-sm text-subtle mt-1">{t('leadMagnet.success.desc')}</p>
 <button
 onClick={() => generateChecklistPDF(variant).catch(() => {})}
 className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg transition-colors"
 >
 <Download className="w-4 h-4" />
 {t('leadMagnet.success.download')}
 </button>
 </div>
 );
 }

 // ─── Compact variant ───────────────────────────────────────────────
 if (compact) {
 return (
 <div className={`relative mt-4 p-4 bg-gradient-to-r ${colors.gradient} border ${colors.border} rounded-xl`}>
 <button
 onClick={handleDismiss}
 className="absolute top-2 right-2 p-1 text-slate-500 hover:text-body rounded-lg transition-colors"
 aria-label={t('leadMagnet.dismiss')}
 >
 <X className="w-3.5 h-3.5" />
 </button>

 <div className="flex items-center gap-2 mb-2">
 <div className={`p-1.5 ${colors.iconBg} rounded-lg`}>
 <Download className={`w-4 h-4 ${colors.iconText}`} />
 </div>
 <span className="font-bold text-sm text-strong">
 {t(`leadMagnet.${variant}.title`)}
 </span>
 </div>

 <form onSubmit={handleSubmit} className="flex gap-2">
 <div className="flex-1">
 <label htmlFor={`lead-magnet-${variant}`} className="sr-only">{t('newsletter.emailLabel')}</label>
 <EmailInput
 id={`lead-magnet-${variant}`}
 value={email}
 onChange={(val) => { setEmail(val); setStatus('idle'); }}
 placeholder={t('newsletter.emailPlaceholder')}
 className="w-full px-3 py-2 bg-surface border border-edge rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-info text-strong text-sm"
 />
 </div>
 <button
 type="submit"
 disabled={status === 'loading'}
 className="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold rounded-lg hover:from-amber-600 hover:to-orange-700 transition-[color,background-color,border-color,opacity] disabled:opacity-50 flex items-center gap-1.5 text-sm shadow-md whitespace-nowrap"
 >
 {status === 'loading' ? (
 <Loader2 className="w-4 h-4 animate-spin" />
 ) : (
 <><Download className="w-4 h-4" /> {t('leadMagnet.cta')}</>
 )}
 </button>
 </form>

 <div className="flex items-center gap-3 mt-2 mb-1">
 <div className="flex-1 h-px bg-surface-raised" />
 <span className="text-xs text-muted">{locale === 'it' ? 'oppure' : locale === 'de' ? 'oder' : locale === 'fr' ? 'ou' : 'or'}</span>
 <div className="flex-1 h-px bg-surface-raised" />
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
 <div>
 <div ref={googleButtonRef} className="flex min-h-[40px] w-full items-center justify-center overflow-hidden rounded-lg" />
 {!googleButtonReady && (
 <button type="button" onClick={() => googleSignIn()} className="w-full min-h-[36px] grid grid-cols-[16px_1fr_16px] items-center px-3 py-1.5 bg-surface border border-edge rounded-lg text-body text-xs font-semibold hover:bg-surface-raised transition-colors">
 <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
 <span className="text-center">Google</span>
 <span aria-hidden="true" />
 </button>
 )}
 </div>
 {linkedInAvailable && (
 <button type="button" onClick={() => signInWithLinkedIn()} className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0A66C2] hover:bg-[#004182] text-white text-xs font-semibold transition-colors">
 <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 LinkedIn
 </button>
 )}
 </div>

 {status === 'error' && (
 <div className="flex items-center gap-2 mt-2 text-danger text-xs">
 <AlertCircle className="w-3 h-3 flex-shrink-0" /> {errorMessage}
 </div>
 )}
 </div>
 );
 }

 // ─── Full variant ──────────────────────────────────────────────────
 return (
 <div className={`relative mt-6 bg-gradient-to-r ${colors.gradient} border ${colors.border} rounded-2xl overflow-hidden`}>
 <button
 onClick={handleDismiss}
 className="absolute top-3 right-3 p-1 text-slate-500 hover:text-body rounded-lg transition-colors z-10"
 aria-label={t('leadMagnet.dismiss')}
 >
 <X className="w-4 h-4" />
 </button>

 <div className="p-5 sm:p-6">
 {/* Badge */}
 <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-warning-subtle text-warning text-xs font-bold uppercase tracking-wider rounded-full mb-3">
 <Gift className="w-3 h-3" />
 {t('leadMagnet.badge')}
 </div>

 {/* Header */}
 <div className="flex items-start gap-3 mb-3">
 <div className={`p-2.5 ${colors.iconBg} rounded-xl shrink-0`}>
 <IconComponent className={`w-6 h-6 ${colors.iconText}`} />
 </div>
 <div>
 <h4 className="font-bold text-strong text-base leading-tight">
 {t(`leadMagnet.${variant}.title`)}
 </h4>
 <p className="text-sm text-subtle mt-1">
 {t(`leadMagnet.${variant}.desc`)}
 </p>
 </div>
 </div>

 {/* What's included */}
 <div className="space-y-1.5 mb-4">
 <div className="flex items-center gap-2 text-xs text-body">
 <ArrowRight className="w-3 h-3 text-emerald-500 shrink-0" />
 <span>{t(`leadMagnet.${variant}.bullet1`)}</span>
 </div>
 <div className="flex items-center gap-2 text-xs text-body">
 <ArrowRight className="w-3 h-3 text-emerald-500 shrink-0" />
 <span>{t(`leadMagnet.${variant}.bullet2`)}</span>
 </div>
 <div className="flex items-center gap-2 text-xs text-body">
 <ArrowRight className="w-3 h-3 text-emerald-500 shrink-0" />
 <span>{t(`leadMagnet.${variant}.bullet3`)}</span>
 </div>
 </div>

 {/* Form */}
 <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
 <div className="flex-1">
 <label htmlFor={`lead-${variant}`} className="sr-only">{t('newsletter.emailLabel')}</label>
 <EmailInput
 id={`lead-${variant}`}
 value={email}
 onChange={(val) => { setEmail(val); setStatus('idle'); }}
 placeholder={t('newsletter.emailPlaceholder')}
 className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-info text-strong text-sm"
 />
 </div>
 <button
 type="submit"
 disabled={status === 'loading'}
 className="px-5 py-2.5 bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold rounded-xl hover:from-amber-600 hover:to-orange-700 transition-[color,background-color,border-color,opacity] disabled:opacity-50 flex items-center justify-center gap-2 text-sm shadow-md whitespace-nowrap"
 >
 {status === 'loading' ? (
 <><Loader2 className="w-4 h-4 animate-spin" /> {t('newsletter.subscribing')}</>
 ) : (
 <><Download className="w-4 h-4" /> {t('leadMagnet.cta')}</>
 )}
 </button>
 </form>

 {/* Social sign-in */}
 <div className="flex items-center gap-3 mt-3 mb-2">
 <div className="flex-1 h-px bg-surface-raised" />
 <span className="text-xs text-muted">{locale === 'it' ? 'oppure' : locale === 'de' ? 'oder' : locale === 'fr' ? 'ou' : 'or'}</span>
 <div className="flex-1 h-px bg-surface-raised" />
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
 <div className="space-y-2">
 {!compact && <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />}
 {!googleButtonReady && (
 <button type="button" onClick={() => googleSignIn()} className="w-full min-h-[40px] grid grid-cols-[20px_1fr_20px] items-center px-4 py-2 bg-surface border border-edge rounded-xl text-body text-xs font-semibold hover:bg-surface-raised transition-colors">
 <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
 <span className="text-center">{t('newsletter.popup.googleSignIn')}</span>
 <span aria-hidden="true" />
 </button>
 )}
 </div>
 {linkedInAvailable && (
 <button type="button" onClick={() => signInWithLinkedIn()} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#0A66C2] hover:bg-[#004182] text-white text-sm font-semibold transition-colors">
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 <span className="hidden sm:inline">{locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}</span>
 <span className="sm:hidden">LinkedIn</span>
 </button>
 )}
 </div>

 {/* Errors */}
 {status === 'error' && (
 <div className="flex items-center gap-2 mt-2 p-2 bg-danger-subtle rounded-lg text-danger text-xs">
 <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {errorMessage}
 </div>
 )}
 {status === 'exists' && (
 <div className="flex items-center gap-2 mt-2 p-2 bg-warning-subtle rounded-lg text-warning text-xs">
 <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {t('newsletter.alreadySubscribed')}
 </div>
 )}

 {/* Footer: social proof + privacy */}
 <div className="flex items-center justify-between mt-3">
 <div className="flex items-center gap-1.5 text-xs text-muted">
 <Users className="w-3.5 h-3.5 text-stripe-500" />
 <span>{t('leadMagnet.socialProof')}</span>
 </div>
 <div className="flex items-center gap-1.5 text-sm text-success">
 <Shield className="w-3 h-3" />
 <span>{t('newsletter.dataPrivacy')}</span>
 </div>
 </div>
 </div>
 </div>
 );
};

export default LeadMagnetCTA;
