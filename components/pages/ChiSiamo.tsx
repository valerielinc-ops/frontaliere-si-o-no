import React from 'react';
import { Users, BookOpen, Shield, Globe, ArrowLeft, CheckCircle2, Newspaper, BarChart3, FileSearch, UserCircle, DollarSign, Award, Mail, Linkedin, ExternalLink } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { useLocale } from '@/services/i18n';
import { buildPath, type ActiveTab } from '@/services/router';
import { AUTHORS } from '@/data/authors';
import { localizeAuthor } from '@/data/authorLocales';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { CHI_SIAMO_COPY } from './chiSiamoCopy';

/** Localised editorial masthead, policy, sources and contact details. */
export const ChiSiamo: React.FC = () => {
 const nav = useNavigation();
 const [locale] = useLocale();
 const copy = CHI_SIAMO_COPY[locale];
 const authors = AUTHORS.map(author => localizeAuthor(author, locale));
 const linkClass = 'text-accent hover:underline font-medium';
 const localLink = (tab: ActiveTab, label: string) => (
 <a href={buildPath({ activeTab: tab }, locale)} className={linkClass}
 onClick={(event) => {
 if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
 event.preventDefault(); nav.navigateTo(tab);
 }}>{label}</a>
 );
 const authorLink = (event: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
 if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
 event.preventDefault(); nav.navigateTo('autore', slug);
 };
 const sectionBody = (section: { paragraphs: string[]; bullets?: string[] }) => <>
 {section.paragraphs.map(paragraph => <p key={paragraph} className="mt-3 first:mt-0">{paragraph}</p>)}
 {section.bullets && <ul className="mt-3 space-y-2">{section.bullets.map(bullet => <BulletItem key={bullet}>{bullet}</BulletItem>)}</ul>}
 </>;
 return (
 <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
 <button onClick={() => nav.navigateTo('calculator')} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors">
 <ArrowLeft size={16} />{copy.back}
 </button>
 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
 <div className="flex items-center gap-4 mb-4">
 <div className="p-3 bg-info rounded-2xl shadow-lg"><Users className="text-on-accent" size={32} /></div>
 <div><h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">{copy.title}</h1><p className="text-sm text-muted mt-1">{copy.subtitle}</p></div>
 </div>
 <p className="text-subtle leading-relaxed">{copy.intro}</p>
 </div>
 <div className="space-y-6">
 <Section icon={Globe} title={copy.mission.title}>{sectionBody(copy.mission)}</Section>
 <Section icon={Newspaper} title={copy.editorial.title}>{sectionBody(copy.editorial)}</Section>
 <Section icon={BarChart3} title={copy.expertise.title}>{sectionBody(copy.expertise)}</Section>
 <Section icon={FileSearch} title={copy.methodology.title}>
 {sectionBody(copy.methodology)}<p className="mt-4 text-xs text-muted">{copy.parameterNote}</p>
 </Section>
 <Section icon={BookOpen} title={copy.sourcesTitle}>
 <p>{copy.sourcesIntro}</p>
 <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
 {copy.sources.map(source => <div key={source} className="flex items-start gap-2 text-sm text-subtle"><CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" /><span>{source}</span></div>)}
 </div>
 </Section>
 <Section icon={UserCircle} title={copy.signatures}>
 <p>{copy.signaturesIntro}</p>
 <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
 {authors.map(author => <li key={author.slug}>
 <a href={buildPath({ activeTab: 'autore', author: author.slug }, locale)} onClick={event => authorLink(event, author.slug)} className="flex items-center gap-3 p-3 rounded-xl bg-info/10 hover:bg-info/20 transition-colors no-underline">
 <img src={cdnImageUrl(author.photoPath)} alt={`${copy.photo} ${author.name}`} width={48} height={48} loading="lazy" decoding="async" className="w-12 h-12 rounded-full object-cover border border-edge shrink-0" />
 <span className="min-w-0"><span className="block text-sm font-semibold text-strong truncate">{author.name}</span><span className="block text-xs text-muted truncate">{author.role}</span></span>
 </a></li>)}
 </ul>
 </Section>
 <Section icon={Shield} title={copy.privacyTitle}><p>{copy.privacy}{' '}{localLink('privacy', copy.privacyLink)}.</p></Section>
 <Section id="finanziamento" icon={DollarSign} title={copy.funding.title}>
 {sectionBody(copy.funding)}
 <p className="mt-4"><a href="https://policies.google.com/technologies/ads" target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 ${linkClass}`}>{copy.ads}<ExternalLink size={12} aria-hidden="true" /></a></p>
 </Section>
 <Section id="standard-giornalistici" icon={Award} title={copy.standards.title}>
 {sectionBody(copy.standards)}
 <ul className="mt-2 space-y-2">
 <BulletItem>{copy.ai}{' '}{localLink('metodologia', copy.methodologyLink)}.</BulletItem>
 <BulletItem>{copy.corrections}{' '}{localLink('correzioni', copy.correctionsLink)}.</BulletItem>
 </ul>
 </Section>
 <Section id="team" icon={Users} title={copy.team}>
 <p className="mb-4">{copy.teamIntro}</p>
 <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {authors.map(author => <li key={author.slug} className="flex items-start gap-3 p-3 rounded-xl bg-surface-alt border border-edge">
 <a href={buildPath({ activeTab: 'autore', author: author.slug }, locale)} onClick={event => authorLink(event, author.slug)} className="shrink-0" aria-label={`${copy.authorPage} ${author.name}`}>
 <img src={cdnImageUrl(author.photoPath)} alt={`${copy.photo} ${author.name}`} width={64} height={64} loading="lazy" decoding="async" className="w-16 h-16 rounded-full object-cover border border-edge" /></a>
 <div className="min-w-0 flex-1">
 <a href={buildPath({ activeTab: 'autore', author: author.slug }, locale)} onClick={event => authorLink(event, author.slug)} className="block text-sm font-semibold text-strong hover:text-accent transition-colors no-underline">{author.name}</a>
 <p className="text-xs text-muted mt-0.5">{author.role}</p>
 {author.social.linkedin && <a href={author.social.linkedin} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline" aria-label={`${copy.linkedin} ${author.name}`}><Linkedin size={12} aria-hidden="true" />LinkedIn</a>}
 </div></li>)}
 </ul>
 </Section>
 <Section id="contatti" icon={Mail} title={copy.contacts}>
 <ul className="space-y-2">
 <BulletItem><strong>{copy.correctionContact}</strong>:{' '}<a href="mailto:redazione@frontaliereticino.ch" className={linkClass}>redazione@frontaliereticino.ch</a>{' '}{copy.orPage}{' '}{localLink('correzioni', copy.correctionsLink)}.</BulletItem>
 <BulletItem><strong>{copy.editorialContact}</strong>:{' '}<a href="mailto:redazione@frontaliereticino.ch" className={linkClass}>redazione@frontaliereticino.ch</a>.</BulletItem>
 <BulletItem>{copy.urgent}{' '}{localLink('metodologia', copy.methodologyLink)}.</BulletItem>
 </ul>
 <p className="mt-4 text-xs text-muted">{copy.footer}</p>
 </Section>
 </div>
 </div>
 );
};

function Section({ id, icon: Icon, title, children }: { id?: string; icon: React.FC<{ size?: number; className?: string }>; title: string; children: React.ReactNode }) {
 return <section id={id} className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm scroll-mt-24">
 <div className="flex items-center gap-3 mb-4"><Icon size={20} className="text-accent" /><h2 className="text-lg font-bold font-display text-strong">{title}</h2></div>
 <div className="text-sm text-subtle leading-relaxed">{children}</div>
 </section>;
}

function BulletItem({ children }: { children: React.ReactNode }) {
 return <li className="flex items-start gap-2"><CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" /><span>{children}</span></li>;
}

export default ChiSiamo;
