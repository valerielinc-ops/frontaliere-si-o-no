/** Public campaign metadata only. No URL, browser ID, email or arbitrary props.
 * A click is attribution evidence; a purchase still requires the payment ledger.
 */
export function sanitizeHouseAdAttribution(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const variants = ['control', 'time_saved', 'profile_match', 'in_control', 'swiss_work', 'next_chapter'];
  const formats = ['mobile_banner', 'mobile_large', 'rectangle', 'leaderboard', 'billboard', 'skyscraper'];
  if (value.campaign !== 'job_search_automation' || !variants.includes(value.variant)
      || value.creativeId !== `${value.variant}_v1` || !formats.includes(value.format)
      || !['it', 'en', 'de', 'fr'].includes(value.locale)
      || !['mobile', 'desktop'].includes(value.device)
      || typeof value.enrolled !== 'boolean'
      || typeof value.placement !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(value.placement)
      || typeof value.clickedAt !== 'number' || !Number.isFinite(value.clickedAt)
      || value.clickedAt > now || now - value.clickedAt > 7 * 86400000) return null;
  return { campaign: value.campaign, experimentId: 'house_creatives_v1', variant: value.variant,
    creativeId: value.creativeId, format: value.format, locale: value.locale,
    placement: value.placement, device: value.device, enrolled: value.enrolled, clickedAt: value.clickedAt };
}
