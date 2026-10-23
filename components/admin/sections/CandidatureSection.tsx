import AssistedApplicationAdmin from '@/components/pages/AssistedApplicationAdmin';
import ApplicationConciergeAdmin from '@/components/pages/ApplicationConciergeAdmin';
import { useAdminNavigation } from '@/components/admin/lib/AdminNavigationContext';

export default function CandidatureSection() {
  const { locationKey } = useAdminNavigation();
  return (
    <div className="space-y-6">
      <AssistedApplicationAdmin locationKey={locationKey} />
      <ApplicationConciergeAdmin />
    </div>
  );
}
