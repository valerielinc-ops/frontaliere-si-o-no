/**
 * Shared internal linking module
 * 
 * Used by both BlogArticles and AiChatbot for consistent navigation.
 * Centralises NavAction types, route mapping, keyword patterns,
 * and chatbot knowledge-base generation from i18n keys.
 */

import { buildPath } from '@/services/router';

// ─── NavAction type ──────────────────────────────────────────

export type NavAction = 'calculator' | 'exchange' | 'health' | 'cost-of-living' | 'pension' | 'pillar3' |
 'payslip' | 'tax-return' | 'residency' | 'ristorni' | 'unemployment' | 'jobs' | 'companies' | 'banks' |
 'first-day' | 'permits' | 'border' | 'calendar' | 'whatif' | 'shopping' | 'transport' | 'salary-compare' | 'traffic-history' |
 'border-map' | 'municipalities' | 'car-transfer' | 'car-cost' | 'permit-compare' | 'renovation' |
 'mobile' | 'ral' | 'parental-leave' | 'nursery' | 'living-ch' | 'living-it' | 'livability' | 'job-board' | 'jobs-observatory' |
 'search-jobs';

/**
 * Named NavAction constants.
 * Use these instead of string literals so renames surface as type errors.
 * Consumers (e.g. AiChatbot searchJobs tool) reference `NAV_ACTION.SEARCH_JOBS`
 * to emit deep-links to the JobBoard results view.
 */
export const NAV_ACTION = {
 SEARCH_JOBS: 'search-jobs',
 JOB_BOARD: 'job-board',
 JOBS: 'jobs',
} as const satisfies Record<string, NavAction>;

export type NavigatorMap = Partial<Record<NavAction, () => void>>;

// ─── NavAction → AppRoute ────────────────────────────────────

/** NavAction → AppRoute for buildPath() so <a> links get real href for SEO crawlers */
export const NAV_ACTION_ROUTES: Record<NavAction, Parameters<typeof buildPath>[0]> = {
 calculator: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' },
 exchange: { activeTab: 'confronti', confrontiSubTab: 'exchange' },
 health: { activeTab: 'confronti', confrontiSubTab: 'health' },
 'cost-of-living':{ activeTab: 'confronti', confrontiSubTab: 'cost-of-living' },
 pension: { activeTab: 'fisco', fiscoSubTab: 'pension' },
 pillar3: { activeTab: 'fisco', fiscoSubTab: 'pillar3' },
 payslip: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' },
 'tax-return': { activeTab: 'fisco', fiscoSubTab: 'tax-return' },
 residency: { activeTab: 'calculator', calcolatoreSubTab: 'residency' },
 ristorni: { activeTab: 'fisco', fiscoSubTab: 'ristorni' },
 unemployment: { activeTab: 'guida', guidaSubTab: 'unemployment' },
 jobs: { activeTab: 'confronti', confrontiSubTab: 'jobs' },
 companies: { activeTab: 'vita', vitaSubTab: 'companies' },
 banks: { activeTab: 'confronti', confrontiSubTab: 'banks' },
 'first-day': { activeTab: 'guida', guidaSubTab: 'first-day' },
 permits: { activeTab: 'guida', guidaSubTab: 'permits' },
 border: { activeTab: 'guida', guidaSubTab: 'border' },
 calendar: { activeTab: 'fisco', fiscoSubTab: 'calendar' },
 whatif: { activeTab: 'calculator', calcolatoreSubTab: 'whatif' },
 shopping: { activeTab: 'confronti', confrontiSubTab: 'shopping' },
 transport: { activeTab: 'vita', vitaSubTab: 'transport' },
 'salary-compare':{ activeTab: 'stats', statsSubTab: 'salary-compare' },
 'jobs-observatory':{ activeTab: 'stats', statsSubTab: 'jobs-observatory' },
 'traffic-history':{ activeTab: 'stats', statsSubTab: 'traffic-history' },
 'border-map': { activeTab: 'guida', guidaSubTab: 'border-map' },
 municipalities: { activeTab: 'vita', vitaSubTab: 'municipalities' },
 'car-transfer': { activeTab: 'guida', guidaSubTab: 'car-transfer' },
 'car-cost': { activeTab: 'guida', guidaSubTab: 'car-cost' },
 'permit-compare':{ activeTab: 'guida', guidaSubTab: 'permit-compare' },
 renovation: { activeTab: 'confronti', confrontiSubTab: 'renovation' },
 mobile: { activeTab: 'confronti', confrontiSubTab: 'mobile' },
 ral: { activeTab: 'calculator', calcolatoreSubTab: 'ral' },
 'parental-leave':{ activeTab: 'calculator', calcolatoreSubTab: 'parental-leave' },
 nursery: { activeTab: 'vita', vitaSubTab: 'nursery' },
 'living-ch': { activeTab: 'vita', vitaSubTab: 'living-ch' },
 'living-it': { activeTab: 'vita', vitaSubTab: 'living-it' },
 livability: { activeTab: 'stats', statsSubTab: 'livability' },
 'job-board': { activeTab: 'job-board' },
 'search-jobs': { activeTab: 'job-board' },
};

// ─── Keyword → NavAction patterns (Italian, most specific first) ─

export const KEYWORD_LINKS: Array<{ pattern: RegExp; action: NavAction }> = [
 // ── Calculator / Salary (most specific first) ──
 { pattern: /calcolatore\s+(?:di\s+)?stipendio(?:\s+netto)?/i, action: 'calculator' },
 { pattern: /stipendio\s+netto/i, action: 'calculator' },
 { pattern: /stipendio\s+lordo/i, action: 'calculator' },
 { pattern: /impost[ae]\s+alla\s+fonte/i, action: 'calculator' },
 { pattern: /nuovo\s+accordo\s+(?:fiscale|frontalier[ei])/i, action: 'calculator' },
 { pattern: /accordo\s+fiscale/i, action: 'calculator' },
 { pattern: /tassazione\s+(?:dei\s+)?frontalier[ei]/i, action: 'calculator' },
 { pattern: /imposta\s+(?:sul\s+)?reddito/i, action: 'calculator' },
 { pattern: /trattenut[ea]\s+(?:fiscal[ei]|in\s+busta)/i, action: 'calculator' },
 // ── Exchange ──
 { pattern: /tasso\s+di\s+(?:cambio|conversione)/i, action: 'exchange' },
 { pattern: /cambio\s+(?:valuta|CHF|EUR|franco|euro)/i, action: 'exchange' },
 { pattern: /franco[\s-]+euro/i, action: 'exchange' },
 { pattern: /euro[\s-]+franco/i, action: 'exchange' },
 { pattern: /CHF[\s/\-]+EUR/i, action: 'exchange' },
 { pattern: /EUR[\s/\-]+CHF/i, action: 'exchange' },
 { pattern: /potere\s+d['']acquisto/i, action: 'exchange' },
 { pattern: /conversione\s+(?:valuta|CHF|EUR)/i, action: 'exchange' },
 // ── Health ──
 { pattern: /confronto?\s+(?:delle?\s+)?cass[ea]\s+malati/i, action: 'health' },
 { pattern: /cass[ea]\s+malati/i, action: 'health' },
 { pattern: /\bLAMal\b/, action: 'health' },
 { pattern: /assicurazione\s+(?:sanitaria|malattia)/i, action: 'health' },
 { pattern: /tassa\s+sulla\s+salute/i, action: 'health' },
 { pattern: /premio\s+(?:di\s+)?assicurazione/i, action: 'health' },
 { pattern: /\bCMI\b/, action: 'health' },
 { pattern: /\bfranchigia\b/i, action: 'health' },
 // ── Cost of living ──
 { pattern: /costo\s+(?:della\s+)?vita/i, action: 'cost-of-living' },
 { pattern: /caro[\s-]vita/i, action: 'cost-of-living' },
 { pattern: /spese\s+(?:mensili|quotidiane)/i, action: 'cost-of-living' },
 { pattern: /\baffitto\b/i, action: 'cost-of-living' },
 // ── Pension ──
 { pattern: /simulatore?\s+(?:di\s+)?pension[ei]/i, action: 'pension' },
 { pattern: /pianificatore?\s+pensionistico/i, action: 'pension' },
 { pattern: /previdenza\s+(?:professionale|svizzera)/i, action: 'pension' },
 { pattern: /\bAVS(?:\/AI)?(?:\/IPG)?\b/, action: 'pension' },
 { pattern: /\bLPP\b/, action: 'pension' },
 { pattern: /primo\s+pilastro/i, action: 'pension' },
 { pattern: /secondo\s+pilastro/i, action: 'pension' },
 { pattern: /contributi\s+(?:previdenziali|sociali)/i, action: 'pension' },
 { pattern: /rendita\s+(?:di\s+)?vecchiaia/i, action: 'pension' },
 { pattern: /et[àa]\s+pensionabile/i, action: 'pension' },
 // ── Pillar 3 ──
 { pattern: /3[°oa]?\s*pilastro/i, action: 'pillar3' },
 { pattern: /pilastro\s+3a/i, action: 'pillar3' },
 { pattern: /terzo\s+pilastro/i, action: 'pillar3' },
 { pattern: /previdenza\s+individuale/i, action: 'pillar3' },
 { pattern: /risparmio\s+(?:fiscale|previdenziale)/i, action: 'pillar3' },
 // ── Payslip ──
 { pattern: /simulatore?\s+(?:di\s+)?busta\s+paga/i, action: 'payslip' },
 { pattern: /busta\s+paga/i, action: 'payslip' },
 { pattern: /cedolino\s+(?:paga|stipendio)/i, action: 'payslip' },
 // ── Border map (addizionale IRPEF — must precede generic IRPEF → tax-return) ──
 { pattern: /addizionale\s+(?:comunale|IRPEF|regionale)/i, action: 'border-map' },
 { pattern: /aliquot[ae]\s+(?:comunal[ei]|addizionale)/i, action: 'border-map' },
 // ── Tax return ──
 { pattern: /dichiarazione\s+(?:dei\s+redditi|fiscale)/i, action: 'tax-return' },
 { pattern: /\bIRPEF\b/, action: 'tax-return' },
 { pattern: /modello\s+(?:730|Redditi)/i, action: 'tax-return' },
 { pattern: /detrazion[ei]\s+fiscal[ei]/i, action: 'tax-return' },
 { pattern: /redditi\s+(?:da\s+)?lavoro\s+dipendente/i, action: 'tax-return' },
 // ── Ristorni ──
 { pattern: /ristorni(?:\s+fiscal[ei])?/i, action: 'ristorni' },
 // ── Residency ──
 { pattern: /simulatore?\s+(?:di\s+)?residenza/i, action: 'residency' },
 { pattern: /trasferimento\s+in\s+Svizzera/i, action: 'residency' },
 { pattern: /iscrizione\s+AIRE/i, action: 'residency' },
 { pattern: /domicilio\s+in\s+Svizzera/i, action: 'residency' },
 // ── Unemployment ──
 { pattern: /indennità\s+(?:di\s+)?disoccupazione/i, action: 'unemployment' },
 { pattern: /assicurazione\s+(?:contro\s+la\s+)?disoccupazione/i, action: 'unemployment' },
 { pattern: /disoccupazione/i, action: 'unemployment' },
 // ── Job Board (actual job listings) — must precede generic Jobs ──
 { pattern: /offerte\s+(?:di\s+)?lavoro\s+(?:in\s+)?(?:Ticino|Svizzera)/i, action: 'job-board' },
 { pattern: /annunci\s+(?:di\s+)?lavoro/i, action: 'job-board' },
 { pattern: /posti?\s+(?:di\s+lavoro\s+)?vacant[ei]/i, action: 'job-board' },
 { pattern: /cerca(?:re)?\s+lavoro\s+(?:in\s+)?(?:Ticino|Svizzera)/i, action: 'job-board' },
 { pattern: /opportunit[àa]\s+(?:di\s+)?(?:lavoro|impiego|carriera)/i, action: 'job-board' },
 { pattern: /lavorare\s+(?:in\s+)?(?:Ticino|Svizzera|canton)/i, action: 'job-board' },
 { pattern: /assunzion[ei]\s+(?:in\s+)?(?:Ticino|Svizzera)/i, action: 'job-board' },
 { pattern: /posizion[ei]\s+apert[ea]/i, action: 'job-board' },
 { pattern: /personale\s+(?:sanitario|infermieristico|medico)/i, action: 'job-board' },
 { pattern: /infermier[ei]\s+(?:in\s+)?(?:Svizzera|Ticino)/i, action: 'job-board' },
 { pattern: /reclutamento\s+(?:frontalier|transfrontalier)/i, action: 'job-board' },
 // ── Jobs (JobComparator — salary comparison) ──
 { pattern: /offerte\s+(?:di\s+)?lavoro/i, action: 'jobs' },
 { pattern: /mercato\s+del\s+lavoro/i, action: 'job-board' },
 { pattern: /cerca(?:re)?\s+lavoro/i, action: 'jobs' },
 // ── Companies (TicinoCompanies directory) ──
 { pattern: /aziende\s+(?:in\s+)?(?:Ticino|Svizzera)/i, action: 'companies' },
 { pattern: /datori?\s+di\s+lavoro/i, action: 'companies' },
 { pattern: /directory\s+(?:delle?\s+)?aziende/i, action: 'companies' },
 // ── Banks ──
 { pattern: /confronto?\s+(?:delle?\s+)?banche/i, action: 'banks' },
 { pattern: /conto\s+(?:bancario|corrente)/i, action: 'banks' },
 { pattern: /conto\s+(?:in\s+)?svizzer[oa]/i, action: 'banks' },
 // ── First day ──
 { pattern: /primo\s+giorno\s+(?:di\s+lavoro|da\s+frontaliere)/i, action: 'first-day' },
 { pattern: /iniziare\s+(?:a\s+)?lavorare\s+in\s+(?:Svizzera|Ticino)/i, action: 'first-day' },
 // ── Permits ──
 { pattern: /permesso\s+(?:di\s+lavoro|frontaliere|di\s+soggiorno|di\s+domicilio)/i, action: 'permits' },
 { pattern: /permesso\s+[GBCL]\b/i, action: 'permits' },
 // ── Border ──
 { pattern: /passaggio?\s+(?:(?:al(?:la)?\s+)?frontiera|(?:al\s+)?(?:valico|dogana))/i, action: 'border' },
 { pattern: /valichi?\s+(?:di\s+frontiera|doganal[ei]|di\s+confine)/i, action: 'border' },
 { pattern: /valico\s+di\s+confine/i, action: 'border' },
 { pattern: /post[oi]\s+di\s+confine/i, action: 'border' },
 { pattern: /confin[ei]\s+svizzer[iao]/i, action: 'border' },
 { pattern: /\bfrontier[ae]\b/i, action: 'border' },
 { pattern: /\bdogana\b/i, action: 'border' },
 { pattern: /\bdoganal[ei]\b/i, action: 'border' },
 // ── Calendar ──
 { pattern: /scadenz[ea]\s+fiscal[ei]/i, action: 'calendar' },
 { pattern: /calendario\s+fiscale/i, action: 'calendar' },
 { pattern: /scadenz[ea]\s+tributari[ea]/i, action: 'calendar' },
 // ── What-if ──
 { pattern: /what[\s-]?if/i, action: 'whatif' },
 { pattern: /simulazion[ei]\s+finanziaria/i, action: 'whatif' },
 // ── Shopping ──
 { pattern: /spesa\s+transfrontaliera/i, action: 'shopping' },
 { pattern: /fare\s+la\s+spesa/i, action: 'shopping' },
 { pattern: /prezzi\s+(?:in\s+)?Svizzera/i, action: 'shopping' },
 // ── Transport ──
 { pattern: /trasporto\s+(?:pubblico|frontaliero)/i, action: 'transport' },
 { pattern: /abbonamento\s+(?:Arcobaleno|treno|trasporti)/i, action: 'transport' },
 { pattern: /pendolar[ei]/i, action: 'transport' },
 { pattern: /tragitto\s+casa[\s-]+lavoro/i, action: 'traffic-history' },
 { pattern: /costo\s+(?:del\s+)?trasporto/i, action: 'transport' },
 // ── Salary compare ──
 { pattern: /confronto?\s+(?:dei\s+)?salar[ei]/i, action: 'salary-compare' },
 { pattern: /confronto?\s+(?:degli?\s+)?stipendi/i, action: 'salary-compare' },
 { pattern: /livello\s+salariale/i, action: 'salary-compare' },
 { pattern: /\bRAL\b/, action: 'salary-compare' },
 // ── Border map (municipalities IRPEF map) ──
 { pattern: /mappa\s+(?:dei\s+)?comuni\s+(?:di\s+)?frontiera/i, action: 'border-map' },
 { pattern: /comuni\s+(?:di\s+)?frontiera/i, action: 'border-map' },
 { pattern: /mappa\s+(?:interattiva\s+)?(?:fiscal[ei]|IRPEF|tasse)/i, action: 'border-map' },
 { pattern: /fascia\s+(?:di\s+)?(?:20|12)\s*km/i, action: 'border-map' },
 // ── Municipalities directory ──
 { pattern: /elenco\s+comuni/i, action: 'municipalities' },
 { pattern: /directory\s+comuni/i, action: 'municipalities' },
 // ── Car transfer ──
 { pattern: /reimmatricolazione\s+(?:dell['']?\s*)?auto/i, action: 'car-transfer' },
 { pattern: /targhe?\s+(?:svizzer[ea]|italian[ea])/i, action: 'car-transfer' },
 { pattern: /trasferimento?\s+(?:dell['']?\s*)?auto/i, action: 'car-transfer' },
 { pattern: /importazione?\s+(?:dell['']?\s*)?(?:auto|veicolo)/i, action: 'car-transfer' },
 // ── Car cost ──
 { pattern: /costi?\s+(?:dell['']?\s*)?auto/i, action: 'car-cost' },
 { pattern: /assicurazione\s+auto/i, action: 'car-cost' },
 { pattern: /calcolatore?\s+(?:auto|veicolo)/i, action: 'car-cost' },
 // ── Permit compare ──
 { pattern: /confronto?\s+(?:dei\s+)?permess[oi]/i, action: 'permit-compare' },
 { pattern: /permesso\s+G\s+(?:vs?|o|contro|versus)\s+(?:permesso\s+)?B/i, action: 'permit-compare' },
 { pattern: /permesso\s+B\s+(?:vs?|o|contro|versus)\s+(?:permesso\s+)?G/i, action: 'permit-compare' },
 // ── Renovation ──
 { pattern: /ristrutturazione\s+(?:casa|edilizia|immobile)/i, action: 'renovation' },
 { pattern: /bonus\s+(?:edilizi[oa]|ristrutturazione|110|casa)/i, action: 'renovation' },
 { pattern: /detrazion[ei]\s+edili/i, action: 'renovation' },
 // ── Mobile operators ──
 { pattern: /operator[ei]\s+(?:telefonic[oi]|mobil[ei])/i, action: 'mobile' },
 { pattern: /confronto?\s+(?:dei\s+)?telefon/i, action: 'mobile' },
 { pattern: /roaming\s+(?:frontalier[ei]|Svizzera|Italia)/i, action: 'mobile' },
 { pattern: /piano?\s+(?:telefonic[oi]|mobil[ei]|cellulare)/i, action: 'mobile' },
 // ── RAL calculator ──
 { pattern: /calcolatore?\s+RAL/i, action: 'ral' },
 { pattern: /retribuzione\s+annua\s+lorda/i, action: 'ral' },
 // ── Parental leave ──
 { pattern: /congedo\s+(?:parentale|maternità|paternità)/i, action: 'parental-leave' },
 { pattern: /maternità/i, action: 'parental-leave' },
 { pattern: /paternità/i, action: 'parental-leave' },
 // ── Nursery ──
 { pattern: /asil[oi]\s+(?:nido|infantil[ei])/i, action: 'nursery' },
 { pattern: /servizi?\s+(?:per\s+l['']?\s*)?infanzia/i, action: 'nursery' },
 // ── Living in Switzerland ──
 { pattern: /vivere\s+in\s+Svizzera/i, action: 'living-ch' },
 { pattern: /vita\s+in\s+Svizzera/i, action: 'living-ch' },
 // ── Living in Italy ──
 { pattern: /vivere\s+in\s+Italia/i, action: 'living-it' },
 { pattern: /vita\s+in\s+Italia/i, action: 'living-it' },
 // ── Livability index ──
 { pattern: /indice\s+(?:di\s+)?vivibilità/i, action: 'livability' },
 { pattern: /qualità\s+(?:della\s+)?vita/i, action: 'livability' },
 { pattern: /classifica\s+(?:dei\s+)?comuni/i, action: 'livability' },
];

// ─── Chatbot Knowledge Base ──────────────────────────────────

/** Maps NavAction → i18n key prefix for blog.cta.{key}.title/desc */
const TOOL_I18N_MAP: Array<{ action: NavAction; ctaKey: string }> = [
 { action: 'calculator', ctaKey: 'calculator' },
 { action: 'exchange', ctaKey: 'exchange' },
 { action: 'health', ctaKey: 'health' },
 { action: 'cost-of-living', ctaKey: 'costOfLiving' },
 { action: 'pension', ctaKey: 'pension' },
 { action: 'pillar3', ctaKey: 'pillar3' },
 { action: 'payslip', ctaKey: 'payslip' },
 { action: 'tax-return', ctaKey: 'taxReturn' },
 { action: 'residency', ctaKey: 'residency' },
 { action: 'ristorni', ctaKey: 'ristorni' },
 { action: 'unemployment', ctaKey: 'unemployment' },
 { action: 'jobs', ctaKey: 'jobs' },
 { action: 'companies', ctaKey: 'companies' },
 { action: 'banks', ctaKey: 'banks' },
 { action: 'first-day', ctaKey: 'firstDay' },
 { action: 'permits', ctaKey: 'permits' },
 { action: 'border', ctaKey: 'border' },
 { action: 'calendar', ctaKey: 'calendar' },
 { action: 'whatif', ctaKey: 'whatif' },
 { action: 'shopping', ctaKey: 'shopping' },
 { action: 'transport', ctaKey: 'transport' },
 { action: 'salary-compare', ctaKey: 'salaryCompare' },
 { action: 'traffic-history', ctaKey: 'trafficHistory' },
 { action: 'parental-leave', ctaKey: 'parentalLeave' },
 { action: 'job-board', ctaKey: 'jobBoard' },
];

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Builds a locale-aware tool catalogue for the chatbot system prompt.
 * Each entry: "- [title](nav:action): description"
 */
export function buildToolCatalogue(t: TranslateFn): string {
 return TOOL_I18N_MAP.map(({ action, ctaKey }) => {
 const title = t(`blog.cta.${ctaKey}.title`);
 const desc = t(`blog.cta.${ctaKey}.desc`);
 return `- [${title}](nav:${action}): ${desc}`;
 }).join('\n');
}

/**
 * Builds a locale-aware system prompt for the Gemini chatbot.
 * Includes the tool catalogue and instructions to use [text](nav:action) links.
 */
export function buildSystemPrompt(t: TranslateFn, locale: string): string {
 const catalogue = buildToolCatalogue(t);
 return t('chatbot.systemPrompt', { tools: catalogue, locale });
}
