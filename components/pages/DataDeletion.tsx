import React from 'react';
import { useTranslation } from '@/services/i18n';
import { getDataDeletionLegalDocument } from '@/services/legal/dataDeletion';
import { LegalDocumentPage } from './LegalDocumentPage';

/** Human-readable deletion instructions, not a callback endpoint or deletion receipt. */
export const DataDeletion: React.FC = () => {
  const { locale } = useTranslation();
  return <LegalDocumentPage document={getDataDeletionLegalDocument(locale)} locale={locale} />;
};
