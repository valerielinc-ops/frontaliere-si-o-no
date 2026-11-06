import React from 'react';
import { useTranslation } from '@/services/i18n';
import { revenueNote } from '@/services/revenueDisclosure';

/** Visible note for pages with partner links; same copy as the static pages. */
export default function RevenueNote({ className = '' }: { className?: string }) {
  const { locale } = useTranslation();
  const note = revenueNote(locale);
  return (
    <p role="note" className={`text-xs text-muted ${className}`}>
      {note.text} <a href={note.href} className="text-accent hover:underline">{note.link}</a>
    </p>
  );
}
