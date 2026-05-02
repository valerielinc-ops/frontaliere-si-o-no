import React from 'react';
import { Users, BookOpen, Shield, Globe, ArrowLeft, CheckCircle2, Newspaper, BarChart3, FileSearch, UserCircle, DollarSign, Award, Mail, Linkedin, ExternalLink } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { AUTHORS } from '@/data/authors';

/**
 * ChiSiamo — /chi-siamo/ About page.
 *
 * Required for E-E-A-T compliance: article:author OG tags point here.
 * Contains: mission, editorial policy, data sources, expertise, contact info.
 * Structured data: AboutPage + Organization schema.
 */
export const ChiSiamo: React.FC = () => {
 const nav = useNavigation();
 return (
 <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
 {/* Back Button */}
 <button
 onClick={() => nav.navigateTo('calculator')}
 className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
 >
 <ArrowLeft size={16} />
 Torna alla Home
 </button>

 {/* Header */}
 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-info rounded-2xl shadow-lg">
 <Users className="text-on-accent" size={32} />
 </div>
 <div>
 <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">Chi Siamo</h1>
 <p className="text-sm text-muted mt-1">Redazione Frontaliere Ticino</p>
 </div>
 </div>
 <p className="text-subtle leading-relaxed">
 <strong>Frontaliere Ticino</strong> è la piattaforma di riferimento per i lavoratori frontalieri
 italiani in Canton Ticino. Forniamo strumenti di calcolo, informazioni fiscali, offerte di lavoro
 e notizie quotidiane sul confine italo-svizzero.
 </p>
 </div>

 <div className="space-y-6">
 {/* Mission */}
 <Section icon={Globe} title="La nostra missione">
 <p>
 Aiutare chi lavora o vuole lavorare in Ticino a prendere decisioni informate. Ogni giorno
 pubblichiamo articoli, guide e aggiornamenti su fisco, lavoro, trasporti e vita quotidiana
 per i frontalieri delle province di Como, Varese e del Verbano-Cusio-Ossola.
 </p>
 <p className="mt-3">
 I nostri strumenti — dal calcolatore stipendio al comparatore costo della vita — sono
 gratuiti e utilizzati da oltre 100.000 utenti ogni mese.
 </p>
 </Section>

 {/* Editorial Policy */}
 <Section icon={Newspaper} title="Politica editoriale">
 <p>
 La redazione segue principi di accuratezza e trasparenza:
 </p>
 <ul className="mt-3 space-y-2">
 <BulletItem>Ogni articolo è basato su fonti verificabili: comunicati ufficiali, atti parlamentari, dati SECO/UST, normative cantonali e federali</BulletItem>
 <BulletItem>Le citazioni sono riportate verbatim dalle fonti originali</BulletItem>
 <BulletItem>I dati numerici (aliquote, importi, scadenze) vengono verificati con le fonti primarie prima della pubblicazione</BulletItem>
 <BulletItem>Ogni articolo include il link alla fonte originale</BulletItem>
 <BulletItem>Non pubblichiamo contenuto sensazionalistico o clickbait</BulletItem>
 </ul>
 </Section>

 {/* Expertise */}
 <Section icon={BarChart3} title="Competenze e specializzazione">
 <p>
 La redazione è specializzata in:
 </p>
 <ul className="mt-3 space-y-2">
 <BulletItem>Fiscalità transfrontaliera (accordo Italia-Svizzera sui frontalieri, tassazione alla fonte, IRPEF)</BulletItem>
 <BulletItem>Diritto del lavoro svizzero e italiano applicato ai frontalieri</BulletItem>
 <BulletItem>Previdenza sociale: AVS/AI, assegni familiari, indennità di disoccupazione</BulletItem>
 <BulletItem>Assicurazione sanitaria: LAMal, sistema sanitario ticinese, tassa salute</BulletItem>
 <BulletItem>Mercato del lavoro ticinese: settori, salari, tendenze occupazionali</BulletItem>
 <BulletItem>Trasporti e infrastrutture: valichi, traffico, trasporto pubblico TILO/FFS</BulletItem>
 </ul>
 </Section>

 {/* Methodology */}
 <Section icon={FileSearch} title="Metodologia">
 <p>
 Tutti i calcoli e le analisi pubblicate su Frontaliere Ticino sono basati su fonti ufficiali
 svizzere e italiane, con aggiornamento costante dei parametri fiscali, previdenziali e assicurativi.
 </p>
 <p className="mt-3">
 Il nostro approccio metodologico segue tre principi fondamentali:
 </p>
 <ul className="mt-3 space-y-2">
 <BulletItem>
 <strong>Fonti primarie</strong>: aliquote fiscali, tabelle contributive e parametri
 previdenziali provengono direttamente dalle amministrazioni competenti (ESTV, INPS, Agenzia
 delle Entrate, AFC Canton Ticino)
 </BulletItem>
 <BulletItem>
 <strong>Verifica incrociata</strong>: ogni dato viene confrontato con almeno due fonti
 indipendenti prima della pubblicazione nei nostri calcolatori
 </BulletItem>
 <BulletItem>
 <strong>Aggiornamento continuo</strong>: i parametri vengono aggiornati entro 48 ore dalla
 pubblicazione ufficiale delle nuove tabelle e aliquote
 </BulletItem>
 </ul>
 <p className="mt-4 text-xs text-muted">
 Ultimo aggiornamento parametri: 2026. I dati sono forniti a scopo informativo e non
 sostituiscono la consulenza di un professionista fiscale abilitato.
 </p>
 </Section>

 {/* Data Sources */}
 <Section icon={BookOpen} title="Fonti dei Dati">
 <p>
 Per garantire l'accuratezza delle informazioni, utilizziamo esclusivamente fonti istituzionali e verificabili:
 </p>
 <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
 {[
 'ESTV — Amministrazione federale delle contribuzioni',
 'UST — Ufficio federale di statistica',
 'INPS — Istituto Nazionale Previdenza Sociale',
 'Agenzia delle Entrate (Italia)',
 'AFC Canton Ticino — Divisione delle contribuzioni',
 'SUVA — Assicurazione infortuni',
 'SECO — Segretariato di Stato dell\'economia',
 'Canton Ticino (ti.ch)',
 'Parlamento federale svizzero',
 'Gran Consiglio ticinese',
 'Cassa cantonale di compensazione AVS',
 'TomTom Traffic API',
 'Agenzie stampa: RSI, Corriere del Ticino, LaRegione',
 ].map((source) => (
 <div key={source} className="flex items-start gap-2 text-sm text-subtle">
 <CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" />
 <span>{source}</span>
 </div>
 ))}
 </div>
 </Section>

 {/* Editorial Team — links to author profile pages (Google News A1 / E-E-A-T) */}
 <Section icon={UserCircle} title="Redazione e firme">
 <p>
 Le firme editoriali di Frontaliere Ticino. Ogni articolo è attribuito a un
 autore con responsabilità sui contenuti pubblicati.
 </p>
 <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
 {AUTHORS.map((author) => (
 <li key={author.slug}>
 <a
 href={`/autori/${author.slug}/`}
 onClick={(e) => { e.preventDefault(); nav.navigateTo('autore' as any, author.slug); }}
 className="flex items-center gap-3 p-3 rounded-xl bg-info/10 hover:bg-info/20 transition-colors no-underline"
 >
 <img
 src={author.photoPath}
 alt={`Foto di ${author.name}`}
 width={48}
 height={48}
 loading="lazy"
 decoding="async"
 className="w-12 h-12 rounded-full object-cover border border-edge shrink-0"
 />
 <span className="min-w-0">
 <span className="block text-sm font-semibold text-strong truncate">{author.name}</span>
 <span className="block text-xs text-muted truncate">{author.role}</span>
 </span>
 </a>
 </li>
 ))}
 </ul>
 </Section>

 {/* Privacy & Trust */}
 <Section icon={Shield} title="Privacy e trasparenza">
 <p>
 Non raccogliamo dati personali sensibili. I calcoli fiscali avvengono interamente nel browser.
 Per maggiori dettagli, consulta la nostra{' '}
 <button
 onClick={() => nav.navigateTo('privacy')}
 className="text-accent hover:underline font-medium"
 >
 Privacy Policy
 </button>.
 </p>
 </Section>

 {/* B2 — Funding & editorial independence (Google News transparency) */}
 <section id="finanziamento" className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm scroll-mt-24">
 <div className="flex items-center gap-3 mb-4">
 <DollarSign size={20} className="text-accent" />
 <h2 className="text-lg font-bold font-display text-strong">Finanziamento e Indipendenza Editoriale</h2>
 </div>
 <div className="text-sm text-subtle leading-relaxed">
 <ul className="space-y-2">
 <BulletItem>
 Il sito è finanziato tramite pubblicità contestuale (Google AdSense).
 </BulletItem>
 <BulletItem>
 Non riceviamo compensi da banche, casse malati, datori di lavoro o
 istituzioni citati negli articoli.
 </BulletItem>
 <BulletItem>
 Nessun contenuto sponsorizzato: gli articoli redazionali non sono mai
 pubblicità mascherata. Se in futuro venissero pubblicati contenuti
 sponsorizzati, sarebbero chiaramente etichettati.
 </BulletItem>
 <BulletItem>
 La redazione è editorialmente indipendente dagli inserzionisti.
 </BulletItem>
 </ul>
 <p className="mt-4">
 <a
 href="https://policies.google.com/technologies/ads"
 target="_blank"
 rel="noopener noreferrer"
 className="inline-flex items-center gap-1 text-accent hover:underline font-medium"
 >
 Politica pubblicitaria AdSense
 <ExternalLink size={12} aria-hidden="true" />
 </a>
 </p>
 </div>
 </section>

 {/* B2 — Editorial standards (Google News transparency) */}
 <section id="standard-giornalistici" className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm scroll-mt-24">
 <div className="flex items-center gap-3 mb-4">
 <Award size={20} className="text-accent" />
 <h2 className="text-lg font-bold font-display text-strong">I Nostri Standard Giornalistici</h2>
 </div>
 <div className="text-sm text-subtle leading-relaxed">
 <ul className="space-y-2">
 <BulletItem>
 <strong>Accuratezza</strong>: ogni affermazione factuale deve essere
 supportata da fonti verificabili.
 </BulletItem>
 <BulletItem>
 <strong>Fact-checking</strong>: usiamo fonti primarie (AFC, UST, USTAT,
 Gazzetta Ufficiale, comunicati stampa istituzionali).
 </BulletItem>
 <BulletItem>
 <strong>Separazione fatti/opinioni</strong>: le analisi e i commenti
 sono chiaramente distinti dai fatti.
 </BulletItem>
 <BulletItem>
 <strong>Attribuzioni</strong>: le dichiarazioni di persone o istituzioni
 sono sempre attribuite alla fonte originale.
 </BulletItem>
 <BulletItem>
 <strong>Uso dell'IA</strong>: utilizziamo strumenti di IA generativa per
 bozze iniziali; ogni articolo è revisionato dalla redazione. Vedi la
 nostra{' '}
 <a
 href="/metodologia/"
 className="text-accent hover:underline font-medium"
 >
 Metodologia
 </a>
 .
 </BulletItem>
 <BulletItem>
 <strong>Correzioni</strong>: gli errori vengono corretti tempestivamente
 e tracciati nel{' '}
 <a
 href="/correzioni/"
 onClick={(e) => { e.preventDefault(); nav.navigateTo('correzioni' as any); }}
 className="text-accent hover:underline font-medium"
 >
 registro pubblico delle correzioni
 </a>
 .
 </BulletItem>
 </ul>
 </div>
 </section>

 {/* B2 — Editorial team cards (Google News masthead) */}
 <section id="team" className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm scroll-mt-24">
 <div className="flex items-center gap-3 mb-4">
 <Users size={20} className="text-accent" />
 <h2 className="text-lg font-bold font-display text-strong">Il Team Editoriale</h2>
 </div>
 <div className="text-sm text-subtle leading-relaxed">
 <p className="mb-4">
 Le firme responsabili dei contenuti pubblicati su Frontaliere Ticino. Ogni
 autore ha una pagina dedicata con biografia, area di competenza e
 cronologia degli articoli firmati.
 </p>
 <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {AUTHORS.map((author) => (
 <li
 key={author.slug}
 className="flex items-start gap-3 p-3 rounded-xl bg-surface-alt border border-edge"
 >
 <a
 href={`/autori/${author.slug}/`}
 onClick={(e) => { e.preventDefault(); nav.navigateTo('autore' as any, author.slug); }}
 className="shrink-0"
 aria-label={`Pagina autore di ${author.name}`}
 >
 <img
 src={author.photoPath}
 alt={`Foto di ${author.name}`}
 width={64}
 height={64}
 loading="lazy"
 decoding="async"
 className="w-16 h-16 rounded-full object-cover border border-edge"
 />
 </a>
 <div className="min-w-0 flex-1">
 <a
 href={`/autori/${author.slug}/`}
 onClick={(e) => { e.preventDefault(); nav.navigateTo('autore' as any, author.slug); }}
 className="block text-sm font-semibold text-strong hover:text-accent transition-colors no-underline"
 >
 {author.name}
 </a>
 <p className="text-xs text-muted mt-0.5">{author.role}</p>
 {author.social.linkedin && (
 <a
 href={author.social.linkedin}
 target="_blank"
 rel="noopener noreferrer"
 className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
 aria-label={`Profilo LinkedIn di ${author.name}`}
 >
 <Linkedin size={12} aria-hidden="true" />
 LinkedIn
 </a>
 )}
 </div>
 </li>
 ))}
 </ul>
 </div>
 </section>

 {/* B2 — Contacts & reports (Google News transparency) */}
 <section id="contatti" className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm scroll-mt-24">
 <div className="flex items-center gap-3 mb-4">
 <Mail size={20} className="text-accent" />
 <h2 className="text-lg font-bold font-display text-strong">Contatti e Segnalazioni</h2>
 </div>
 <div className="text-sm text-subtle leading-relaxed">
 <ul className="space-y-2">
 <BulletItem>
 <strong>Per correzioni</strong>:{' '}
 <a
 href="mailto:redazione@frontaliereticino.ch"
 className="text-accent hover:underline font-medium"
 >
 redazione@frontaliereticino.ch
 </a>{' '}
 o la pagina{' '}
 <a
 href="/correzioni/"
 onClick={(e) => { e.preventDefault(); nav.navigateTo('correzioni' as any); }}
 className="text-accent hover:underline font-medium"
 >
 /correzioni/
 </a>
 .
 </BulletItem>
 <BulletItem>
 <strong>Per domande editoriali</strong>:{' '}
 <a
 href="mailto:redazione@frontaliereticino.ch"
 className="text-accent hover:underline font-medium"
 >
 redazione@frontaliereticino.ch
 </a>
 .
 </BulletItem>
 <BulletItem>
 <strong>Per segnalazioni urgenti</strong>: usiamo il processo descritto
 nella{' '}
 <a
 href="/metodologia/"
 className="text-accent hover:underline font-medium"
 >
 Metodologia
 </a>
 .
 </BulletItem>
 </ul>
 <p className="mt-4 text-xs text-muted">
 Frontaliere Ticino · Ticino, Svizzera · Fondata nel 2024
 </p>
 </div>
 </section>
 </div>
 </div>
 );
};

/* ── Reusable sub-components ── */

function Section({ icon: Icon, title, children }: { icon: React.FC<{ size?: number; className?: string }>; title: string; children: React.ReactNode }) {
 return (
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <Icon size={20} className="text-accent" />
 <h2 className="text-lg font-bold font-display text-strong">{title}</h2>
 </div>
 <div className="text-sm text-subtle leading-relaxed">
 {children}
 </div>
 </div>
 );
}

function BulletItem({ children }: { children: React.ReactNode }) {
 return (
 <li className="flex items-start gap-2">
 <CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" />
 <span>{children}</span>
 </li>
 );
}

export default ChiSiamo;
