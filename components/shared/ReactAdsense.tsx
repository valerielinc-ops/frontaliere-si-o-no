/** React AdSense integration adapted from @ctrl/react-adsense (MIT).
 * Upstream: scttcper/react-adsense, eb810c63c73e45fe65ba8cc5e0ff7de9b3cc868d.
 * We retain its one-request-per-node and client-only eligibility, with an
 * explicit request callback so errors/width deferral remain observable. The
 * upstream 3.x browser() API requires React 19.3; this site uses React 19.2.
 * License: docs/licenses/react-adsense.txt.
 */
import { useEffect, useRef, type ComponentProps } from 'react';

type Props = Omit<ComponentProps<'ins'>, 'onError'> & {
  client: string;
  slot: string;
  format: string;
  layout?: string;
  layoutKey?: string;
  responsive: boolean;
  request: (element: HTMLModElement) => void;
};

export function ReactAdsense({ client, slot, format, layout, layoutKey, responsive, request, ...rest }: Props) {
  const ref = useRef<HTMLModElement>(null);
  // The shared requester, rather than a mount-local boolean, owns idempotency
  // across StrictMode, static hydration and library-loaded-late recovery.
  useEffect(() => { if (ref.current) request(ref.current); }, [request]);
  return <ins {...rest} ref={ref} className="ft-ad-pending" style={{ display: 'block', textAlign: layout === 'in-article' ? 'center' : undefined }}
    data-ad-client={client} data-ad-slot={slot} data-ad-format={format}
    {...(layout ? { 'data-ad-layout': layout } : {})}
    {...(layoutKey ? { 'data-ad-layout-key': layoutKey } : {})}
    {...(responsive ? { 'data-full-width-responsive': 'true' } : {})} />;
}
