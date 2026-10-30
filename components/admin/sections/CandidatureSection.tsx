import { useState } from 'react';
import AssistedApplicationAdmin from '@/components/pages/AssistedApplicationAdmin';
import { useAdminNavigation } from '@/components/admin/lib/AdminNavigationContext';
import { relativeTime } from '@/components/admin/lib/formatters';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';

export default function CandidatureSection() {
  const { locationKey } = useAdminNavigation();
  const [queueSummary, setQueueSummary] = useState<{ count: number; updatedAt: string } | null>(null);
  const queueLabel = queueSummary ? `${queueSummary.count} ordini nella coda assistita` : 'Coda assistita non ancora disponibile';
  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Candidature assistite" summary={`${queueLabel} · ${queueSummary ? `aggiornato ${relativeTime(queueSummary.updatedAt) || 'di recente'}` : 'non ancora aggiornato'}`} />
      <AssistedApplicationAdmin locationKey={locationKey} onSummary={setQueueSummary} />
    </div>
  );
}
