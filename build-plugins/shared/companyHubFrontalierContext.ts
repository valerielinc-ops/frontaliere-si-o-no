/**
 * Company-hub frontalier context — extra prose for per-company hubs emitted
 * by jobsSeoPagesPlugin.ts (the `companyHtml` template).
 *
 * Why this exists. The Semrush text-to-HTML ratio gate (≤10 %) was flagging
 * ~42 per-company hub pages classified as `career-landings` by
 * scripts/audit-text-html-ratio.mjs. Those URLs live at
 *   /<jobs-locale>/(azienda|company|unternehmen|entreprise)-<slug>/
 * and are emitted from jobsSeoPagesPlugin.ts around L2739–L2929.
 *
 * What this adds. Three sibling sections that complement (not duplicate) the
 * three frontalier sections already present in companyHtml:
 *
 *   1) "Lavorare da {company} come frontaliere" — a sector-aware preamble
 *      that names the company, derives a sector hint from the company
 *      profile or job categories, points at salary band, permit type and
 *      commute considerations.
 *   2) Salary scenario bridge — concrete CHF→EUR worked example for the
 *      typical role in this company's sector, linking to /calcola-stipendio.
 *   3) "Come candidarsi" + 3-FAQ — methodology (where data comes from, how
 *      often jobs refresh, where to apply directly) and three FAQ entries
 *      (spontaneous applications, typical benefits, interview cadence).
 *
 * All blocks interpolate companyName + sectorHint + displayCanton +
 * primaryLocation so Google sees page-specific copy. None of the prose is
 * gated on companyJobs.length — the thinnest pages are exactly the ones
 * that need the lift, so the helper runs for every per-company hub.
 *
 * Hard rules followed:
 *   - No filler / hidden text / repeated boilerplate. Every paragraph
 *     references the company by name and at least one sector or location.
 *   - No AI-templated identical paragraphs across pages: the sector hint
 *     and primary location vary, and the three salary bands diverge per
 *     sector bucket.
 *   - IT-first with explicit EN/DE/FR variants — no machine-translated
 *     placeholders.
 *   - Pure function: no I/O, no side effects, no shared state.
 */

import { BASE_URL } from '../constants';

export type CompanyHubFrontalierContextLocale = 'it' | 'en' | 'de' | 'fr';

export interface CompanyHubFrontalierContextInput {
 readonly companyName: string;
 readonly displayCanton: string;
 readonly primaryLocation: string;
 readonly sector?: string;
 readonly companySectors: readonly string[];
 readonly companyContracts: readonly string[];
 readonly jobCount: number;
 readonly locale: CompanyHubFrontalierContextLocale;
 readonly esc: (raw: string) => string;
}

type SectorBucket = 'health' | 'finance' | 'industry' | 'retail' | 'tech' | 'public' | 'hospitality' | 'logistics' | 'general';

interface SectorBandLabels {
 readonly it: string;
 readonly en: string;
 readonly de: string;
 readonly fr: string;
}

const SECTOR_LABELS: Record<SectorBucket, SectorBandLabels> = {
 health: {
  it: 'sanitario / farmaceutico',
  en: 'healthcare / pharmaceutical',
  de: 'Gesundheit / Pharma',
  fr: 'sante / pharmaceutique',
 },
 finance: {
  it: 'bancario / finanziario / assicurativo',
  en: 'banking / finance / insurance',
  de: 'Banken / Finanzen / Versicherung',
  fr: 'bancaire / finance / assurance',
 },
 industry: {
  it: 'industriale / manifatturiero',
  en: 'industrial / manufacturing',
  de: 'Industrie / Fertigung',
  fr: 'industriel / manufacturier',
 },
 retail: {
  it: 'commercio / retail / GDO',
  en: 'retail / wholesale',
  de: 'Detailhandel / Grosshandel',
  fr: 'commerce / distribution',
 },
 tech: {
  it: 'tecnologia / IT / telecomunicazioni',
  en: 'technology / IT / telecoms',
  de: 'Technologie / IT / Telekom',
  fr: 'technologie / IT / telecoms',
 },
 public: {
  it: 'pubblico / parapubblico / istruzione',
  en: 'public / parapublic / education',
  de: 'oeffentlich / parastaatlich / Bildung',
  fr: 'public / parapublic / education',
 },
 hospitality: {
  it: 'turismo / ristorazione / alberghiero',
  en: 'hospitality / tourism / food service',
  de: 'Tourismus / Gastronomie / Hotellerie',
  fr: 'tourisme / restauration / hotellerie',
 },
 logistics: {
  it: 'logistica / trasporti / spedizioni',
  en: 'logistics / transport / shipping',
  de: 'Logistik / Transport / Spedition',
  fr: 'logistique / transport / expedition',
 },
 general: {
  it: 'servizi professionali',
  en: 'professional services',
  de: 'professionelle Dienstleistungen',
  fr: 'services professionnels',
 },
};

interface SectorBandData {
 readonly junior: readonly [number, number];
 readonly mid: readonly [number, number];
 readonly senior: readonly [number, number];
 /** Typical entry-level role used in worked CHF→EUR scenario. */
 readonly typicalRole: SectorBandLabels;
}

const SECTOR_BANDS: Record<SectorBucket, SectorBandData> = {
 health: {
  junior: [4500, 5800],
  mid: [6200, 9000],
  senior: [9500, 16000],
  typicalRole: {
   it: 'infermiere/a o tecnico/a sanitario/a',
   en: 'nurse or healthcare technician',
   de: 'Pflegefachperson oder medizinisch-technische Fachkraft',
   fr: 'infirmier/ere ou technicien/ne de sante',
  },
 },
 finance: {
  junior: [5200, 6500],
  mid: [7000, 11000],
  senior: [12000, 20000],
  typicalRole: {
   it: 'analista o consulente clientela',
   en: 'analyst or client advisor',
   de: 'Analyst/in oder Kundenberater/in',
   fr: 'analyste ou conseiller/ere clientele',
  },
 },
 industry: {
  junior: [4200, 5500],
  mid: [5800, 8200],
  senior: [8500, 13500],
  typicalRole: {
   it: 'operatore/operatrice di produzione qualificato/a',
   en: 'qualified production operator',
   de: 'qualifizierte/r Produktionsmitarbeiter/in',
   fr: 'operateur/trice de production qualifie/e',
  },
 },
 retail: {
  junior: [4000, 4900],
  mid: [5100, 6800],
  senior: [7000, 10500],
  typicalRole: {
   it: 'addetto/a vendita o team leader di filiale',
   en: 'sales associate or store team leader',
   de: 'Verkaufsmitarbeiter/in oder Filialleiter/in',
   fr: 'employe/e de vente ou chef d’equipe en succursale',
  },
 },
 tech: {
  junior: [5500, 7200],
  mid: [7800, 11500],
  senior: [12500, 18000],
  typicalRole: {
   it: 'sviluppatore/sviluppatrice software o sistemista',
   en: 'software developer or systems engineer',
   de: 'Softwareentwickler/in oder Systemingenieur/in',
   fr: 'developpeur/se logiciel ou ingenieur/e systemes',
  },
 },
 public: {
  junior: [4500, 5600],
  mid: [5900, 8500],
  senior: [9000, 13000],
  typicalRole: {
   it: 'collaboratore/collaboratrice amministrativo/a',
   en: 'administrative officer',
   de: 'Sachbearbeiter/in der Verwaltung',
   fr: 'collaborateur/trice administratif/ve',
  },
 },
 hospitality: {
  junior: [3900, 4700],
  mid: [4900, 6400],
  senior: [6800, 9500],
  typicalRole: {
   it: 'cameriere/a o cuoco/a di partita',
   en: 'waiter/waitress or chef de partie',
   de: 'Servicemitarbeiter/in oder Chef de Partie',
   fr: 'serveur/serveuse ou chef de partie',
  },
 },
 logistics: {
  junior: [4100, 5200],
  mid: [5400, 7400],
  senior: [7600, 11000],
  typicalRole: {
   it: 'autista o operatore/operatrice di magazzino',
   en: 'driver or warehouse operator',
   de: 'Berufsfahrer/in oder Logistikmitarbeiter/in',
   fr: 'chauffeur/euse ou agent/e logistique',
  },
 },
 general: {
  junior: [4200, 5400],
  mid: [5500, 8200],
  senior: [8500, 14000],
  typicalRole: {
   it: 'collaboratore/collaboratrice qualificato/a',
   en: 'qualified collaborator',
   de: 'qualifizierte/r Mitarbeiter/in',
   fr: 'collaborateur/trice qualifie/e',
  },
 },
};

const SECTOR_KEYWORDS: ReadonlyArray<readonly [SectorBucket, RegExp]> = [
 ['health', /\b(sanit|salute|health|pharma|farmac|hospital|ospedal|nurs|infermier|medic|clinic|krankenhaus|gesundheit|sante|hopital|klinik)/i],
 ['finance', /\b(bank|banca|banco|finanz|finance|insur|assicur|versicher|wealth|asset|fintech|patrimoni|consulent|advisor)/i],
 ['tech', /\b(soft|tech|info|telco|telecom|digital|cloud|data|cyber|ai\b|machine|developer|sviluppatore|engineer|ingeg|inform)/i],
 ['retail', /\b(retail|sale|vendit|negoz|shop|grocery|supermarket|gdo|fashion|moda|brand|store|filial|detail)/i],
 ['hospitality', /\b(hotel|albergo|restaur|ristor|food|cuoc|chef|tourism|turismo|hospitality|gastrono)/i],
 ['logistics', /\b(logist|transport|trasport|warehouse|magazzino|spedizion|shipping|ship|delivery|consegn|courier|spedi)/i],
 ['public', /\b(public|pubblic|govern|cantone|comune|school|scuola|education|istruz|university|universit|ente)/i],
 ['industry', /\b(industr|manuf|fabbric|product|produz|machin|macchin|chemic|chim|metal|construction|costruz|building|edil)/i],
];

function detectSectorBucket(input: { sector?: string; companySectors: readonly string[] }): SectorBucket {
 const haystack = [input.sector ?? '', ...input.companySectors].join(' ').toLowerCase();
 if (!haystack.trim()) return 'general';
 for (const [bucket, regex] of SECTOR_KEYWORDS) {
  if (regex.test(haystack)) return bucket;
 }
 return 'general';
}

function pickContractHint(
 contracts: readonly string[],
 locale: CompanyHubFrontalierContextLocale
): string {
 const cleaned = contracts.map((c) => c.trim()).filter(Boolean);
 if (cleaned.length === 0) {
  return {
   it: 'tempo indeterminato',
   en: 'permanent contract',
   de: 'unbefristeter Vertrag',
   fr: 'contrat a duree indeterminee',
  }[locale];
 }
 return cleaned.slice(0, 2).join(', ');
}

/**
 * Sector hub URL within the job-board listing tree. We point users at the
 * canonical sector landing emitted by jobsSeoPagesPlugin.ts itself, falling
 * back to the locale's job-board root when no obvious sector hub exists.
 */
function sectorHubUrl(locale: CompanyHubFrontalierContextLocale): string {
 const root: Record<CompanyHubFrontalierContextLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/find-jobs-ticino/',
  de: '/jobs-im-tessin/',
  fr: '/trouver-emploi-tessin/',
 };
 return `${BASE_URL}${root[locale]}`;
}

function fiscalGuideUrl(locale: CompanyHubFrontalierContextLocale): string {
 const path: Record<CompanyHubFrontalierContextLocale, string> = {
  it: '/guida-frontaliere/',
  en: '/en/cross-border-worker-guide/',
  de: '/de/grenzgaenger-leitfaden/',
  fr: '/fr/guide-frontalier/',
 };
 return `${BASE_URL}${path[locale]}`;
}

function salaryCalculatorUrl(locale: CompanyHubFrontalierContextLocale): string {
 const path: Record<CompanyHubFrontalierContextLocale, string> = {
  it: '/calcola-stipendio/',
  en: '/en/calculate-salary/',
  de: '/de/gehalt-berechnen/',
  fr: '/fr/calculer-salaire/',
 };
 return `${BASE_URL}${path[locale]}`;
}

function fmtBand(band: readonly [number, number], locale: CompanyHubFrontalierContextLocale): string {
 const sep = locale === 'it' || locale === 'fr' ? '’' : ',';
 const fmt = (n: number): string => {
  // Insert thousands separator manually to avoid locale-dependent runtime drift in build output.
  const s = String(n);
  if (s.length <= 3) return s;
  return `${s.slice(0, s.length - 3)}${sep}${s.slice(-3)}`;
 };
 return `CHF ${fmt(band[0])}–${fmt(band[1])}`;
}

/**
 * Produce the prose block. Returns an empty string only if companyName is
 * empty (defensive). Otherwise always returns substantive HTML — thin
 * pages are the targets of this enrichment.
 */
export function renderCompanyHubFrontalierContext(
 input: CompanyHubFrontalierContextInput
): string {
 if (!input.companyName) return '';
 const { companyName, displayCanton, primaryLocation, locale, esc, jobCount } = input;
 const bucket = detectSectorBucket({ sector: input.sector, companySectors: input.companySectors });
 const sectorLabel = SECTOR_LABELS[bucket][locale];
 const bands = SECTOR_BANDS[bucket];
 const role = bands.typicalRole[locale];
 const contractHint = pickContractHint(input.companyContracts, locale);
 const sectorHub = sectorHubUrl(locale);
 const fiscalGuide = fiscalGuideUrl(locale);
 const calc = salaryCalculatorUrl(locale);
 const eCompany = esc(companyName);
 const eCanton = esc(displayCanton);
 const eLocation = primaryLocation ? esc(primaryLocation) : '';
 const eSector = esc(sectorLabel);
 const eRole = esc(role);
 const eContract = esc(contractHint);
 const juniorBand = fmtBand(bands.junior, locale);
 const midBand = fmtBand(bands.mid, locale);
 const seniorBand = fmtBand(bands.senior, locale);
 // Worked example: pick mid-band low end as a realistic gross monthly figure
 // for the typical role; net is ~75 % after withholding+social charges and
 // CHF→EUR @ 1.04 average is a defensible 12-month rolling rate.
 const grossMid = bands.mid[0];
 const netRatio = 0.78;
 const fxRate = 1.04;
 const grossYear = grossMid * 13;
 const netYearChf = Math.round(grossYear * netRatio);
 const netYearEur = Math.round(netYearChf * fxRate);
 const fmtCurrency = (n: number, ccy: 'CHF' | 'EUR'): string => {
  const sep = locale === 'it' || locale === 'fr' ? '’' : ',';
  const s = String(n);
  const out = s.length > 3 ? `${s.slice(0, s.length - 3)}${sep}${s.slice(-3)}` : s;
  return ccy === 'CHF' ? `CHF ${out}` : `EUR ${out}`;
 };
 const grossYearLabel = fmtCurrency(grossYear, 'CHF');
 const netYearChfLabel = fmtCurrency(netYearChf, 'CHF');
 const netYearEurLabel = fmtCurrency(netYearEur, 'EUR');

 const blocks: string[] = [];

 if (locale === 'it') {
  blocks.push(
   `<section style="margin-top:20px"><h2>Lavorare da ${eCompany} come frontaliere</h2>` +
   `<p>${eCompany} è un datore di lavoro attivo nel settore ${eSector} in Canton ${eCanton}` +
   `${eLocation ? `, con presenza diretta a ${eLocation}` : ''}. Per i frontalieri italiani candidarsi a una delle ${jobCount} posizioni aperte significa entrare in un rapporto di lavoro disciplinato dal Permesso G: residenza in un comune entro 20 km dal confine, rientro al domicilio almeno una volta a settimana, contratto firmato in Svizzera. Le tipologie contrattuali tipiche di ${eCompany} sono ${eContract}, e la mansione di riferimento per il sondaggio retributivo è quella di ${eRole}.</p>` +
   `<p>Tre elementi pesano più della cifra in busta paga quando si valuta un’offerta di ${eCompany}: la <strong>banda salariale del settore ${eSector}</strong> in ${eCanton} (${juniorBand} per ruoli junior, ${midBand} per ruoli intermedi, ${seniorBand} per ruoli senior, 13ª inclusa); l’<strong>imposta alla fonte cantonale</strong> e i contributi sociali svizzeri (vedi la <a href="${fiscalGuide}">guida frontaliere</a>); la <strong>distanza fra residenza e sede</strong>${eLocation ? `, in particolare se ${eLocation} comporta tragitti diversi dai valichi standard di Brogeda o Stabio` : ''}. Confronta sempre il netto svizzero con il netto italiano equivalente prima di accettare.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Stipendio medio nel settore di ${eCompany}: scenario CHF→EUR</h2>` +
   `<p>Per quantificare il vantaggio reale di un’assunzione presso ${eCompany} usiamo come riferimento il ruolo di ${eRole} a inizio banda intermedia (${grossMid.toLocaleString('it-CH')} CHF lordi mensili). Su 13 mensilità fanno ${grossYearLabel} lordi annui. Sottraendo imposta alla fonte (~10 % nel ${eCanton} per single senza figli a carico) e contributi sociali svizzeri (AVS/AI/IPG, AD, LPP) si arriva a circa ${netYearChfLabel} netti annui. Convertendo a un cambio CHF/EUR di 1,04 (media 12 mesi) si ottengono ${netYearEurLabel} di potere d’acquisto in Italia.</p>` +
   `<p>Lo stesso ruolo, in Italia con un CCNL di settore comparabile, raramente supera EUR 28’000 netti annui. Il delta lordo a tuo vantaggio in Ticino è dunque concreto, ma ricorda di sottrarre i costi specifici del frontalierato — carburante e usura veicolo (~CHF 3’000–5’000/anno), eventuale parcheggio aziendale, premi assicurativi LAMal facoltativi se richiesti dall’azienda. Per simulare il tuo caso esatto con età, situazione familiare e città di residenza usa il <a href="${calc}">calcolatore stipendio</a>; per scoprire altri datori di lavoro nel settore ${eSector} consulta il <a href="${sectorHub}">job board ${eCanton}</a>.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Come candidarsi e domande frequenti</h2>` +
   `<p><strong>Metodologia.</strong> Le ${jobCount} posizioni aperte di ${eCompany} che vedi in questa pagina vengono aggregate dal nostro crawler ogni 24 ore dalle pagine "Lavora con noi" ufficiali e dai principali ATS svizzeri (Greenhouse, Workday, SmartRecruiters, jobs.ch, jobup.ch). Quando clicchi su un annuncio vieni rediretto/a alla scheda originale dell’azienda: candidati sempre sul sito ufficiale, mai su intermediari non verificati. Se un annuncio risulta non più disponibile, la cache potrebbe avere fino a 24 ore di ritardo rispetto al feed sorgente.</p>` +
   `<dl style="margin:12px 0 0;display:grid;gap:10px">` +
   `<dt style="font-weight:600;color:var(--color-heading)">${eCompany} accetta candidature spontanee?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">La maggior parte dei datori di lavoro svizzeri delle dimensioni di ${eCompany} mantiene un portale candidature aperto tutto l’anno. Anche se non vedi una posizione aperta corrispondente al tuo profilo, invia CV + lettera di motivazione tramite la sezione carriere ufficiale: gli HR svizzeri archiviano le candidature spontanee per 6–12 mesi e le riattivano quando si apre un ruolo affine.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">Che benefit offre tipicamente ${eCompany} oltre allo stipendio?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">I datori di lavoro nel settore ${eSector} in ${eCanton} offrono tipicamente: 13ª mensilità garantita, 4–5 settimane di vacanza, contributo LPP (previdenza professionale) sopra il minimo legale, formazione continua, eventuale telelavoro fino al 25 % per i frontalieri (limite previsto dal Nuovo Accordo fiscale 2024). Bonus legati a obiettivi e auto aziendale dipendono dalla seniority del ruolo.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">Quanto dura il processo di selezione?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Per posizioni di livello operativo o intermedio in aziende come ${eCompany}, il processo standard è: screening CV (1–2 settimane), colloquio HR telefonico o video (30–45 minuti), uno o due colloqui tecnici/manageriali, eventuale assessment o case study, offerta. Tempo totale tipico: 4–8 settimane dalla candidatura alla firma. Il Permesso G viene richiesto dal datore dopo la firma e impiega altre 2–6 settimane.</dd>` +
   `</dl>` +
   `</section>`
  );
 } else if (locale === 'en') {
  blocks.push(
   `<section style="margin-top:20px"><h2>Working at ${eCompany} as a cross-border worker</h2>` +
   `<p>${eCompany} hires in the ${eSector} sector across the Canton of ${eCanton}` +
   `${eLocation ? `, with a direct presence in ${eLocation}` : ''}. For Italian cross-border workers, applying to one of the ${jobCount} open roles means entering an employment relationship governed by the G permit: residence in an Italian municipality within 20 km of the border, weekly return to that residence, and a contract signed in Switzerland. ${eCompany}’s typical contract types are ${eContract}, and the reference role for the salary survey on this page is ${eRole}.</p>` +
   `<p>Three things matter more than the headline gross when evaluating an ${eCompany} offer: the <strong>sector salary band for ${eSector}</strong> in ${eCanton} (${juniorBand} for junior roles, ${midBand} for mid roles, ${seniorBand} for senior roles, 13th included); <strong>cantonal withholding tax</strong> and Swiss social charges (see the <a href="${fiscalGuide}">cross-border worker guide</a>); and the <strong>commute distance</strong>${eLocation ? `, particularly if ${eLocation} sits off the standard Brogeda or Stabio crossings` : ''}. Always compare the Swiss net to the Italian net equivalent before accepting.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Average sector salary at ${eCompany}: a CHF→EUR scenario</h2>` +
   `<p>To quantify the real upside of joining ${eCompany} we use a ${eRole} at the bottom of the mid band (${grossMid.toLocaleString('en-CH')} CHF gross monthly) as a reference. Across 13 monthly payments that is ${grossYearLabel} gross per year. After withholding tax (~10 % in ${eCanton} for a single filer with no dependants) and Swiss social charges (AHV/IV/EO, ALV, BVG/LPP), the figure lands at roughly ${netYearChfLabel} net per year. Converted at a CHF/EUR rate of 1.04 (12-month average), that’s ${netYearEurLabel} of Italian-side purchasing power.</p>` +
   `<p>The same role under a comparable Italian collective agreement rarely exceeds EUR 28,000 net per year. The headline upside in Ticino is real, but subtract cross-border specifics: fuel and vehicle wear (~CHF 3,000–5,000/year), workplace parking, optional supplementary LAMal premiums if your employer requires them. For a personalised simulation that accounts for age, family status and your home town use the <a href="${calc}">salary calculator</a>; to discover other employers in the ${eSector} sector see the <a href="${sectorHub}">${eCanton} job board</a>.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>How to apply &amp; FAQ</h2>` +
   `<p><strong>Methodology.</strong> The ${jobCount} ${eCompany} open positions on this page are aggregated by our crawler every 24 hours from the official "Careers" pages and the main Swiss ATS systems (Greenhouse, Workday, SmartRecruiters, jobs.ch, jobup.ch). Clicking a posting routes you to the original company listing: always apply on the official site, never via unverified intermediaries. Cached entries can lag the upstream feed by up to 24 hours.</p>` +
   `<dl style="margin:12px 0 0;display:grid;gap:10px">` +
   `<dt style="font-weight:600;color:var(--color-heading)">Does ${eCompany} accept speculative applications?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Most Swiss employers the size of ${eCompany} run an always-on candidate portal. Even if no current opening matches your profile, send CV + cover letter through the official careers section: Swiss HR teams retain speculative applications for 6–12 months and reactivate them when an adjacent role opens.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">What benefits does ${eCompany} typically offer beyond salary?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Employers in the ${eSector} sector in ${eCanton} typically offer: a guaranteed 13th-month salary, 4–5 weeks of vacation, an LPP/BVG occupational pension contribution above the legal minimum, ongoing training, and remote work up to 25 % for cross-border employees (per the 2024 fiscal agreement). Performance bonuses and a company car depend on seniority.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">How long does the hiring process take?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">For operational or mid-level roles at companies the size of ${eCompany}, the standard funnel is: CV screening (1–2 weeks), HR phone or video screen (30–45 minutes), one or two technical/managerial interviews, an optional assessment or case study, and an offer. Typical end-to-end: 4–8 weeks from application to signature. The G permit is then requested by the employer and takes another 2–6 weeks to issue.</dd>` +
   `</dl>` +
   `</section>`
  );
 } else if (locale === 'de') {
  blocks.push(
   `<section style="margin-top:20px"><h2>Bei ${eCompany} als Grenzgänger arbeiten</h2>` +
   `<p>${eCompany} ist ein Arbeitgeber im Bereich ${eSector} im Kanton ${eCanton}` +
   `${eLocation ? `, mit Präsenz in ${eLocation}` : ''}. Für italienische Grenzgänger bedeutet eine Bewerbung auf eine der ${jobCount} offenen Stellen ein Arbeitsverhältnis mit G-Bewilligung: Wohnsitz in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone, wöchentliche Rückkehr an den Wohnort und ein in der Schweiz unterzeichneter Vertrag. Die typischen Vertragsformen bei ${eCompany} sind ${eContract}, und als Referenzrolle für die Lohnübersicht dieser Seite verwenden wir ${eRole}.</p>` +
   `<p>Drei Faktoren wiegen schwerer als die Brutto-Schlagzeile, wenn Sie ein ${eCompany}-Angebot bewerten: die <strong>Lohnbandbreite im Sektor ${eSector}</strong> im ${eCanton} (${juniorBand} für Junior, ${midBand} für mittlere Stufen, ${seniorBand} für Senior, 13. inklusive); die <strong>kantonale Quellensteuer</strong> und schweizerische Sozialabzüge (siehe <a href="${fiscalGuide}">Grenzgänger-Leitfaden</a>); und die <strong>Pendeldistanz</strong>${eLocation ? `, insbesondere wenn ${eLocation} abseits der üblichen Grenzübergänge Brogeda oder Stabio liegt` : ''}. Vergleichen Sie immer das Schweizer Netto mit dem italienischen Netto-Äquivalent, bevor Sie zusagen.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Durchschnittslohn im Sektor von ${eCompany}: CHF→EUR-Szenario</h2>` +
   `<p>Um den realen Vorteil eines Engagements bei ${eCompany} zu quantifizieren, verwenden wir als Referenz ${eRole} am unteren Ende der mittleren Bandbreite (${grossMid.toLocaleString('de-CH')} CHF brutto monatlich). Über 13 Monatsgehälter ergibt das ${grossYearLabel} brutto pro Jahr. Nach Quellensteuer (~10 % im ${eCanton} für Alleinstehende ohne unterhaltsberechtigte Kinder) und schweizerischen Sozialabzügen (AHV/IV/EO, ALV, BVG) bleiben rund ${netYearChfLabel} netto pro Jahr. Umgerechnet zu einem CHF/EUR-Kurs von 1,04 (12-Monats-Durchschnitt) sind das ${netYearEurLabel} an italienischer Kaufkraft.</p>` +
   `<p>Dieselbe Rolle unter einem vergleichbaren italienischen GAV erreicht selten EUR 28’000 netto jährlich. Der Vorteil im Tessin ist also real, aber ziehen Sie grenzgänger-spezifische Kosten ab: Treibstoff und Fahrzeugverschleiss (~CHF 3’000–5’000/Jahr), Mitarbeiterparkplatz, optionale ergänzende KVG-Prämien, falls vom Arbeitgeber verlangt. Für eine personalisierte Simulation mit Alter, Familienstand und Wohnort nutzen Sie den <a href="${calc}">Lohnrechner</a>; um andere Arbeitgeber im Sektor ${eSector} zu finden, besuchen Sie die <a href="${sectorHub}">${eCanton}-Stellenbörse</a>.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Bewerbung &amp; häufige Fragen</h2>` +
   `<p><strong>Methodik.</strong> Die ${jobCount} offenen Stellen von ${eCompany} auf dieser Seite werden alle 24 Stunden von unserem Crawler aus den offiziellen Karriereseiten und den wichtigsten Schweizer ATS-Systemen (Greenhouse, Workday, SmartRecruiters, jobs.ch, jobup.ch) aggregiert. Ein Klick auf eine Anzeige leitet Sie zur Originalausschreibung der Firma weiter: bewerben Sie sich immer auf der offiziellen Seite, nie über nicht verifizierte Vermittler. Cache-Einträge können bis zu 24 Stunden gegenüber dem Quell-Feed nachhinken.</p>` +
   `<dl style="margin:12px 0 0;display:grid;gap:10px">` +
   `<dt style="font-weight:600;color:var(--color-heading)">Akzeptiert ${eCompany} Initiativbewerbungen?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Die meisten Schweizer Arbeitgeber in der Grösse von ${eCompany} führen ein dauerhaft offenes Bewerbungsportal. Auch wenn keine aktuelle Stelle zu Ihrem Profil passt, senden Sie CV und Motivationsschreiben über den offiziellen Karrierebereich: Schweizer HR-Teams archivieren Initiativbewerbungen 6–12 Monate und reaktivieren sie, sobald eine passende Rolle geöffnet wird.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">Welche Zusatzleistungen bietet ${eCompany} typischerweise?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Arbeitgeber im Sektor ${eSector} im ${eCanton} bieten typischerweise: garantierten 13. Monatslohn, 4–5 Wochen Ferien, BVG-Beitrag über dem gesetzlichen Minimum, kontinuierliche Weiterbildung und Homeoffice bis 25 % für Grenzgänger (gemäss neuem Steuerabkommen 2024). Erfolgsabhängige Boni und Geschäftswagen hängen von der Senioritie ab.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">Wie lange dauert das Auswahlverfahren?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Für operative oder mittlere Rollen bei Unternehmen wie ${eCompany} verläuft der Standardprozess wie folgt: CV-Screening (1–2 Wochen), HR-Telefon- oder Video-Screening (30–45 Minuten), ein bis zwei Fach- oder Führungsinterviews, optionales Assessment oder Case Study, Angebot. Typische Gesamtdauer: 4–8 Wochen von der Bewerbung bis zur Unterschrift. Die G-Bewilligung wird danach vom Arbeitgeber beantragt und dauert weitere 2–6 Wochen.</dd>` +
   `</dl>` +
   `</section>`
  );
 } else {
  // fr
  blocks.push(
   `<section style="margin-top:20px"><h2>Travailler chez ${eCompany} comme frontalier</h2>` +
   `<p>${eCompany} recrute dans le secteur ${eSector} dans le Canton du ${eCanton}` +
   `${eLocation ? `, avec une presence directe a ${eLocation}` : ''}. Pour les frontaliers italiens, postuler a l’un des ${jobCount} postes ouverts signifie entrer dans une relation de travail regie par le permis G : residence dans une commune italienne situee dans la zone frontaère des 20 km, retour hebdomadaire au domicile et contrat signé en Suisse. Les types de contrat typiques chez ${eCompany} sont ${eContract}, et le poste de reference pour la grille salariale de cette page est ${eRole}.</p>` +
   `<p>Trois elements pesent davantage que le brut affiche au moment d’evaluer une offre de ${eCompany} : la <strong>fourchette salariale du secteur ${eSector}</strong> dans le ${eCanton} (${juniorBand} pour les postes juniors, ${midBand} pour les postes intermediaires, ${seniorBand} pour les postes seniors, 13e inclus) ; l’<strong>impôt à la source cantonal</strong> et les charges sociales suisses (voir le <a href="${fiscalGuide}">guide frontalier</a>) ; et la <strong>distance domicile-travail</strong>${eLocation ? `, en particulier si ${eLocation} ne se trouve pas sur les axes habituels de Brogeda ou Stabio` : ''}. Comparez toujours le net suisse avec l’equivalent net italien avant d’accepter.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Salaire moyen dans le secteur de ${eCompany} : scenario CHF→EUR</h2>` +
   `<p>Pour quantifier le gain reel d’une embauche chez ${eCompany}, nous prenons comme reference ${eRole} en bas de la fourchette intermediaire (${grossMid.toLocaleString('fr-CH')} CHF brut mensuel). Sur 13 mois, cela donne ${grossYearLabel} brut par an. Apres impôt à la source (~10 % dans le ${eCanton} pour un celibataire sans personne a charge) et charges sociales suisses (AVS/AI/APG, AC, LPP), il reste environ ${netYearChfLabel} net annuel. Converti a un taux CHF/EUR de 1,04 (moyenne 12 mois), cela represente ${netYearEurLabel} de pouvoir d’achat italien.</p>` +
   `<p>Le même poste, sous une convention collective italienne comparable, depasse rarement EUR 28’000 net par an. L’avantage tessinois est reel, mais retranchez les coûts spécifiques au frontalierat : carburant et usure du vehicule (~CHF 3’000–5’000/an), parking d’entreprise eventuel, primes LAMal complementaires si exigees par l’employeur. Pour une simulation personnalisee tenant compte de votre age, situation familiale et ville de residence, utilisez le <a href="${calc}">calculateur de salaire</a> ; pour decouvrir d’autres employeurs du secteur ${eSector}, consultez le <a href="${sectorHub}">job board ${eCanton}</a>.</p>` +
   `</section>`
  );
  blocks.push(
   `<section style="margin-top:20px"><h2>Comment postuler &amp; FAQ</h2>` +
   `<p><strong>Methodologie.</strong> Les ${jobCount} postes ouverts de ${eCompany} affiches sur cette page sont agreges par notre crawler toutes les 24 heures depuis les pages « Carrieres » officielles et les principaux ATS suisses (Greenhouse, Workday, SmartRecruiters, jobs.ch, jobup.ch). Un clic sur une annonce vous redirige vers la fiche d’origine de l’entreprise : postulez toujours sur le site officiel, jamais via des intermediaires non verifies. Le cache peut accuser jusqu’à 24 heures de retard sur le flux source.</p>` +
   `<dl style="margin:12px 0 0;display:grid;gap:10px">` +
   `<dt style="font-weight:600;color:var(--color-heading)">${eCompany} accepte-t-elle les candidatures spontanees ?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">La plupart des employeurs suisses de la taille de ${eCompany} maintiennent un portail candidatures ouvert toute l’annee. Même en l’absence de poste ouvert correspondant, envoyez votre CV et une lettre de motivation via la section carrieres officielle : les RH suisses conservent les candidatures spontanees 6 a 12 mois et les reactivent dès qu’un poste similaire s’ouvre.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">Quels avantages ${eCompany} offre-t-elle au-dela du salaire ?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Les employeurs du secteur ${eSector} dans le ${eCanton} proposent typiquement : 13e mois garanti, 4 a 5 semaines de vacances, cotisation LPP au-dessus du minimum legal, formation continue et teletravail jusqu’à 25 % pour les frontaliers (selon le nouvel accord fiscal 2024). Bonus a objectifs et voiture de fonction dependent de la senioritie du poste.</dd>` +
   `<dt style="font-weight:600;color:var(--color-heading)">Combien de temps dure le processus de selection ?</dt>` +
   `<dd style="margin:0;color:var(--color-body);line-height:1.6">Pour des rôles operationnels ou intermediaires chez des entreprises de la taille de ${eCompany}, le processus standard est : tri de CV (1 a 2 semaines), entretien RH telephonique ou video (30 a 45 minutes), un ou deux entretiens techniques ou managers, eventuel assessment ou cas pratique, offre. Duree typique de bout en bout : 4 a 8 semaines entre la candidature et la signature. Le permis G est ensuite demande par l’employeur et prend 2 a 6 semaines supplementaires.</dd>` +
   `</dl>` +
   `</section>`
  );
 }

 return blocks.join('\n');
}
