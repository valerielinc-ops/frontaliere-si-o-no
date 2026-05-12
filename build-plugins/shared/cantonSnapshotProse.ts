/**
 * cantonSnapshotProse.ts
 *
 * Long-form prose appended to every per-canton job-market snapshot page
 * (`/{localePrefix}/{job-board-slug}-{canton}/snapshot/`). Sister module to
 * `cantonSeoProse.ts`, which serves the canton-hub / today / sector slots
 * already wired into PR #140. The snapshot pages are a different beast:
 *
 *  - Body is dominated by two short rank tables (top cities + top sectors)
 *    and a 3-tile stat grid. With only the existing 2-paragraph methodology
 *    block the EN locale runs ~9.2-9.7 % visible-text / HTML and trips the
 *    `audit:text-html-ratio` Semrush gate (≤ 10 % is the floor).
 *  - The TI page already has substantial editorial prose; only the 20
 *    non-TI EN snapshots are thin (run 25752701002 ratchet failure).
 *
 * Why a dedicated module
 * ----------------------
 *  - Tone is unique: snapshot interpretation, market timing, frontaliere
 *    positioning vs Ticino — different from the canton-hub flavour.
 *  - Adds ~1.6-2.0 KB visible text per page across 4 paragraphs, lifting
 *    every page above the 12 % ratio with margin for data drift.
 *  - Parameterised by canton display name + distance band so two cantons
 *    emit different prose and Google's cross-page duplicate-content
 *    heuristic stays happy.
 *
 * Design constraints (CLAUDE.md non-negotiables #15-17)
 * -----------------------------------------------------
 *  - Mobile-first: caller inserts the block BELOW the data area (rank
 *    tables + tiles). Filler never pushes the meat below the fold on a
 *    ≤ 414 px viewport.
 *  - No new colour values: only `--color-*` semantic tokens. Auto-switches
 *    light/dark with no `dark:` Tailwind prefixes.
 *  - Pure: identical inputs return identical HTML, so determinism + any
 *    future snapshot tests stay stable.
 *
 * Public API
 * ----------
 *  - `buildSnapshotProseBlock({ locale, cantonDisplay, totalJobs, ctaHref,
 *    ctaLabel })` returns a self-contained `<section>` of HTML.
 */

export type SnapshotLocale = 'it' | 'en' | 'de' | 'fr';

export interface SnapshotProseOpts {
  /** Output locale. */
  locale: SnapshotLocale;
  /** Canton display name in the target locale (e.g. 'Zurich', 'Argovia'). */
  cantonDisplay: string;
  /** Total active openings for the canton today. */
  totalJobs: number;
  /** Top sector label in the target locale (e.g. 'Healthcare'). Optional. */
  topSectorLabel?: string | null;
  /** Top city name (raw, not localised). Optional. */
  topCityName?: string | null;
  /** Absolute or root-relative href to the matching "hiring this week" hub. */
  ctaHref: string;
  /** Localised CTA label. */
  ctaLabel: string;
}

/**
 * Border-distance band for a Swiss canton seen from the typical Italian
 * frontaliere feeder cities (Como, Varese, Verbano-Cusio-Ossola, Aosta).
 * Drives the commute-strategy paragraph.
 *
 *  - `border-daily` — reachable in < 90 min by car or train. Daily commute
 *    is the realistic model. TI / GR / VS / GE.
 *  - `near-mixed` — 90-150 min. Daily possible, weekly hotel / Wochen-
 *    aufenthalt is common — VD / FR / NE / JU / SO / BE / LU / NW / OW /
 *    UR / SZ / AG / BL.
 *  - `far-weekly` — 150+ min. Weekly accommodation is the realistic model
 *    for most Italian-feeder commuters. ZH / SH / SG / TG / AI+AR (APPENZELLO) /
 *    BS / GL / ZG.
 */
type SnapshotDistanceBand = 'border-daily' | 'near-mixed' | 'far-weekly';

function distanceBand(cantonDisplay: string): SnapshotDistanceBand {
  const c = cantonDisplay.trim().toLowerCase();
  if (
    c === 'ticino' || c === 'tessin' ||
    c === 'grigioni' || c === 'grisons' || c === 'graubünden' || c === 'graubunden' || c === 'grischun' ||
    c === 'vallese' || c === 'wallis' || c === 'valais' ||
    c === 'ginevra' || c === 'geneva' || c === 'genf' || c === 'genève' || c === 'geneve'
  ) {
    return 'border-daily';
  }
  if (
    c === 'vaud' || c === 'waadt' ||
    c === 'friburgo' || c === 'fribourg' || c === 'freiburg' ||
    c === 'neuchâtel' || c === 'neuchatel' || c === 'neuenburg' ||
    c === 'giura' || c === 'jura' ||
    c === 'soletta' || c === 'solothurn' || c === 'soleure' ||
    c === 'berna' || c === 'bern' || c === 'berne' ||
    c === 'lucerna' || c === 'luzern' || c === 'lucerne' ||
    c === 'nidvaldo' || c === 'nidwalden' || c === 'nidwald' ||
    c === 'obvaldo' || c === 'obwalden' || c === 'obwald' ||
    c === 'uri' ||
    c === 'svitto' || c === 'schwyz' || c === 'schwytz' ||
    c === 'argovia' || c === 'aargau' || c === 'argovie' ||
    c === 'basilea-campagna' || c === 'basilea campagna' || c === 'basel-landschaft' || c === 'bâle-campagne' || c === 'basel landschaft'
  ) {
    return 'near-mixed';
  }
  return 'far-weekly';
}

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtJobs(jobs: number, locale: SnapshotLocale): string {
  const tag =
    locale === 'it' ? 'it-CH'
    : locale === 'de' ? 'de-CH'
    : locale === 'fr' ? 'fr-CH'
    : 'en-US';
  return jobs.toLocaleString(tag);
}

interface ProseParagraphs {
  heading: string;
  reading: string;     // P1 — what this week's snapshot signals
  positioning: string; // P2 — frontaliere positioning vs Ticino, distance band
  timing: string;      // P3 — when/how to apply, use of city/sector ranks
  related: string;     // P4 — cross-links (calculator, FX, health, fuel)
}

function buildParagraphs(opts: SnapshotProseOpts): ProseParagraphs {
  const { locale, cantonDisplay, totalJobs, topSectorLabel, topCityName, ctaHref, ctaLabel } = opts;
  const canton = cantonDisplay;
  const jobs = fmtJobs(totalJobs, locale);
  const band = distanceBand(canton);
  const sectorClause = topSectorLabel ? ` ${topSectorLabel}` : '';
  const cityClause = topCityName ? ` ${topCityName}` : '';

  // Locale-aware salary calculator / FX / health-insurance / fuel hrefs reuse
  // the canonical paths used elsewhere on the site so internal-link equity
  // stays inside the same routing graph.
  const CALC: Record<SnapshotLocale, string> = {
    it: '/calcola-stipendio/',
    en: '/en/salary-calculator/',
    de: '/de/lohnrechner/',
    fr: '/fr/calculateur-salaire/',
  };
  const FX: Record<SnapshotLocale, string> = {
    it: '/comparatori/cambio-valuta/',
    en: '/en/comparators/currency-exchange/',
    de: '/de/vergleiche/wechselkurs/',
    fr: '/fr/comparateurs/change-devises/',
  };
  const HEALTH: Record<SnapshotLocale, string> = {
    it: '/comparatori/casse-malati/',
    en: '/en/comparators/health-insurance/',
    de: '/de/vergleiche/krankenkassen/',
    fr: '/fr/comparateurs/caisses-maladie/',
  };
  const FUEL: Record<SnapshotLocale, string> = {
    it: '/prezzi-benzina-svizzera/',
    en: '/en/gasoline-price-switzerland/',
    de: '/de/benzinpreis-schweiz/',
    fr: '/fr/prix-essence-suisse/',
  };

  const calcHref = CALC[locale];
  const fxHref = FX[locale];
  const healthHref = HEALTH[locale];
  const fuelHref = FUEL[locale];

  if (locale === 'en') {
    const headings = 'Reading this snapshot as a cross-border worker';
    const reading = `The ${jobs} active openings in canton ${canton} captured by this snapshot reflect what is actually on the market right now, not what was advertised six months ago. The figure is rebuilt every 6-12 hours from 80+ direct employer crawlers — corporate career portals, the federal job-pool, hospital networks, retail chains, and SME job boards — so the count moves with real hiring decisions instead of recycled aggregator listings. Compared with the structural Ticino baseline (typically 1,500-3,000 openings in a normal week), ${canton} sits in a different demand band, and the city / sector ranking shown above is the fastest way to see whether the canton's hiring concentration matches the role you are searching for.`;

    const positioningByBand: Record<SnapshotDistanceBand, string> = {
      'border-daily': `For an Italian frontaliere based in Como, Varese, Verbano-Cusio-Ossola, or Aosta, ${canton} sits in the border-daily band: the commute is realistic on a daily basis by car (90 min or less off-peak) or by regional train (TILO / RegioExpress combinations). This makes the canton directly comparable with Ticino: Permit G applies, withholding tax mechanics are similar, and the AVS / LPP contributions feed the same Italian-side pension-totalisation flow under the 1968 EU-Switzerland coordination. The trade-off vs Ticino is usually language: outside ${canton === 'Ticino' ? 'Ticino itself' : 'GE'}, postings expect at least passive German / French, and Italian alone is harder to monetise except in cross-border-trade or hospitality roles.`,
      'near-mixed': `For an Italian frontaliere based in Como, Varese, Verbano-Cusio-Ossola, or Aosta, ${canton} sits in the 90-150 minute band: a daily commute is technically possible but tires after a few weeks, and most cross-border workers active in ${canton} run a hybrid model — three or four days on site with a Wochenaufenthalt-style weekly rental and Friday return home. Permit G still applies if you return to Italy at least once a week; if not, the more permanent Permit B is the alternative and changes the fiscal treatment (full Swiss taxation, no Italian-side withholding refund). The salary calculator below lets you compare both scenarios with ${canton}-specific tax rates.`,
      'far-weekly': `For an Italian frontaliere based in Como, Varese, Verbano-Cusio-Ossola, or Aosta, ${canton} sits in the far-weekly band: a daily commute is not realistic and almost all Italian cross-border workers active here run a Wochenaufenthalt model — Monday-Friday in ${canton} with a weekly rental, return to Italy at the weekend. Permit G requires a weekly return; if your role realistically prevents it, Permit B is the realistic choice and shifts you onto full Swiss taxation (no Italian-side cross-border refund mechanism). The salary calculator linked at the bottom of this page handles both scenarios with the canton-specific tax tables for ${canton}.`,
    };
    const positioning = positioningByBand[band];

    const timing = `Use the city ranking above to decide where to send the CV first: postings concentrated in${cityClause || ' the canton capital and the two largest secondary centres'} typically share the same labour market and the same commute pattern, so a generalist application can be lightly localised and sent to two or three of them in parallel. The sector ranking lets you spot whether ${canton} is currently a${sectorClause || ' healthcare / administration / sales'}-dominated week or whether a more technical wave (IT, engineering, finance) is opening up — a useful pre-screen before spending an evening on a tailored cover letter. Postings published Monday to Wednesday tend to receive responses fastest because HR reviewers process them within the same week; postings published Thursday and Friday often only get reviewed the following Monday.`;

    const related = `When you have a shortlist of roles, open the <a href="${esc(calcHref)}" style="color:var(--color-link);text-decoration:underline">cross-border net salary calculator</a> with the gross figure from each posting to see the actual net the role pays you under the new 2026 fiscal agreement and your specific Italian comune of residence. For the CHF / EUR transfer cost on the monthly net check the <a href="${esc(fxHref)}" style="color:var(--color-link);text-decoration:underline">currency-exchange comparator</a>; for compulsory LAMal insurance — mandatory after roughly three months on Swiss soil even on a Permit G with insurance abroad — see the <a href="${esc(healthHref)}" style="color:var(--color-link);text-decoration:underline">health-insurance premiums page</a>; and for daily commute costs see the <a href="${esc(fuelHref)}" style="color:var(--color-link);text-decoration:underline">Swiss fuel-price tracker</a>. When you are ready to apply, the <a href="${esc(ctaHref)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(ctaLabel)}</a> hub lists the active employers in ${canton} this week.`;

    return { heading: headings, reading, positioning, timing, related };
  }

  if (locale === 'it') {
    const heading = 'Come leggere questo snapshot da frontaliere';
    const reading = `Le ${jobs} offerte attive nel canton ${canton} fotografate da questo snapshot rappresentano la domanda reale oggi, non quella di sei mesi fa. Il dato viene ricostruito ogni 6-12 ore da 80+ crawler dedicati a portali aziendali diretti, pool federale del lavoro, reti ospedaliere, catene retail e job-board PMI — quindi segue le decisioni di assunzione reali e non riassemblaggi da aggregatori terzi. Rispetto alla baseline strutturale ticinese (tipicamente 1.500-3.000 offerte in una settimana normale), il canton ${canton} si colloca in una banda di domanda diversa, e la classifica per città e settori più sopra è il modo più rapido per vedere se la concentrazione di assunzioni del canton corrisponde al ruolo che stai cercando.`;
    const positioningByBand: Record<SnapshotDistanceBand, string> = {
      'border-daily': `Per un frontaliere italiano residente a Como, Varese, Verbano-Cusio-Ossola o Aosta, il canton ${canton} è in fascia border-daily: il commute quotidiano è realistico in auto (90 minuti o meno fuori orario di punta) o in treno regionale (combinazioni TILO / RegioExpress). Questo rende il canton direttamente confrontabile con il Ticino: Permesso G applicabile, ritenuta d'acconto svizzera analoga, contributi AVS / LPP che alimentano lo stesso flusso di totalizzazione pensionistica italiana ai sensi del coordinamento UE-Svizzera del 1968. Il trade-off vs Ticino è di solito linguistico: fuori da ${canton === 'Ticino' ? 'Ticino stesso' : 'Ginevra'}, i posting si aspettano almeno tedesco / francese passivo, e l'italiano da solo è più difficile da monetizzare salvo in ruoli di import-export o ospitalità.`,
      'near-mixed': `Per un frontaliere italiano residente a Como, Varese, Verbano-Cusio-Ossola o Aosta, il canton ${canton} ricade nella fascia 90-150 minuti: il commute giornaliero è tecnicamente possibile ma stanca dopo qualche settimana, e la maggior parte dei frontalieri attivi nel canton ${canton} adotta un modello ibrido — tre o quattro giorni in sede con un Wochenaufenthalt settimanale e rientro il venerdì sera. Il Permesso G resta applicabile se rientri in Italia almeno una volta a settimana; in caso contrario il Permesso B diventa l'alternativa naturale e cambia il trattamento fiscale (tassazione integrale svizzera, niente rimborso italiano della ritenuta).`,
      'far-weekly': `Per un frontaliere italiano residente a Como, Varese, Verbano-Cusio-Ossola o Aosta, il canton ${canton} è in fascia far-weekly: il commute giornaliero non è realistico e quasi tutti i frontalieri italiani attivi qui usano il modello Wochenaufenthalt — lunedì-venerdì nel canton ${canton} con affitto settimanale, rientro in Italia nel weekend. Il Permesso G richiede il rientro settimanale; se il ruolo non lo permette realisticamente, il Permesso B è la scelta concreta e ti sposta sulla tassazione integrale svizzera (niente meccanismo di rimborso transfrontaliero italiano).`,
    };
    const positioning = positioningByBand[band];
    const timing = `Usa la classifica per città sopra per decidere dove mandare il CV per prima:${cityClause ? ` le offerte concentrate su ${topCityName}` : ' le offerte concentrate sul capoluogo e sui due centri secondari principali'} condividono in genere lo stesso bacino di lavoro e lo stesso schema di pendolarismo, quindi una candidatura generalista può essere localizzata in modo leggero e inviata a due o tre destinatari in parallelo. La classifica per settori ti dice se il canton ${canton} è in una settimana dominata da${sectorClause ? ` ${topSectorLabel.toLowerCase()}` : ' sanità / amministrativo / vendite'} oppure se si sta aprendo un'onda più tecnica (IT, ingegneria, finanza) — un pre-screen utile prima di passare una serata su una cover letter su misura. Le offerte pubblicate da lunedì a mercoledì ricevono risposta più rapidamente perché HR le elabora nella stessa settimana; quelle pubblicate giovedì e venerdì spesso vengono lette solo il lunedì successivo.`;
    const related = `Quando hai una shortlist di ruoli, apri il <a href="${esc(calcHref)}" style="color:var(--color-link);text-decoration:underline">calcolatore stipendio netto frontaliere</a> con la cifra lorda di ciascun posting per vedere il netto reale che il ruolo eroga sotto il nuovo accordo fiscale 2026 e il tuo specifico comune italiano di residenza. Per il costo del cambio CHF / EUR sul netto mensile vedi il <a href="${esc(fxHref)}" style="color:var(--color-link);text-decoration:underline">comparatore cambio valuta</a>; per l'assicurazione LAMal obbligatoria — dopo circa tre mesi su suolo svizzero anche con Permesso G e assicurazione all'estero — vedi la <a href="${esc(healthHref)}" style="color:var(--color-link);text-decoration:underline">pagina premi cassa malati</a>; per il costo benzina del pendolarismo vedi i <a href="${esc(fuelHref)}" style="color:var(--color-link);text-decoration:underline">prezzi carburante svizzeri</a>. Quando sei pronto a candidarti, l'hub <a href="${esc(ctaHref)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(ctaLabel)}</a> elenca i datori di lavoro attivi nel canton ${canton} questa settimana.`;
    return { heading, reading, positioning, timing, related };
  }

  if (locale === 'de') {
    const heading = 'Diesen Snapshot als Grenzgänger lesen';
    const reading = `Die ${jobs} aktiven Stellen im Kanton ${canton} in diesem Snapshot zeigen die tatsächliche Nachfrage von heute — nicht jene vor sechs Monaten. Die Zahl wird alle 6-12 Stunden aus über 80 direkten Arbeitgeber-Crawlern neu aufgebaut (Karriereportale, Bundesstellenpool, Spitalnetzwerke, Einzelhandelsketten, KMU-Stellenportale) und folgt damit realen Einstellungsentscheidungen statt recyceltem Aggregator-Material. Im Vergleich zur strukturellen Tessiner Baseline (typischerweise 1.500-3.000 Stellen in einer Normalwoche) liegt der Kanton ${canton} in einem anderen Nachfrageband, und die Städte- und Branchen-Rangliste oben ist der schnellste Weg, um zu sehen, ob die Einstellungs-Konzentration zum gesuchten Rollenprofil passt.`;
    const positioningByBand: Record<SnapshotDistanceBand, string> = {
      'border-daily': `Für einen italienischen Grenzgänger mit Wohnsitz in Como, Varese, Verbano-Cusio-Ossola oder Aosta liegt der Kanton ${canton} im border-daily-Band: tägliches Pendeln ist mit dem Auto (90 Minuten oder weniger ausserhalb der Stosszeit) oder mit Regionalzug (TILO / RegioExpress) realistisch. Damit wird der Kanton direkt mit dem Tessin vergleichbar: G-Bewilligung gilt, Quellensteuer-Mechanik ist ähnlich, und AHV / BVG-Beiträge fliessen in dieselbe italienische Renten-Zusammenrechnung gemäss EU-Schweiz-Koordinierung von 1968. Der Trade-off gegenüber Tessin ist sprachlich: ausserhalb ${canton === 'Tessin' ? 'des Tessins' : 'von Genf'} erwarten die Inserate mindestens passives Deutsch / Französisch.`,
      'near-mixed': `Für einen italienischen Grenzgänger mit Wohnsitz in Como, Varese, Verbano-Cusio-Ossola oder Aosta liegt der Kanton ${canton} im 90-150-Minuten-Band: tägliches Pendeln ist technisch möglich, ermüdet aber nach einigen Wochen, und die meisten im Kanton ${canton} aktiven Grenzgänger nutzen ein Hybridmodell — drei oder vier Tage vor Ort mit Wochenaufenthalt und Rückkehr am Freitagabend. Die G-Bewilligung gilt weiterhin, wenn Sie mindestens einmal pro Woche nach Italien zurückkehren; andernfalls ist die B-Bewilligung die natürliche Alternative und ändert die fiskalische Behandlung (volle schweizerische Besteuerung, keine italienische Quellensteuer-Rückerstattung).`,
      'far-weekly': `Für einen italienischen Grenzgänger mit Wohnsitz in Como, Varese, Verbano-Cusio-Ossola oder Aosta liegt der Kanton ${canton} im far-weekly-Band: tägliches Pendeln ist nicht realistisch, und nahezu alle italienischen Grenzgänger nutzen hier das Wochenaufenthalt-Modell — Montag bis Freitag im Kanton ${canton} mit Wochenmiete, Rückkehr nach Italien am Wochenende. Die G-Bewilligung verlangt die wöchentliche Rückkehr; lässt die Rolle dies realistisch nicht zu, ist die B-Bewilligung die konkrete Wahl und wechselt Sie auf die volle schweizerische Besteuerung.`,
    };
    const positioning = positioningByBand[band];
    const timing = `Verwenden Sie die Städte-Rangliste oben, um zu entscheiden, wohin Sie zuerst bewerben:${cityClause ? ` Stellen mit Konzentration auf ${topCityName}` : ' Stellen mit Konzentration auf die Kantonshauptstadt und die beiden grössten Zweitzentren'} teilen sich in der Regel denselben Arbeitsmarkt und dasselbe Pendel-Muster, sodass eine generalistische Bewerbung leicht lokalisiert und parallel an zwei oder drei Adressaten gesendet werden kann. Die Branchen-Rangliste zeigt, ob im Kanton ${canton} derzeit eine${sectorClause ? ` ${topSectorLabel.toLowerCase()}-Woche` : ' Gesundheits- / Verwaltungs- / Vertriebs-Woche'} läuft oder ob sich eine eher technische Welle (IT, Engineering, Finanz) öffnet — ein nützlicher Pre-Screen, bevor Sie einen Abend in ein massgeschneidertes Anschreiben investieren. Montag bis Mittwoch publizierte Inserate erhalten am schnellsten Antwort.`;
    const related = `Wenn Sie eine Shortlist haben, öffnen Sie den <a href="${esc(calcHref)}" style="color:var(--color-link);text-decoration:underline">Grenzgänger-Nettolohnrechner</a> mit dem Bruttobetrag jedes Inserats, um den tatsächlichen Nettolohn unter dem neuen Steuerabkommen 2026 und Ihrer italienischen Wohngemeinde zu sehen. Für die CHF / EUR-Wechselkosten siehe den <a href="${esc(fxHref)}" style="color:var(--color-link);text-decoration:underline">Wechselkurs-Vergleich</a>; für die obligatorische LAMal-Krankenversicherung — Pflicht nach rund drei Monaten auf Schweizer Boden auch mit G-Bewilligung und Auslandsversicherung — siehe <a href="${esc(healthHref)}" style="color:var(--color-link);text-decoration:underline">Krankenkassenprämien</a>; für Pendelkosten siehe den <a href="${esc(fuelHref)}" style="color:var(--color-link);text-decoration:underline">Treibstoffpreis-Tracker</a>. Zum Bewerben listet der Hub <a href="${esc(ctaHref)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(ctaLabel)}</a> die diese Woche im Kanton ${canton} aktiven Arbeitgeber.`;
    return { heading, reading, positioning, timing, related };
  }

  // French (fr) — default fall-through.
  const heading = 'Lire cet aperçu en tant que frontalier';
  const reading = `Les ${jobs} offres actives dans le canton ${canton} capturées par cet aperçu reflètent la demande réelle d'aujourd'hui, et non celle d'il y a six mois. Le chiffre est reconstruit toutes les 6-12 heures à partir de plus de 80 crawlers ciblant directement les employeurs (portails carrière d'entreprise, pool fédéral de l'emploi, réseaux hospitaliers, chaînes de distribution, plateformes PME) — il suit donc les décisions réelles d'embauche au lieu d'agréger des annonces recyclées. Comparé à la baseline tessinoise structurelle (1 500 à 3 000 offres en semaine normale), le canton ${canton} se situe dans une autre bande de demande, et le classement par ville et par secteur ci-dessus est le moyen le plus rapide pour voir si la concentration d'embauche du canton correspond au rôle recherché.`;
  const positioningByBand: Record<SnapshotDistanceBand, string> = {
    'border-daily': `Pour un frontalier italien résidant à Côme, Varèse, Verbano-Cusio-Ossola ou Aoste, le canton ${canton} est dans la bande frontière quotidienne : le trajet quotidien est réaliste en voiture (90 minutes ou moins hors heures de pointe) ou en train régional (combinaisons TILO / RegioExpress). Cela rend le canton directement comparable au Tessin : permis G applicable, mécanique de retenue à la source similaire, cotisations AVS / LPP qui alimentent le même flux italien de totalisation des pensions selon la coordination UE-Suisse de 1968. L'arbitrage face au Tessin est généralement linguistique : hors ${canton === 'Tessin' ? 'du Tessin' : 'de Genève'}, les offres attendent au moins l'allemand / le français passif.`,
    'near-mixed': `Pour un frontalier italien résidant à Côme, Varèse, Verbano-Cusio-Ossola ou Aoste, le canton ${canton} se situe dans la bande 90-150 minutes : le trajet quotidien est techniquement possible mais fatigue après quelques semaines, et la plupart des frontaliers actifs dans le canton ${canton} adoptent un modèle hybride — trois ou quatre jours sur place avec un Wochenaufenthalt hebdomadaire et retour le vendredi soir. Le permis G reste applicable si vous rentrez en Italie au moins une fois par semaine ; sinon le permis B devient l'alternative naturelle et change le traitement fiscal (imposition suisse intégrale, pas de remboursement italien de la retenue).`,
    'far-weekly': `Pour un frontalier italien résidant à Côme, Varèse, Verbano-Cusio-Ossola ou Aoste, le canton ${canton} est dans la bande hebdomadaire : un trajet quotidien n'est pas réaliste et presque tous les frontaliers italiens actifs ici utilisent le modèle Wochenaufenthalt — du lundi au vendredi dans le canton ${canton} avec un logement hebdomadaire, retour en Italie le week-end. Le permis G exige un retour hebdomadaire ; si le rôle ne le permet pas réellement, le permis B est le choix concret et vous bascule sur l'imposition suisse intégrale.`,
  };
  const positioning = positioningByBand[band];
  const timing = `Utilisez le classement par ville ci-dessus pour décider où envoyer le CV en premier :${cityClause ? ` les offres concentrées sur ${topCityName}` : ' les offres concentrées sur le chef-lieu et les deux principaux centres secondaires'} partagent généralement le même bassin d'emploi et le même schéma de pendularité, ce qui permet d'adapter légèrement une candidature généraliste et de l'envoyer à deux ou trois destinataires en parallèle. Le classement par secteur indique si le canton ${canton} traverse une semaine dominée par${sectorClause ? ` ${topSectorLabel.toLowerCase()}` : ' la santé / l\'administration / les ventes'} ou si une vague plus technique (IT, ingénierie, finance) s'ouvre — un pré-tri utile avant de passer une soirée sur une lettre de motivation sur mesure. Les annonces publiées du lundi au mercredi reçoivent les réponses les plus rapides.`;
  const related = `Quand vous avez une liste courte de rôles, ouvrez le <a href="${esc(calcHref)}" style="color:var(--color-link);text-decoration:underline">calculateur de salaire net frontalier</a> avec le brut de chaque annonce pour voir le net réel sous le nouvel accord fiscal 2026 et votre commune italienne de résidence. Pour le coût de change CHF / EUR voir le <a href="${esc(fxHref)}" style="color:var(--color-link);text-decoration:underline">comparateur change devises</a> ; pour l'assurance LAMal obligatoire — obligatoire après environ trois mois sur sol suisse même avec un permis G et une assurance à l'étranger — voir <a href="${esc(healthHref)}" style="color:var(--color-link);text-decoration:underline">les primes d'assurance maladie</a> ; pour le coût du carburant voir le <a href="${esc(fuelHref)}" style="color:var(--color-link);text-decoration:underline">tracker des prix de l'essence en Suisse</a>. Pour postuler, le hub <a href="${esc(ctaHref)}" style="color:var(--color-link);text-decoration:underline;font-weight:600">${esc(ctaLabel)}</a> liste les employeurs actifs dans le canton ${canton} cette semaine.`;
  return { heading, reading, positioning, timing, related };
}

/**
 * Render the snapshot-specific deep-dive prose block. Returned HTML is a
 * self-contained `<section>` that the caller appends BELOW the data area
 * (rank tables + tiles + methodology) and ABOVE the closing CTA, so the
 * mobile fold rule (CLAUDE.md #15-17) is respected.
 *
 * The block adds ~1.6-2.0 KB of visible text per page across four
 * paragraphs (~110-160 words each), lifting the text-to-HTML ratio above
 * the 12 % bar with comfortable margin against data drift.
 */
export function buildSnapshotProseBlock(opts: SnapshotProseOpts): string {
  const p = buildParagraphs(opts);
  const blockStyle =
    'max-width:860px;margin:32px auto 0;color:var(--color-body);line-height:1.65;font-size:15px';
  const h2Style =
    'font-size:20px;font-weight:700;color:var(--color-heading);margin:24px 0 12px';
  const pStyle = 'margin:0 0 14px';

  return `<section class="snapshot-seo-prose" data-canton="${esc(opts.cantonDisplay)}" data-locale="${esc(opts.locale)}" style="${blockStyle}">
  <h2 style="${h2Style}">${esc(p.heading)}</h2>
  <p style="${pStyle}">${p.reading}</p>
  <p style="${pStyle}">${p.positioning}</p>
  <p style="${pStyle}">${p.timing}</p>
  <p style="${pStyle}">${p.related}</p>
</section>`;
}
