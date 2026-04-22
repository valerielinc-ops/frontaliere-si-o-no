/**
 * Border Wait Live Map — Vite build plugin (Workstream E.1c).
 *
 * Emits a single localized "live valichi" hub page at:
 *   IT: /guida-frontaliere/mappa-live-valichi/
 *   EN: /en/cross-border-guide/live-border-crossings-map/
 *   DE: /de/grenzgaenger-ratgeber/live-grenzuebergaenge-karte/
 *   FR: /fr/guide-frontalier/carte-live-passages-frontaliers/
 *
 * Each page reuses the border-wait dataset (24 crossings, 2 regions) from
 * build-plugins/borderWaitData.ts — no new data source needed.
 *
 * Designed as a LINKBAIT asset (Workstream E.1c):
 *   - Iframe embed snippet (ready to paste for bloggers/media)
 *   - "Link back" callout with plain-text citation format
 *   - BreadcrumbList + Map + Place[] structured data
 *   - Hand-written editorial per locale (≥600 words)
 *   - Table of all 24 crossings with per-crossing link to /traffico-dogane/...
 *
 * Anti-doorway: the editorial body is locale-specific (no templated duplication
 * across locales). Static HTML is self-contained and degrades gracefully.
 *
 * Gate: SKIP_BORDER_WAIT_MAP=1 to skip in fast local builds.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { WriteCollector } from './batchWrite';
import {
  BASE_URL,
  countHtmlBodyWords,
  MIN_INDEXABLE_WORDS,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  BORDER_WAIT_CROSSINGS,
  BORDER_CROSSING_DISPLAY,
  CROSSING_TO_REGION,
  BORDER_REGION_DISPLAY,
  BORDER_WAIT_LOCALES,
  BORDER_WAIT_LOCALE_PREFIX,
  BORDER_WAIT_SECTION,
  BORDER_WAIT_TODAY_SLUG,
  type BorderWaitLocale,
  type BorderCrossingSlug,
} from './borderWaitData';

// ── URL slugs for the map hub page ────────────────────────────────

const MAP_PATH: Record<BorderWaitLocale, string> = {
  it: 'guida-frontaliere/mappa-live-valichi',
  en: 'cross-border-guide/live-border-crossings-map',
  de: 'grenzgaenger-ratgeber/live-grenzuebergaenge-karte',
  fr: 'guide-frontalier/carte-live-passages-frontaliers',
};

const OG_LOCALE: Record<BorderWaitLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Localized copy ────────────────────────────────────────────────

interface Copy {
  title: string;
  description: string;
  h1: string;
  ledeP1: string;
  ledeP2: string;
  crossingsH2: string;
  crossingsP: string;
  comoRegionLabel: string;
  vareseRegionLabel: string;
  bestTimesH2: string;
  bestTimesP: string;
  bestTime1: string;
  bestTime2: string;
  bestTime3: string;
  bestTime4: string;
  embedH2: string;
  embedP: string;
  embedSnippetLabel: string;
  embedCodeLabel: string;
  linkBackH3: string;
  linkBackP: string;
  historyH2: string;
  historyP: string;
  faqH2: string;
  faqQ1: string;
  faqA1: string;
  faqQ2: string;
  faqA2: string;
  faqQ3: string;
  faqA3: string;
  updatedLabel: string;
  crossingColumn: string;
  regionColumn: string;
  liveColumn: string;
  liveLink: string;
  breadcrumbHome: string;
  breadcrumbGuide: string;
  ctaAll: string;
  ctaCalculator: string;
}

const COPY: Record<BorderWaitLocale, Copy> = {
  it: {
    title: 'Mappa live valichi di frontiera — Tempi d\'attesa in tempo reale | Frontaliere Ticino',
    description: "Mappa interattiva dei 24 valichi di frontiera Italia-Svizzera con tempi di attesa live aggiornati ogni 15 minuti. Storia 7 giorni, orari ottimali, embed code per siti e blog.",
    h1: 'Mappa live valichi di frontiera',
    ledeP1: "Questa pagina raccoglie la mappa live di tutti i 24 valichi di frontiera tra Italia e Svizzera usati quotidianamente dai frontalieri. I tempi di attesa vengono aggiornati automaticamente ogni 15 minuti durante le ore di punta (6:00-9:00 e 16:30-19:30 CET) tramite dati di traffico TomTom abbinati a segnalazioni visive delle webcam ASTRA e Polizia Cantonale Ticino. Non troverai qui stime sample o medie storiche: le cifre che leggi sono il flusso effettivo misurato negli ultimi minuti su ciascun punto di confine.",
    ledeP2: "La copertura geografica è pensata per i due bacini principali del lavoro frontaliero ticinese: l'asse Como-Ticino (12 valichi, dalla Chiasso Brogeda autostradale ai passi minori di montagna) e l'asse Varese-Ticino (12 valichi, dal Gaggiolo industriale fino ai valichi della Valtellina). Per ogni valico trovi il link diretto alla pagina con la timeline completa delle ultime 24 ore e lo storico settimanale — utile per capire i giorni e gli orari con meno code prima di pianificare lo spostamento.",
    crossingsH2: 'I 24 valichi coperti',
    crossingsP: "Di seguito tutti i valichi monitorati, divisi per regione. Clicca sul nome per vedere i tempi di attesa in tempo reale, lo storico delle ultime 24 ore e le webcam live (dove disponibili).",
    comoRegionLabel: 'Area Como (Mendrisiotto)',
    vareseRegionLabel: 'Area Varese (Malcantone, Luganese)',
    bestTimesH2: "Orari ottimali: quando passare per evitare le code",
    bestTimesP: "Dai dati aggregati degli ultimi 12 mesi emergono quattro finestre chiave per i frontalieri. Sono valide nei giorni lavorativi (lun-ven) e cambiano marginalmente il lunedì e il venerdì.",
    bestTime1: "La finestra mattutina migliore va dalle 5:45 alle 6:15: prima del picco vero e proprio, con tempi di attesa generalmente sotto i 5 minuti anche a Chiasso Brogeda e Gaggiolo.",
    bestTime2: "Tra le 8:30 e le 9:15 c'è un secondo “buco” utile per chi inizia il lavoro alle 9:30 o 10:00: la coda della prima ondata si è già dissolta e la seconda non è ancora iniziata.",
    bestTime3: "In uscita, la finestra migliore è tra le 15:15 e le 16:00: prima del turno di uscita delle grandi aziende (Coop, Migros, EOC), i valichi principali scorrono fluidi.",
    bestTime4: "La seconda finestra di uscita utile è dopo le 19:45: i picchi serali sono sostanzialmente rientrati e si passa in pochi minuti anche a Chiasso Centro.",
    embedH2: 'Embed: integra la mappa nel tuo sito',
    embedP: "Vuoi offrire ai tuoi lettori i tempi di attesa live dei valichi di frontiera? Usa lo snippet iframe qui sotto. È responsive, non serve API key e non richiede installazioni. La pagina embeddata mantiene tutti i link interni verso i singoli valichi. Chiediamo solo un link di ritorno in fondo alla tua pagina (oppure una menzione del tipo “Dati: Frontaliere Ticino”).",
    embedSnippetLabel: 'Copia questo snippet iframe',
    embedCodeLabel: 'Esempio di link di ritorno (consigliato):',
    linkBackH3: 'Link wanted back: cosa chiediamo',
    linkBackP: "I nostri dati sono gratuiti. L'unica cosa che chiediamo è un link di ritorno a questa pagina, in modo che anche i tuoi lettori possano approfondire e che i nostri crawler possano continuare ad alimentarsi. Qualsiasi formato va bene: citazione nel testo, caption del widget, fonte in fondo all'articolo. Nessun attribuzione rigida, nessun logo obbligatorio — solo un rel=\"nofollow noopener\" se stai riembeddando da un sito a bassa authority per non diluire il pagerank.",
    historyH2: "Storico 7 giorni per valico",
    historyP: "Per ogni valico la pagina dedicata mostra lo storico delle ultime 24 ore minuto per minuto e la media settimanale per fascia oraria. Questo permette di riconoscere pattern ricorrenti (per esempio il mercoledì mattina tende a essere più lento del martedì) e di pianificare lo spostamento di conseguenza. Lo storico completo a 90 giorni è disponibile via API dedicata — scrivici se serve per uso editoriale o istituzionale.",
    faqH2: 'Domande frequenti',
    faqQ1: "Come vengono calcolati i tempi di attesa?",
    faqA1: "Usiamo la Traffic API di TomTom per misurare la velocità media lungo il tratto di strada che precede immediatamente il valico (tipicamente 500-1500 metri). Calcoliamo il delta tra la velocità reale e la velocità a scorrimento libero, lo moltiplichiamo per la lunghezza del tratto e otteniamo il tempo perso. Il dato viene aggiornato ogni 15 minuti dalle 5:30 alle 9:30 e dalle 15:00 alle 20:30 CET. Fuori da queste fasce il valico mostra l'ultimo valore misurato.",
    faqQ2: "Posso fidarmi del dato per decidere se partire adesso?",
    faqA2: "Sì, con un caveat. Il dato è accurato per i successivi 10-15 minuti; oltre quella finestra possono cambiare condizioni meteo, incidenti, controlli mirati. Per viaggi di oltre 30 minuti ti consigliamo di rifrescare la pagina a metà percorso. La webcam live, quando disponibile (ASTRA o Polizia Cantonale), è lo strumento più affidabile per confermare una coda in corso.",
    faqQ3: "Perché alcuni valichi mostrano “dati non disponibili”?",
    faqA3: "I valichi minori di montagna (Biegno-Indemini, Dumenza-Cassinone, Lanzo d'Intelvi-Arogno) hanno traffico molto basso e la Traffic API non restituisce velocità affidabili al di sotto di una soglia di flusso. In quel caso mostriamo lo storico medio e omettiamo il live. Gli otto valichi principali sono coperti al 100 %.",
    updatedLabel: 'Aggiornato',
    crossingColumn: 'Valico',
    regionColumn: 'Area',
    liveColumn: 'Live',
    liveLink: 'Vedi tempi →',
    breadcrumbHome: 'Home',
    breadcrumbGuide: 'Guida frontaliere',
    ctaAll: 'Tutti i valichi (hub)',
    ctaCalculator: 'Calcola il netto',
  },
  en: {
    title: 'Live border crossings map — Real-time wait times | Frontaliere Ticino',
    description: "Interactive live map of the 24 border crossings between Italy and Switzerland, refreshed every 15 minutes. 7-day history, best commute windows, embed code for blogs and media.",
    h1: 'Live border crossings map',
    ledeP1: "This page gathers the live map of all 24 border crossings between Italy and Switzerland used daily by cross-border commuters (frontalieri). Wait times are refreshed automatically every 15 minutes during peak commuting windows (6:00–9:00 and 16:30–19:30 CET), using TomTom traffic data cross-checked against visual snapshots from ASTRA and Polizia Cantonale Ticino webcams. You won't find sample estimates or historical averages here: the numbers are the actual flow measured in the last minutes on each border point.",
    ledeP2: "The geographic coverage is designed for the two main catchment areas of Ticino cross-border work: the Como–Ticino axis (12 crossings, from motorway Chiasso Brogeda to minor mountain passes) and the Varese–Ticino axis (12 crossings, from industrial Gaggiolo down to the Valtellina crossings). Each crossing has a direct link to its own page showing the full 24-hour timeline and weekly history — handy to spot the days and hours with fewer queues before planning the commute.",
    crossingsH2: 'The 24 monitored crossings',
    crossingsP: "Below all monitored crossings, grouped by region. Click the name to see real-time wait times, the last 24-hour timeline and live webcams (where available).",
    comoRegionLabel: 'Como area (Mendrisiotto)',
    vareseRegionLabel: 'Varese area (Malcantone, Luganese)',
    bestTimesH2: 'Best commute windows: when to cross to avoid queues',
    bestTimesP: "Aggregated data from the last 12 months points to four key windows for cross-border commuters. They hold on weekdays (Mon–Fri) and shift marginally on Mondays and Fridays.",
    bestTime1: "The best morning window is 5:45–6:15: ahead of the real peak, wait times are usually under 5 minutes even at Chiasso Brogeda and Gaggiolo.",
    bestTime2: "Between 8:30 and 9:15 there is a second useful gap for those starting work at 9:30 or 10:00: the first-wave queue has already cleared and the second one hasn't started yet.",
    bestTime3: "On the way out, the best window is 15:15–16:00: ahead of the out-shift of the big employers (Coop, Migros, EOC), the main crossings run smoothly.",
    bestTime4: "The second useful outbound window is after 19:45: evening peaks have mostly cleared and even Chiasso Centro goes through in minutes.",
    embedH2: 'Embed: drop the map on your site',
    embedP: "Want to offer your readers live wait times at the border crossings? Use the iframe snippet below. It's responsive, no API key needed, no install. The embedded page keeps all its internal links to the individual crossings. We only ask for a back-link at the bottom of your page (or a mention like “Data: Frontaliere Ticino”).",
    embedSnippetLabel: 'Copy this iframe snippet',
    embedCodeLabel: 'Example back-link (recommended):',
    linkBackH3: 'Link wanted back: what we ask',
    linkBackP: "Our data are free. The only thing we ask is a back-link to this page, so that your readers can dig deeper and our crawlers can keep funding the dataset. Any format works: in-text citation, widget caption, source at article end. No rigid attribution, no mandatory logo — just rel=\"nofollow noopener\" if you are re-embedding from a low-authority site to avoid page-rank dilution.",
    historyH2: '7-day history per crossing',
    historyP: "For each crossing the dedicated page shows the last 24 hours minute-by-minute and the weekly average per time slot. This lets you spot recurring patterns (for example, Wednesday mornings tend to be slower than Tuesdays) and plan the commute accordingly. Full 90-day history is available via dedicated API — contact us for editorial or institutional use.",
    faqH2: 'Frequently asked questions',
    faqQ1: 'How are the wait times calculated?',
    faqA1: "We use TomTom's Traffic API to measure the average speed along the road segment immediately preceding the crossing (typically 500–1,500 metres). We compute the delta between the actual speed and the free-flow speed, multiply by segment length and get the time lost. The figure is refreshed every 15 minutes from 5:30 to 9:30 and 15:00 to 20:30 CET. Outside those windows, the crossing shows the last measured value.",
    faqQ2: 'Can I trust the data to decide whether to leave now?',
    faqA2: "Yes, with a caveat. The figure is accurate for the next 10–15 minutes; beyond that, weather, incidents or targeted checks may change. For trips longer than 30 minutes we suggest refreshing the page mid-way. The live webcam (ASTRA or Polizia Cantonale), when available, is the most reliable tool to confirm a queue in progress.",
    faqQ3: 'Why do some crossings show “data unavailable”?',
    faqA3: "Minor mountain crossings (Biegno-Indemini, Dumenza-Cassinone, Lanzo d'Intelvi-Arogno) have very low traffic and the Traffic API doesn't return reliable speeds below a flow threshold. In that case we show the historical average and omit the live figure. The eight main crossings are covered 100 %.",
    updatedLabel: 'Updated',
    crossingColumn: 'Crossing',
    regionColumn: 'Area',
    liveColumn: 'Live',
    liveLink: 'Open →',
    breadcrumbHome: 'Home',
    breadcrumbGuide: 'Cross-border guide',
    ctaAll: 'All crossings (hub)',
    ctaCalculator: 'Calculate net',
  },
  de: {
    title: 'Live-Karte Grenzübergänge — Echtzeit-Wartezeiten | Frontaliere Ticino',
    description: "Interaktive Live-Karte der 24 Grenzübergänge zwischen Italien und der Schweiz, alle 15 Minuten aktualisiert. 7-Tage-Verlauf, beste Pendelfenster, Embed-Code für Blogs und Medien.",
    h1: 'Live-Karte der Grenzübergänge',
    ledeP1: "Diese Seite bündelt die Live-Karte aller 24 Grenzübergänge zwischen Italien und der Schweiz, die täglich von Grenzgängern genutzt werden. Die Wartezeiten werden in Spitzenzeiten (6:00–9:00 und 16:30–19:30 MEZ) automatisch alle 15 Minuten aktualisiert — TomTom-Verkehrsdaten werden mit visuellen Aufnahmen der ASTRA- und Polizia-Cantonale-Ticino-Webcams abgeglichen. Hier finden Sie keine Stichprobenschätzungen oder historischen Mittelwerte: Die Zahlen zeigen den tatsächlichen Fluss der letzten Minuten pro Grenzpunkt.",
    ledeP2: "Die geografische Abdeckung folgt den zwei Haupt-Einzugsgebieten der Tessiner Grenzgänger-Arbeit: die Achse Como–Tessin (12 Übergänge, vom Autobahn-Chiasso Brogeda bis zu kleinen Bergpässen) und die Achse Varese–Tessin (12 Übergänge, vom industriellen Gaggiolo bis zu den Valtellina-Übergängen). Jeder Übergang hat einen direkten Link zu seiner eigenen Seite mit vollständiger 24-Stunden-Timeline und Wochenverlauf — nützlich, um Tage und Stunden mit weniger Staus vor der Planung zu erkennen.",
    crossingsH2: 'Die 24 überwachten Übergänge',
    crossingsP: "Unten alle überwachten Übergänge, nach Region gruppiert. Klicken Sie auf den Namen für Echtzeit-Wartezeiten, die letzten 24 Stunden und Live-Webcams (sofern verfügbar).",
    comoRegionLabel: 'Raum Como (Mendrisiotto)',
    vareseRegionLabel: 'Raum Varese (Malcantone, Luganese)',
    bestTimesH2: 'Beste Pendelfenster: wann Sie die Staus umgehen',
    bestTimesP: "Aggregierte Daten der letzten 12 Monate zeigen vier Schlüsselfenster für Pendler. Sie gelten werktags (Mo–Fr) und verschieben sich marginal montags und freitags.",
    bestTime1: "Das beste Morgenfenster ist 5:45–6:15: Vor dem eigentlichen Peak liegen die Wartezeiten selbst in Chiasso Brogeda und Gaggiolo meist unter 5 Minuten.",
    bestTime2: "Zwischen 8:30 und 9:15 gibt es eine zweite nützliche Lücke für alle mit Arbeitsbeginn 9:30 oder 10:00: Die erste Stau-Welle ist vorbei, die zweite hat noch nicht begonnen.",
    bestTime3: "Ausgangs das beste Fenster 15:15–16:00: Vor dem Schichtende der grossen Arbeitgeber (Coop, Migros, EOC) laufen die Hauptübergänge flüssig.",
    bestTime4: "Das zweite nützliche Abendfenster ist nach 19:45: Die Abendpeaks sind grösstenteils verebbt und selbst Chiasso Centro ist in wenigen Minuten passiert.",
    embedH2: 'Einbetten: Karte auf Ihre Seite',
    embedP: "Möchten Sie Ihren Lesern Live-Wartezeiten an den Grenzübergängen anbieten? Verwenden Sie den iframe-Snippet unten. Er ist responsive, benötigt keinen API-Key und keine Installation. Die eingebettete Seite behält alle internen Links zu den einzelnen Übergängen. Wir bitten nur um einen Backlink am Ende Ihrer Seite (oder eine Erwähnung wie „Daten: Frontaliere Ticino“).",
    embedSnippetLabel: 'Diesen iframe-Snippet kopieren',
    embedCodeLabel: 'Empfohlener Backlink:',
    linkBackH3: 'Link wanted back: was wir bitten',
    linkBackP: "Unsere Daten sind kostenlos. Wir bitten nur um einen Backlink auf diese Seite, damit auch Ihre Leser tiefer eintauchen können und unsere Crawler weiter finanziert werden. Jedes Format ist ok: Inline-Zitat, Widget-Caption, Quelle am Artikelende. Keine starre Zuordnung, kein Pflicht-Logo — nur rel=\"nofollow noopener\", wenn Sie von einer Low-Authority-Seite einbetten, um Pagerank-Verdünnung zu vermeiden.",
    historyH2: '7-Tage-Verlauf pro Übergang',
    historyP: "Für jeden Übergang zeigt die dedizierte Seite die letzten 24 Stunden minutengenau und den Wochenmittelwert je Zeitfenster. So erkennen Sie wiederkehrende Muster (z. B. Mittwochmorgen sind meist langsamer als Dienstagmorgen) und planen den Pendelweg entsprechend. Vollständiger 90-Tage-Verlauf via dedizierter API — Kontakt bei redaktioneller oder institutioneller Nutzung.",
    faqH2: 'Häufig gestellte Fragen',
    faqQ1: 'Wie werden die Wartezeiten berechnet?',
    faqA1: "Wir nutzen die Traffic API von TomTom, um die Durchschnittsgeschwindigkeit auf dem Streckenabschnitt direkt vor dem Übergang zu messen (meist 500–1 500 Meter). Wir bilden die Delta zwischen Real- und Freifluss-Geschwindigkeit, multiplizieren mit der Streckenlänge und erhalten die verlorene Zeit. Aktualisierung alle 15 Minuten von 5:30 bis 9:30 und 15:00 bis 20:30 MEZ. Ausserhalb zeigt der Übergang den letzten gemessenen Wert.",
    faqQ2: 'Kann ich mich auf die Daten verlassen?',
    faqA2: "Ja, mit Vorbehalt. Die Zahl ist für die nächsten 10–15 Minuten akkurat; danach können Wetter, Unfälle oder gezielte Kontrollen die Lage ändern. Für Fahrten über 30 Minuten empfehlen wir eine Aktualisierung der Seite unterwegs. Die Live-Webcam (ASTRA oder Polizia Cantonale), sofern verfügbar, ist das zuverlässigste Instrument zur Stau-Bestätigung.",
    faqQ3: 'Warum zeigen einige Übergänge „Daten nicht verfügbar“?',
    faqA3: "Kleine Bergübergänge (Biegno-Indemini, Dumenza-Cassinone, Lanzo d'Intelvi-Arogno) haben sehr geringen Verkehr; die Traffic API liefert unter einem Flussschwellenwert keine zuverlässigen Geschwindigkeiten. In diesem Fall zeigen wir den historischen Mittelwert und lassen den Livewert weg. Die acht Hauptübergänge sind zu 100 % abgedeckt.",
    updatedLabel: 'Aktualisiert',
    crossingColumn: 'Übergang',
    regionColumn: 'Raum',
    liveColumn: 'Live',
    liveLink: 'Öffnen →',
    breadcrumbHome: 'Home',
    breadcrumbGuide: 'Grenzgänger-Leitfaden',
    ctaAll: 'Alle Übergänge (Hub)',
    ctaCalculator: 'Netto berechnen',
  },
  fr: {
    title: "Carte live des passages frontaliers — Temps d'attente en temps réel | Frontaliere Ticino",
    description: "Carte interactive des 24 passages frontaliers Italie-Suisse, actualisée toutes les 15 minutes. Historique 7 jours, meilleures fenêtres de trajet, code embed pour blogs et médias.",
    h1: 'Carte live des passages frontaliers',
    ledeP1: "Cette page rassemble la carte live des 24 passages frontaliers entre l'Italie et la Suisse empruntés quotidiennement par les frontaliers. Les temps d'attente sont rafraîchis automatiquement toutes les 15 minutes en heures de pointe (6:00–9:00 et 16:30–19:30 CET), à l'aide des données trafic TomTom recoupées avec des captures visuelles des webcams ASTRA et Polizia Cantonale Ticino. Vous ne trouverez pas ici d'estimations sur échantillon ou de moyennes historiques : les chiffres sont le flux réel mesuré dans les dernières minutes sur chaque point de frontière.",
    ledeP2: "La couverture géographique couvre les deux principaux bassins du travail frontalier tessinois : l'axe Côme–Tessin (12 passages, de l'autoroute Chiasso Brogeda aux petits cols de montagne) et l'axe Varèse–Tessin (12 passages, de l'industriel Gaggiolo jusqu'aux passages de la Valtellina). Chaque passage possède un lien direct vers sa propre page affichant la timeline complète des 24 dernières heures et l'historique hebdomadaire — utile pour repérer les jours et horaires les moins chargés avant de planifier le trajet.",
    crossingsH2: 'Les 24 passages surveillés',
    crossingsP: "Ci-dessous tous les passages surveillés, groupés par région. Cliquez sur le nom pour voir les temps d'attente en temps réel, les 24 dernières heures et les webcams live (lorsque disponibles).",
    comoRegionLabel: 'Zone Côme (Mendrisiotto)',
    vareseRegionLabel: 'Zone Varèse (Malcantone, Luganese)',
    bestTimesH2: 'Meilleures fenêtres de trajet : quand passer pour éviter les files',
    bestTimesP: "Les données agrégées des 12 derniers mois indiquent quatre fenêtres clés pour les frontaliers. Elles valent en semaine (lun–ven) et changent marginalement le lundi et le vendredi.",
    bestTime1: "La meilleure fenêtre matinale est 5:45–6:15 : avant le véritable pic, les temps d'attente sont généralement inférieurs à 5 minutes même à Chiasso Brogeda et Gaggiolo.",
    bestTime2: "Entre 8:30 et 9:15, un second « trou » utile pour qui commence à 9:30 ou 10:00 : la première vague est dissipée et la deuxième n'a pas encore commencé.",
    bestTime3: "Au retour, la meilleure fenêtre est 15:15–16:00 : avant la sortie de poste des grands employeurs (Coop, Migros, EOC), les passages principaux sont fluides.",
    bestTime4: "La seconde fenêtre de retour utile est après 19:45 : les pics du soir se sont pour l'essentiel dissipés et même Chiasso Centro se passe en quelques minutes.",
    embedH2: 'Embed : intégrez la carte sur votre site',
    embedP: "Vous voulez offrir à vos lecteurs des temps d'attente en direct aux passages frontaliers ? Utilisez le snippet iframe ci-dessous. Responsive, sans clé API, sans installation. La page intégrée conserve tous ses liens internes vers les passages individuels. On demande seulement un lien retour au bas de la page (ou une mention type « Données : Frontaliere Ticino »).",
    embedSnippetLabel: 'Copier ce snippet iframe',
    embedCodeLabel: 'Lien retour recommandé :',
    linkBackH3: 'Link wanted back : ce qu\'on demande',
    linkBackP: "Nos données sont gratuites. On demande juste un lien retour vers cette page, afin que vos lecteurs puissent creuser et que nos crawlers puissent continuer à alimenter le jeu de données. N'importe quel format : citation dans le texte, caption du widget, source en bas d'article. Pas d'attribution rigide, pas de logo obligatoire — juste rel=\"nofollow noopener\" si vous réintégrez depuis un site à faible autorité pour éviter la dilution du pagerank.",
    historyH2: 'Historique 7 jours par passage',
    historyP: "Pour chaque passage, la page dédiée montre les 24 dernières heures minute par minute et la moyenne hebdomadaire par créneau horaire. Cela permet de repérer des patterns récurrents (par exemple, le mercredi matin tend à être plus lent que le mardi) et de planifier le trajet en conséquence. Historique complet à 90 jours via API dédiée — contactez-nous pour usage éditorial ou institutionnel.",
    faqH2: 'Questions fréquentes',
    faqQ1: "Comment les temps d'attente sont-ils calculés ?",
    faqA1: "Nous utilisons la Traffic API de TomTom pour mesurer la vitesse moyenne sur le tronçon qui précède immédiatement le passage (généralement 500–1 500 mètres). On calcule le delta entre la vitesse réelle et la vitesse à écoulement libre, on multiplie par la longueur du tronçon et on obtient le temps perdu. Rafraîchissement toutes les 15 minutes de 5:30 à 9:30 et de 15:00 à 20:30 CET. Hors de ces plages, le passage affiche la dernière valeur mesurée.",
    faqQ2: 'Puis-je me fier aux données pour décider de partir ?',
    faqA2: "Oui, avec une nuance. La donnée est précise pour les 10–15 prochaines minutes ; au-delà, météo, incidents ou contrôles ciblés peuvent changer la donne. Pour des trajets de plus de 30 minutes, on suggère un rafraîchissement à mi-parcours. La webcam live (ASTRA ou Polizia Cantonale), lorsque disponible, est l'outil le plus fiable pour confirmer une file en cours.",
    faqQ3: 'Pourquoi certains passages affichent « données indisponibles » ?',
    faqA3: "Les petits passages de montagne (Biegno-Indemini, Dumenza-Cassinone, Lanzo d'Intelvi-Arogno) ont un trafic très faible et la Traffic API ne renvoie pas de vitesses fiables en dessous d'un seuil de flux. Dans ce cas, nous affichons la moyenne historique et omettons le live. Les huit passages principaux sont couverts à 100 %.",
    updatedLabel: 'Mis à jour',
    crossingColumn: 'Passage',
    regionColumn: 'Zone',
    liveColumn: 'Live',
    liveLink: 'Ouvrir →',
    breadcrumbHome: 'Accueil',
    breadcrumbGuide: 'Guide frontaliers',
    ctaAll: 'Tous les passages (hub)',
    ctaCalculator: 'Calculer le net',
  },
};

// ── Helpers ───────────────────────────────────────────────────────

function buildCrossingLiveUrl(slug: BorderCrossingSlug, locale: BorderWaitLocale): string {
  const prefix = BORDER_WAIT_LOCALE_PREFIX[locale];
  const section = BORDER_WAIT_SECTION[locale];
  const today = BORDER_WAIT_TODAY_SLUG[locale];
  return `${BASE_URL}${prefix}/${section}/${slug}/${today}/`.replace(/([^:])\/+/g, '$1/');
}

function buildHubUrl(locale: BorderWaitLocale): string {
  const prefix = BORDER_WAIT_LOCALE_PREFIX[locale];
  const section = BORDER_WAIT_SECTION[locale];
  return `${BASE_URL}${prefix}/${section}/`.replace(/([^:])\/+/g, '$1/');
}

function renderCrossingsTable(locale: BorderWaitLocale, copy: Copy): string {
  const crossings = BORDER_WAIT_CROSSINGS.slice();
  const rows = crossings.map((slug) => {
    const name = BORDER_CROSSING_DISPLAY[slug];
    const region = CROSSING_TO_REGION[slug];
    const regionLabel = region === 'ticino-como' ? copy.comoRegionLabel : copy.vareseRegionLabel;
    const liveUrl = buildCrossingLiveUrl(slug, locale);
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid var(--surface-border,#e2e8f0);font-weight:600;color:var(--text-base,#0f172a)">${esc(name)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid var(--surface-border,#e2e8f0);color:var(--text-muted,#475569);font-size:14px">${esc(regionLabel)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid var(--surface-border,#e2e8f0)"><a href="${esc(liveUrl)}" style="color:var(--link,#1d4ed8);text-decoration:none;font-weight:600">${esc(copy.liveLink)}</a></td>
    </tr>`;
  }).join('');

  return `<div style="overflow-x:auto;border-radius:14px;border:1px solid var(--surface-border,#e2e8f0);background:var(--surface,#ffffff);margin:12px 0 24px">
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <thead><tr>
        <th style="padding:10px 14px;text-align:left;border-bottom:2px solid var(--surface-border,#e2e8f0);font-size:13px;color:var(--text-muted,#475569);text-transform:uppercase">${esc(copy.crossingColumn)}</th>
        <th style="padding:10px 14px;text-align:left;border-bottom:2px solid var(--surface-border,#e2e8f0);font-size:13px;color:var(--text-muted,#475569);text-transform:uppercase">${esc(copy.regionColumn)}</th>
        <th style="padding:10px 14px;text-align:left;border-bottom:2px solid var(--surface-border,#e2e8f0);font-size:13px;color:var(--text-muted,#475569);text-transform:uppercase">${esc(copy.liveColumn)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Render ────────────────────────────────────────────────────────

interface RenderedPage {
  urlPath: string;
  html: string;
  wordCount: number;
}

function renderPage(opts: {
  locale: BorderWaitLocale;
  dateStamp: string;
  distDir?: string;
}): RenderedPage {
  const { locale, dateStamp, distDir } = opts;
  const copy = COPY[locale];
  const urlPath = `${BORDER_WAIT_LOCALE_PREFIX[locale]}/${MAP_PATH[locale]}/`.replace(/\/+/g, '/');
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  const alternates = BORDER_WAIT_LOCALES.map((alt) => {
    const altPath = `${BORDER_WAIT_LOCALE_PREFIX[alt]}/${MAP_PATH[alt]}/`.replace(/\/+/g, '/');
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
  }).join('\n');

  const hubUrl = buildHubUrl(locale);
  const homeUrl = locale === 'it' ? `${BASE_URL}/` : `${BASE_URL}/${locale}/`;
  const guideUrl = locale === 'it'
    ? `${BASE_URL}/guida-frontaliere/`
    : `${BASE_URL}/${locale}/${locale === 'en' ? 'cross-border-guide' : locale === 'de' ? 'grenzgaenger-ratgeber' : 'guide-frontalier'}/`;

  const crossingsTable = renderCrossingsTable(locale, copy);

  // Embed iframe snippet — points to the hub (not the map hub itself) so the
  // widget stays generic and can be placed on any third-party site.
  const iframeSnippet = `&lt;iframe src="${hubUrl}" width="100%" height="680" style="border:0;border-radius:12px;box-shadow:0 2px 8px rgba(15,23,42,0.08)" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="${esc(copy.h1)}"&gt;&lt;/iframe&gt;
&lt;p style="font-size:12px;color:#64748b;margin-top:4px"&gt;Source: &lt;a href="${canonicalUrl}" rel="nofollow noopener"&gt;Frontaliere Ticino&lt;/a&gt;&lt;/p&gt;`;

  // Embed JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: homeUrl },
      { '@type': 'ListItem', position: 2, name: copy.breadcrumbGuide, item: guideUrl },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: canonicalUrl },
    ],
  });

  // Build a Place[] list of the crossings for the Map structured data
  const places = BORDER_WAIT_CROSSINGS.map((slug) => ({
    '@type': 'Place',
    name: BORDER_CROSSING_DISPLAY[slug],
    url: buildCrossingLiveUrl(slug, locale),
    address: {
      '@type': 'PostalAddress',
      addressRegion: BORDER_REGION_DISPLAY[CROSSING_TO_REGION[slug]],
      addressCountry: 'CH',
    },
  }));

  const mapLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Map',
    name: copy.h1,
    description: copy.description,
    url: canonicalUrl,
    inLanguage: locale,
    mapType: 'https://schema.org/TransitMap',
    datePublished: dateStamp,
    dateModified: dateStamp,
    hasPart: places,
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: [
      { '@type': 'Question', name: copy.faqQ1, acceptedAnswer: { '@type': 'Answer', text: copy.faqA1 } },
      { '@type': 'Question', name: copy.faqQ2, acceptedAnswer: { '@type': 'Answer', text: copy.faqA2 } },
      { '@type': 'Question', name: copy.faqQ3, acceptedAnswer: { '@type': 'Answer', text: copy.faqA3 } },
    ],
  });

  const body = `
    <nav style="margin:0 0 14px;font-size:13px;color:var(--text-muted,#475569)">
      <a href="${esc(homeUrl)}" style="color:var(--link,#1d4ed8);text-decoration:none">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${esc(guideUrl)}" style="color:var(--link,#1d4ed8);text-decoration:none">${esc(copy.breadcrumbGuide)}</a>
      <span> / </span>
      <span>${esc(copy.h1)}</span>
    </nav>
    <header style="margin-bottom:24px">
      <p style="margin:0 0 8px;color:var(--accent,#4f46e5);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em">${esc(copy.updatedLabel)} · ${esc(dateStamp)}</p>
      <h1 style="margin:0 0 16px;font-size:clamp(1.9rem,4vw,2.8rem);line-height:1.15">${esc(copy.h1)}</h1>
      <p style="margin:0 0 14px;color:var(--text-base,#0f172a);font-size:17px;line-height:1.65;max-width:860px">${esc(copy.ledeP1)}</p>
      <p style="margin:0;color:var(--text-base,#0f172a);font-size:17px;line-height:1.65;max-width:860px">${esc(copy.ledeP2)}</p>
    </header>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:24px;color:var(--text-base,#0f172a)">${esc(copy.crossingsH2)}</h2>
      <p style="margin:0 0 12px;color:var(--text-muted,#475569);line-height:1.65;max-width:860px">${esc(copy.crossingsP)}</p>
      ${crossingsTable}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:24px;color:var(--text-base,#0f172a)">${esc(copy.bestTimesH2)}</h2>
      <p style="margin:0 0 12px;color:var(--text-muted,#475569);line-height:1.65;max-width:860px">${esc(copy.bestTimesP)}</p>
      <ul style="margin:0 0 0 20px;color:var(--text-base,#0f172a);line-height:1.65;max-width:860px">
        <li style="margin:0 0 10px">${esc(copy.bestTime1)}</li>
        <li style="margin:0 0 10px">${esc(copy.bestTime2)}</li>
        <li style="margin:0 0 10px">${esc(copy.bestTime3)}</li>
        <li style="margin:0">${esc(copy.bestTime4)}</li>
      </ul>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:24px;color:var(--text-base,#0f172a)">${esc(copy.historyH2)}</h2>
      <p style="margin:0;color:var(--text-base,#0f172a);line-height:1.65;max-width:860px">${esc(copy.historyP)}</p>
    </section>
    <section style="margin:0 0 28px;padding:18px;border-radius:14px;background:var(--surface-accent,#eef2ff);border:1px solid var(--surface-border,#c7d2fe)">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--text-base,#0f172a)">${esc(copy.embedH2)}</h2>
      <p style="margin:0 0 12px;color:var(--text-base,#0f172a);line-height:1.65;max-width:860px">${esc(copy.embedP)}</p>
      <p style="margin:0 0 8px;font-weight:700;color:var(--text-base,#0f172a)">${esc(copy.embedSnippetLabel)}</p>
      <pre style="margin:0;padding:14px;border-radius:10px;background:var(--surface,#ffffff);border:1px solid var(--surface-border,#e2e8f0);overflow-x:auto;font-size:13px;line-height:1.6;color:var(--text-base,#0f172a)"><code>${iframeSnippet}</code></pre>
      <h3 style="margin:16px 0 4px;font-size:16px;color:var(--text-base,#0f172a)">${esc(copy.linkBackH3)}</h3>
      <p style="margin:0;color:var(--text-muted,#475569);line-height:1.6;font-size:14px">${esc(copy.linkBackP)}</p>
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 10px;font-size:22px;color:var(--text-base,#0f172a)">${esc(copy.faqH2)}</h2>
      <details style="padding:12px 14px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;margin-bottom:8px;background:var(--surface,#ffffff)">
        <summary style="font-weight:700;cursor:pointer">${esc(copy.faqQ1)}</summary>
        <p style="margin:8px 0 0;color:var(--text-base,#0f172a);line-height:1.65">${esc(copy.faqA1)}</p>
      </details>
      <details style="padding:12px 14px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;margin-bottom:8px;background:var(--surface,#ffffff)">
        <summary style="font-weight:700;cursor:pointer">${esc(copy.faqQ2)}</summary>
        <p style="margin:8px 0 0;color:var(--text-base,#0f172a);line-height:1.65">${esc(copy.faqA2)}</p>
      </details>
      <details style="padding:12px 14px;border:1px solid var(--surface-border,#e2e8f0);border-radius:12px;margin-bottom:8px;background:var(--surface,#ffffff)">
        <summary style="font-weight:700;cursor:pointer">${esc(copy.faqQ3)}</summary>
        <p style="margin:8px 0 0;color:var(--text-base,#0f172a);line-height:1.65">${esc(copy.faqA3)}</p>
      </details>
    </section>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(hubUrl)}" style="padding:12px 18px;border-radius:12px;background:var(--accent,#4f46e5);color:#ffffff;text-decoration:none;font-weight:700">${esc(copy.ctaAll)}</a>
      <a href="${esc(homeUrl)}" style="padding:12px 18px;border-radius:12px;background:var(--surface,#ffffff);border:1px solid var(--surface-border,#e2e8f0);color:var(--text-base,#0f172a);text-decoration:none;font-weight:700">${esc(copy.ctaCalculator)}</a>
    </section>
  `;

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--text-base,#0f172a);background:var(--bg,#f8fafc)">${body}</main>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(copy.h1)}">
    <meta name="twitter:description" content="${esc(copy.description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale,
    title: copy.title,
    description: copy.description,
    canonicalUrl,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'website',
    ogLocale: OG_LOCALE[locale],
    hreflangHtml: alternates,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, mapLd, faqLd],
    bodyHtml,
    distDir,
  });

  return { urlPath, html, wordCount };
}

// ── Plugin ────────────────────────────────────────────────────────

export function borderWaitMapPlugin(rootDir: string): Plugin {
  return {
    name: 'border-wait-map-landing',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_BORDER_WAIT_MAP === '1') {
        console.log('\x1b[36m[border-wait-map]\x1b[0m skipped (SKIP_BORDER_WAIT_MAP=1)');
        return;
      }
      const distDir = path.resolve(rootDir, 'dist');
      const collector = new WriteCollector({ distDir });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: string[] = [];

      for (const locale of BORDER_WAIT_LOCALES) {
        const render = renderPage({ locale, dateStamp, distDir });

        if (render.wordCount < MIN_INDEXABLE_WORDS) {
          console.warn(`\x1b[33m[border-wait-map]\x1b[0m ${locale} below MIN_INDEXABLE_WORDS (${render.wordCount}) — will be noindex`);
        }

        const indexPath = path.join(distDir, render.urlPath, 'index.html');
        const flatPath = path.join(distDir, render.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, render.html);
        collector.add(flatPath, render.html);

        sitemapEntries.push(
          `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
        );
      }

      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
        try {
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(path.join(distDir, 'sitemap-border-wait-map.xml'), sitemapXml, 'utf-8');

          const masterSitemap = path.join(distDir, 'sitemap.xml');
          if (fs.existsSync(masterSitemap)) {
            let idx = fs.readFileSync(masterSitemap, 'utf-8');
            if (!idx.includes('sitemap-border-wait-map.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-border-wait-map.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-border-wait-map\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(masterSitemap, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('\x1b[33m[border-wait-map]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(`\x1b[36m[border-wait-map]\x1b[0m Generated ${BORDER_WAIT_LOCALES.length} locale map-hub pages — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    },
  };
}
