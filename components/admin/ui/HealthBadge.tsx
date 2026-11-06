import { AdminStatusPill } from './AdminStatusPill';

export function HealthBadge({ ok, label }: { ok: boolean; label: string }) {
  return <AdminStatusPill tone={ok ? 'success' : 'danger'}>{label}</AdminStatusPill>;
}
