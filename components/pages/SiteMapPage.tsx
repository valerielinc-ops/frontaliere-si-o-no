import React from 'react';
import { Map, Calculator, Scale, BookOpen, Heart, BarChart3, FileText, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';
import type { AppRoute } from '@/services/router';

function nav(route: AppRoute) {
 const href = buildPath(route);
 return (e: React.MouseEvent) => {
 e.preventDefault();
 window.history.pushState(null, '', href);
 window.dispatchEvent(new PopStateEvent('popstate'));
 };
}

interface LinkItem { label: string; route: AppRoute }
interface Section { icon: React.ReactNode; title: string; links: LinkItem[] }

export default function SiteMapPage() {
 const { t } = useTranslation();

 const sections: Section[] = [
 {
 icon: <Calculator className="w-5 h-5 text-stripe-600" />,
 title: t('sitemap.section.calculators'),
 links: [
 { label: t('sitemap.link.calculator'), route: { activeTab: 'calculator' } },
 { label: t('sitemap.link.whatif'), route: { activeTab: 'calculator', calcolatoreSubTab: 'whatif' } },
 { label: t('sitemap.link.payslip'), route: { activeTab: 'calculator', calcolatoreSubTab: 'payslip' } },
 { label: t('sitemap.link.ral'), route: { activeTab: 'calculator', calcolatoreSubTab: 'ral' } },
 { label: t('sitemap.link.bonus'), route: { activeTab: 'calculator', calcolatoreSubTab: 'bonus' } },
 { label: t('sitemap.link.parentalLeave'), route: { activeTab: 'calculator', calcolatoreSubTab: 'parental-leave' } },
 { label: t('sitemap.link.residency'), route: { activeTab: 'calculator', calcolatoreSubTab: 'residency' } },
 { label: t('sitemap.link.salaryQuiz'), route: { activeTab: 'calculator', calcolatoreSubTab: 'salary-quiz' } },
 ],
 },
 {
 icon: <Scale className="w-5 h-5 text-emerald-600" />,
 title: t('sitemap.section.comparators'),
 links: [
 { label: t('sitemap.link.exchange'), route: { activeTab: 'confronti', confrontiSubTab: 'exchange' } },
 { label: t('sitemap.link.banks'), route: { activeTab: 'confronti', confrontiSubTab: 'banks' } },
 { label: t('sitemap.link.health'), route: { activeTab: 'confronti', confrontiSubTab: 'health' } },
 { label: t('sitemap.link.mobile'), route: { activeTab: 'confronti', confrontiSubTab: 'mobile' } },
 { label: t('sitemap.link.shopping'), route: { activeTab: 'confronti', confrontiSubTab: 'shopping' } },
 { label: t('sitemap.link.costOfLiving'), route: { activeTab: 'confronti', confrontiSubTab: 'cost-of-living' } },
 { label: t('sitemap.link.jobs'), route: { activeTab: 'confronti', confrontiSubTab: 'jobs' } },
 { label: t('sitemap.link.renovation'), route: { activeTab: 'confronti', confrontiSubTab: 'renovation' } },
 ],
 },
 {
 icon: <FileText className="w-5 h-5 text-stripe-600" />,
 title: t('sitemap.section.fiscal'),
 links: [
 { label: t('sitemap.link.taxReturn'), route: { activeTab: 'fisco', fiscoSubTab: 'tax-return' } },
 { label: t('sitemap.link.withholdingRates'), route: { activeTab: 'fisco', fiscoSubTab: 'withholding-rates' } },
 { label: t('sitemap.link.calendar'), route: { activeTab: 'fisco', fiscoSubTab: 'calendar' } },
 { label: t('sitemap.link.holidays'), route: { activeTab: 'fisco', fiscoSubTab: 'holidays' } },
 { label: t('sitemap.link.ristorni'), route: { activeTab: 'fisco', fiscoSubTab: 'ristorni' } },
 { label: t('sitemap.link.pension'), route: { activeTab: 'fisco', fiscoSubTab: 'pension' } },
 { label: t('sitemap.link.pillar3'), route: { activeTab: 'fisco', fiscoSubTab: 'pillar3' } },
 { label: t('sitemap.link.quiz'), route: { activeTab: 'fisco', fiscoSubTab: 'quiz' } },
 ],
 },
 {
 icon: <BookOpen className="w-5 h-5 text-amber-600" />,
 title: t('sitemap.section.guides'),
 links: [
 { label: t('sitemap.link.firstDay'), route: { activeTab: 'guida', guidaSubTab: 'first-day' } },
 { label: t('sitemap.link.permits'), route: { activeTab: 'guida', guidaSubTab: 'permits' } },
 { label: t('sitemap.link.border'), route: { activeTab: 'guida', guidaSubTab: 'border' } },
 { label: t('sitemap.link.unemployment'), route: { activeTab: 'guida', guidaSubTab: 'unemployment' } },
 { label: t('sitemap.link.carTransfer'), route: { activeTab: 'guida', guidaSubTab: 'car-transfer' } },
 { label: t('sitemap.link.carCost'), route: { activeTab: 'guida', guidaSubTab: 'car-cost' } },
 { label: t('sitemap.link.permitCompare'), route: { activeTab: 'guida', guidaSubTab: 'permit-compare' } },
 { label: t('sitemap.link.borderMap'), route: { activeTab: 'guida', guidaSubTab: 'border-map' } },
 ],
 },
 {
 icon: <Heart className="w-5 h-5 text-rose-600" />,
 title: t('sitemap.section.life'),
 links: [
 { label: t('sitemap.link.livingCH'), route: { activeTab: 'vita', vitaSubTab: 'living-ch' } },
 { label: t('sitemap.link.livingIT'), route: { activeTab: 'vita', vitaSubTab: 'living-it' } },
 { label: t('sitemap.link.companies'), route: { activeTab: 'vita', vitaSubTab: 'companies' } },
 { label: t('sitemap.link.schools'), route: { activeTab: 'vita', vitaSubTab: 'schools' } },
 { label: t('sitemap.link.nursery'), route: { activeTab: 'vita', vitaSubTab: 'nursery' } },
 { label: t('sitemap.link.places'), route: { activeTab: 'vita', vitaSubTab: 'places' } },
 { label: t('sitemap.link.transport'), route: { activeTab: 'vita', vitaSubTab: 'transport' } },
 { label: t('sitemap.link.municipalities'), route: { activeTab: 'vita', vitaSubTab: 'municipalities' } },
 ],
 },
 {
 icon: <BarChart3 className="w-5 h-5 text-cyan-600" />,
 title: t('sitemap.section.stats'),
 links: [
 { label: t('sitemap.link.overview'), route: { activeTab: 'stats' } },
 { label: t('sitemap.link.livability'), route: { activeTab: 'stats', statsSubTab: 'livability' } },
 { label: t('sitemap.link.salaryCompare'), route: { activeTab: 'stats', statsSubTab: 'salary-compare' } },
 { label: t('sitemap.link.trafficHistory'), route: { activeTab: 'stats', statsSubTab: 'traffic-history' } },
 { label: t('sitemap.link.fuelPrices'), route: { activeTab: 'stats', statsSubTab: 'fuel-prices' } },
 ],
 },
 {
 icon: <ExternalLink className="w-5 h-5 text-subtle" />,
 title: t('sitemap.section.other'),
 links: [
 { label: t('sitemap.link.blog'), route: { activeTab: 'blog' } },
 { label: t('sitemap.link.glossario'), route: { activeTab: 'glossario' } },
 { label: t('sitemap.link.faq'), route: { activeTab: 'faq' } },
 { label: t('sitemap.link.forum'), route: { activeTab: 'forum' } },
 { label: t('sitemap.link.contact'), route: { activeTab: 'contact' } },
 { label: t('sitemap.link.privacy'), route: { activeTab: 'privacy' } },
 ],
 },
 ];

 return (
 <div className="space-y-6">
 <div className="text-center">
 <div className="inline-flex items-center gap-2 px-3 py-1 bg-accent-subtle rounded-full text-sm text-accent font-medium mb-3">
 <Map className="w-4 h-4" />
 {t('sitemap.badge')}
 </div>
 <h1 className="text-2xl font-bold text-heading">{t('sitemap.title')}</h1>
 <p className="text-sm text-subtle mt-1 max-w-xl mx-auto">{t('sitemap.subtitle')}</p>
 </div>

 <div className="grid gap-6 md:grid-cols-2">
 {sections.map((section) => (
 <div key={section.title} className="bg-surface rounded-xl border border-edge p-5">
 <div className="flex items-center gap-2 mb-3">
 {section.icon}
 <h2 className="text-lg font-bold text-heading">{section.title}</h2>
 </div>
 <ul className="space-y-1.5">
 {section.links.map((link) => {
 const href = buildPath(link.route);
 return (
 <li key={href}>
 <a
 href={href}
 onClick={nav(link.route)}
 className="text-sm text-accent hover:text-stripe-900 dark:hover:text-stripe-300 hover:underline"
 >
 {link.label}
 </a>
 </li>
 );
 })}
 </ul>
 </div>
 ))}
 </div>
 </div>
 );
}
