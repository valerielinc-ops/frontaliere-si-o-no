import React, { useState, useMemo } from 'react';
import { Heart, Shield, AlertCircle, Info, ChevronDown, ChevronUp, Star, TrendingDown, ExternalLink, Filter, Award, Search } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

type InsuranceModel = 'standard' | 'hmo' | 'hausarzt' | 'telmed';
type AgeGroup = '0-18' | '19-25' | '26+';

interface InsurerProfile {
  id: string;
  name: string;
  website: string;
  color: string;
  rating: number;
  models: InsuranceModel[];
  serviceNote: string;
  isLowCost?: boolean;
}

const INSURERS: InsurerProfile[] = [
  { id: 'assura', name: 'Assura', website: 'https://www.assura.ch', color: 'from-blue-500 to-indigo-600', rating: 3.2, models: ['standard', 'hausarzt', 'telmed'], serviceNote: 'Premi tra i più bassi, servizio clienti migliorabile', isLowCost: true },
  { id: 'css', name: 'CSS', website: 'https://www.css.ch', color: 'from-red-500 to-rose-600', rating: 4.1, models: ['standard', 'hmo', 'hausarzt', 'telmed'], serviceNote: 'App moderna, buon servizio clienti' },
  { id: 'helsana', name: 'Helsana', website: 'https://www.helsana.ch', color: 'from-emerald-500 to-teal-600', rating: 4.0, models: ['standard', 'hmo', 'hausarzt', 'telmed'], serviceNote: 'Grande gruppo, rete capillare' },
  { id: 'swica', name: 'SWICA', website: 'https://www.swica.ch', color: 'from-teal-500 to-cyan-600', rating: 4.5, models: ['standard', 'hmo', 'hausarzt', 'telmed'], serviceNote: 'Eccellente servizio, premiata più volte' },
  { id: 'sanitas', name: 'Sanitas', website: 'https://www.sanitas.com', color: 'from-cyan-500 to-blue-600', rating: 3.9, models: ['standard', 'hmo', 'hausarzt', 'telmed'], serviceNote: 'Buona offerta digitale' },
  { id: 'concordia', name: 'Concordia', website: 'https://www.concordia.ch', color: 'from-purple-500 to-violet-600', rating: 4.2, models: ['standard', 'hausarzt', 'telmed'], serviceNote: 'Buon rapporto qualità-prezzo' },
  { id: 'visana', name: 'Visana', website: 'https://www.visana.ch', color: 'from-amber-500 to-orange-600', rating: 3.8, models: ['standard', 'hmo', 'hausarzt'], serviceNote: 'Presente soprattutto nella Svizzera tedesca' },
  { id: 'kpt', name: 'KPT', website: 'https://www.kpt.ch', color: 'from-sky-500 to-blue-600', rating: 4.3, models: ['standard', 'hausarzt', 'telmed'], serviceNote: 'Premi competitivi, alta soddisfazione' },
  { id: 'okk', name: 'ÖKK', website: 'https://www.oekk.ch', color: 'from-lime-500 to-green-600', rating: 4.0, models: ['standard', 'hausarzt', 'telmed'], serviceNote: 'Forte nei Grigioni, servizio personale' },
  { id: 'groupe-mutuel', name: 'Groupe Mutuel', website: 'https://www.groupemutuel.ch', color: 'from-indigo-500 to-purple-600', rating: 3.5, models: ['standard', 'hmo', 'hausarzt', 'telmed'], serviceNote: 'Grande gruppo, molte opzioni', isLowCost: true },
  { id: 'atupri', name: 'Atupri', website: 'https://www.atupri.ch', color: 'from-fuchsia-500 to-pink-600', rating: 3.7, models: ['standard', 'hmo', 'telmed'], serviceNote: 'Fully digital, app moderna', isLowCost: true },
  { id: 'sympany', name: 'Sympany', website: 'https://www.sympany.ch', color: 'from-rose-500 to-red-600', rating: 3.6, models: ['standard', 'hausarzt', 'telmed'], serviceNote: 'Premi competitivi nella regione Basilea' },
  { id: 'egk', name: 'EGK', website: 'https://www.egk.ch', color: 'from-green-600 to-emerald-700', rating: 4.1, models: ['standard', 'hausarzt', 'telmed'], serviceNote: 'Specializzata in medicina naturale' },
  { id: 'aquilana', name: 'Aquilana', website: 'https://www.aquilana.ch', color: 'from-blue-600 to-sky-700', rating: 3.4, models: ['standard', 'hausarzt'], serviceNote: 'Premi bassi, servizio essenziale', isLowCost: true },
];

const FRANCHISES = [300, 500, 1000, 1500, 2000, 2500];
const FRANCHISES_CHILD = [0, 100, 200, 300, 400, 500, 600];

const BASE_PREMIUMS: Record<string, number> = {
  'assura-TI': 367, 'css-TI': 432, 'helsana-TI': 445, 'swica-TI': 418,
  'sanitas-TI': 428, 'concordia-TI': 401, 'visana-TI': 440, 'kpt-TI': 395,
  'okk-TI': 435, 'groupe-mutuel-TI': 388, 'atupri-TI': 385, 'sympany-TI': 415,
  'egk-TI': 410, 'aquilana-TI': 372,
  'assura-GR': 310, 'css-GR': 375, 'helsana-GR': 385, 'swica-GR': 360,
  'sanitas-GR': 370, 'concordia-GR': 348, 'visana-GR': 380, 'kpt-GR': 342,
  'okk-GR': 330, 'groupe-mutuel-GR': 335, 'atupri-GR': 332, 'sympany-GR': 358,
  'egk-GR': 355, 'aquilana-GR': 318,
  'assura-VS': 340, 'css-VS': 398, 'helsana-VS': 410, 'swica-VS': 385,
  'sanitas-VS': 395, 'concordia-VS': 370, 'visana-VS': 405, 'kpt-VS': 365,
  'okk-VS': 395, 'groupe-mutuel-VS': 355, 'atupri-VS': 350, 'sympany-VS': 380,
  'egk-VS': 378, 'aquilana-VS': 345,
  'assura-ZH': 385, 'css-ZH': 455, 'helsana-ZH': 470, 'swica-ZH': 440,
  'sanitas-ZH': 450, 'concordia-ZH': 425, 'visana-ZH': 460, 'kpt-ZH': 420,
  'okk-ZH': 455, 'groupe-mutuel-ZH': 410, 'atupri-ZH': 405, 'sympany-ZH': 435,
  'egk-ZH': 430, 'aquilana-ZH': 390,
  'assura-GE': 420, 'css-GE': 495, 'helsana-GE': 510, 'swica-GE': 480,
  'sanitas-GE': 490, 'concordia-GE': 460, 'visana-GE': 500, 'kpt-GE': 455,
  'okk-GE': 495, 'groupe-mutuel-GE': 445, 'atupri-GE': 440, 'sympany-GE': 475,
  'egk-GE': 465, 'aquilana-GE': 425,
  'assura-BE': 355, 'css-BE': 415, 'helsana-BE': 430, 'swica-BE': 405,
  'sanitas-BE': 415, 'concordia-BE': 390, 'visana-BE': 395, 'kpt-BE': 380,
  'okk-BE': 420, 'groupe-mutuel-BE': 375, 'atupri-BE': 370, 'sympany-BE': 400,
  'egk-BE': 395, 'aquilana-BE': 360,
  'assura-LU': 335, 'css-LU': 395, 'helsana-LU': 408, 'swica-LU': 385,
  'sanitas-LU': 395, 'concordia-LU': 370, 'visana-LU': 400, 'kpt-LU': 362,
  'okk-LU': 400, 'groupe-mutuel-LU': 355, 'atupri-LU': 352, 'sympany-LU': 382,
  'egk-LU': 378, 'aquilana-LU': 340,
};

const MODEL_DISCOUNT: Record<InsuranceModel, number> = {
  standard: 0, hausarzt: 0.07, hmo: 0.12, telmed: 0.10,
};

const FRANCHISE_ADJUSTMENT: Record<number, number> = {
  0: 0.08, 100: 0.05, 200: 0.02, 300: 0, 400: -0.03, 500: -0.05,
  600: -0.08, 1000: -0.15, 1500: -0.22, 2000: -0.28, 2500: -0.33,
};

const AGE_MULTIPLIER: Record<AgeGroup, number> = {
  '0-18': 0.25, '19-25': 0.75, '26+': 1.0,
};

const ACCIDENT_ADDITION = 0.07;

const CANTONS = [
  { value: 'TI', label: 'Ticino (TI)' },
  { value: 'GR', label: 'Grigioni (GR)' },
  { value: 'VS', label: 'Vallese (VS)' },
  { value: 'ZH', label: 'Zurigo (ZH)' },
  { value: 'GE', label: 'Ginevra (GE)' },
  { value: 'BE', label: 'Berna (BE)' },
  { value: 'LU', label: 'Lucerna (LU)' },
];

function calculatePremium(
  insurerId: string, canton: string, model: InsuranceModel,
  franchise: number, ageGroup: AgeGroup, withAccident: boolean
): number | null {
  const base = BASE_PREMIUMS[`${insurerId}-${canton}`];
  if (base === undefined) return null;
  const insurer = INSURERS.find(i => i.id === insurerId);
  if (!insurer || !insurer.models.includes(model)) return null;
  let p = base * (1 - MODEL_DISCOUNT[model]) * (1 + (FRANCHISE_ADJUSTMENT[franchise] ?? 0)) * AGE_MULTIPLIER[ageGroup];
  if (withAccident) p *= (1 + ACCIDENT_ADDITION);
  return Math.round(p * 100) / 100;
}

export { INSURERS, calculatePremium, FRANCHISES, FRANCHISES_CHILD, MODEL_DISCOUNT, FRANCHISE_ADJUSTMENT, CANTONS };

const MODEL_LABELS: Record<InsuranceModel, string> = {
  standard: 'Standard', hausarzt: 'Medico di famiglia',
  hmo: 'HMO (Centro medico)', telmed: 'Telmed (Telefono/Online)',
};

interface ComputedResult {
  insurer: InsurerProfile;
  premium: number;
  annualCost: number;
  annualTotal: number;
  savingsVsMax: number;
  rank: number;
  isBestPrice: boolean;
  isBestValue: boolean;
}

const HealthInsurance: React.FC = () => {
  const { t } = useTranslation();
  const [age, setAge] = useState<number>(35);
  const [canton, setCanton] = useState('TI');
  const [franchise, setFranchise] = useState(300);
  const [model, setModel] = useState<InsuranceModel>('standard');
  const [withAccident, setWithAccident] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  const ageGroup: AgeGroup = age < 19 ? '0-18' : age <= 25 ? '19-25' : '26+';
  const availableFranchises = ageGroup === '0-18' ? FRANCHISES_CHILD : FRANCHISES;
  const effectiveFranchise = availableFranchises.includes(franchise) ? franchise : availableFranchises[0];

  const results: ComputedResult[] = useMemo(() => {
    const computed: ComputedResult[] = [];
    for (const insurer of INSURERS) {
      const premium = calculatePremium(insurer.id, canton, model, effectiveFranchise, ageGroup, withAccident);
      if (premium === null) continue;
      const annualCost = premium * 12;
      computed.push({ insurer, premium, annualCost, annualTotal: annualCost + effectiveFranchise, savingsVsMax: 0, rank: 0, isBestPrice: false, isBestValue: false });
    }
    computed.sort((a, b) => a.premium - b.premium);
    const maxCost = computed.length > 0 ? computed[computed.length - 1].annualCost : 0;
    computed.forEach((r, i) => { r.rank = i + 1; r.savingsVsMax = maxCost - r.annualCost; });
    if (computed.length > 0) {
      computed[0].isBestPrice = true;
      const top5 = computed.slice(0, 5);
      const bestVal = top5.reduce((b, c) => c.insurer.rating > b.insurer.rating ? c : b, top5[0]);
      bestVal.isBestValue = true;
    }
    return computed;
  }, [canton, model, effectiveFranchise, ageGroup, withAccident]);

  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return results;
    const term = searchTerm.toLowerCase();
    return results.filter(r => r.insurer.name.toLowerCase().includes(term));
  }, [results, searchTerm]);

  const cheapest = results[0] ?? null;
  const mostExpensive = results.length > 0 ? results[results.length - 1] : null;

  return (
    <div className="space-y-6 pb-8">
      <div className="bg-gradient-to-br from-rose-600 to-pink-700 rounded-2xl p-6 sm:p-8 text-white">
        <div className="flex items-center gap-3 mb-3">
          <Heart size={28} />
          <h2 className="text-2xl sm:text-3xl font-extrabold">{t('health.title')}</h2>
        </div>
        <p className="text-rose-100 text-base sm:text-lg">
          {'Confronta i premi di ' + INSURERS.length + ' assicurazioni LAMal svizzere. Inserisci i tuoi dati per trovare l\'offerta migliore.'}
        </p>
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <p className="font-bold mb-1">Nota per frontalieri</p>
            <p>
              {'I frontalieri possono scegliere tra LAMal svizzera o SSN italiano (diritto d\'opzione). '}
              {'La scelta va comunicata entro 3 mesi dall\'inizio dell\'attività ed è '}
              <strong>irrevocabile</strong>{'. Premi indicativi — verifica su '}
              <a href="https://www.priminfo.admin.ch/it/praemien" target="_blank" rel="noopener noreferrer" className="underline font-bold">priminfo.admin.ch</a>.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700 shadow-sm">
        <h3 className="text-sm font-bold text-slate-600 dark:text-slate-500 uppercase tracking-wider mb-4 flex items-center gap-2">
          <Filter size={16} /> I tuoi parametri
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">{'Età'}</label>
            <input type="number" min={0} max={99} value={age}
              onChange={(e) => setAge(Math.max(0, Math.min(99, Number(e.target.value))))}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm" />
            <span className="text-[10px] text-slate-500 mt-0.5 block">
              {ageGroup === '0-18' ? 'Bambino' : ageGroup === '19-25' ? 'Giovane adulto' : 'Adulto'}
            </span>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Cantone di lavoro</label>
            <select value={canton} onChange={(e) => setCanton(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm">
              {CANTONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Franchigia (CHF/anno)</label>
            <select value={effectiveFranchise} onChange={(e) => setFranchise(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm">
              {availableFranchises.map(f => <option key={f} value={f}>{f} CHF</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Modello assicurativo</label>
            <select value={model} onChange={(e) => setModel(e.target.value as InsuranceModel)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-sm">
              {Object.entries(MODEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Copertura infortuni</label>
            <div className="flex gap-2 mt-1">
              <button onClick={() => setWithAccident(false)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${!withAccident ? 'bg-rose-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                Senza</button>
              <button onClick={() => setWithAccident(true)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${withAccident ? 'bg-rose-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}>
                Con</button>
            </div>
          </div>
        </div>
      </div>

      {cheapest && mostExpensive && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 mb-1">
              <TrendingDown size={16} />
              <span className="text-xs font-bold uppercase tracking-wider">{'Più economica'}</span>
            </div>
            <p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{cheapest.premium.toFixed(2)} CHF</p>
            <p className="text-xs text-slate-500">{cheapest.insurer.name} /mese</p>
          </div>
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 mb-1">
              <Award size={16} />
              <span className="text-xs font-bold uppercase tracking-wider">Miglior rapporto</span>
            </div>
            {(() => { const bv = filtered.find(r => r.isBestValue); return bv ? (<><p className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{bv.premium.toFixed(2)} CHF</p><p className="text-xs text-slate-500">{bv.insurer.name} - {bv.insurer.rating}/5</p></>) : null; })()}
          </div>
          <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-500 mb-1">
              <Info size={16} />
              <span className="text-xs font-bold uppercase tracking-wider">Risparmio max annuo</span>
            </div>
            <p className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-400">
              {(mostExpensive.annualCost - cheapest.annualCost).toFixed(0)} CHF
            </p>
            <p className="text-xs text-slate-500">{'tra la più cara e la più economica'}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative flex-1 max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input type="text" placeholder="Cerca assicurazione..."
            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100" />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-500">
          {filtered.length} assicurazioni trovate
        </p>
      </div>

      <div className="space-y-3">
        {filtered.map((result) => {
          const isExpanded = expandedCard === result.insurer.id;
          return (
            <div key={result.insurer.id}
              className={`bg-white dark:bg-slate-800 rounded-xl border-2 transition-all ${
                result.isBestPrice ? 'border-emerald-400 dark:border-emerald-600 shadow-lg'
                : result.isBestValue ? 'border-blue-400 dark:border-blue-600 shadow-md'
                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}>
              <div className="p-4 cursor-pointer" onClick={() => setExpandedCard(isExpanded ? null : result.insurer.id)}>
                <div className="flex items-center gap-4">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center font-extrabold text-sm ${
                    result.rank === 1 ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'
                    : result.rank <= 3 ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-500'}`}>
                    {result.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-slate-800 dark:text-slate-100">{result.insurer.name}</h3>
                      {result.isBestPrice && (
                        <span className="px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold uppercase rounded-full">Migliore prezzo</span>)}
                      {result.isBestValue && !result.isBestPrice && (
                        <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-[10px] font-bold uppercase rounded-full">Miglior rapporto</span>)}
                      {result.insurer.isLowCost && (
                        <span className="px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-[10px] font-bold rounded-full">Low-cost</span>)}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <div className="flex items-center gap-0.5">
                        {[1,2,3,4,5].map(s => (
                          <Star key={s} size={10}
                            className={s <= Math.round(result.insurer.rating) ? 'text-amber-400 fill-amber-400' : 'text-slate-300 dark:text-slate-600'} />
                        ))}
                        <span className="text-[10px] text-slate-500 ml-1">{result.insurer.rating}</span>
                      </div>
                      <span className="text-[10px] text-slate-500 hidden sm:inline">{result.insurer.serviceNote}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xl sm:text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                      {result.premium.toFixed(2)} <span className="text-sm font-bold text-slate-500">CHF</span></p>
                    <p className="text-[10px] text-slate-500">/mese</p>
                    {result.savingsVsMax > 0 && result.rank <= 5 && (
                      <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold mt-0.5">
                        {'risparmi ' + result.savingsVsMax.toFixed(0) + ' CHF/anno'}</p>)}
                  </div>
                  <div className="text-slate-500">
                    {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                  </div>
                </div>
              </div>
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 pt-3 animate-fade-in">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Premio mensile</p>
                      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{result.premium.toFixed(2)} CHF</p>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Costo annuo</p>
                      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{result.annualCost.toFixed(0)} CHF</p>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Franchigia</p>
                      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{effectiveFranchise} CHF</p>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
                      <p className="text-[10px] text-slate-500 uppercase font-bold">Tot. max/anno</p>
                      <p className="text-lg font-bold text-amber-600 dark:text-amber-400">{result.annualTotal.toFixed(0)} CHF</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                    <div>
                      <p className="text-xs font-bold text-slate-600 dark:text-slate-500 mb-2">Modelli disponibili</p>
                      <div className="flex flex-wrap gap-1.5">
                        {result.insurer.models.map(m => (
                          <span key={m} className={`px-2 py-1 rounded-md text-[10px] font-bold ${
                            m === model ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 ring-1 ring-rose-300'
                            : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-500'}`}>
                            {MODEL_LABELS[m]}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-600 dark:text-slate-500 mb-2">Confronto franchige</p>
                      <div className="space-y-1">
                        {(ageGroup === '0-18' ? FRANCHISES_CHILD : FRANCHISES).slice(0, 4).map(f => {
                          const p = calculatePremium(result.insurer.id, canton, model, f, ageGroup, withAccident);
                          return p !== null ? (
                            <div key={f} className="flex items-center justify-between text-xs">
                              <span className={`text-slate-500 ${f === effectiveFranchise ? 'font-bold text-slate-800 dark:text-slate-100' : ''}`}>
                                {f} CHF</span>
                              <span className={`font-mono ${f === effectiveFranchise ? 'font-bold text-slate-800 dark:text-slate-100' : 'text-slate-500'}`}>
                                {p.toFixed(2)} CHF/mese</span>
                            </div>) : null;
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-700">
                    <p className="text-xs text-slate-500">{result.insurer.serviceNote}</p>
                    <a href={result.insurer.website} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg transition-colors">
                      <ExternalLink size={12} /> Vai al sito</a>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          <Shield size={48} className="mx-auto mb-3 opacity-30" />
          <p className="font-bold">Nessuna assicurazione trovata</p>
          <p className="text-sm">Modifica i parametri o il termine di ricerca</p>
        </div>
      )}

      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Info size={20} className="text-blue-600" />
          LAMal svizzera vs SSN italiano
        </h3>
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div className="p-4 bg-white/60 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">Scegli LAMal se:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Hai bisogno di cure mediche frequenti in Svizzera</li>
              <li>Vuoi tempi di attesa brevi per specialisti</li>
              <li>Hai famiglia che vive in Svizzera</li>
            </ul>
          </div>
          <div className="p-4 bg-white/60 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">Scegli SSN se:</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>Vuoi risparmiare sul costo sanitario (SSN gratuito)</li>
              <li>Le tue cure mediche sono principalmente in Italia</li>
              <li>Preferisci non pagare premi mensili</li>
            </ul>
          </div>
        </div>
        <div className="p-4 bg-amber-50 dark:bg-amber-950/50 rounded-xl border border-amber-200 dark:border-amber-800">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            {'La scelta tra LAMal e SSN è '}
            <strong>definitiva</strong>
            {'. Hai 3 mesi per decidere. Premi basati su dati BAG 2025. Verifica su '}
            <a href="https://www.priminfo.admin.ch/it/praemien" target="_blank" rel="noopener noreferrer" className="underline font-bold">priminfo.admin.ch</a>.
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
        <h3 className="text-sm font-bold text-slate-600 dark:text-slate-500 uppercase tracking-wider mb-3">
          Modelli assicurativi
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([
            { m: 'standard' as InsuranceModel, desc: 'Libera scelta del medico. Flessibile ma costoso.' },
            { m: 'hausarzt' as InsuranceModel, desc: 'Prima il medico di famiglia. Sconto ~7%.' },
            { m: 'hmo' as InsuranceModel, desc: 'Centro medico convenzionato. Sconto ~12%.' },
            { m: 'telmed' as InsuranceModel, desc: 'Primo contatto telefonico/online. Sconto ~10%.' },
          ]).map(({ m, desc }) => (
            <div key={m} className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
              <p className="text-xs font-bold text-rose-600 dark:text-rose-400">{MODEL_LABELS[m]}</p>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default HealthInsurance;
