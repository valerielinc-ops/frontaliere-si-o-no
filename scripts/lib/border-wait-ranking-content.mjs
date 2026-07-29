/**
 * Deterministic, quota-free content builder for the weekly "best/worst dogane"
 * ranking digest (evergreen sibling of events-digest-content.mjs, same
 * pattern: single stable id/slug, body refreshed weekly, no LLM/no quota).
 *
 * Needs crossing display names / regions / per-crossing page links from
 * `build-plugins/borderWaitData.ts` (a `.ts` module) — so, unlike the pure
 * `border-wait-ranking.mjs` aggregation lib, this file must run under `tsx`
 * (or vitest, which transforms TS the same way), never plain `node`. Same
 * split as scripts/check-border-data-health.mjs. `services/borderWaitFormat.ts`
 * is the same kind of `.ts` dependency — shared with the React widget so the
 * two never render two different roundings of the same minute value.
 */
import {
  BORDER_WAIT_CROSSINGS,
  BORDER_CROSSING_DISPLAY,
  CROSSING_TO_REGION,
  isTicinoCrossing,
  buildOggiPath,
  buildRootHubPath,
} from '../../build-plugins/borderWaitData.ts';
import { fmtMinutes, fmtSignedMinutesDelta } from '../../services/borderWaitFormat.ts';

/** Stable, evergreen identity — never changes (no date in id/slug → no flooding). */
export const RANKING_ARTICLE_ID = 'classifica-dogane-ticino';
export const RANKING_ARTICLE_SLUGS = {
  it: 'classifica-dogane-ticino',
  en: 'ticino-border-crossing-ranking',
  de: 'rangliste-grenzuebergaenge-tessin',
  fr: 'classement-douanes-tessin',
};

const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_TOP = 5;
const MAX_TABLE_ROWS = 20;

// Small, stable set (3 regions) — not imported from the i18n copy bundle to
// keep this a pure/no-dependency content builder; mirrors borderWaitData.ts's
// own precedent of deliberately duplicating a small stable constant across a
// module boundary (see that file's header comment).
const REGION_LABEL = {
  it: { 'ticino-como': 'Ticino–Como', 'ticino-varese': 'Ticino–Varese', 'ticino-verbano': 'Ticino–Verbano' },
  en: { 'ticino-como': 'Ticino–Como', 'ticino-varese': 'Ticino–Varese', 'ticino-verbano': 'Ticino–Verbano' },
  de: { 'ticino-como': 'Tessin–Como', 'ticino-varese': 'Tessin–Varese', 'ticino-verbano': 'Tessin–Verbano' },
  fr: { 'ticino-como': 'Tessin–Côme', 'ticino-varese': 'Tessin–Varèse', 'ticino-verbano': 'Tessin–Verbano' },
};

const MONTHS = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

function humanDate(dateIso, locale) {
  const [y, mo, d] = dateIso.split('-').map(Number);
  const month = MONTHS[locale][mo - 1];
  if (locale === 'de') return `${d}. ${month} ${y}`;
  return `${d} ${month} ${y}`;
}

/** "27 giugno – 3 luglio 2026" (same month collapses to a single month name). */
function humanDateRange(weekStart, weekEnd, locale) {
  const [ys, mos, ds] = weekStart.split('-').map(Number);
  const [ye, moe, de] = weekEnd.split('-').map(Number);
  if (ys === ye && mos === moe) {
    const month = MONTHS[locale][mos - 1];
    return locale === 'de' ? `${ds}.–${de}. ${month} ${ye}` : `${ds}–${de} ${month} ${ye}`;
  }
  return `${humanDate(weekStart, locale)} – ${humanDate(weekEnd, locale)}`;
}

function displayName(slug) {
  return BORDER_CROSSING_DISPLAY[slug] || slug;
}

function crossingLink(locale, slug) {
  return `[${displayName(slug)}](${buildOggiPath(locale, slug)})`;
}

function regionLabel(locale, slug) {
  const region = CROSSING_TO_REGION[slug];
  return (region && REGION_LABEL[locale][region]) || '';
}

function trendArrow(direction) {
  if (direction === 'worse') return '▲';
  if (direction === 'better') return '▼';
  return '→';
}

/** Fastest vs. slowest crossing within each region that has ≥2 ranked crossings. */
function regionBreakdown(known) {
  const byRegion = new Map();
  for (const r of known) {
    const region = CROSSING_TO_REGION[r.slug];
    if (!region) continue;
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(r);
  }
  const rows = [];
  for (const [region, entries] of byRegion.entries()) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((a, b) => a.avgMinutes - b.avgMinutes);
    rows.push({ region, fastest: sorted[0], slowest: sorted[sorted.length - 1] });
  }
  return rows;
}

const T = {
  it: {
    title: () => 'Classifica delle dogane in Ticino: le migliori e le peggiori per tempo di attesa',
    excerpt: () =>
      'Ogni dogana del Ticino, classificata per tempo medio di attesa: qual è la più veloce, qual è la più lenta, e quanti minuti di vita si guadagnano (o si perdono) a sceglierne una piuttosto che un’altra.',
    imageAlt: 'Traffico in coda a una dogana del Canton Ticino',
    h1: 'Le dogane del Ticino, dalla più veloce alla più lenta',
    weekOf: (rangeLabel) => `📅 Settimana del **${rangeLabel}** — dati aggiornati ogni 15 minuti su tutti i valichi.`,
    intro:
      'Ecco chi vince e chi perde questa settimana. La classifica confronta il tempo medio totale (avvicinamento + attesa al varco) di ogni dogana ticinese, così sai in anticipo dove rischi di perdere tempo e dove invece puoi risparmiarlo.',
    noData:
      'Non ci sono ancora abbastanza dati raccolti per stilare una classifica affidabile. Torna tra qualche giorno: la raccolta è continua e la pagina si aggiorna automaticamente.',
    bestH: 'Le 5 dogane più veloci',
    worstH: 'Le 5 dogane più lente',
    funFactCallout: (fact) =>
      `📊 **Il conto della vita perduta (o guadagnata).** Chi attraversa ogni giorno ${crossingLink('it', fact.worstSlug)} invece di ${crossingLink('it', fact.bestSlug)} perde in media **${fmtMinutes(fact.deltaMinutesPerCrossing)} in più a ogni passaggio**. Su base annua (2 passaggi al giorno, ~230 giornate lavorative) fanno **${fact.minutesPerYear.toLocaleString('it-CH')} minuti**, cioè **${fact.hoursPerYear} ore** — quasi ${fact.workingDaysLostPerYear} giornate intere passate in coda in più all'anno.`,
    moverImproved: (slug, deltaLabel) =>
      `🟢 **Chi è migliorata di più:** ${crossingLink('it', slug)} ha guadagnato **${deltaLabel}** rispetto alla settimana scorsa — se la eviti di solito, potrebbe valere la pena riprovarla.`,
    moverWorsened: (slug, deltaLabel) =>
      `🔴 **Chi è peggiorata di più:** ${crossingLink('it', slug)} ha perso **${deltaLabel}** rispetto alla settimana scorsa — se la usi abitualmente, meglio tenere d'occhio un'alternativa.`,
    tip: '💡 Prima di partire, controlla il traffico live del tuo valico abituale: a volte basta uno scarto di 10-15 minuti per evitare la coda peggiore.',
    tableH: 'Classifica completa',
    tableIntro:
      'Tempo medio totale (avvicinamento + attesa al varco) calcolato sugli ultimi 7 giorni. La colonna "Δ" mostra la variazione in minuti rispetto alla settimana precedente; la freccia ne indica la direzione.',
    colRank: '#',
    colCrossing: 'Dogana',
    colRegion: 'Zona',
    colWait: 'Attesa media',
    colDelta: 'Δ 7gg',
    colTrend: 'Tendenza',
    howH: 'Come leggere questi dati',
    how: `I tempi arrivano dal monitoraggio in tempo reale delle code ai valichi, campionato ogni 15 minuti nelle ore di punta. La classifica usa una **media pesata** sugli ultimi 7 giorni — le ore con più rilevazioni contano di più, così un singolo picco isolato non falsa il quadro. Le dogane con poche rilevazioni non vengono classificate, per lo stesso motivo. La colonna "Δ 7gg" confronta la media di questa settimana con quella della settimana precedente (stessa finestra di 7 giorni, spostata indietro): un valore positivo (▲) significa che il valico è diventato più lento, uno negativo (▼) che è migliorato. Per il traffico live di ogni singolo valico vedi la [pagina traffico dogane](${buildRootHubPath('it')}).`,
    adviceH: 'Cosa fare con questi dati',
    adviceIntro:
      "Una classifica settimanale serve solo se la usi *prima* di partire, non dopo. Tre modi pratici di sfruttarla: scegli il valico più veloce della tua zona per gli spostamenti flessibili; se il tuo valico abituale è peggiorato molto rispetto alla settimana scorsa (vedi sopra), prova un'alternativa nella stessa zona per qualche giorno; e se sei tra chi può scegliere l'orario, ricorda che la media qui è calcolata sulle ore di punta — un piccolo scarto d'orario spesso pesa più della scelta del valico.",
    regionH: 'Il confronto zona per zona',
    regionIntro: (label, fastLink, fastMin, slowLink, slowMin) =>
      `**${label}**: ${fastLink} è la più rapida (${fastMin}), ${slowLink} la più lenta (${slowMin}).`,
    weeklyRecap: (improved, worsened) => {
      if (improved === 0 && worsened === 0) return 'Questa settimana la situazione è rimasta sostanzialmente stabile su tutti i valichi monitorati.';
      return `Questa settimana ${improved} ${improved === 1 ? 'valico è migliorato' : 'valichi sono migliorati'} e ${worsened} ${worsened === 1 ? 'è peggiorato' : 'sono peggiorati'} in modo significativo rispetto alla settimana precedente — il traffico di confine cambia più spesso di quanto si pensi, per questo la classifica si aggiorna ogni settimana invece di restare fissa.`;
    },
    faq: (fact) => [
      {
        q: 'Qual è la dogana più veloce del Ticino oggi?',
        a: fact
          ? `In base agli ultimi 7 giorni di dati, ${displayName(fact.bestSlug)} è la dogana con il tempo di attesa medio più basso. La classifica completa qui sopra si aggiorna ogni settimana.`
          : 'La classifica si aggiorna ogni settimana in base ai dati di traffico raccolti sulle dogane ticinesi.',
      },
      {
        q: 'Con che frequenza vengono aggiornati i tempi di attesa?',
        a: 'I dati vengono raccolti ogni 15 minuti nelle ore di punta da un servizio di monitoraggio del traffico; la classifica di questo articolo viene ricalcolata una volta a settimana su una media mobile di 7 giorni.',
      },
      {
        q: 'Quanti minuti si perdono davvero scegliendo la dogana sbagliata?',
        a: fact
          ? `Nel confronto peggiore/migliore attuale, la differenza è di circa ${fmtMinutes(fact.deltaMinutesPerCrossing)} a passaggio: su due passaggi al giorno per circa 230 giornate lavorative fanno circa ${fact.hoursPerYear} ore all'anno.`
          : "Dipende dalla differenza tra la dogana scelta e l'alternativa più veloce nello stesso periodo: la stima si trova nel riquadro dedicato qui sopra, quando disponibile.",
      },
    ],
  },
  en: {
    title: () => 'Ticino border crossing ranking: the fastest and slowest for wait times',
    excerpt: () =>
      "Every border crossing in Ticino, ranked by average wait time: which one is fastest, which is slowest, and how many minutes of your life you gain (or lose) picking one over another.",
    imageAlt: 'Queuing traffic at a Canton Ticino border crossing',
    h1: 'Ticino border crossings, from fastest to slowest',
    weekOf: (rangeLabel) => `📅 Week of **${rangeLabel}** — data refreshed every 15 minutes at every crossing.`,
    intro:
      "Here's who wins and who loses this week. The ranking compares the average total time (approach + checkpoint queue) at every Ticino border crossing, so you know in advance where you're likely to lose time — and where you can save it.",
    noData:
      "Not enough data has been collected yet for a reliable ranking. Check back in a few days — collection is continuous and this page refreshes automatically.",
    bestH: 'The 5 fastest crossings',
    worstH: 'The 5 slowest crossings',
    funFactCallout: (fact) =>
      `📊 **The lost-life math.** Someone crossing every day at ${crossingLink('en', fact.worstSlug)} instead of ${crossingLink('en', fact.bestSlug)} loses, on average, **${fmtMinutes(fact.deltaMinutesPerCrossing)} extra per crossing**. Over a year (2 crossings/day, ~230 working days) that's **${fact.minutesPerYear.toLocaleString('en-CH')} minutes** — **${fact.hoursPerYear} hours**, or almost ${fact.workingDaysLostPerYear} full extra days stuck in traffic.`,
    moverImproved: (slug, deltaLabel) =>
      `🟢 **Biggest improvement:** ${crossingLink('en', slug)} gained **${deltaLabel}** versus last week — if you usually avoid it, it might be worth another try.`,
    moverWorsened: (slug, deltaLabel) =>
      `🔴 **Biggest worsening:** ${crossingLink('en', slug)} lost **${deltaLabel}** versus last week — if it's your usual crossing, keep an alternative in mind.`,
    tip: "💡 Before you leave, check the live traffic on your usual crossing — sometimes a 10-15 minute shift avoids the worst of the queue.",
    tableH: 'Full ranking',
    tableIntro:
      'Average total time (approach + checkpoint queue) over the last 7 days. The "Δ" column shows the change in minutes versus the previous week; the arrow shows its direction.',
    colRank: '#',
    colCrossing: 'Crossing',
    colRegion: 'Area',
    colWait: 'Avg. wait',
    colDelta: 'Δ 7d',
    colTrend: 'Trend',
    howH: 'How to read this data',
    how: `Wait times come from real-time queue monitoring, sampled every 15 minutes during peak hours. The ranking uses a **weighted average** over the last 7 days — hours with more readings count more, so a single isolated spike doesn't skew the picture. Crossings with too few readings are excluded for the same reason. The "Δ 7d" column compares this week's average with the previous week's (same 7-day window, shifted back): a positive value (▲) means the crossing got slower, a negative one (▼) means it improved. For live traffic at any single crossing, see the [border-wait hub](${buildRootHubPath('en')}).`,
    adviceH: 'What to actually do with this data',
    adviceIntro:
      "A weekly ranking is only useful if you act on it *before* you leave, not after. Three practical ways to use it: pick the fastest crossing in your area when your schedule is flexible; if your usual crossing got a lot worse this week (see above), try an alternative in the same area for a few days; and if you can choose your departure time, remember this average is built from peak hours — a small time shift often matters more than which crossing you pick.",
    regionH: 'Area by area',
    regionIntro: (label, fastLink, fastMin, slowLink, slowMin) =>
      `**${label}**: ${fastLink} is the fastest (${fastMin}), ${slowLink} the slowest (${slowMin}).`,
    weeklyRecap: (improved, worsened) => {
      if (improved === 0 && worsened === 0) return 'This week the situation stayed largely stable across every monitored crossing.';
      return `This week ${improved} ${improved === 1 ? 'crossing' : 'crossings'} improved and ${worsened} ${worsened === 1 ? 'crossing' : 'crossings'} got significantly worse versus the previous week — border traffic shifts more often than people assume, which is why this ranking refreshes weekly instead of staying fixed.`;
    },
    faq: (fact) => [
      {
        q: "What's the fastest border crossing in Ticino today?",
        a: fact
          ? `Based on the last 7 days of data, ${displayName(fact.bestSlug)} has the lowest average wait time. The full ranking above refreshes weekly.`
          : 'The ranking refreshes weekly based on traffic data collected at Ticino border crossings.',
      },
      {
        q: 'How often are wait times updated?',
        a: 'Data is collected every 15 minutes during peak hours by a traffic-monitoring service; this article recalculates its ranking once a week on a rolling 7-day average.',
      },
      {
        q: 'How many minutes do you really lose picking the wrong crossing?',
        a: fact
          ? `In the current worst-vs-best comparison, the gap is about ${fmtMinutes(fact.deltaMinutesPerCrossing)} per crossing — over two crossings a day for roughly 230 working days, that's about ${fact.hoursPerYear} hours a year.`
          : "It depends on the gap between your usual crossing and the fastest alternative in the same period — see the callout above when available.",
      },
    ],
  },
  de: {
    title: () => 'Rangliste der Grenzübergänge im Tessin: die schnellsten und langsamsten Wartezeiten',
    excerpt: () =>
      'Jeder Grenzübergang im Tessin, nach durchschnittlicher Wartezeit sortiert: welcher ist am schnellsten, welcher am langsamsten — und wie viele Minuten Lebenszeit man gewinnt (oder verliert), wenn man den einen statt den anderen wählt.',
    imageAlt: 'Stau an einem Grenzübergang im Kanton Tessin',
    h1: 'Die Grenzübergänge im Tessin, vom schnellsten zum langsamsten',
    weekOf: (rangeLabel) => `📅 Woche vom **${rangeLabel}** — Daten alle 15 Minuten an jedem Übergang aktualisiert.`,
    intro:
      'Wer gewinnt diese Woche, wer verliert? Die Rangliste vergleicht die durchschnittliche Gesamtzeit (Anfahrt + Wartezeit am Übergang) an jedem Tessiner Grenzübergang — so weisst du im Voraus, wo du Zeit verlierst und wo du sie sparen kannst.',
    noData:
      'Es liegen noch nicht genug Daten für eine verlässliche Rangliste vor. Schau in ein paar Tagen wieder vorbei — die Erhebung läuft kontinuierlich, die Seite aktualisiert sich automatisch.',
    bestH: 'Die 5 schnellsten Übergänge',
    worstH: 'Die 5 langsamsten Übergänge',
    funFactCallout: (fact) =>
      `📊 **Die Rechnung zur verlorenen Lebenszeit.** Wer täglich ${crossingLink('de', fact.worstSlug)} statt ${crossingLink('de', fact.bestSlug)} nimmt, verliert im Schnitt **${fmtMinutes(fact.deltaMinutesPerCrossing)} zusätzlich pro Grenzübertritt**. Aufs Jahr hochgerechnet (2 Übertritte/Tag, ~230 Arbeitstage) sind das **${fact.minutesPerYear.toLocaleString('de-CH')} Minuten** — **${fact.hoursPerYear} Stunden**, fast ${fact.workingDaysLostPerYear} ganze zusätzliche Tage im Stau.`,
    moverImproved: (slug, deltaLabel) =>
      `🟢 **Grösste Verbesserung:** ${crossingLink('de', slug)} hat gegenüber letzter Woche **${deltaLabel}** gewonnen — wer den Übergang sonst meidet, kann ihn wieder versuchen.`,
    moverWorsened: (slug, deltaLabel) =>
      `🔴 **Grösste Verschlechterung:** ${crossingLink('de', slug)} hat gegenüber letzter Woche **${deltaLabel}** verloren — wer ihn regelmässig nutzt, sollte eine Alternative im Blick behalten.`,
    tip: '💡 Prüfe vor der Abfahrt den Live-Verkehr an deinem gewohnten Übergang — manchmal reicht eine Verschiebung von 10-15 Minuten, um den schlimmsten Stau zu umgehen.',
    tableH: 'Vollständige Rangliste',
    tableIntro:
      'Durchschnittliche Gesamtzeit (Anfahrt + Wartezeit am Übergang) der letzten 7 Tage. Die Spalte "Δ" zeigt die Veränderung in Minuten gegenüber der Vorwoche; der Pfeil zeigt die Richtung.',
    colRank: '#',
    colCrossing: 'Übergang',
    colRegion: 'Zone',
    colWait: 'Ø Wartezeit',
    colDelta: 'Δ 7T',
    colTrend: 'Trend',
    howH: 'So liest du diese Daten',
    how: `Die Wartezeiten stammen aus der Echtzeit-Überwachung der Warteschlangen, alle 15 Minuten während der Stosszeiten erhoben. Die Rangliste nutzt einen **gewichteten Durchschnitt** über die letzten 7 Tage — Stunden mit mehr Messungen zählen stärker, damit ein einzelner Ausreisser das Bild nicht verzerrt. Aus demselben Grund werden Übergänge mit zu wenigen Messungen ausgeschlossen. Die Spalte "Δ 7T" vergleicht den Durchschnitt dieser Woche mit dem der Vorwoche (gleiches 7-Tage-Fenster, zurückversetzt): ein positiver Wert (▲) bedeutet, der Übergang wurde langsamer, ein negativer (▼), er wurde besser. Live-Verkehr für einen einzelnen Übergang siehe [Übersicht Grenzwartezeiten](${buildRootHubPath('de')}).`,
    adviceH: 'Was du mit diesen Daten machen kannst',
    adviceIntro:
      'Eine wöchentliche Rangliste bringt nur etwas, wenn du sie *vor* der Abfahrt nutzt, nicht danach. Drei praktische Anwendungen: Bei flexiblem Zeitplan den schnellsten Übergang deiner Zone wählen; ist dein gewohnter Übergang diese Woche deutlich schlechter geworden (siehe oben), ein paar Tage eine Alternative in derselben Zone testen; und wenn du deine Abfahrtszeit wählen kannst: Der Durchschnitt hier basiert auf den Stosszeiten — eine kleine zeitliche Verschiebung wiegt oft mehr als die Wahl des Übergangs.',
    regionH: 'Der Vergleich nach Zone',
    regionIntro: (label, fastLink, fastMin, slowLink, slowMin) =>
      `**${label}**: ${fastLink} ist am schnellsten (${fastMin}), ${slowLink} am langsamsten (${slowMin}).`,
    weeklyRecap: (improved, worsened) => {
      if (improved === 0 && worsened === 0) return 'Diese Woche blieb die Lage an allen erfassten Übergängen weitgehend stabil.';
      return `Diese Woche haben sich ${improved} ${improved === 1 ? 'Übergang' : 'Übergänge'} verbessert und ${worsened} ${worsened === 1 ? 'Übergang' : 'Übergänge'} gegenüber der Vorwoche deutlich verschlechtert — der Grenzverkehr ändert sich öfter, als man denkt, deshalb wird diese Rangliste wöchentlich statt starr aktualisiert.`;
    },
    faq: (fact) => [
      {
        q: 'Welcher Grenzübergang im Tessin ist heute am schnellsten?',
        a: fact
          ? `Basierend auf den letzten 7 Tagen hat ${displayName(fact.bestSlug)} die niedrigste durchschnittliche Wartezeit. Die vollständige Rangliste oben wird wöchentlich aktualisiert.`
          : 'Die Rangliste wird wöchentlich anhand der an den Tessiner Grenzübergängen erhobenen Verkehrsdaten aktualisiert.',
      },
      {
        q: 'Wie oft werden die Wartezeiten aktualisiert?',
        a: 'Die Daten werden alle 15 Minuten während der Stosszeiten von einem Verkehrsüberwachungsdienst erhoben; dieser Artikel berechnet seine Rangliste einmal pro Woche auf Basis eines gleitenden 7-Tage-Durchschnitts neu.',
      },
      {
        q: 'Wie viele Minuten verliert man wirklich beim falschen Übergang?',
        a: fact
          ? `Im aktuellen Vergleich zwischen dem langsamsten und dem schnellsten Übergang beträgt der Unterschied rund ${fmtMinutes(fact.deltaMinutesPerCrossing)} pro Übertritt — bei zwei Übertritten täglich über rund 230 Arbeitstage sind das etwa ${fact.hoursPerYear} Stunden im Jahr.`
          : 'Das hängt vom Unterschied zwischen deinem üblichen Übergang und der schnellsten Alternative im selben Zeitraum ab — siehe den Kasten oben, sobald verfügbar.',
      },
    ],
  },
  fr: {
    title: () => 'Classement des douanes tessinoises : les plus rapides et les plus lentes',
    excerpt: () =>
      "Chaque douane du Tessin, classée selon son temps d'attente moyen : laquelle est la plus rapide, laquelle est la plus lente, et combien de minutes de vie on gagne (ou on perd) en choisissant l'une plutôt que l'autre.",
    imageAlt: 'File de voitures à une douane du canton du Tessin',
    h1: 'Les douanes du Tessin, de la plus rapide à la plus lente',
    weekOf: (rangeLabel) => `📅 Semaine du **${rangeLabel}** — données actualisées toutes les 15 minutes à chaque douane.`,
    intro:
      "Voici qui gagne et qui perd cette semaine. Le classement compare le temps total moyen (approche + attente au poste) de chaque douane tessinoise, pour savoir à l'avance où vous risquez de perdre du temps — et où vous pouvez en gagner.",
    noData:
      "Pas encore assez de données collectées pour un classement fiable. Revenez dans quelques jours : la collecte est continue et cette page se met à jour automatiquement.",
    bestH: 'Les 5 douanes les plus rapides',
    worstH: 'Les 5 douanes les plus lentes',
    funFactCallout: (fact) =>
      `📊 **Le calcul de la vie perdue (ou gagnée).** Qui traverse chaque jour à ${crossingLink('fr', fact.worstSlug)} plutôt qu'à ${crossingLink('fr', fact.bestSlug)} perd en moyenne **${fmtMinutes(fact.deltaMinutesPerCrossing)} de plus à chaque passage**. Sur une année (2 passages/jour, ~230 jours ouvrés), cela fait **${fact.minutesPerYear.toLocaleString('fr-CH')} minutes** — **${fact.hoursPerYear} heures**, soit presque ${fact.workingDaysLostPerYear} journées entières passées en plus dans les bouchons.`,
    moverImproved: (slug, deltaLabel) =>
      `🟢 **Meilleure progression :** ${crossingLink('fr', slug)} a gagné **${deltaLabel}** par rapport à la semaine dernière — si vous l'évitez d'habitude, ça vaut peut-être le coup de réessayer.`,
    moverWorsened: (slug, deltaLabel) =>
      `🔴 **Plus forte dégradation :** ${crossingLink('fr', slug)} a perdu **${deltaLabel}** par rapport à la semaine dernière — si c'est votre douane habituelle, gardez une alternative en tête.`,
    tip: "💡 Avant de partir, vérifiez le trafic en direct de votre douane habituelle : parfois 10 à 15 minutes de décalage suffisent à éviter le pire de la file.",
    tableH: 'Classement complet',
    tableIntro:
      'Temps total moyen (approche + attente au poste) sur les 7 derniers jours. La colonne « Δ » indique la variation en minutes par rapport à la semaine précédente ; la flèche en montre le sens.',
    colRank: '#',
    colCrossing: 'Douane',
    colRegion: 'Zone',
    colWait: 'Attente moy.',
    colDelta: 'Δ 7j',
    colTrend: 'Tendance',
    howH: 'Comment lire ces données',
    how: `Les temps d'attente proviennent d'une surveillance en temps réel des files, échantillonnée toutes les 15 minutes aux heures de pointe. Le classement utilise une **moyenne pondérée** sur 7 jours — les heures avec le plus de mesures comptent davantage, pour qu'un pic isolé ne fausse pas le résultat. Les douanes avec trop peu de mesures sont exclues pour la même raison. La colonne « Δ 7j » compare la moyenne de cette semaine à celle de la semaine précédente (même fenêtre de 7 jours, décalée en arrière) : une valeur positive (▲) signifie que la douane est devenue plus lente, une valeur négative (▼) qu'elle s'est améliorée. Pour le trafic en direct d'une douane en particulier, voir le [hub trafic douanes](${buildRootHubPath('fr')}).`,
    adviceH: 'Que faire concrètement de ces données',
    adviceIntro:
      "Un classement hebdomadaire n'est utile que si vous vous en servez *avant* de partir, pas après. Trois façons concrètes de l'utiliser : choisissez la douane la plus rapide de votre zone quand votre horaire est flexible ; si votre douane habituelle s'est nettement dégradée cette semaine (voir ci-dessus), testez une alternative dans la même zone pendant quelques jours ; et si vous pouvez choisir votre heure de départ, rappelez-vous que cette moyenne est calculée sur les heures de pointe — un petit décalage horaire pèse souvent plus que le choix de la douane.",
    regionH: 'La comparaison zone par zone',
    regionIntro: (label, fastLink, fastMin, slowLink, slowMin) =>
      `**${label}** : ${fastLink} est la plus rapide (${fastMin}), ${slowLink} la plus lente (${slowMin}).`,
    weeklyRecap: (improved, worsened) => {
      if (improved === 0 && worsened === 0) return "Cette semaine, la situation est restée globalement stable sur toutes les douanes surveillées.";
      return `Cette semaine, ${improved} ${improved === 1 ? 'douane s\'est améliorée' : 'douanes se sont améliorées'} et ${worsened} ${worsened === 1 ? 's\'est nettement dégradée' : 'se sont nettement dégradées'} par rapport à la semaine précédente — le trafic frontalier change plus souvent qu'on ne le pense, c'est pourquoi ce classement est actualisé chaque semaine plutôt que figé.`;
    },
    faq: (fact) => [
      {
        q: "Quelle est la douane la plus rapide du Tessin aujourd'hui ?",
        a: fact
          ? `Sur la base des 7 derniers jours, ${displayName(fact.bestSlug)} affiche le temps d'attente moyen le plus bas. Le classement complet ci-dessus est mis à jour chaque semaine.`
          : "Le classement est mis à jour chaque semaine à partir des données de trafic collectées aux douanes tessinoises.",
      },
      {
        q: "À quelle fréquence les temps d'attente sont-ils mis à jour ?",
        a: "Les données sont collectées toutes les 15 minutes aux heures de pointe par un service de surveillance du trafic ; cet article recalcule son classement une fois par semaine sur une moyenne glissante de 7 jours.",
      },
      {
        q: "Combien de minutes perd-on vraiment en choisissant la mauvaise douane ?",
        a: fact
          ? `Dans la comparaison actuelle pire/meilleure douane, l'écart est d'environ ${fmtMinutes(fact.deltaMinutesPerCrossing)} par passage — sur deux passages par jour pendant environ 230 jours ouvrés, cela représente environ ${fact.hoursPerYear} heures par an.`
          : "Cela dépend de l'écart entre votre douane habituelle et l'alternative la plus rapide sur la même période — voir l'encadré ci-dessus lorsqu'il est disponible.",
      },
    ],
  },
};

/** Render a markdown ranking table for a slice of the sorted ranking array. */
function renderTable(locale, rows, trend, t) {
  const header = `| ${t.colRank} | ${t.colCrossing} | ${t.colRegion} | ${t.colWait} | ${t.colDelta} | ${t.colTrend} |`;
  const sep = '|---|---|---|---|---|---|';
  const body = rows
    .map((r) => {
      const tr = trend[r.slug];
      const arrow = tr ? trendArrow(tr.direction) : '–';
      const delta = tr && typeof tr.deltaMinutes === 'number' ? fmtSignedMinutesDelta(tr.deltaMinutes) : '–';
      return `| ${r.rank} | ${crossingLink(locale, r.slug)} | ${regionLabel(locale, r.slug)} | ${fmtMinutes(r.avgMinutes)} | ${delta} | ${arrow} |`;
    })
    .join('\n');
  return [header, sep, body].join('\n');
}

/**
 * Build the full 4-locale article payload for the border-wait ranking digest.
 * @param {{ ranking: Array<{slug:string, avgMinutes:number, totalSamples:number, rank:number}>, trend: Record<string, {direction:string, deltaMinutes:number}>, funFacts: object|null, weekStart?: string, weekEnd?: string, movers?: {improved: Array, worsened: Array}, todayIso: string }} params
 */
export function buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso }) {
  // Evergreen id/copy is Ticino-only ("Classifica delle dogane in Ticino") —
  // BORDER_WAIT_CROSSINGS now also covers the 67 Germany-corridor crossings
  // (#4889/#4952), so this must additionally exclude non-Ticino slugs or a
  // German crossing could surface as this Ticino-only article's best/worst.
  const known = ranking.filter((r) => BORDER_WAIT_CROSSINGS.includes(r.slug) && isTicinoCrossing(r.slug));
  const best = known.slice(0, MAX_TOP);
  const worst = known.slice(-MAX_TOP).reverse();
  const tableRows = known.slice(0, MAX_TABLE_ROWS);
  const regions = regionBreakdown(known);

  const content = {};
  const imageAlt = {};
  for (const locale of LOCALES) {
    const t = T[locale];
    const hasData = known.length >= 2;
    const rangeLabel = weekStart && weekEnd ? humanDateRange(weekStart, weekEnd, locale) : humanDate(todayIso, locale);

    const moverLines = [];
    if (movers?.improved?.[0]) {
      moverLines.push(t.moverImproved(movers.improved[0].slug, fmtSignedMinutesDelta(movers.improved[0].deltaMinutes)));
    }
    if (movers?.worsened?.[0]) {
      moverLines.push(t.moverWorsened(movers.worsened[0].slug, fmtSignedMinutesDelta(movers.worsened[0].deltaMinutes)));
    }

    const body1 = hasData
      ? [
          `## ${t.h1}`,
          '',
          t.weekOf(rangeLabel),
          '',
          t.intro,
          '',
          funFacts ? t.funFactCallout(funFacts) : '',
          '',
          ...moverLines,
          '',
          t.tip,
        ]
          .filter(Boolean)
          .join('\n')
      : `## ${t.h1}\n\n${t.noData}`;

    const body2 = hasData
      ? [
          `## ${t.bestH}`,
          '',
          renderTable(locale, best, trend, t),
          '',
          `## ${t.worstH}`,
          '',
          renderTable(locale, worst, trend, t),
          '',
          `## ${t.tableH}`,
          '',
          t.tableIntro,
          '',
          renderTable(locale, tableRows, trend, t),
        ].join('\n')
      : '';

    const body3 = `## ${t.howH}\n\n${t.how}`;

    const regionLines = regions.map((r) =>
      t.regionIntro(
        REGION_LABEL[locale][r.region],
        crossingLink(locale, r.fastest.slug),
        fmtMinutes(r.fastest.avgMinutes),
        crossingLink(locale, r.slowest.slug),
        fmtMinutes(r.slowest.avgMinutes),
      ),
    );
    const improvedCount = movers?.improved?.length || 0;
    const worsenedCount = movers?.worsened?.length || 0;

    const body4 = hasData
      ? [
          `## ${t.adviceH}`,
          '',
          t.adviceIntro,
          '',
          t.weeklyRecap(improvedCount, worsenedCount),
          regionLines.length
            ? ['', `### ${t.regionH}`, '', ...regionLines.map((l) => `- ${l}`)].join('\n')
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

    content[locale] = {
      title: t.title(),
      excerpt: t.excerpt(),
      body1,
      body2,
      body3,
      body4,
      faq: t.faq(funFacts).map(({ q, a }) => ({ q, a })),
    };
    imageAlt[locale] = t.imageAlt;
  }

  return {
    id: RANKING_ARTICLE_ID,
    slugs: { ...RANKING_ARTICLE_SLUGS },
    imageAlt,
    content,
    _rankedCount: known.length,
  };
}
