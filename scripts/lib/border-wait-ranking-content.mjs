/**
 * Deterministic, quota-free content builder for the weekly "best/worst dogane"
 * ranking digest (evergreen sibling of events-digest-content.mjs, same
 * pattern: single stable id/slug, body refreshed weekly, no LLM/no quota).
 *
 * Needs crossing display names / regions / per-crossing page links from
 * `build-plugins/borderWaitData.ts` (a `.ts` module) — so, unlike the pure
 * `border-wait-ranking.mjs` aggregation lib, this file must run under `tsx`
 * (or vitest, which transforms TS the same way), never plain `node`. Same
 * split as scripts/check-border-data-health.mjs.
 */
import {
  BORDER_WAIT_CROSSINGS,
  BORDER_CROSSING_DISPLAY,
  CROSSING_TO_REGION,
  buildOggiPath,
  buildRootHubPath,
} from '../../build-plugins/borderWaitData.ts';

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

function humanDate(todayIso, locale) {
  const [y, mo, d] = todayIso.split('-').map(Number);
  const month = MONTHS[locale][mo - 1];
  if (locale === 'de') return `${d}. ${month} ${y}`;
  return `${d} ${month} ${y}`;
}

function fmtMinutes(minutes) {
  return `${Math.max(0, Math.round(minutes))} min`;
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

const T = {
  it: {
    title: () => 'Classifica delle dogane in Ticino: le migliori e le peggiori per tempo di attesa',
    excerpt: () =>
      'Ogni dogana del Ticino, classificata per tempo medio di attesa: qual è la più veloce, qual è la più lenta, e quanti minuti di vita si guadagnano (o si perdono) a sceglierne una piuttosto che un’altra.',
    imageAlt: 'Traffico in coda a una dogana del Canton Ticino',
    h1: 'Le dogane del Ticino, dalla più veloce alla più lenta',
    intro: (dateLabel) =>
      `Aggiornata al ${dateLabel}, in base ai dati di traffico raccolti ogni 15 minuti su tutte le dogane del Canton Ticino. Ecco chi vince e chi perde questa settimana.`,
    noData:
      'Non ci sono ancora abbastanza dati raccolti per stilare una classifica affidabile. Torna tra qualche giorno: la raccolta è continua e la pagina si aggiorna automaticamente.',
    bestH: 'Le 5 dogane più veloci',
    worstH: 'Le 5 dogane più lente',
    funFactCallout: (fact) =>
      `📊 **Il conto della vita perduta (o guadagnata).** Chi attraversa ogni giorno ${crossingLink('it', fact.worstSlug)} invece di ${crossingLink('it', fact.bestSlug)} perde in media **${fmtMinutes(fact.deltaMinutesPerCrossing)} in più a ogni passaggio**. Su base annua (2 passaggi al giorno, ~230 giornate lavorative) fanno **${fact.minutesPerYear.toLocaleString('it-CH')} minuti**, cioè **${fact.hoursPerYear} ore** — quasi ${fact.workingDaysLostPerYear} giornate intere passate in coda in più all'anno.`,
    tableH: 'Classifica completa',
    tableIntro:
      'Tempo medio totale (avvicinamento + attesa al varco) calcolato sugli ultimi 7 giorni. La freccia indica la tendenza rispetto alla settimana precedente.',
    colRank: '#',
    colCrossing: 'Dogana',
    colRegion: 'Zona',
    colWait: 'Attesa media',
    colTrend: 'Tendenza',
    howH: 'Come leggere questi dati',
    how: `I tempi arrivano dal monitoraggio in tempo reale delle code ai valichi, campionato ogni 15 minuti nelle ore di punta. La classifica usa una media pesata sugli ultimi 7 giorni: le dogane con poche rilevazioni non vengono classificate per non falsare il confronto. Per il traffico live di ogni singolo valico vedi la [pagina traffico dogane](${buildRootHubPath('it')}).`,
    tip: '💡 Prima di partire, controlla il traffico live del tuo valico abituale: a volte basta uno scarto di 10-15 minuti per evitare la coda peggiore.',
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
    intro: (dateLabel) =>
      `Updated as of ${dateLabel}, based on traffic data collected every 15 minutes across every Ticino border crossing. Here's who wins and who loses this week.`,
    noData:
      "Not enough data has been collected yet for a reliable ranking. Check back in a few days — collection is continuous and this page refreshes automatically.",
    bestH: 'The 5 fastest crossings',
    worstH: 'The 5 slowest crossings',
    funFactCallout: (fact) =>
      `📊 **The lost-life math.** Someone crossing every day at ${crossingLink('en', fact.worstSlug)} instead of ${crossingLink('en', fact.bestSlug)} loses, on average, **${fmtMinutes(fact.deltaMinutesPerCrossing)} extra per crossing**. Over a year (2 crossings/day, ~230 working days) that's **${fact.minutesPerYear.toLocaleString('en-CH')} minutes** — **${fact.hoursPerYear} hours**, or almost ${fact.workingDaysLostPerYear} full extra days stuck in traffic.`,
    tableH: 'Full ranking',
    tableIntro:
      'Average total time (approach + checkpoint queue) over the last 7 days. The arrow shows the trend versus the previous week.',
    colRank: '#',
    colCrossing: 'Crossing',
    colRegion: 'Area',
    colWait: 'Avg. wait',
    colTrend: 'Trend',
    howH: 'How to read this data',
    how: `Wait times come from real-time queue monitoring, sampled every 15 minutes during peak hours. The ranking uses a 7-day weighted average; crossings with too few readings are excluded so the comparison stays fair. For live traffic at any single crossing, see the [border-wait hub](${buildRootHubPath('en')}).`,
    tip: "💡 Before you leave, check the live traffic on your usual crossing — sometimes a 10-15 minute shift avoids the worst of the queue.",
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
    intro: (dateLabel) =>
      `Aktualisiert am ${dateLabel}, basierend auf Verkehrsdaten, die alle 15 Minuten an allen Tessiner Grenzübergängen erhoben werden. Wer gewinnt diese Woche, wer verliert?`,
    noData:
      'Es liegen noch nicht genug Daten für eine verlässliche Rangliste vor. Schau in ein paar Tagen wieder vorbei — die Erhebung läuft kontinuierlich, die Seite aktualisiert sich automatisch.',
    bestH: 'Die 5 schnellsten Übergänge',
    worstH: 'Die 5 langsamsten Übergänge',
    funFactCallout: (fact) =>
      `📊 **Die Rechnung zur verlorenen Lebenszeit.** Wer täglich ${crossingLink('de', fact.worstSlug)} statt ${crossingLink('de', fact.bestSlug)} nimmt, verliert im Schnitt **${fmtMinutes(fact.deltaMinutesPerCrossing)} zusätzlich pro Grenzübertritt**. Aufs Jahr hochgerechnet (2 Übertritte/Tag, ~230 Arbeitstage) sind das **${fact.minutesPerYear.toLocaleString('de-CH')} Minuten** — **${fact.hoursPerYear} Stunden**, fast ${fact.workingDaysLostPerYear} ganze zusätzliche Tage im Stau.`,
    tableH: 'Vollständige Rangliste',
    tableIntro:
      'Durchschnittliche Gesamtzeit (Anfahrt + Wartezeit am Übergang) der letzten 7 Tage. Der Pfeil zeigt den Trend gegenüber der Vorwoche.',
    colRank: '#',
    colCrossing: 'Übergang',
    colRegion: 'Zone',
    colWait: 'Ø Wartezeit',
    colTrend: 'Trend',
    howH: 'So liest du diese Daten',
    how: `Die Wartezeiten stammen aus der Echtzeit-Überwachung der Warteschlangen, alle 15 Minuten während der Stosszeiten erhoben. Die Rangliste nutzt einen gewichteten 7-Tage-Durchschnitt; Übergänge mit zu wenigen Messungen werden ausgeschlossen, damit der Vergleich fair bleibt. Live-Verkehr für einen einzelnen Übergang siehe [Übersicht Grenzwartezeiten](${buildRootHubPath('de')}).`,
    tip: '💡 Prüfe vor der Abfahrt den Live-Verkehr an deinem gewohnten Übergang — manchmal reicht eine Verschiebung von 10-15 Minuten, um den schlimmsten Stau zu umgehen.',
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
    intro: (dateLabel) =>
      `Mis à jour au ${dateLabel}, sur la base des données de trafic collectées toutes les 15 minutes sur toutes les douanes tessinoises. Voici qui gagne et qui perd cette semaine.`,
    noData:
      "Pas encore assez de données collectées pour un classement fiable. Revenez dans quelques jours : la collecte est continue et cette page se met à jour automatiquement.",
    bestH: 'Les 5 douanes les plus rapides',
    worstH: 'Les 5 douanes les plus lentes',
    funFactCallout: (fact) =>
      `📊 **Le calcul de la vie perdue (ou gagnée).** Qui traverse chaque jour à ${crossingLink('fr', fact.worstSlug)} plutôt qu'à ${crossingLink('fr', fact.bestSlug)} perd en moyenne **${fmtMinutes(fact.deltaMinutesPerCrossing)} de plus à chaque passage**. Sur une année (2 passages/jour, ~230 jours ouvrés), cela fait **${fact.minutesPerYear.toLocaleString('fr-CH')} minutes** — **${fact.hoursPerYear} heures**, soit presque ${fact.workingDaysLostPerYear} journées entières passées en plus dans les bouchons.`,
    tableH: 'Classement complet',
    tableIntro:
      "Temps total moyen (approche + attente au poste) sur les 7 derniers jours. La flèche indique la tendance par rapport à la semaine précédente.",
    colRank: '#',
    colCrossing: 'Douane',
    colRegion: 'Zone',
    colWait: 'Attente moy.',
    colTrend: 'Tendance',
    howH: 'Comment lire ces données',
    how: `Les temps d'attente proviennent d'une surveillance en temps réel des files, échantillonnée toutes les 15 minutes aux heures de pointe. Le classement utilise une moyenne pondérée sur 7 jours ; les douanes avec trop peu de mesures sont exclues pour garder une comparaison équitable. Pour le trafic en direct d'une douane en particulier, voir le [hub trafic douanes](${buildRootHubPath('fr')}).`,
    tip: "💡 Avant de partir, vérifiez le trafic en direct de votre douane habituelle : parfois 10 à 15 minutes de décalage suffisent à éviter le pire de la file.",
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
  const header = `| ${t.colRank} | ${t.colCrossing} | ${t.colRegion} | ${t.colWait} | ${t.colTrend} |`;
  const sep = '|---|---|---|---|---|';
  const body = rows
    .map((r) => {
      const tr = trend[r.slug];
      const arrow = tr ? trendArrow(tr.direction) : '–';
      return `| ${r.rank} | ${crossingLink(locale, r.slug)} | ${regionLabel(locale, r.slug)} | ${fmtMinutes(r.avgMinutes)} | ${arrow} |`;
    })
    .join('\n');
  return [header, sep, body].join('\n');
}

/**
 * Build the full 4-locale article payload for the border-wait ranking digest.
 * @param {{ ranking: Array<{slug:string, avgMinutes:number, totalSamples:number, rank:number}>, trend: Record<string, {direction:string}>, funFacts: object|null, todayIso: string }} params
 */
export function buildBorderWaitRankingArticle({ ranking, trend, funFacts, todayIso }) {
  const known = ranking.filter((r) => BORDER_WAIT_CROSSINGS.includes(r.slug));
  const best = known.slice(0, MAX_TOP);
  const worst = known.slice(-MAX_TOP).reverse();
  const tableRows = known.slice(0, MAX_TABLE_ROWS);

  const content = {};
  const imageAlt = {};
  for (const locale of LOCALES) {
    const t = T[locale];
    const dateLabel = humanDate(todayIso, locale);
    const hasData = known.length >= 2;

    const body1 = hasData
      ? [
          `## ${t.h1}`,
          '',
          t.intro(dateLabel),
          '',
          funFacts ? t.funFactCallout(funFacts) : '',
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

    content[locale] = {
      title: t.title(),
      excerpt: t.excerpt(),
      body1,
      body2,
      body3,
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
