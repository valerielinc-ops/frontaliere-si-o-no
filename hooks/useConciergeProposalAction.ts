import { useEffect, useMemo, useRef, useState } from 'react';
import { acceptApplicationConciergeProposal, fetchApplicationConciergeService, type ApplicationConciergeService } from '@/services/applicationConciergeService';
import { conciergeProposalContext, conciergeServiceHref } from '@/services/applicationConciergeNavigation';

export function useConciergeProposalAction({ user, authLoading, onRequireAuth, locale, navigate = (href: string) => window.location.assign(href), search = typeof window === 'undefined' ? '' : window.location.search }: {
  user: any; authLoading: boolean; onRequireAuth?: () => void; locale: 'it' | 'en' | 'de' | 'fr'; navigate?: (href: string) => void; search?: string;
}) {
  const context = useMemo(() => conciergeProposalContext(search), [search]);
  const active = new URLSearchParams(search).has('concierge_service') || new URLSearchParams(search).has('concierge_proposal');
  const [service, setService] = useState<ApplicationConciergeService | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const identity = `${user?.uid || ''}|${search}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    let cancelled = false;
    setService(null); setError(null); setBusy(false); inFlight.current = false;
    if (!active || !context || !user?.getIdToken || authLoading) return;
    void fetchApplicationConciergeService(user, context.serviceId).then(result => {
      if (!cancelled) setService(result);
    }).catch(() => { if (!cancelled) setError('jobBoard.concierge.proposalUnavailable'); });
    return () => { cancelled = true; };
  }, [active, context?.serviceId, context?.proposalId, user?.uid, authLoading]);
  const proposal = service?.proposals.find(item => item.proposalId === context?.proposalId);
  const serviceHref = context ? conciergeServiceHref(context.serviceId, locale) : null;
  const apply = (job: { id: string | number }): boolean => {
    if (!active) return false;
    if (inFlight.current || authLoading) return true;
    if (!user?.getIdToken) { onRequireAuth?.(); return true; }
    if (context && !service && !error) return true;
    if (!context || !proposal || proposal.jobId !== String(job.id)) { setError('jobBoard.concierge.proposalUnavailable'); return true; }
    if (proposal.status === 'accepted' && proposal.childApplicationId) {
      navigate(conciergeServiceHref(context.serviceId, locale, proposal.childApplicationId)); return true;
    }
    if (proposal.status !== 'proposed') { if (serviceHref) navigate(serviceHref); return true; }
    inFlight.current = true; setBusy(true); setError(null);
    const actionIdentity = identity;
    void (async () => {
      const [{ getAuth }, { getApp }] = await Promise.all([import('firebase/auth'), import('@/services/firebase')]);
      const auth = getAuth(await getApp());
      const stillOwned = () => currentIdentity.current === actionIdentity && auth.currentUser?.uid === user.uid;
      if (!stillOwned()) return;
      try {
        const result = await acceptApplicationConciergeProposal(user, context.serviceId, proposal.proposalId);
        if (stillOwned()) navigate(conciergeServiceHref(context.serviceId, locale, result.childApplicationId));
      } catch (failure) {
        if (!stillOwned()) return;
        // A second tab can have accepted the same proposal while this request was in flight.
        if (failure instanceof Error && failure.message === 'proposal_already_decided') {
          const fresh = await fetchApplicationConciergeService(user, context.serviceId);
          const accepted = fresh.proposals.find(item => item.proposalId === proposal.proposalId && item.status === 'accepted');
          if (accepted?.childApplicationId && stillOwned()) {
            navigate(conciergeServiceHref(context.serviceId, locale, accepted.childApplicationId)); return;
          }
        }
        if (stillOwned()) setError('jobBoard.concierge.proposalUnavailable');
      }
    })().catch(() => { if (currentIdentity.current === actionIdentity) setError('jobBoard.concierge.proposalUnavailable'); })
      .finally(() => { if (currentIdentity.current === actionIdentity) { inFlight.current = false; setBusy(false); } });
    return true;
  };
  return { active, busy, error, serviceHref, apply,
    labelKey: proposal?.status === 'accepted' ? 'jobBoard.concierge.openChild' : proposal && proposal.status !== 'proposed' ? 'jobBoard.concierge.backToService' : 'jobBoard.concierge.accept' };
}
