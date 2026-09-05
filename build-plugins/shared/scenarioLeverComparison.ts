/**
 * scenarioLeverComparison — the per-page unique element for the salary
 * calculator family (issue #7385, prima fetta di #7340).
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * Misurato con `npm run audit:information-gain` (metrica in
 * `docs/INFORMATION-GAIN.md`): le 22 coorti dei calcolatori di stipendio netto
 * (`/calcola-stipendio/`, `/gehalt-berechnen/`, `/calculate-salary/`,
 * `/calculer-salaire/`) stavano a **mediana IGS 0–4 %**, sotto il floor 5 % del
 * gate, ed erano la famiglia più grande dei 37 offender del 2026-09-01.
 *
 * La causa non è pigrizia editoriale: la pagina È una combinazione
 * RAL × figli × stato civile × regime frontaliero, quindi tutto ciò che la
 * distingue dalle sorelle è **numerico**, e la maschera n. 1 del motore
 * (`NUMERI → #`) lo azzera per costruzione — senza quella maschera la metrica
 * premierebbe il mail-merge. Dopo la maschera, di una coorte da 54 pagine
 * (3 combinazioni × 18 gradini di RAL) non restava **nessun segmento** che
 * appartenesse a questa pagina e non alle sorelle.
 *
 * COSA AGGIUNGE, E PERCHÉ NON È ALTRO TEMPLATE
 * ---------------------------------------------------------------------------
 * Stessa mossa di `nearestMunicipalityComparison.ts` per i comuni (#5002):
 * page-specific **per costruzione, non per scrittura**. Qui i "vicini" non sono
 * comuni ma le **combinazioni adiacenti** — un figlio in più, l'altro stato
 * civile, l'altro regime frontaliero, il gradino di RAL sopra e sotto — e la
 * prosa non ripete le cifre già mascherate: dice **quale leva pesa di più, in
 * che ordine, e di quante volte**. Ordine e rapporti sono un fatto calcolato
 * che cambia con la RAL e con la combinazione, quindi cambia in PAROLE lungo
 * l'asse su cui le sorelle si distinguevano solo in cifre. È anche la risposta
 * alla domanda che la pagina poneva e non risolveva: "cosa cambia se…".
 *
 * PERCHÉ NON BASTAVA UNA FRASE IN PIÙ CON DENTRO I NUMERI
 * ---------------------------------------------------------------------------
 * Qualunque frase la cui unica variazione siano le cifre collassa sulla stessa
 * forma mascherata delle sorelle e vale 0. Le fasce qualitative qui sotto
 * (`ratioBucket`, `retentionBucket`) sono grossolane di proposito: sono
 * categorie di prosa, non un modo di riscrivere un numero in lettere per
 * aggirare la maschera — un numero scritto in cifre resta in tabella e in
 * `distinctDataValues`, dove la metrica lo conta una volta sola.
 *
 * L'INTESTAZIONE È FISSA, E DEVE RESTARE FISSA
 * ---------------------------------------------------------------------------
 * La coorte è definita dallo scheletro delle intestazioni mascherate: un `h2`
 * che variasse per pagina frantumerebbe la famiglia in coorti da una pagina,
 * che il motore non punteggia — un IGS "risolto" facendo sparire la misura,
 * cioè esattamente ciò che AGENTS.md #1 vieta. Il titolo di sezione è uno
 * solo per locale.
 *
 * DETERMINISMO
 * ---------------------------------------------------------------------------
 * Gira dentro il build. Le leve sono derivate dalla combinazione con
 * `calculateSimulation` (la stessa funzione del calcolatore interattivo, così
 * la pagina non può divergere dallo strumento), l'ordinamento rompe ogni
 * pareggio sulla chiave della leva, e i risultati sono memoizzati per
 * combinazione: stesso input, stessi byte, ad ogni build.
 */

import { calculateSimulation } from '../../services/calculationService';
import {
  SALARY_LEVELS,
  scenarioToInputs,
  type SalaryHubScenario,
} from '../salaryHubScenarios';

export type LeverLocale = 'it' | 'en' | 'de' | 'fr';

/** Una leva = una dimensione cambiata, le altre quattro ferme. */
type LeverKey =
  | 'salaryUp'
  | 'salaryDown'
  | 'childMore'
  | 'childLess'
  | 'marital'
  | 'regime'
  | 'zone';

interface Lever {
  key: LeverKey;
  /** Etichetta già localizzata, dipendente dalla combinazione di partenza. */
  label: string;
  /** Δ del netto annuo del frontaliere italiano, in CHF (con segno). */
  deltaCHF: number;
}

const scenarioKey = (s: SalaryHubScenario): string =>
  `${s.salary}|${s.frontierType}|${s.maritalStatus}|${s.children}|${s.distanceZone}`;

/**
 * Netto annuo (residente in Italia) di una combinazione, memoizzato.
 *
 * Ogni pagina interroga fino a sei combinazioni vicine e ogni combinazione è
 * vicina di più pagine: senza memo il build rifarebbe ~2.500 simulazioni per
 * locale. La chiave è la combinazione, non l'oggetto, così la cache è condivisa
 * fra i quattro locali (la simulazione non dipende dalla lingua).
 */
const netCache = new Map<string, number>();

function netItalianResident(scenario: SalaryHubScenario): number {
  const key = scenarioKey(scenario);
  const cached = netCache.get(key);
  if (cached !== undefined) return cached;
  const net = calculateSimulation(scenarioToInputs(scenario)).itResident.netIncomeAnnual;
  netCache.set(key, net);
  return net;
}

/** Il gradino di RAL adiacente, o null ai due estremi della scala. */
function salaryStep(salary: number, direction: 1 | -1): number | null {
  const idx = SALARY_LEVELS.indexOf(salary as (typeof SALARY_LEVELS)[number]);
  if (idx < 0) return null;
  const next = SALARY_LEVELS[idx + direction];
  return next ?? null;
}

// ── Copy ──────────────────────────────────────────────────────────────────

interface LeverCopy {
  heading: string;
  /** Ordine di peso delle leve. `list` è già una enumerazione localizzata. */
  ranking: (list: string) => string;
  /** Rapporto fra la leva più pesante e la seconda. */
  ratio: (top: string, second: string, bucket: string) => string;
  /**
   * Rapporto fra il gradino di RAL e la leva non salariale più pesante: è il
   * confronto che si muove più in fretta lungo la scala, quindi quello che
   * distingue una pagina dalla stessa combinazione a RAL diversa.
   */
  stepVsOther: (step: string, other: string, bucket: string) => string;
  /** Le leve che a questa RAL pesano più di un gradino di stipendio. */
  heavierThanStep: (list: string) => string;
  /** Nessuna leva batte il gradino di stipendio. */
  heavierThanStepNone: string;
  /** La coppia di leve che a questa RAL si equivalgono di più. */
  closestPair: (first: string, second: string) => string;
  /** La leva che pesa meno della combinazione. */
  weakest: (label: string, bucket: string) => string;
  /** Quanto resta netto di un franco lordo in più, salendo di un gradino. */
  retention: (bucket: string) => string;
  /** Nessun gradino sopra: la pagina è in cima alla scala. */
  retentionTop: string;
  /** Posizione della combinazione fra tutte quelle della stessa RAL. */
  rank: (ordinal: string, total: string) => string;
  /**
   * Posizione di questa RAL fra i gradini della scala, per quota di lordo che
   * resta netta: la trattenuta non è proporzionale, quindi l'ordine non è
   * quello delle RAL.
   */
  ladderRank: (ordinal: string, total: string) => string;
  /** Verdetto residenza: conviene ancora la residenza italiana? */
  residency: (bucket: string) => string;
  ratioBuckets: readonly string[];
  retentionBuckets: readonly string[];
  weakestBuckets: readonly string[];
  residencyBuckets: readonly string[];
  ordinals: readonly string[];
  /** Congiunzione finale dell'enumerazione ("a, b e c"). */
  and: string;
  labels: {
    salaryUp: string;
    salaryDown: string;
    childMore: string;
    childLess: string;
    toMarried: string;
    toSingle: string;
    toOldFrontier: string;
    toNewFrontier: string;
    toOver20: string;
    toWithin20: string;
  };
}

/**
 * Le fasce sono ordinate dalla più stretta alla più larga e lette con lo stesso
 * indice in tutti i locali: `ratioBucket()` sceglie l'indice una volta sola, poi
 * ogni lingua legge la propria voce. Un locale con un numero diverso di fasce
 * darebbe prosa diversa a parità di dato, ed è il tipo di deriva che una
 * tabella per lingua non fa notare.
 */
const RATIO_EDGES = [1.15, 1.4, 1.75, 2.25, 2.75, 3.5, 5, 8] as const;
const RETENTION_EDGES = [0.3, 0.45, 0.55, 0.65, 0.75, 0.85] as const;
/** Peso della leva più debole sul netto annuo. */
const WEAKEST_EDGES = [0.002, 0.005, 0.01, 0.02, 0.04] as const;
/** Differenza fra netto da residente CH e da frontaliere, sul netto CH. */
const RESIDENCY_EDGES = [-0.06, -0.02, 0.02, 0.06, 0.12] as const;

function bucketIndex(value: number, edges: readonly number[]): number {
  for (let i = 0; i < edges.length; i += 1) {
    if (value < edges[i]) return i;
  }
  return edges.length;
}

const COPY: Record<LeverLocale, LeverCopy> = {
  it: {
    heading: 'Quale leva sposta di più questo netto',
    ranking: (list) =>
      `Su questa combinazione le leve che spostano di più il netto sono, in ordine di peso: ${list}.`,
    ratio: (top, second, bucket) =>
      `In cifre proprie di questa RAL, ${top} pesa ${bucket} ${second}.`,
    stepVsOther: (step, other, bucket) =>
      `Il confronto che si muove più in fretta salendo la scala delle RAL è quello fra queste due leve: ${step} e ${other}. A questo livello la prima pesa ${bucket} la seconda.`,
    heavierThanStep: (list) =>
      `A questa RAL pesano più di un gradino di stipendio queste leve: ${list}.`,
    heavierThanStepNone:
      'A questa RAL nessun’altra leva sposta il netto quanto un gradino di stipendio.',
    closestPair: (first, second) =>
      `Le due leve che qui si equivalgono di più sono ${first} e ${second}.`,
    weakest: (label, bucket) =>
      `La leva che conta meno qui è ${label}: sul netto annuo di questa combinazione sposta ${bucket}.`,
    retention: (bucket) =>
      `Salendo al gradino di RAL successivo, di ogni franco lordo in più resta netta ${bucket} su questa combinazione.`,
    retentionTop:
      'Questa è la RAL più alta della scala pubblicata: sopra non c\'è un gradino con cui confrontare il netto marginale.',
    rank: (ordinal, total) =>
      `Fra le ${total} combinazioni calcolate alla stessa RAL, questa è ${ordinal} per netto in Italia.`,
    ladderRank: (ordinal, total) =>
      `Fra le ${total} RAL pubblicate per questa combinazione, questa è ${ordinal} per quota di lordo che resta netta.`,
    residency: (bucket) => `In questa combinazione, rispetto al trasferimento in Svizzera, ${bucket}.`,
    ratioBuckets: [
      'quasi esattamente quanto pesa',
      'poco più di quanto pesa',
      'una volta e mezza quanto pesa',
      'il doppio di quanto pesa',
      'due volte e mezza quanto pesa',
      'il triplo di quanto pesa',
      'quattro volte quanto pesa',
      'sei volte quanto pesa',
      'oltre otto volte quanto pesa',
    ],
    retentionBuckets: [
      'meno di un terzo',
      'poco più di un terzo',
      'circa la metà',
      'poco più della metà',
      'quasi tre quarti',
      'circa quattro quinti',
      'quasi tutto',
    ],
    weakestBuckets: [
      'una frazione trascurabile',
      'una frazione appena leggibile in busta paga',
      'poco meno di un punto percentuale',
      'un paio di punti percentuali',
      'qualche punto percentuale',
      'una fetta a due cifre percentuali',
    ],
    residencyBuckets: [
      'la residenza svizzera resta nettamente più conveniente',
      'la residenza svizzera resta un po\' più conveniente',
      'le due residenze si equivalgono quasi',
      'restare frontaliere è un po\' più conveniente',
      'restare frontaliere è nettamente più conveniente',
      'restare frontaliere è la scelta di gran lunga più conveniente',
    ],
    ordinals: [
      'la prima', 'la seconda', 'la terza', 'la quarta', 'la quinta', 'la sesta',
      'la settima', 'l\'ottava', 'la nona', 'la decima', 'l\'undicesima', 'la dodicesima',
      'la tredicesima', 'la quattordicesima', 'la quindicesima', 'la sedicesima',
      'la diciassettesima', 'la diciottesima', 'la diciannovesima', 'la ventesima',
      'la ventunesima', 'la ventiduesima', 'la ventitreesima', 'la ventiquattresima',
    ],
    and: 'e',
    labels: {
      salaryUp: 'il gradino di RAL successivo',
      salaryDown: 'il gradino di RAL precedente',
      childMore: 'un figlio a carico in più',
      childLess: 'un figlio a carico in meno',
      toMarried: 'il matrimonio con coniuge non lavoratore',
      toSingle: 'il ritorno alla posizione di single',
      toOldFrontier: 'il passaggio al regime di vecchio frontaliere',
      toNewFrontier: 'il passaggio al regime di nuovo frontaliere',
      toOver20: 'lo spostamento della residenza oltre i 20 km dal confine',
      toWithin20: 'lo spostamento della residenza entro i 20 km dal confine',
    },
  },
  en: {
    heading: 'Which lever moves this net pay the most',
    ranking: (list) =>
      `On this combination the levers that move the net pay the most are, by weight: ${list}.`,
    ratio: (top, second, bucket) =>
      `In figures specific to this gross salary, ${top} weighs ${bucket} ${second}.`,
    stepVsOther: (step, other, bucket) =>
      `The comparison that moves fastest along the gross-salary ladder is the one between these two levers: ${step} and ${other}. At this level the first weighs ${bucket} the second.`,
    heavierThanStep: (list) =>
      `At this gross salary the following levers weigh more than one salary step: ${list}.`,
    heavierThanStepNone:
      'At this gross salary no other lever moves the net pay as much as one salary step does.',
    closestPair: (first, second) =>
      `The two levers that come closest to each other here are ${first} and ${second}.`,
    weakest: (label, bucket) =>
      `The lever that matters least here is ${label}: on this combination's annual net it moves ${bucket}.`,
    retention: (bucket) =>
      `Moving up to the next gross salary step, ${bucket} of every extra gross franc stays net on this combination.`,
    retentionTop:
      'This is the highest gross salary on the published ladder: there is no step above it to compare the marginal net with.',
    rank: (ordinal, total) =>
      `Among the ${total} combinations computed at the same gross salary, this one ranks ${ordinal} by net pay in Italy.`,
    ladderRank: (ordinal, total) =>
      `Among the ${total} gross salaries published for this combination, this one ranks ${ordinal} by the share of gross that stays net.`,
    residency: (bucket) => `Compared with moving to Switzerland, on this combination ${bucket}.`,
    ratioBuckets: [
      'almost exactly as much as',
      'slightly more than',
      'one and a half times',
      'twice as much as',
      'two and a half times',
      'three times as much as',
      'four times as much as',
      'six times as much as',
      'more than eight times as much as',
    ],
    retentionBuckets: [
      'less than a third',
      'barely more than a third',
      'about half',
      'slightly more than half',
      'nearly three quarters',
      'about four fifths',
      'almost all',
    ],
    weakestBuckets: [
      'a negligible fraction',
      'a fraction barely visible on the payslip',
      'just under one percentage point',
      'a couple of percentage points',
      'a few percentage points',
      'a double-digit percentage slice',
    ],
    residencyBuckets: [
      'Swiss residency stays clearly more convenient',
      'Swiss residency stays slightly more convenient',
      'the two residencies are almost equivalent',
      'staying a cross-border commuter is slightly more convenient',
      'staying a cross-border commuter is clearly more convenient',
      'staying a cross-border commuter is by far the more convenient choice',
    ],
    ordinals: [
      'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
      'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
      'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
      'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth',
    ],
    and: 'and',
    labels: {
      salaryUp: 'the next gross salary step',
      salaryDown: 'the previous gross salary step',
      childMore: 'one more dependent child',
      childLess: 'one fewer dependent child',
      toMarried: 'marriage to a non-working spouse',
      toSingle: 'going back to single status',
      toOldFrontier: 'switching to the old cross-border regime',
      toNewFrontier: 'switching to the new cross-border regime',
      toOver20: 'moving the residence beyond 20 km from the border',
      toWithin20: 'moving the residence within 20 km of the border',
    },
  },
  de: {
    heading: 'Welcher Hebel dieses Nettoeinkommen am stärksten bewegt',
    ranking: (list) =>
      `Bei dieser Kombination bewegen die folgenden Hebel das Netto am stärksten, nach Gewicht geordnet: ${list}.`,
    ratio: (top, second, bucket) =>
      `In den Zahlen dieses Bruttolohns wiegt ${top} ${bucket} ${second}.`,
    stepVsOther: (step, other, bucket) =>
      `Entlang der Bruttolohnleiter verschiebt sich am schnellsten der Vergleich zwischen diesen beiden Hebeln: ${step} und ${other}. Auf dieser Stufe wiegt der erste ${bucket} der zweite.`,
    heavierThanStep: (list) =>
      `Bei diesem Bruttolohn wiegen die folgenden Hebel mehr als eine Lohnstufe: ${list}.`,
    heavierThanStepNone:
      'Bei diesem Bruttolohn bewegt kein anderer Hebel das Netto so stark wie eine Lohnstufe.',
    closestPair: (first, second) =>
      `Die beiden Hebel, die sich hier am nächsten kommen, sind ${first} und ${second}.`,
    weakest: (label, bucket) =>
      `Am wenigsten zählt hier ${label}: am Jahresnetto dieser Kombination bewegt es ${bucket}.`,
    retention: (bucket) =>
      `Beim Sprung auf die nächste Bruttostufe bleibt von jedem zusätzlichen Bruttofranken bei dieser Kombination ${bucket} netto übrig.`,
    retentionTop:
      'Dies ist der höchste Bruttolohn der veröffentlichten Leiter: darüber gibt es keine Stufe, mit der sich das Grenznetto vergleichen liesse.',
    rank: (ordinal, total) =>
      `Unter den ${total} bei gleichem Bruttolohn berechneten Kombinationen steht diese an ${ordinal} Stelle beim Netto in Italien.`,
    ladderRank: (ordinal, total) =>
      `Unter den ${total} für diese Kombination veröffentlichten Bruttolöhnen steht dieser an ${ordinal} Stelle beim Anteil des Bruttos, der netto bleibt.`,
    residency: (bucket) => `Verglichen mit einem Umzug in die Schweiz ${bucket}.`,
    ratioBuckets: [
      'fast genau so viel wie',
      'etwas mehr als',
      'anderthalbmal so viel wie',
      'doppelt so viel wie',
      'zweieinhalbmal so viel wie',
      'dreimal so viel wie',
      'viermal so viel wie',
      'sechsmal so viel wie',
      'mehr als achtmal so viel wie',
    ],
    retentionBuckets: [
      'weniger als ein Drittel',
      'knapp mehr als ein Drittel',
      'etwa die Hälfte',
      'etwas mehr als die Hälfte',
      'fast drei Viertel',
      'etwa vier Fünftel',
      'fast alles',
    ],
    weakestBuckets: [
      'einen vernachlässigbaren Bruchteil',
      'einen auf der Lohnabrechnung kaum sichtbaren Bruchteil',
      'knapp unter einem Prozentpunkt',
      'ein paar Prozentpunkte',
      'einige Prozentpunkte',
      'einen zweistelligen Prozentanteil',
    ],
    residencyBuckets: [
      'bleibt der Wohnsitz in der Schweiz deutlich vorteilhafter',
      'bleibt der Wohnsitz in der Schweiz etwas vorteilhafter',
      'sind beide Wohnsitze nahezu gleichwertig',
      'ist der Grenzgängerstatus etwas vorteilhafter',
      'ist der Grenzgängerstatus deutlich vorteilhafter',
      'ist der Grenzgängerstatus mit Abstand die vorteilhaftere Wahl',
    ],
    ordinals: [
      'erster', 'zweiter', 'dritter', 'vierter', 'fünfter', 'sechster', 'siebter',
      'achter', 'neunter', 'zehnter', 'elfter', 'zwölfter', 'dreizehnter',
      'vierzehnter', 'fünfzehnter', 'sechzehnter', 'siebzehnter', 'achtzehnter',
      'neunzehnter', 'zwanzigster', 'einundzwanzigster', 'zweiundzwanzigster',
      'dreiundzwanzigster', 'vierundzwanzigster',
    ],
    and: 'und',
    labels: {
      salaryUp: 'die nächsthöhere Bruttostufe',
      salaryDown: 'die nächsttiefere Bruttostufe',
      childMore: 'ein zusätzliches unterhaltsberechtigtes Kind',
      childLess: 'ein unterhaltsberechtigtes Kind weniger',
      toMarried: 'die Heirat mit nicht erwerbstätigem Ehepartner',
      toSingle: 'die Rückkehr zum Ledigenstatus',
      toOldFrontier: 'der Wechsel zum alten Grenzgängerregime',
      toNewFrontier: 'der Wechsel zum neuen Grenzgängerregime',
      toOver20: 'die Verlegung des Wohnsitzes über 20 km von der Grenze hinaus',
      toWithin20: 'die Verlegung des Wohnsitzes auf unter 20 km zur Grenze',
    },
  },
  fr: {
    heading: 'Quel levier déplace le plus ce salaire net',
    ranking: (list) =>
      `Sur cette combinaison, les leviers qui déplacent le plus le net sont, par ordre de poids : ${list}.`,
    ratio: (top, second, bucket) =>
      `En chiffres propres à ce salaire brut, ${top} pèse ${bucket} ${second}.`,
    stepVsOther: (step, other, bucket) =>
      `La comparaison qui bouge le plus vite le long de l'échelle des bruts est celle entre ces deux leviers : ${step} et ${other}. À ce niveau, le premier pèse ${bucket} le second.`,
    heavierThanStep: (list) =>
      `À ce niveau de brut, les leviers qui pèsent plus qu'un palier de salaire sont : ${list}.`,
    heavierThanStepNone:
      "À ce niveau de brut, aucun autre levier ne déplace le net autant qu'un palier de salaire.",
    closestPair: (first, second) =>
      `Les deux leviers qui se valent le plus ici sont ${first} et ${second}.`,
    weakest: (label, bucket) =>
      `Le levier qui compte le moins ici est ${label} : sur le net annuel de cette combinaison, il déplace ${bucket}.`,
    retention: (bucket) =>
      `En montant au palier de brut suivant, ${bucket} de chaque franc brut supplémentaire reste net sur cette combinaison.`,
    retentionTop:
      'C\'est le salaire brut le plus élevé de l\'échelle publiée : il n\'y a pas de palier au-dessus pour comparer le net marginal.',
    rank: (ordinal, total) =>
      `Parmi les ${total} combinaisons calculées au même brut, celle-ci arrive ${ordinal} pour le net en Italie.`,
    ladderRank: (ordinal, total) =>
      `Parmi les ${total} salaires bruts publiés pour cette combinaison, celui-ci arrive ${ordinal} pour la part du brut qui reste nette.`,
    residency: (bucket) => `Par rapport à un déménagement en Suisse, sur cette combinaison ${bucket}.`,
    ratioBuckets: [
      'presque exactement autant que',
      'un peu plus que',
      'une fois et demie',
      'deux fois',
      'deux fois et demie',
      'trois fois',
      'quatre fois',
      'six fois',
      'plus de huit fois',
    ],
    retentionBuckets: [
      'moins d\'un tiers',
      'à peine plus d\'un tiers',
      'environ la moitié',
      'un peu plus de la moitié',
      'près des trois quarts',
      'environ quatre cinquièmes',
      'presque tout',
    ],
    weakestBuckets: [
      'une fraction négligeable',
      'une fraction à peine lisible sur la fiche de paie',
      'un peu moins d\'un point de pourcentage',
      'deux points de pourcentage environ',
      'quelques points de pourcentage',
      'une part à deux chiffres en pourcentage',
    ],
    residencyBuckets: [
      'la résidence suisse reste nettement plus avantageuse',
      'la résidence suisse reste un peu plus avantageuse',
      'les deux résidences se valent presque',
      'rester frontalier est un peu plus avantageux',
      'rester frontalier est nettement plus avantageux',
      'rester frontalier est de loin le choix le plus avantageux',
    ],
    ordinals: [
      'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième',
      'septième', 'huitième', 'neuvième', 'dixième', 'onzième', 'douzième',
      'treizième', 'quatorzième', 'quinzième', 'seizième', 'dix-septième',
      'dix-huitième', 'dix-neuvième', 'vingtième', 'vingt-et-unième',
      'vingt-deuxième', 'vingt-troisième', 'vingt-quatrième',
    ],
    and: 'et',
    labels: {
      salaryUp: 'le palier de brut supérieur',
      salaryDown: 'le palier de brut inférieur',
      childMore: 'un enfant à charge de plus',
      childLess: 'un enfant à charge de moins',
      toMarried: 'le mariage avec un conjoint sans activité',
      toSingle: 'le retour au statut de célibataire',
      toOldFrontier: 'le passage à l\'ancien régime frontalier',
      toNewFrontier: 'le passage au nouveau régime frontalier',
      toOver20: 'le déplacement de la résidence au-delà de 20 km de la frontière',
      toWithin20: 'le rapprochement de la résidence à moins de 20 km de la frontière',
    },
  },
};

// ── Leve ──────────────────────────────────────────────────────────────────

/**
 * Le combinazioni vicine: una sola dimensione cambiata per volta.
 *
 * Il regime frontaliero e la zona di distanza non sono indipendenti — il
 * vecchio frontaliere non esiste oltre i 20 km (stessa potatura di
 * `generateAllScenarios`). Una leva che cambiasse due dimensioni insieme non
 * sarebbe più "quanto pesa questa cosa", quindi in quel caso la leva
 * semplicemente non c'è: meglio una leva in meno che un confronto che misura
 * due cose.
 */
function buildLevers(scenario: SalaryHubScenario, copy: LeverCopy): Lever[] {
  const base = netItalianResident(scenario);
  const levers: Lever[] = [];
  const add = (key: LeverKey, label: string, variant: SalaryHubScenario): void => {
    levers.push({ key, label, deltaCHF: netItalianResident(variant) - base });
  };

  const up = salaryStep(scenario.salary, 1);
  if (up !== null) add('salaryUp', copy.labels.salaryUp, { ...scenario, salary: up });
  const down = salaryStep(scenario.salary, -1);
  if (down !== null) add('salaryDown', copy.labels.salaryDown, { ...scenario, salary: down });

  if (scenario.children < 3)
    add('childMore', copy.labels.childMore, { ...scenario, children: scenario.children + 1 });
  if (scenario.children > 0)
    add('childLess', copy.labels.childLess, { ...scenario, children: scenario.children - 1 });

  add(
    'marital',
    scenario.maritalStatus === 'MARRIED' ? copy.labels.toSingle : copy.labels.toMarried,
    {
      ...scenario,
      maritalStatus: scenario.maritalStatus === 'MARRIED' ? 'SINGLE' : 'MARRIED',
    },
  );

  if (scenario.distanceZone === 'WITHIN_20KM')
    add(
      'regime',
      scenario.frontierType === 'OLD' ? copy.labels.toNewFrontier : copy.labels.toOldFrontier,
      { ...scenario, frontierType: scenario.frontierType === 'OLD' ? 'NEW' : 'OLD' },
    );

  if (scenario.frontierType === 'NEW')
    add(
      'zone',
      scenario.distanceZone === 'OVER_20KM' ? copy.labels.toWithin20 : copy.labels.toOver20,
      {
        ...scenario,
        distanceZone: scenario.distanceZone === 'OVER_20KM' ? 'WITHIN_20KM' : 'OVER_20KM',
      },
    );

  // Peso decrescente, pareggi rotti sulla chiave: nessuna dipendenza
  // dall'ordine di inserimento, quindi nessun churn di byte fra build.
  return levers.sort(
    (a, b) => Math.abs(b.deltaCHF) - Math.abs(a.deltaCHF) || (a.key < b.key ? -1 : 1),
  );
}

/** Enumerazione localizzata: "a, b e c". */
function joinList(items: string[], and: string): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface LeverComparisonInput {
  scenario: SalaryHubScenario;
  /** Tutte le combinazioni emesse, per posizionare questa alla stessa RAL. */
  allScenarios: readonly SalaryHubScenario[];
  /** Netto annuo del residente CH, per il verdetto sulla residenza. */
  chResidentNetAnnual: number;
  /** Netto annuo del frontaliere, già calcolato dalla pagina. */
  itResidentNetAnnual: number;
  locale: LeverLocale;
}

/**
 * Le frasi del blocco, in ordine di resa. Esportata separatamente dall'HTML
 * perché il test della metrica misura la prosa, non il markup.
 */
export function scenarioLeverSentences(input: LeverComparisonInput): string[] {
  const copy = COPY[input.locale];
  const { scenario } = input;
  const levers = buildLevers(scenario, copy);
  const sentences: string[] = [];
  if (levers.length === 0) return sentences;

  sentences.push(copy.ranking(joinList(levers.map((x) => x.label), copy.and)));

  if (levers.length >= 2) {
    const [top, second] = levers;
    const secondMagnitude = Math.abs(second.deltaCHF);
    // Un secondo Δ nullo renderebbe il rapporto infinito: in quel caso la
    // frase del rapporto non ha nulla da dire e si tace, invece di stampare
    // una fascia inventata.
    if (secondMagnitude > 0) {
      const ratio = Math.abs(top.deltaCHF) / secondMagnitude;
      sentences.push(
        copy.ratio(
          top.label,
          second.label,
          copy.ratioBuckets[bucketIndex(ratio, RATIO_EDGES)],
        ),
      );
    }
  }

  // Il gradino di RAL cresce con la RAL, le leve familiari e di regime no: il
  // loro rapporto è la grandezza che cambia più in fretta lungo i 18 gradini,
  // cioè l'asse su cui le sorelle di una stessa combinazione si distinguevano
  // finora solo in cifre.
  const step = levers.find((x) => x.key === 'salaryUp') ?? levers.find((x) => x.key === 'salaryDown');
  const other = levers.find((x) => x.key !== 'salaryUp' && x.key !== 'salaryDown');
  if (step && other && Math.abs(other.deltaCHF) > 0) {
    const ratio = Math.abs(step.deltaCHF) / Math.abs(other.deltaCHF);
    sentences.push(
      copy.stepVsOther(step.label, other.label, copy.ratioBuckets[bucketIndex(ratio, RATIO_EDGES)]),
    );
  }

  // Quali leve battono un gradino di stipendio: l'insieme cambia con la RAL
  // (a 40 000 CHF un figlio vale più di 5 000 CHF di lordo, a 150 000 no), ed è
  // la domanda che il lettore del calcolatore si pone davvero.
  const stepMagnitude = Math.max(
    ...levers
      .filter((x) => x.key === 'salaryUp' || x.key === 'salaryDown')
      .map((x) => Math.abs(x.deltaCHF)),
    0,
  );
  const heavier = levers.filter(
    (x) => x.key !== 'salaryUp' && x.key !== 'salaryDown' && Math.abs(x.deltaCHF) > stepMagnitude,
  );
  sentences.push(
    heavier.length > 0
      ? copy.heavierThanStep(joinList(heavier.map((x) => x.label), copy.and))
      : copy.heavierThanStepNone,
  );

  // La coppia adiacente più vicina in peso: con l'ordine che cambia lungo la
  // scala, cambia anche quale coppia si equivale, e con essa le parole.
  if (levers.length >= 2) {
    let closest = 0;
    let closestGap = Infinity;
    for (let i = 0; i + 1 < levers.length; i += 1) {
      const gap = Math.abs(Math.abs(levers[i].deltaCHF) - Math.abs(levers[i + 1].deltaCHF));
      if (gap < closestGap) {
        closestGap = gap;
        closest = i;
      }
    }
    sentences.push(copy.closestPair(levers[closest].label, levers[closest + 1].label));
  }

  const weakest = levers[levers.length - 1];
  if (input.itResidentNetAnnual > 0) {
    const share = Math.abs(weakest.deltaCHF) / input.itResidentNetAnnual;
    sentences.push(
      copy.weakest(weakest.label, copy.weakestBuckets[bucketIndex(share, WEAKEST_EDGES)]),
    );
  }

  const up = levers.find((x) => x.key === 'salaryUp');
  const nextSalary = salaryStep(scenario.salary, 1);
  if (up && nextSalary !== null) {
    const retention = up.deltaCHF / (nextSalary - scenario.salary);
    sentences.push(copy.retention(copy.retentionBuckets[bucketIndex(retention, RETENTION_EDGES)]));
  } else {
    sentences.push(copy.retentionTop);
  }

  // Dove sta questa RAL sulla scala per quota di lordo che resta netta. La
  // trattenuta cresce con il reddito ma non in modo regolare (soglie IRPEF,
  // franchigia, tabella alla fonte), quindi l'ordine NON è quello delle RAL e
  // la frase dice qualcosa che il lettore non ricava dal titolo.
  const ladder = SALARY_LEVELS.map((salary) => {
    const variant = { ...scenario, salary };
    return { key: scenarioKey(variant), share: netItalianResident(variant) / salary };
  }).sort((a, b) => b.share - a.share || (a.key < b.key ? -1 : 1));
  const ladderPosition = ladder.findIndex((x) => x.key === scenarioKey(scenario));
  if (ladderPosition >= 0 && ladderPosition < copy.ordinals.length) {
    sentences.push(copy.ladderRank(copy.ordinals[ladderPosition], String(ladder.length)));
  }

  const sameSalary = input.allScenarios
    .filter((s) => s.salary === scenario.salary)
    .map((s) => ({ key: scenarioKey(s), net: netItalianResident(s) }))
    .sort((a, b) => b.net - a.net || (a.key < b.key ? -1 : 1));
  const position = sameSalary.findIndex((s) => s.key === scenarioKey(scenario));
  if (position >= 0 && position < copy.ordinals.length) {
    sentences.push(copy.rank(copy.ordinals[position], String(sameSalary.length)));
  }

  if (input.chResidentNetAnnual > 0) {
    const edge =
      (input.itResidentNetAnnual - input.chResidentNetAnnual) / input.chResidentNetAnnual;
    sentences.push(copy.residency(copy.residencyBuckets[bucketIndex(edge, RESIDENCY_EDGES)]));
  }

  return sentences;
}

/**
 * Il blocco HTML. `h2` fisso per locale (vedi l'intestazione del modulo), una
 * frase per `<li>` così che il motore della metrica veda un segmento per frase
 * — unisce sui confini di elemento, quindi un unico `<p>` conterebbe come un
 * segmento solo e una frase page-specific in mezzo a cinque generiche varrebbe
 * zero.
 */
export function renderScenarioLeverComparison(input: LeverComparisonInput): string {
  const copy = COPY[input.locale];
  const sentences = scenarioLeverSentences(input);
  if (sentences.length === 0) return '';
  const items = sentences.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  return `<h2>${escapeHtml(copy.heading)}</h2><ul class="scenario-levers">${items}</ul>`;
}
