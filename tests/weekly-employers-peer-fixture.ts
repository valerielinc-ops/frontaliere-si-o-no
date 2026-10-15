/**
 * Un corpus deterministico di pagine `aziende-che-assumono` — 7 città × 6
 * settimane — per misurare l'Information Gain della famiglia PRE-merge
 * (issue #7595).
 *
 * PERCHÉ UNA FIXTURE E NON `data/jobs.json`
 * ---------------------------------------------------------------------------
 * La misura va rifatta a ogni run e deve dare lo STESSO numero, altrimenti la
 * soglia del test lampeggia su una churn del dataset settimanale invece che su
 * una regressione del codice. `jobs.json` è un file rigenerato: cambia sotto i
 * piedi del test ogni volta che il crawler gira, e nella CI `tests` non è
 * nemmeno detto che ci sia. La fixture qui sotto riproduce le proprietà che
 * contano per la metrica — quante offerte per città, quali datori di lavoro,
 * quali ruoli, e che le tre cose cambino da città a città e da settimana a
 * settimana — e le riproduce identiche a ogni esecuzione.
 *
 * Le pagine passano comunque per `buildCityWeeklyStats` e
 * `renderWeeklyEmployersPage`, cioè per l'aggregazione e il renderer VERI: è
 * l'input a essere sintetico, non il codice sotto misura.
 */
import {
  buildCityWeeklyStats,
  renderWeeklyEmployersPage,
  type WeeklyCountableJob,
} from '@/build-plugins/weeklyEmployersPlugin';
import {
  WEEKLY_EMPLOYERS_CITIES,
  buildArchiveWeekPath,
  type WeeklyEmployersCity,
} from '@/build-plugins/weeklyEmployersData';

/** Datori di lavoro, uno per posizione nel giro: la fetta ruota per città. */
const EMPLOYERS = [
  'Alptronic', 'Bruni Logistica', 'Casagrande Impianti', 'Delta Pharma',
  'Elvetica Servizi', 'Fontana Costruzioni', 'Gottardo Meccanica', 'Helvetia Care',
  'Insubria Food', 'Jelmoli Retail', 'Kursaal Hospitality', 'Lario Chimica',
  'Monte Ceneri Trasporti', 'Novara Precision', 'Olivone Energia', 'Piora Automazione',
  'Quadrio Consulting', 'Riviera Tessile', 'Sopraceneri Metalli', 'Tresa Elettronica',
  'Uccelli Assicurazioni', 'Verzasca Digital', 'Wiesendanger AG', 'Zurighese Banca',
];

const ROLES = [
  'Operaio di produzione', 'Impiegato commerciale', 'Magazziniere', 'Infermiere',
  'Addetto vendita', 'Tecnico manutentore', 'Contabile', 'Autista C/E',
  'Cuoco', 'Sviluppatore software', 'Fresatore CNC', 'Addetto qualità',
];

/**
 * Descrizione lunga abbastanza da superare la soglia di 50 parole di
 * `jobIsActive` in tutti e quattro i locali. È volutamente identica su ogni
 * offerta: non è la descrizione a dover differenziare le pagine — la pagina non
 * la pubblica — ed è la stessa scorciatoia che il plugin usa per gli archivi.
 */
const DESCRIPTION = [
  'Posizione aperta presso un datore di lavoro attivo nel Canton Ticino, aperta anche',
  'a candidati frontalieri con permesso G. Il contratto segue il Codice delle',
  'obbligazioni svizzero e, dove applicabile, il contratto collettivo di settore. Sono',
  'richieste esperienza nel ruolo, conoscenza della lingua italiana e disponibilità a',
  'lavorare su turni. La retribuzione viene indicata in lordo annuo e il netto reale',
  'dipende dal regime fiscale del lavoratore. La selezione prevede un colloquio con',
  'le risorse umane e un secondo colloquio tecnico con il responsabile di reparto.',
].join(' ');

/** Numero di offerte per (città, settimana): deterministico e mai piatto. */
function jobCount(cityIndex: number, weekNum: number): number {
  return 4 + ((cityIndex * 7 + weekNum * 3) % 19);
}

/** Le offerte "attive" di una settimana, su tutte le città. */
export function weeklyJobsFixture(weekNum: number): WeeklyCountableJob[] {
  const jobs: WeeklyCountableJob[] = [];
  const cities = WEEKLY_EMPLOYERS_CITIES.filter((c) => c !== 'ticino');
  cities.forEach((city, cityIndex) => {
    const count = jobCount(cityIndex, weekNum);
    for (let i = 0; i < count; i++) {
      // La fetta di datori ruota su città e settimana: due città della stessa
      // settimana non hanno la stessa classifica di aziende, ed è questo che le
      // pagine reali mostrano.
      const employer = EMPLOYERS[(cityIndex * 5 + weekNum * 2 + Math.floor(i / 2)) % EMPLOYERS.length];
      const role = ROLES[(cityIndex * 3 + i) % ROLES.length];
      jobs.push({
        slug: `fixture-${city}-${weekNum}-${i}`,
        title: role,
        company: employer,
        companyKey: employer.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        location: city,
        addressLocality: city,
        postedDate: `2026-0${1 + (weekNum % 9)}-15`,
        description: DESCRIPTION,
      } as WeeklyCountableJob);
    }
  });
  return jobs;
}

export const FIXTURE_WEEKS = [30, 31, 32, 33, 34, 35];
const FIXTURE_YEAR = 2026;

/**
 * Il corpus renderizzato. `withPeerComparison: false` rende le stesse pagine
 * SENZA il blocco del confronto: è la misura "prima" citata nella issue, e
 * tenerla nel codice è ciò che rende la soglia verificabile invece che
 * asserita.
 */
export function renderWeeklyEmployersCorpus(
  opts: { withPeerComparison?: boolean } = {},
): Array<{ urlPath: string; html: string }> {
  const withPeer = opts.withPeerComparison !== false;
  const pages: Array<{ urlPath: string; html: string }> = [];
  const today = new Date('2026-09-05T00:00:00Z');

  for (const weekNum of FIXTURE_WEEKS) {
    const jobs = weeklyJobsFixture(weekNum);
    const statsByCity = new Map(
      WEEKLY_EMPLOYERS_CITIES.map((city) => [
        city,
        buildCityWeeklyStats({ city, locale: 'it', jobs }),
      ]),
    );
    const peerCities = WEEKLY_EMPLOYERS_CITIES.map((city) => ({
      city,
      activeJobsCount: statsByCity.get(city)!.activeJobsCount,
    }));

    for (const city of WEEKLY_EMPLOYERS_CITIES as readonly WeeklyEmployersCity[]) {
      const canonicalPath = buildArchiveWeekPath('it', city, weekNum, FIXTURE_YEAR);
      pages.push({
        urlPath: canonicalPath,
        html: renderWeeklyEmployersPage({
          locale: 'it',
          city,
          variant: 'archive',
          weekNum,
          year: FIXTURE_YEAR,
          stats: statsByCity.get(city)!,
          hasHistoricalDelta: false,
          canonicalPath,
          today,
          indexable: true,
          availableArchives: FIXTURE_WEEKS.map((w) => ({ weekNum: w, year: FIXTURE_YEAR })),
          ...(withPeer ? { peerCities } : {}),
        }),
      });
    }
  }
  return pages;
}
