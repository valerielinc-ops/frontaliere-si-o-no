import { Suspense, useCallback, useEffect, useState } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { resilientImport } from '@/services/resilientImport';
import { useAuth } from '@/services/authService';

const JobAlertForm = lazyRetry(() => import('@/components/community/JobAlertForm'));

interface JobAlertSectionProps {
 initialKeyword?: string;
 onRequireAuth?: () => void;
}

export default function JobAlertSection({ initialKeyword = '', onRequireAuth }: JobAlertSectionProps) {
 const { user } = useAuth();
 const [enabled, setEnabled] = useState<boolean | null>(null);

 const focusAuthGate = useCallback(() => {
  const gate = document.getElementById('job-auth-gate');
  if (!gate) return;
  gate.scrollIntoView({ behavior: 'smooth', block: 'center' });
  gate.querySelector<HTMLElement>('button, input, [tabindex]')?.focus({ preventScroll: true });
 }, []);

 useEffect(() => {
 resilientImport(() => import('@/services/firebase'), (m) => typeof m.getConfigValue === 'function')
 .then(({ getConfigValue }) => getConfigValue('ENABLE_JOB_ALERTS'))
 .then((v) => setEnabled(v === 'true'))
 .catch(() => setEnabled(false));
 }, []);

 if (!enabled) return null;

 const authUser = user ? { uid: user.uid, email: user.email } : null;

 return (
 <Suspense fallback={<div className="h-[100px] rounded-xl bg-surface-raised animate-pulse" />}>
 <JobAlertForm
 authUser={authUser}
 onRequireAuth={onRequireAuth ?? focusAuthGate}
 initialKeyword={initialKeyword}
 />
 </Suspense>
 );
}
