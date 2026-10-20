import React from 'react';
import { ArrowLeft, ScrollText } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { useLocale } from '@/services/i18n';
import { METHODOLOGY_COPY } from '@/services/editorialMethodology';

/** The static renderer, SPA and SEO metadata share the same editorial disclosure. */
export const Metodologia: React.FC = () => {
  const nav = useNavigation();
  const [locale] = useLocale();
  const copy = METHODOLOGY_COPY[locale];
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      <button onClick={() => nav.navigateTo('calculator')} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">
        <ArrowLeft size={16} />{copy.back}
      </button>
      <header className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
        <ScrollText className="text-accent mb-4" size={32} />
        <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">{copy.title}</h1>
        <p className="text-subtle leading-relaxed mt-3">{copy.description}</p>
      </header>
      <div className="space-y-6">
        {copy.sections.map(section => (
          <section key={section.id} id={section.id} className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
            <h2 className="text-lg font-bold font-display text-strong mb-3">{section.title}</h2>
            {section.paragraphs.map(paragraph => <p key={paragraph} className="text-sm text-subtle leading-relaxed mt-3">{paragraph}</p>)}
          </section>
        ))}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
          <a href="mailto:redazione@frontaliereticino.ch" className="text-accent hover:underline">redazione@frontaliereticino.ch</a>
          <h2 className="text-lg font-bold font-display text-strong mt-4 mb-3">{copy.links}</h2>
          <div className="flex flex-wrap gap-4 text-sm">
            <button onClick={() => nav.navigateTo('chi-siamo')} className="text-accent hover:underline">{copy.about}</button>
            <button onClick={() => nav.navigateTo('correzioni' as never)} className="text-accent hover:underline">{copy.corrections}</button>
            <button onClick={() => nav.navigateTo('privacy')} className="text-accent hover:underline">Privacy</button>
          </div>
        </div>
      </div>
    </div>
  );
};
export default Metodologia;
