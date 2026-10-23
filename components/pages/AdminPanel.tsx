/**
 * Compatibility entrypoint for integrations that still import the legacy path.
 * The real admin surface is split into lazy sections under components/admin.
 */
import AdminApp from '@/components/admin/AdminApp';

export default function AdminPanel({ adminSection }: { adminSection?: string } = {}) {
  return <AdminApp adminSection={adminSection} />;
}
