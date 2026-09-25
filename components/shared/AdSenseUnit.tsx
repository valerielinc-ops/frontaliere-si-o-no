/**
 * AdSenseUnit — thin wrapper around AdSenseBanner with a simplified prop API.
 *
 * Use this in page-level views (JobExpiredView, JobOrphanView, etc.) where you
 * only need slot + format without the full AdSenseBanner configuration surface.
 *
 * Props:
 * slot — AdSense ad slot ID (required)
 * format — AdSense ad format (default: 'autorelaxed')
 * className — optional wrapper className
 */

import AdSenseBanner from './AdSenseBanner';

interface AdSenseUnitProps {
 slot: string;
 format?: string;
 className?: string;
}

export default function AdSenseUnit({ slot, format = 'autorelaxed', className }: AdSenseUnitProps) {
 return <AdSenseBanner adSlot={slot} adFormat={format} className={className} />;
}
