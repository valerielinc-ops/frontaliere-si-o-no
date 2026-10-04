import React from 'react';
import { useTranslation } from '@/services/i18n';
import { getTermsLegalDocument } from '@/services/legal/terms';
import { LegalDocumentPage } from './LegalDocumentPage';

export const TermsOfService: React.FC = () => {
  const { locale } = useTranslation();
  return <LegalDocumentPage document={getTermsLegalDocument(locale)} locale={locale} />;
};
