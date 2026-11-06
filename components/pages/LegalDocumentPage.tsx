import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { LEGAL_BODY_CLASS, LEGAL_HOME_LABEL, legalLinks, type LegalDocument, type LegalLocale } from '@/services/legal/types';

type Props = { document: LegalDocument; locale: LegalLocale; adsControls?: React.ReactNode };

/** Render reviewed local legal copy; no user-supplied HTML reaches this component. */
export const LegalDocumentPage: React.FC<Props> = ({ document, locale, adsControls }) => (
  <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
    <a href={legalLinks(locale).home} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent">
      <ArrowLeft size={16} aria-hidden="true" />{LEGAL_HOME_LABEL[locale]}
    </a>
    <header className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
      <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">{document.title}</h1>
      {document.updated && <p className="text-sm text-muted mt-2">{document.updated}</p>}
      <div className={`${LEGAL_BODY_CLASS} mt-4`} dangerouslySetInnerHTML={{ __html: document.introHtml }} />
    </header>
    <div className="space-y-6">
      {document.sections.map((section, index) => (
        <section key={section.id ?? index} id={section.id} className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
          <h2 className="text-xl font-bold font-display text-strong mb-4">{section.title}</h2>
          <div className={LEGAL_BODY_CLASS}>
            {section.blocks.map((block, blockIndex) => 'html' in block
              ? <div key={blockIndex} dangerouslySetInnerHTML={{ __html: block.html }} />
              : <React.Fragment key={blockIndex}>{adsControls}</React.Fragment>)}
          </div>
        </section>
      ))}
    </div>
  </div>
);
