/** Public campaign metadata only. No URL, browser ID, email or arbitrary props.
 * A click is attribution evidence; a purchase still requires the payment ledger.
 */
export function sanitizeHouseAdAttribution(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const variants = ['control', 'time_saved', 'profile_match', 'in_control', 'swiss_work', 'next_chapter'];
  const formats = ['mobile_banner', 'mobile_large', 'rectangle', 'leaderboard', 'billboard', 'skyscraper'];
  const contextSources = ['generic', 'job_detail', 'job_filter'];
  const contextSectors = ['generic', 'commute', 'construction', 'electrician', 'hospitality', 'logistics', 'maintenance', 'production'];
  if (value.campaign !== 'job_search_automation' || !variants.includes(value.variant)
      || (value.experimentId !== undefined && !['house_creatives_v1', 'house_creatives_v2'].includes(value.experimentId))
      || value.creativeId !== `${value.variant}_v1` || !formats.includes(value.format)
      || !['it', 'en', 'de', 'fr'].includes(value.locale)
      || !['mobile', 'desktop'].includes(value.device)
      || (value.contextSource !== undefined && !contextSources.includes(value.contextSource))
      || (value.contextSector !== undefined && !contextSectors.includes(value.contextSector))
      || typeof value.enrolled !== 'boolean'
      || typeof value.placement !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(value.placement)
      || typeof value.clickedAt !== 'number' || !Number.isFinite(value.clickedAt)
      || value.clickedAt > now || now - value.clickedAt > 7 * 86400000) return null;
  const contextSource = value.contextSource || 'generic';
  const contextSector = value.contextSector || 'generic';
  if ((contextSource === 'generic') !== (contextSector === 'generic')) return null;
  const experimentId = value.experimentId === 'house_creatives_v2' ? 'house_creatives_v2' : 'house_creatives_v1';
  const legacySource = experimentId === 'house_creatives_v1'
    ? (value.enrolled ? 'legacy_client_hash' : 'legacy_fixed_control')
    : 'local_default';
  const currentSource = ['firebase_remote_config', 'local_default'].includes(value.assignmentSource)
    ? value.assignmentSource
    : legacySource;
  const assignmentSource = experimentId === 'house_creatives_v2' ? currentSource : legacySource;
  const enrolled = value.enrolled === true
    && (experimentId === 'house_creatives_v1' || assignmentSource === 'firebase_remote_config');
  return { campaign: value.campaign, experimentId, assignmentSource, variant: value.variant,
    creativeId: value.creativeId, format: value.format, locale: value.locale,
    placement: value.placement, device: value.device, enrolled, contextSource, contextSector, clickedAt: value.clickedAt };
}

/** Minimal cohort data for the reader-subscription creative experiment. */
export function sanitizeReaderSubscriptionAdAttribution(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const variants = ['control', 'subscription'];
  const formats = ['mobile_banner', 'mobile_large', 'rectangle', 'leaderboard', 'billboard', 'skyscraper'];
  if (value.campaign !== 'reader_subscription'
      || value.experimentId !== 'reader_subscription_house_v1'
      || !variants.includes(value.variant)
      || value.creativeId !== (value.variant === 'subscription' ? 'subscription_v1' : 'control_v1')
      || !formats.includes(value.format)
      || !['it', 'en', 'de', 'fr'].includes(value.locale)
      || !['mobile', 'desktop'].includes(value.device)
      || value.assignmentSource !== 'firebase_remote_config'
      || value.enrolled !== true
      || !['click', 'exposure'].includes(value.touchpoint)
      || (value.touchpoint === 'click' && value.variant !== 'subscription')
      || typeof value.placement !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(value.placement)
      || typeof value.attributedAt !== 'number' || !Number.isFinite(value.attributedAt)
      || value.attributedAt > now || now - value.attributedAt > 7 * 86400000) return null;
  return {
    campaign: 'reader_subscription', experimentId: 'reader_subscription_house_v1',
    assignmentSource: 'firebase_remote_config', variant: value.variant,
    creativeId: value.creativeId, format: value.format, locale: value.locale,
    placement: value.placement, device: value.device, enrolled: true,
    touchpoint: value.touchpoint, attributedAt: value.attributedAt,
  };
}
