import type { FC } from 'react';
import { useTranslation } from '@/services/i18n';
import { Building2, ExternalLink, Shield, Scale, Users, Phone, Mail, ChevronRight } from 'lucide-react';

interface UnionInfo {
 name: string;
 acronym: string;
 sectors: string;
 website: string;
 monthlyFee: string;
 ticinoContact?: string;
 highlights: string[];
}

const SWISS_UNIONS: UnionInfo[] = [
 {
 name: 'UNIA — Sindacato svizzero',
 acronym: 'UNIA',
 sectors: 'Edilizia, industria, servizi, commercio, trasporti',
 website: 'https://www.unia.ch/it',
 monthlyFee: '~1% del salario lordo',
 ticinoContact: 'Via Cantonale 7, 6500 Bellinzona — 058 817 19 50',
 highlights: [
 'Il più grande sindacato svizzero (185.000 iscritti)',
 'Assistenza legale in caso di licenziamento o controversie',
 'Negoziazione contratti collettivi (CCL)',
 'Consulenza gratuita su busta paga e diritti',
 ],
 },
 {
 name: 'OCST — Organizzazione Cristiano-Sociale Ticinese',
 acronym: 'OCST',
 sectors: 'Tutti i settori in Ticino',
 website: 'https://www.ocst.ch',
 monthlyFee: '~0.8-1% del salario lordo',
 ticinoContact: 'Via Balestra 19, 6900 Lugano — 091 921 15 51',
 highlights: [
 'Specifico per il Canton Ticino — forte radicamento locale',
 'Sportello frontalieri dedicato',
 'Assistenza fiscale e previdenziale',
 'Negoziazione CCL per settori ticinesi',
 ],
 },
 {
 name: 'Syna — Sindacato interprofessionale',
 acronym: 'Syna',
 sectors: 'Industria, artigianato, servizi, commercio',
 website: 'https://www.syna.ch/it',
 monthlyFee: '~0.7% del salario lordo',
 ticinoContact: 'Via Pretorio 11, 6900 Lugano — 058 817 18 18',
 highlights: [
 'Parte del movimento cristiano-sociale',
 'Presente in 23 settori professionali',
 'Consulenza giuridica inclusa',
 'Forte nella Svizzera romanda e italiana',
 ],
 },
 {
 name: 'Transfair — Sindacato del servizio pubblico',
 acronym: 'Transfair',
 sectors: 'Servizio pubblico, trasporti, telecomunicazioni',
 website: 'https://www.transfair.ch/it',
 monthlyFee: '~CHF 20-40/mese',
 highlights: [
 'Specializzato in settore pubblico e parapubblico',
 'Rappresenta dipendenti FFS, Posta, Swisscom',
 'Negoziazione condizioni quadro servizio pubblico',
 ],
 },
];

const ITALIAN_UNIONS: UnionInfo[] = [
 {
 name: 'CGIL — Confederazione Generale Italiana del Lavoro',
 acronym: 'CGIL',
 sectors: 'Tutti i settori',
 website: 'https://www.cgil.it',
 monthlyFee: '~1% del salario netto (tramite patronato INCA)',
 highlights: [
 'Il più grande sindacato italiano (5.5 milioni di iscritti)',
 'Patronato INCA: pratiche fiscali, pensioni, disoccupazione frontalieri',
 'Sedi nelle province di confine (Como, Varese, Verbania)',
 'Assistenza dichiarazione redditi per frontalieri',
 ],
 },
 {
 name: 'CISL — Confederazione Italiana Sindacati Lavoratori',
 acronym: 'CISL',
 sectors: 'Tutti i settori',
 website: 'https://www.cisl.it',
 monthlyFee: '~1% del salario netto',
 highlights: [
 'Secondo sindacato italiano per iscritti',
 'Patronato INAS: pratiche previdenziali e assistenziali',
 'CAF CISL: dichiarazione redditi e 730',
 'Sportelli provincia di Como e Varese',
 ],
 },
 {
 name: 'UIL — Unione Italiana del Lavoro',
 acronym: 'UIL',
 sectors: 'Tutti i settori',
 website: 'https://www.uil.it',
 monthlyFee: '~1% del salario netto',
 highlights: [
 'Terzo sindacato italiano',
 'Patronato ITAL: pratiche previdenziali per frontalieri',
 'CAF UIL: assistenza fiscale',
 'Orientamento su NASpI e disoccupazione transfrontaliera',
 ],
 },
];

const UnionCard: FC<{ union: UnionInfo; country: 'ch' | 'it' }> = ({ union, country }) => {
 const flag = country === 'ch' ? '🇨🇭' : '🇮🇹';
 return (
 <div className="rounded-xl border border-edge bg-surface p-4 hover:shadow-md transition-shadow">
 <div className="flex items-start justify-between mb-3">
 <div>
 <h3 className="font-bold text-heading text-sm">
 {flag} {union.name}
 </h3>
 <p className="text-xs text-muted mt-0.5">{union.sectors}</p>
 </div>
 <a
 href={union.website}
 target="_blank"
 rel="noreferrer"
 className="flex-shrink-0 p-1.5 rounded-lg bg-surface-raised text-slate-500 hover:text-accent transition-colors"
 aria-label={`Visita ${union.acronym}`}
 >
 <ExternalLink size={14} />
 </a>
 </div>
 <div className="space-y-1.5 mb-3">
 {union.highlights.map((h, i) => (
 <div key={i} className="flex items-start gap-2 text-xs text-subtle">
 <ChevronRight size={12} className="text-stripe-500 flex-shrink-0 mt-0.5" />
 <span>{h}</span>
 </div>
 ))}
 </div>
 <div className="flex flex-wrap gap-2 text-xs">
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-subtle text-success">
 💰 {union.monthlyFee}
 </span>
 {union.ticinoContact && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-subtle text-accent">
 📍 {union.ticinoContact.split('—')[0].trim()}
 </span>
 )}
 </div>
 </div>
 );
}

export default function Sindacati() {
 const t = useTranslation();

 return (
 <div className="space-y-8">
 {/* Header */}
 <div className="text-center">
 <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent-subtle text-accent text-sm font-semibold mb-3">
 <Scale size={16} />
 Sindacati per Frontalieri
 </div>
 <h1 className="text-2xl sm:text-3xl font-extrabold text-heading">
 Sindacati Svizzera e Italia per Frontalieri
 </h1>
 <p className="mt-2 text-subtle max-w-2xl mx-auto">
 Confronta i principali sindacati svizzeri e italiani: servizi, costi, sedi in Ticino e zone di confine. Scopri quale sindacato tutela meglio i tuoi diritti da lavoratore frontaliere.
 </p>
 </div>

 {/* Why join a union */}
 <div className="rounded-2xl bg-gradient-to-br from-teal-50 to-stripe-50 dark:from-teal-950/30 dark:to-stripe-950/20 border border-info-border p-6">
 <div className="flex items-center gap-3 mb-4">
 <div className="p-2 bg-info-subtle rounded-xl">
 <Shield className="w-5 h-5 text-info" />
 </div>
 <h2 className="text-lg font-bold text-heading">Perché iscriversi a un sindacato?</h2>
 </div>
 <div className="grid sm:grid-cols-2 gap-3">
 {[
 { icon: Scale, text: 'Assistenza legale in caso di licenziamento, controversie lavorative o discriminazione' },
 { icon: Users, text: 'Negoziazione dei contratti collettivi di lavoro (CCL) che definiscono salari minimi e condizioni' },
 { icon: Phone, text: 'Consulenza gratuita su busta paga, contributi AVS/LPP, assicurazioni e fisco' },
 { icon: Mail, text: 'Supporto per pratiche burocratiche: permessi, disoccupazione NASpI, dichiarazione redditi' },
 ].map(({ icon: Icon, text }, i) => (
 <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-surface/60">
 <Icon size={18} className="text-accent flex-shrink-0 mt-0.5" />
 <span className="text-sm text-body">{text}</span>
 </div>
 ))}
 </div>
 </div>

 {/* Swiss Unions */}
 <div>
 <h2 className="text-xl font-bold text-heading mb-4 flex items-center gap-2">
 🇨🇭 Sindacati Svizzeri
 </h2>
 <div className="grid sm:grid-cols-2 gap-4">
 {SWISS_UNIONS.map((u) => (
 <UnionCard key={u.acronym} union={u} country="ch" />
 ))}
 </div>
 </div>

 {/* Italian Unions */}
 <div>
 <h2 className="text-xl font-bold text-heading mb-4 flex items-center gap-2">
 🇮🇹 Sindacati Italiani
 </h2>
 <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
 {ITALIAN_UNIONS.map((u) => (
 <UnionCard key={u.acronym} union={u} country="it" />
 ))}
 </div>
 </div>

 {/* Frontalier-specific rights */}
 <div className="rounded-2xl border border-edge bg-surface p-6">
 <h2 className="text-lg font-bold text-heading mb-4 flex items-center gap-2">
 <Building2 size={20} className="text-amber-600" />
 Diritti specifici del frontaliere
 </h2>
 <div className="space-y-3 text-sm text-body">
 <div className="p-3 rounded-lg bg-surface-alt/50">
 <strong>Licenziamento:</strong> In Svizzera i termini di preavviso dipendono dall'anzianità (1-3 mesi). Il sindacato verifica la corretta applicazione e può impugnare licenziamenti abusivi.
 </div>
 <div className="p-3 rounded-lg bg-surface-alt/50">
 <strong>Malattia e infortunio:</strong> L'assicurazione contro gli infortuni (LAINF) è obbligatoria. Il sindacato aiuta a ottenere il corretto indennizzo e verifica le prestazioni dell'assicurazione malattia.
 </div>
 <div className="p-3 rounded-lg bg-surface-alt/50">
 <strong>Disoccupazione:</strong> I frontalieri hanno diritto alla NASpI italiana. I patronati sindacali (INCA, INAS, ITAL) gestiscono l'intera pratica di richiesta.
 </div>
 <div className="p-3 rounded-lg bg-surface-alt/50">
 <strong>Tassazione:</strong> Il regime fiscale dei nuovi frontalieri (post 17/07/2023) prevede tassazione concorrente. Il sindacato offre consulenza sul regime applicabile e sulla dichiarazione dei redditi.
 </div>
 </div>
 </div>

 {/* CTA links */}
 <div className="flex flex-wrap gap-3 justify-center text-sm">
 <a href="/guida-frontaliere/" className="inline-flex items-center gap-1 px-4 py-2 rounded-xl bg-stripe-600 text-white font-semibold hover:bg-stripe-700 transition-colors">
 Guida Frontaliere <ChevronRight size={14} />
 </a>
 <a href="/contratti-lavoro-svizzera/" className="inline-flex items-center gap-1 px-4 py-2 rounded-xl bg-surface-raised text-strong font-semibold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">
 Contratti di Lavoro <ChevronRight size={14} />
 </a>
 <a href="/tasse-e-pensione/" className="inline-flex items-center gap-1 px-4 py-2 rounded-xl bg-surface-raised text-strong font-semibold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">
 Fisco e Previdenza <ChevronRight size={14} />
 </a>
 </div>
 </div>
 );
}
