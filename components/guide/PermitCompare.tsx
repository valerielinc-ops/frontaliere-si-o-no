import React, { useState, useMemo, useEffect, useCallback, Suspense } from 'react';
import { requestSlot, releaseSlot, isActive, subscribe, POPUP_PRIORITY } from '@/services/popupQueue';
import { lazyRetry } from '@/services/lazyRetry';

const RelatedTools = lazyRetry(() => import('@/components/shared/RelatedTools'));
import type { UserProfileData } from '@/components/pages/UserProfile';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { MUNICIPALITIES, type Municipality } from '@/data/municipalities';
import { Users, TrendingUp, TrendingDown, Minus, AlertTriangle, Download, Info, Sparkles, CheckSquare, ExternalLink, FileText } from 'lucide-react';
import { useExchangeRate } from '@/services/exchangeRateService';
import { calculateProgressiveWorkDeduction, calculateProportionalTaxCredit } from '@/services/calculationService';

// ── G permit type ──
type GPermitType = 'new_within_20km' | 'new_beyond_20km' | 'old';
type WizardResidenceGoal = 'italy' | 'switzerland' | 'undecided';
type WizardPriority = 'net' | 'stability' | 'family';
type WizardHorizon = 'short' | 'long';

interface WizardState {
 profile: GPermitType;
 residenceGoal: WizardResidenceGoal;
 priority: WizardPriority;
 horizon: WizardHorizon;
}

interface WizardDecision {
 recommendation: 'g' | 'b' | 'similar';
 reasonKey: string;
}

// ── Simplified G vs B cost model ──

// Swiss social deductions (employee share)
const AVS = 0.053;
const AD = 0.011;
const AINF = 0.007;
const IJM = 0.008;
const LPP_AVG = 0.06; // average across ages for simplified comparison
const SOCIAL_TOTAL = AVS + AD + AINF + IJM + LPP_AVG;

// Ticino withholding tax (simplified interpolation for quick comparison)
const TABLE_A: [number, number][] = [[0, 0], [30000, 3.2], [50000, 6.0], [80000, 11.3], [100000, 13.2], [140000, 16.5], [200000, 19.4]];
const TABLE_B: [number, number][] = [[0, 0], [40000, 1.1], [60000, 2.5], [80000, 5.1], [100000, 8.7], [140000, 12.8], [200000, 16.5]];

function interpolate(value: number, pts: [number, number][]): number {
 if (value <= pts[0][0]) return pts[0][1];
 if (value >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
 for (let i = 0; i < pts.length - 1; i++) {
 const [x0, y0] = pts[i];
 const [x1, y1] = pts[i + 1];
 if (value >= x0 && value < x1) return y0 + (value - x0) * (y1 - y0) / (x1 - x0);
 }
 return 0;
}

// Italian IRPEF 2026 scaglioni
function calcIrpef(taxableEUR: number): number {
 if (taxableEUR <= 0) return 0;
 let tax = 0;
 const brackets: [number, number][] = [[28000, 0.23], [50000, 0.35], [Infinity, 0.43]];
 let remaining = taxableEUR;
 let prev = 0;
 for (const [limit, rate] of brackets) {
 const slice = Math.min(remaining, limit - prev);
 tax += slice * rate;
 remaining -= slice;
 prev = limit;
 if (remaining <= 0) break;
 }
 return tax;
}

const DEFAULT_EXCHANGE_RATE = 0.94; // CHF → EUR fallback

// Swiss cities for Permit B (simplified)
const SWISS_CITIES = [
 { name: 'Lugano', rentCHF: 1650, healthCHF: 380 },
 { name: 'Bellinzona', rentCHF: 1350, healthCHF: 370 },
 { name: 'Locarno', rentCHF: 1400, healthCHF: 375 },
 { name: 'Mendrisio', rentCHF: 1300, healthCHF: 370 },
 { name: 'Chiasso', rentCHF: 1200, healthCHF: 370 },
];

interface ComparisonResult {
 g: { taxes: number; rent: number; food: number; transport: number; health: number; total: number; net: number };
 b: { taxes: number; rent: number; food: number; transport: number; health: number; total: number; net: number };
 breakeven: number;
 verdict: 'g' | 'b' | 'similar';
}

function buildTemplateContent(
 templateId: string,
 context: { municipality: Municipality; swissCity: string; grossSalary: number; gType: GPermitType }
): string {
 const today = new Date().toISOString().slice(0, 10);
 const gTypeLabel =
 context.gType === 'old'
 ? 'Vecchio frontaliere'
 : context.gType === 'new_within_20km'
 ? 'Nuovo frontaliere entro 20 km'
 : 'Nuovo frontaliere oltre 20 km';

 switch (templateId) {
 case 'status-request':
 return `Oggetto: Richiesta conferma inquadramento fiscale frontaliere\n\nAlla cortese attenzione dell'Ufficio imposte alla fonte e del bollo,\n\ncon la presente richiedo conferma scritta del mio inquadramento ai fini dell'Accordo CH-IT sui lavoratori frontalieri.\n\nDati sintetici:\n- Data richiesta: ${today}\n- Comune di residenza: ${context.municipality.name} (${context.municipality.province})\n- Profilo dichiarato: ${gTypeLabel}\n- Reddito annuo indicativo: CHF ${context.grossSalary.toLocaleString()}\n\nResto a disposizione per eventuale documentazione integrativa.\n\nCordiali saluti,\n[Firma]\n[Recapiti]`;
 case 'hiring-checklist':
 return `Checklist documentale assunzione frontaliere\n\nData: ${today}\n\n1) Documento identità valido\n2) Contratto di lavoro svizzero / lettera di assunzione\n3) Certificato di residenza (comune italiano)\n4) Eventuale attestazione status"vecchio frontaliere" (modello 1A)\n5) Coordinate bancarie (IBAN)\n6) Copertura sanitaria (LAMal/SSN) e scelta opzione\n7) Eventuali certificati familiari utili per detrazioni\n8) Copia ultime buste paga / CU (se cambio datore)\n\nNote operative:\n- Conservare ricevute e protocolli di invio.\n- Verificare scadenze fiscali annuali Italia/CH.`;
 case 'tax-deadlines':
 return `Promemoria scadenze frontalieri (bozza personalizzabile)\n\nData generazione: ${today}\nComune: ${context.municipality.name}\n\nGen-Feb:\n- Raccolta CU/Lohnausweis e documenti annuali\n\nMar-Giu:\n- Verifica dichiarazione redditi in Italia\n- Controllo eventuale credito imposta\n\nLug-Set:\n- Verifica acconti/saldi IRPEF (se dovuti)\n\nOtt-Dic:\n- Simulazione fiscale anno successivo\n- Aggiornamento documenti lavoro e residenza\n\nSuggerimento: fissare promemoria mensili e controllo trimestrale con CAF/consulente.`;
 case 'residence-certificate':
 return `Oggetto: Richiesta certificato di residenza storico\n\nAl Comune di [COMUNE],\n\nil/la sottoscritto/a richiede il rilascio del certificato di residenza storico per finalità fiscali/lavorative connesse allo status di lavoratore frontaliero.\n\nDati richiedente:\n- Nome e cognome: [NOME]\n- Codice fiscale: [CF]\n- Indirizzo: [INDIRIZZO]\n\nSi chiede il rilascio in formato [digitale/cartaceo] con eventuale indicazione dei periodi di residenza.\n\nData: ${today}\nFirma: ____________________`;
 case 'caf-delegation':
 return `Delega CAF / consulente per pratica frontalieri\n\nIo sottoscritto/a [NOME], CF [CF], delego [CAF/CONSULENTE] a presentare e gestire la documentazione fiscale/amministrativa relativa alla mia posizione di lavoratore frontaliero.\n\nAmbito delega:\n- Raccolta e invio documentazione\n- Interlocuzione con enti competenti\n- Verifica scadenze e adempimenti\n\nValidità delega: dal ${today} fino a revoca scritta.\n\nAllego documento d'identità.\n\nFirma delegante: ____________________\nFirma delegato: ____________________`;
 default:
 return `Template non disponibile (${templateId})`;
 }
}

function compare(grossCHF: number, muni: Municipality, swissCity: typeof SWISS_CITIES[0], EXCHANGE_RATE: number = DEFAULT_EXCHANGE_RATE, gType: GPermitType = 'new_beyond_20km'): ComparisonResult {
 // ── Permit G (frontaliere) ──
 const socialG = grossCHF * SOCIAL_TOTAL;
 const swissTaxRateG = interpolate(grossCHF, TABLE_A) / 100; // single barème A for simplicity
 // NEW within 20km: CH retains only 80% of withholding; others: 100%
 const chTaxShare = gType === 'new_within_20km' ? 0.8 : 1.0;
 const swissTaxG = grossCHF * swissTaxRateG * chTaxShare;
 
 // Italian taxes depend on permit type
 const grossEUR = grossCHF * EXCHANGE_RATE;
 const socialEUR = socialG * EXCHANGE_RATE;
 let totalItalianTax = 0;

 if (gType === 'old') {
 // OLD agreement: 100% taxed at source in CH, no Italian IRPEF, no franchigia
 totalItalianTax = 0;
 } else {
 // NEW agreement 2026: franchigia €10k, social deductions, detrazioni Art. 13 TUIR
 const franchigia = 10000;
 const taxableIT = Math.max(0, grossEUR - socialEUR - franchigia);
 const irpefGross = calcIrpef(taxableIT);
 const detrazioni = calculateProgressiveWorkDeduction(taxableIT);
 const addRegionale = taxableIT * 0.0173; // Lombardia
 const addComunale = taxableIT * (muni.irpefAddizionale / 100);
 const irpefLiability = Math.max(0, irpefGross + addRegionale + addComunale - detrazioni);
 // Proportional Swiss tax credit per Art. 165 c.10 TUIR
 const paidSourceTaxEUR = swissTaxG * EXCHANGE_RATE;
 const swissTaxCredit = calculateProportionalTaxCredit(paidSourceTaxEUR, taxableIT, grossEUR);
 totalItalianTax = Math.max(0, irpefLiability - swissTaxCredit);
 }

 const rentG = muni.avgRentMonthly * 12; // EUR
 const foodG = 350 * 12; // EUR/month estimate
 const transportG = (muni.distanceKm * 2 * 220 * 0.15); // EUR commute cost (220 work days, €0.15/km)
 const healthG = 200 * 12; // EUR SSN + supplementary

 const totalCostsG = socialG * EXCHANGE_RATE + swissTaxG * EXCHANGE_RATE + totalItalianTax + rentG + foodG + transportG + healthG;
 const netG = grossEUR - totalCostsG;

 // ── Permit B (resident in CH) ──
 const socialB = grossCHF * SOCIAL_TOTAL;
 const swissTaxRateB = interpolate(grossCHF, TABLE_B) / 100; // married barème B for more favorable comparison
 const swissTaxB = grossCHF * swissTaxRateB;
 // No Italian taxes for Permit B residents

 const rentB = swissCity.rentCHF * 12;
 const foodB = 600 * 12; // CHF/month (higher cost of living)
 const transportB = 100 * 12; // CHF/month (local transport only)
 const healthB = swissCity.healthCHF * 12;

 const totalCostsBCHF = socialB + swissTaxB + rentB + foodB + transportB + healthB;
 const netBCHF = grossCHF - totalCostsBCHF;
 const netB = netBCHF * EXCHANGE_RATE; // Convert to EUR for comparison

 // ── Breakeven ──
 // Find salary where netB > netG (binary search)
 let lo = 30000, hi = 300000;
 for (let i = 0; i < 30; i++) {
 const mid = (lo + hi) / 2;
 const testG = compare_simple_net(mid, muni, swissCity, EXCHANGE_RATE, gType);
 if (testG.netB > testG.netG) hi = mid;
 else lo = mid;
 }
 const breakeven = Math.round((lo + hi) / 2 / 1000) * 1000;

 const diff = netG - netB;
 const verdict: 'g' | 'b' | 'similar' = Math.abs(diff) < 2000 ? 'similar' : diff > 0 ? 'g' : 'b';

 return {
 g: {
 taxes: Math.round(swissTaxG * EXCHANGE_RATE + totalItalianTax),
 rent: Math.round(rentG),
 food: Math.round(foodG),
 transport: Math.round(transportG),
 health: Math.round(healthG),
 total: Math.round(totalCostsG),
 net: Math.round(netG),
 },
 b: {
 taxes: Math.round((socialB + swissTaxB) * EXCHANGE_RATE),
 rent: Math.round(rentB * EXCHANGE_RATE),
 food: Math.round(foodB * EXCHANGE_RATE),
 transport: Math.round(transportB * EXCHANGE_RATE),
 health: Math.round(healthB * EXCHANGE_RATE),
 total: Math.round(totalCostsBCHF * EXCHANGE_RATE),
 net: Math.round(netB),
 },
 breakeven,
 verdict,
 };
}

// Simplified net calculation for breakeven search
function compare_simple_net(grossCHF: number, muni: Municipality, swissCity: typeof SWISS_CITIES[0], EXCHANGE_RATE: number = DEFAULT_EXCHANGE_RATE, gType: GPermitType = 'new_beyond_20km') {
 const grossEUR = grossCHF * EXCHANGE_RATE;
 const socialG = grossCHF * SOCIAL_TOTAL;
 const chTaxShare = gType === 'new_within_20km' ? 0.8 : 1.0;
 const swissTaxG = grossCHF * (interpolate(grossCHF, TABLE_A) / 100) * chTaxShare;

 let italianTax = 0;
 if (gType !== 'old') {
 const taxableIT = Math.max(0, grossEUR - 10000);
 const irpef = calcIrpef(taxableIT);
 const addRegionale = taxableIT * 0.0173;
 const addComunale = taxableIT * (muni.irpefAddizionale / 100);
 italianTax = irpef + addRegionale + addComunale;
 }

 const totalCostsG = socialG * EXCHANGE_RATE + swissTaxG * EXCHANGE_RATE + italianTax + muni.avgRentMonthly * 12 + 350 * 12 + muni.distanceKm * 2 * 220 * 0.15 + 200 * 12;
 const netG = grossEUR - totalCostsG;

 const socialB = grossCHF * SOCIAL_TOTAL;
 const swissTaxB = grossCHF * (interpolate(grossCHF, TABLE_B) / 100);
 const totalCostsBCHF = socialB + swissTaxB + swissCity.rentCHF * 12 + 600 * 12 + 100 * 12 + swissCity.healthCHF * 12;
 const netB = (grossCHF - totalCostsBCHF) * EXCHANGE_RATE;

 return { netG, netB };
}

export default function PermitCompare({ userProfile }: { userProfile?: UserProfileData | null }) {
 const { t } = useTranslation();
 const { rate: exchangeRate } = useExchangeRate();
 const [grossSalary, setGrossSalary] = useState(100000);
 const [wizardStep, setWizardStep] = useState(1);

 // Prefill salary from user profile
 useEffect(() => {
 if (userProfile?.grossSalary) {
 const s = parseFloat(userProfile.grossSalary);
 if (!isNaN(s) && s > 0) setGrossSalary(s);
 }
 }, [userProfile]);
 const [municipalityIdx, setMunicipalityIdx] = useState(0);
 const [swissCityIdx, setSwissCityIdx] = useState(0);
 const [gType, setGType] = useState<GPermitType>('new_beyond_20km');
 const [wizardState, setWizardState] = useState<WizardState>({
 profile: 'new_beyond_20km',
 residenceGoal: 'italy',
 priority: 'net',
 horizon: 'short',
 });
 const [easterEgg, setEasterEgg] = useState<{ message: string; emoji: string } | null>(null);
 const [easterEggVisible, setEasterEggVisible] = useState(false);

 // Sync easter egg toast with popup queue so it doesn't overlap gamification
 useEffect(() => {
 if (!easterEgg) return;
 requestSlot('easter-egg-permit', POPUP_PRIORITY.EASTER_EGG_TOAST);
 setEasterEggVisible(isActive('easter-egg-permit'));
 const unsub = subscribe(() => setEasterEggVisible(isActive('easter-egg-permit')));
 const autoHide = setTimeout(() => {
 setEasterEgg(null);
 releaseSlot('easter-egg-permit');
 }, 4000);
 return () => { unsub(); clearTimeout(autoHide); };
 }, [easterEgg]);

 const dismissEasterEgg = useCallback(() => {
 setEasterEgg(null);
 releaseSlot('easter-egg-permit');
 }, []);

 const handleGTypeClick = useCallback((value: GPermitType) => {
 if (value === gType) return;
 setGType(value);
 setWizardState((prev) => ({ ...prev, profile: value }));
 Analytics.trackPermitView(value, 'select');
 const type = value === 'old' ? 'old' : 'new';
 const key = `frontaliere_easter_egg_seen_${type}`;
 if (localStorage.getItem(key)) return;
 localStorage.setItem(key, '1');
 if (value === 'old') {
 setEasterEgg({ message: t('permitCompare.easterEggOld'), emoji: '😎' });
 } else {
 setEasterEgg({ message: t('permitCompare.easterEggNew'), emoji: '💪' });
 }
 }, [gType, t]);

 const muni = MUNICIPALITIES[municipalityIdx];
 const swissCity = SWISS_CITIES[swissCityIdx];

 const result = useMemo(() => compare(grossSalary, muni, swissCity, exchangeRate, gType), [grossSalary, muni, swissCity, exchangeRate, gType]);

 const wizardDecision = useMemo<WizardDecision>(() => {
 let scoreG = 0;
 let scoreB = 0;

 if (result.verdict === 'g') scoreG += 2;
 if (result.verdict === 'b') scoreB += 2;

 if (wizardState.residenceGoal === 'italy') scoreG += 3;
 if (wizardState.residenceGoal === 'switzerland') scoreB += 3;
 if (wizardState.residenceGoal === 'undecided') {
 scoreG += 1;
 scoreB += 1;
 }

 if (wizardState.horizon === 'long') scoreB += 1;
 if (wizardState.horizon === 'short') scoreG += 1;

 if (wizardState.priority === 'net') {
 if (result.verdict === 'g') scoreG += 2;
 if (result.verdict === 'b') scoreB += 2;
 }
 if (wizardState.priority === 'stability') scoreB += 2;
 if (wizardState.priority === 'family') {
 if (wizardState.residenceGoal === 'switzerland') scoreB += 2;
 else {
 scoreG += 1;
 scoreB += 1;
 }
 }

 if (wizardState.profile === 'old') scoreG += 2;
 if (wizardState.profile !== 'old') scoreG += 1;

 if (Math.abs(scoreG - scoreB) <= 1) {
 return { recommendation: 'similar', reasonKey: 'permitCompare.wizard.reasonBalanced' };
 }
 if (scoreG > scoreB) {
 if (wizardState.residenceGoal === 'italy') return { recommendation: 'g', reasonKey: 'permitCompare.wizard.reasonItaly' };
 if (wizardState.priority === 'net') return { recommendation: 'g', reasonKey: 'permitCompare.wizard.reasonNet' };
 return { recommendation: 'g', reasonKey: 'permitCompare.wizard.reasonFlex' };
 }
 if (wizardState.residenceGoal === 'switzerland') return { recommendation: 'b', reasonKey: 'permitCompare.wizard.reasonSwiss' };
 if (wizardState.priority === 'stability' || wizardState.horizon === 'long') {
 return { recommendation: 'b', reasonKey: 'permitCompare.wizard.reasonStability' };
 }
 return { recommendation: 'b', reasonKey: 'permitCompare.wizard.reasonSwiss' };
 }, [result.verdict, wizardState]);

 const handleWizardApply = useCallback(() => {
 handleGTypeClick(wizardState.profile);
 }, [wizardState.profile, handleGTypeClick]);

 const handleDownloadTemplate = useCallback(
 (templateId: string) => {
 const content = buildTemplateContent(templateId, {
 municipality: muni,
 swissCity: swissCity.name,
 grossSalary,
 gType: wizardState.profile,
 });
 const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `${templateId}-${new Date().toISOString().slice(0, 10)}.txt`;
 document.body.appendChild(a);
 a.click();
 a.remove();
 URL.revokeObjectURL(url);
 },
 [grossSalary, muni, swissCity.name, wizardState.profile]
 );

 const documentTemplates = useMemo(
 () => [
 { id: 'status-request', title: t('permitCompare.docs.templateStatusTitle'), description: t('permitCompare.docs.templateStatusDesc') },
 { id: 'hiring-checklist', title: t('permitCompare.docs.templateChecklistTitle'), description: t('permitCompare.docs.templateChecklistDesc') },
 { id: 'tax-deadlines', title: t('permitCompare.docs.templateDeadlinesTitle'), description: t('permitCompare.docs.templateDeadlinesDesc') },
 { id: 'residence-certificate', title: t('permitCompare.docs.templateResidenceTitle'), description: t('permitCompare.docs.templateResidenceDesc') },
 { id: 'caf-delegation', title: t('permitCompare.docs.templateDelegationTitle'), description: t('permitCompare.docs.templateDelegationDesc') },
 ],
 [t]
 );

 const officialResources = useMemo(
 () => [
 { label: t('permitCompare.docs.linkTi'), url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/accordo-tra-la-svizzera-e-litalia-sullimposizione-dei-lavoratori-frontalieri' },
 { label: t('permitCompare.docs.linkSem'), url: 'https://www.sem.admin.ch/sem/en/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html' },
 { label: t('permitCompare.docs.linkCh'), url: 'https://www.ch.ch/it/stranieri-in-svizzera/lavorare-in-svizzera/' },
 { label: t('permitCompare.docs.linkAire'), url: 'https://www.esteri.it/it/servizi-consolari-e-visti/italiani-all-estero/aire_0/' },
 { label: t('permitCompare.docs.linkInps'), url: 'https://www.inps.it/it/it/inps-comunica/dossier/la-naspi/naspi-per-lavoratori-migranti.html' },
 { label: t('permitCompare.docs.linkFaq'), url: 'https://www4.ti.ch/dfe/dc/dichiarazione/imposte-alla-fonte-1/faq-frontaliere' },
 ],
 [t]
 );

 const rows: { label: string; gVal: number; bVal: number }[] = [
 { label: t('permitCompare.taxes'), gVal: result.g.taxes, bVal: result.b.taxes },
 { label: t('permitCompare.rent'), gVal: result.g.rent, bVal: result.b.rent },
 { label: t('permitCompare.food'), gVal: result.g.food, bVal: result.b.food },
 { label: t('permitCompare.transport'), gVal: result.g.transport, bVal: result.b.transport },
 { label: t('permitCompare.insurance'), gVal: result.g.health, bVal: result.b.health },
 ];

 const handlePDF = async () => {
 Analytics.trackPermitView(gType, 'view_comparison');
 const { default: jsPDF } = await import('jspdf');
 const { default: autoTable } = await import('jspdf-autotable');
 const doc = new jsPDF();
 doc.setFontSize(16);
 doc.text(t('permitCompare.title'), 14, 20);
 doc.setFontSize(10);
 doc.text(`${muni.name} vs ${swissCity.name} — CHF ${grossSalary.toLocaleString()}`, 14, 28);

 autoTable(doc, {
 startY: 35,
 head: [['', t('permitCompare.permitG'), t('permitCompare.permitB')]],
 body: [
 ...rows.map((r) => [r.label, `€ ${r.gVal.toLocaleString()}`, `€ ${r.bVal.toLocaleString()}`]),
 [t('permitCompare.totalNet'), `€ ${result.g.net.toLocaleString()}`, `€ ${result.b.net.toLocaleString()}`],
 ],
 });

 doc.save('permit-g-vs-b.pdf');
 };

 const VerdictIcon = result.verdict === 'g' ? TrendingUp : result.verdict === 'b' ? TrendingDown : Minus;
 const verdictColors = result.verdict === 'g'
 ? 'bg-success-subtle text-success'
 : result.verdict === 'b'
 ? 'bg-accent-subtle text-accent'
 : 'bg-surface-alt text-strong';

 return (
 <div className="space-y-6">
 {/* Easter egg toast */}
 {easterEgg && easterEggVisible && (
 <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in cursor-pointer" role="button" tabIndex={0} onClick={dismissEasterEgg} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissEasterEgg(); } }} aria-label="Chiudi notifica">
 <div className="bg-warning-subtle border border-warning-border rounded-2xl shadow-xl px-6 py-3 flex items-center gap-3 max-w-md">
 <span className="text-2xl">{easterEgg.emoji}</span>
 <p className="text-sm font-semibold text-warning">{easterEgg.message}</p>
 </div>
 </div>
 )}

 {/* Header */}
 <div className="bg-surface rounded-xl shadow-lg p-6">
 <div className="flex items-center gap-3 mb-2">
 <Users className="text-warning" size={28} />
 <h2 className="text-2xl font-bold font-display text-heading">{t('permitCompare.title')}</h2>
 </div>
 <p className="text-subtle">{t('permitCompare.subtitle')}</p>
 <p className="text-sm text-subtle mt-3 leading-relaxed">
 {t('guide.permitCompare.intro.p1')}
 </p>
 </div>

 <div className="grid lg:grid-cols-5 gap-6">
 {/* Inputs */}
 <div className="lg:col-span-2 space-y-4">
 <div className="bg-surface rounded-xl shadow p-5 space-y-4">
 <div className="flex items-center gap-2">
 <Sparkles size={18} className="text-warning" />
 <h3 className="text-base font-bold text-heading">{t('permitCompare.wizard.title')}</h3>
 </div>
 <p className="text-sm text-subtle">{t('permitCompare.wizard.subtitle')}</p>

 <div className="flex items-center gap-2 text-xs">
 {[1, 2, 3, 4].map((step) => (
 <button
 key={step}
 onClick={() => setWizardStep(step)}
 className={`w-7 h-7 rounded-full border font-semibold ${
 wizardStep >= step
 ? 'bg-warning-strong border-warning text-on-accent'
 : 'border-edge text-muted'
 }`}
 >
 {step}
 </button>
 ))}
 </div>

 {wizardStep === 1 && (
 <div className="space-y-2">
 <p className="text-sm font-medium text-body">{t('permitCompare.wizard.step1')}</p>
 <div className="space-y-2">
 {([
 { value: 'new_within_20km' as GPermitType, label: t('permitCompare.gTypeNew20') },
 { value: 'new_beyond_20km' as GPermitType, label: t('permitCompare.gTypeBeyond20') },
 { value: 'old' as GPermitType, label: t('permitCompare.gTypeOld') },
 ]).map((opt) => (
 <button
 key={opt.value}
 onClick={() => setWizardState((prev) => ({ ...prev, profile: opt.value }))}
 className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
 wizardState.profile === opt.value
 ? 'border-warning bg-warning-subtle border-warning-border'
 : 'border-edge'
 }`}
 >
 {opt.label}
 </button>
 ))}
 </div>
 </div>
 )}

 {wizardStep === 2 && (
 <div className="space-y-2">
 <p className="text-sm font-medium text-body">{t('permitCompare.wizard.step2')}</p>
 <div className="grid grid-cols-1 gap-2">
 {([
 { value: 'italy' as WizardResidenceGoal, label: t('permitCompare.wizard.goalItaly') },
 { value: 'switzerland' as WizardResidenceGoal, label: t('permitCompare.wizard.goalSwiss') },
 { value: 'undecided' as WizardResidenceGoal, label: t('permitCompare.wizard.goalUndecided') },
 ]).map((opt) => (
 <button
 key={opt.value}
 onClick={() => setWizardState((prev) => ({ ...prev, residenceGoal: opt.value }))}
 className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
 wizardState.residenceGoal === opt.value
 ? 'border-warning bg-warning-subtle border-warning-border'
 : 'border-edge'
 }`}
 >
 {opt.label}
 </button>
 ))}
 </div>
 </div>
 )}

 {wizardStep === 3 && (
 <div className="space-y-3">
 <div>
 <p className="text-sm font-medium text-body mb-2">{t('permitCompare.wizard.step3A')}</p>
 <div className="grid grid-cols-2 gap-2">
 {([
 { value: 'short' as WizardHorizon, label: t('permitCompare.wizard.horizonShort') },
 { value: 'long' as WizardHorizon, label: t('permitCompare.wizard.horizonLong') },
 ]).map((opt) => (
 <button
 key={opt.value}
 onClick={() => setWizardState((prev) => ({ ...prev, horizon: opt.value }))}
 className={`rounded-lg border px-3 py-2 text-sm ${
 wizardState.horizon === opt.value
 ? 'border-warning bg-warning-subtle border-warning-border'
 : 'border-edge'
 }`}
 >
 {opt.label}
 </button>
 ))}
 </div>
 </div>
 <div>
 <p className="text-sm font-medium text-body mb-2">{t('permitCompare.wizard.step3B')}</p>
 <div className="grid grid-cols-1 gap-2">
 {([
 { value: 'net' as WizardPriority, label: t('permitCompare.wizard.priorityNet') },
 { value: 'stability' as WizardPriority, label: t('permitCompare.wizard.priorityStability') },
 { value: 'family' as WizardPriority, label: t('permitCompare.wizard.priorityFamily') },
 ]).map((opt) => (
 <button
 key={opt.value}
 onClick={() => setWizardState((prev) => ({ ...prev, priority: opt.value }))}
 className={`rounded-lg border px-3 py-2 text-sm text-left ${
 wizardState.priority === opt.value
 ? 'border-warning bg-warning-subtle border-warning-border'
 : 'border-edge'
 }`}
 >
 {opt.label}
 </button>
 ))}
 </div>
 </div>
 </div>
 )}

 {wizardStep === 4 && (
 <div className="space-y-3">
 <div className="rounded-lg border border-warning-border bg-warning-subtle px-3 py-3">
 <p className="text-xs uppercase tracking-wide text-warning font-semibold">
 {t('permitCompare.wizard.recommendation')}
 </p>
 <p className="text-lg font-bold text-heading mt-1">
 {wizardDecision.recommendation === 'g'
 ? t('permitCompare.permitG')
 : wizardDecision.recommendation === 'b'
 ? t('permitCompare.permitB')
 : t('permitCompare.similar')}
 </p>
 <p className="text-sm text-subtle mt-1">{t(wizardDecision.reasonKey)}</p>
 </div>
 <button
 onClick={handleWizardApply}
 className="w-full rounded-lg bg-warning-strong hover:bg-warning-strong-hover text-on-accent text-sm font-semibold px-3 py-2 transition"
 >
 {t('permitCompare.wizard.apply')}
 </button>
 </div>
 )}

 <div className="flex items-center justify-between">
 <button
 onClick={() => setWizardStep((prev) => Math.max(1, prev - 1))}
 className="text-xs px-2 py-1 rounded border border-edge text-subtle"
 >
 {t('common.back')}
 </button>
 <button
 onClick={() => setWizardStep((prev) => Math.min(4, prev + 1))}
 className="text-xs px-2 py-1 rounded border border-edge text-subtle"
 >
 {t('common.next')}
 </button>
 </div>
 </div>

 <div className="bg-surface rounded-xl shadow p-5 space-y-4">
 {/* Gross Salary */}
 <div>
 <label htmlFor="pc-salary" className="block text-sm font-medium text-body mb-1">
 {t('permitCompare.grossSalary')}: <span className="font-bold text-warning">CHF {grossSalary.toLocaleString()}</span>
 </label>
 <input
 id="pc-salary"
 type="range"
 min={30000}
 max={250000}
 step={5000}
 value={grossSalary}
 onChange={(e) => setGrossSalary(Number(e.target.value))}
 className="w-full accent-warning"
 />
 </div>

 {/* Italian municipality */}
 <div>
 <label htmlFor="pc-muni" className="block text-sm font-medium text-body mb-1">
 {t('permitCompare.municipality')}
 </label>
 <select
 id="pc-muni"
 value={municipalityIdx}
 onChange={(e) => setMunicipalityIdx(Number(e.target.value))}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
 >
 {MUNICIPALITIES.map((m, i) => (
 <option key={m.name} value={i}>
 {m.name} ({m.province})
 </option>
 ))}
 </select>
 </div>

 {/* Swiss city */}
 <div>
 <label htmlFor="pc-swiss" className="block text-sm font-medium text-body mb-1">
 {t('permitCompare.swissMunicipality')}
 </label>
 <select
 id="pc-swiss"
 value={swissCityIdx}
 onChange={(e) => setSwissCityIdx(Number(e.target.value))}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
 >
 {SWISS_CITIES.map((c, i) => (
 <option key={c.name} value={i}>{c.name}</option>
 ))}
 </select>
 </div>

 {/* Quick info about selected municipality */}
 <div className="bg-neutral-subtle rounded-lg p-3 text-sm border border-neutral-border">
 <div className="flex justify-between text-subtle">
 <span>{t('livability.distance')}</span>
 <span className="font-mono">{muni.distanceKm} km</span>
 </div>
 <div className="flex justify-between text-subtle">
 <span>{t('livability.rent')}</span>
 <span className="font-mono">€ {muni.avgRentMonthly}/mese</span>
 </div>
 <div className="flex justify-between text-subtle">
 <span>{t('livability.irpef')}</span>
 <span className="font-mono">{muni.irpefAddizionale}%</span>
 </div>
 </div>

 {/* G Permit Type */}
 <div>
 <label className="block text-sm font-medium text-body mb-2">
 {t('permitCompare.gTypeLabel')}
 </label>
 <div className="space-y-2">
 {([
 { value: 'new_within_20km' as GPermitType, label: t('permitCompare.gTypeNew20'), desc: t('permitCompare.gTypeNew20Desc') },
 { value: 'new_beyond_20km' as GPermitType, label: t('permitCompare.gTypeBeyond20'), desc: t('permitCompare.gTypeBeyond20Desc') },
 { value: 'old' as GPermitType, label: t('permitCompare.gTypeOld'), desc: t('permitCompare.gTypeOldDesc') },
 ]).map((opt) => (
 <button
 key={opt.value}
 onClick={() => handleGTypeClick(opt.value)}
 className={`w-full text-left rounded-lg border p-3 transition ${
 gType === opt.value
 ? 'border-warning bg-warning-subtle border-warning-border'
 : 'border-edge hover:border-edge'
 }`}
 aria-label={opt.label}
 >
 <div className="flex items-center gap-2">
 <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
 gType === opt.value
 ? 'border-warning bg-warning-strong'
 : 'border-edge'
 }`} />
 <span className={`text-sm font-semibold ${
 gType === opt.value
 ? 'text-warning'
 : 'text-body'
 }`}>{opt.label}</span>
 </div>
 <p className="text-sm text-muted mt-1 ml-5">{opt.desc}</p>
 </button>
 ))}
 </div>
 </div>

 {/* Info box about G type */}
 <div className="bg-neutral-subtle rounded-lg p-3 text-xs border border-neutral-border">
 <div className="flex items-start gap-2">
 <Info size={14} className="flex-shrink-0 mt-0.5 text-neutral" />
 <p className="text-neutral">{t('permitCompare.gTypeInfo')}</p>
 </div>
 </div>
 </div>
 </div>

 {/* Results */}
 <div className="lg:col-span-3 space-y-4">
 <div className="bg-surface rounded-xl shadow p-5">
 <div className="flex items-center justify-between mb-4">
 <h3 className="text-lg font-bold font-display text-heading">{t('permitCompare.comparison')}</h3>
 <button
 onClick={handlePDF}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-warning-strong text-on-accent text-sm rounded-lg hover:bg-warning-strong-hover transition"
 aria-label="Export PDF"
 >
 <Download size={14} /> PDF
 </button>
 </div>

 {/* Comparison table */}
 <div className="overflow-x-auto">
 <table className="w-full text-sm">
 <thead>
 <tr className="border-b border-edge">
 <th className="text-left py-2 pr-4 text-subtle"></th>
 <th className="text-right py-2 px-3 text-subtle whitespace-nowrap">
 🇮🇹 {t('permitCompare.permitG')}
 <div className="text-xs font-normal text-muted">
 {gType === 'new_within_20km' ? t('permitCompare.gTypeNew20Short')
 : gType === 'new_beyond_20km' ? t('permitCompare.gTypeBeyond20Short')
 : t('permitCompare.gTypeOldShort')}
 </div>
 </th>
 <th className="text-right py-2 pl-3 text-subtle whitespace-nowrap">
 🇨🇭 {t('permitCompare.permitB')}
 </th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => (
 <tr key={r.label} className="border-b border-edge/50">
 <td className="py-2.5 pr-4 text-body">{r.label}</td>
 <td className="py-2.5 px-3 text-right font-mono text-strong">
 € {r.gVal.toLocaleString()}
 </td>
 <td className="py-2.5 pl-3 text-right font-mono text-strong">
 € {r.bVal.toLocaleString()}
 </td>
 </tr>
 ))}
 </tbody>
 <tfoot>
 <tr className="font-bold text-base border-t-2 border-edge">
 <td className="py-3 pr-4 text-heading">{t('permitCompare.totalNet')}</td>
 <td className={`py-3 px-3 text-right ${result.verdict === 'g' ? 'text-success' : 'text-heading'}`}>
 € {result.g.net.toLocaleString()}
 </td>
 <td className={`py-3 pl-3 text-right ${result.verdict === 'b' ? 'text-success' : 'text-heading'}`}>
 € {result.b.net.toLocaleString()}
 </td>
 </tr>
 </tfoot>
 </table>
 </div>

 {/* Breakeven */}
 <div className="mt-4 bg-neutral-subtle rounded-lg p-4 border border-neutral-border">
 <p className="text-sm font-semibold text-body">{t('permitCompare.breakeven')}</p>
 <p className="text-2xl font-bold text-warning mt-1">
 CHF {result.breakeven.toLocaleString()} / anno
 </p>
 <p className="text-sm text-muted mt-1">{t('permitCompare.breakevenDesc')}</p>
 </div>

 {/* Verdict */}
 <div className={`mt-4 rounded-lg p-4 flex items-start gap-3 ${verdictColors}`}>
 <VerdictIcon className="flex-shrink-0 mt-0.5" size={20} />
 <div>
 <p className="font-semibold">{t('permitCompare.verdict')}</p>
 <p className="text-sm mt-1">
 {result.verdict === 'g'
 ? t('permitCompare.gBetter')
 : result.verdict === 'b'
 ? t('permitCompare.bBetter')
 : t('permitCompare.similar')}
 </p>
 {result.verdict !== 'similar' && (
 <p className="text-xs mt-1 opacity-80">
 {t('carCost.savings')}: € {Math.abs(result.g.net - result.b.net).toLocaleString()}/anno
 </p>
 )}
 </div>
 </div>
 </div>

 <div className="bg-surface rounded-xl shadow p-5 space-y-4">
 <div className="flex items-center gap-2">
 <CheckSquare size={18} className="text-warning" />
 <h3 className="text-lg font-bold font-display text-heading">{t('permitCompare.docs.title')}</h3>
 </div>
 <p className="text-sm text-subtle">{t('permitCompare.docs.subtitle')}</p>

 <div className="grid md:grid-cols-2 gap-3">
 {documentTemplates.map((template) => (
 <button
 key={template.id}
 onClick={() => handleDownloadTemplate(template.id)}
 className="text-left rounded-lg border border-edge px-3 py-3 hover:border-warning transition"
 >
 <div className="flex items-center gap-2 mb-1">
 <FileText size={14} className="text-warning" />
 <span className="font-semibold text-strong text-sm">{template.title}</span>
 </div>
 <p className="text-sm text-muted">{template.description}</p>
 </button>
 ))}
 </div>

 <div className="border-t border-edge pt-3">
 <p className="text-sm font-semibold text-body mb-2">{t('permitCompare.docs.official')}</p>
 <ul className="space-y-2">
 {officialResources.map((resource) => (
 <li key={resource.url}>
 <a
 href={resource.url}
 target="_blank"
 rel="noopener noreferrer"
 className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
 >
 {resource.label}
 <ExternalLink size={12} />
 </a>
 </li>
 ))}
 </ul>
 </div>
 </div>

 {/* Disclaimer */}
 <div className="flex items-start gap-2 text-sm text-muted">
 <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
 <p>{t('permitCompare.disclaimer')}</p>
 </div>
 </div>
 </div>
 <Suspense fallback={null}><RelatedTools context="permits" /></Suspense>
 </div>
 );
}
