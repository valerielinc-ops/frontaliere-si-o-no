const AUTOMATED_DELIVERY_HOLDS = Object.freeze({
  tiktok: 'TikTok browser publishing is held until the owner-approved uploader flag is enabled.',
  instagram: 'Instagram browser publishing is held until the owner-approved publisher flag is enabled.',
});

export function socialAutomatedDeliveryPolicy(channel, {
  instagramBrowserPublishingApproved = false,
  tiktokBrowserPublishingApproved = false,
} = {}) {
  if (channel === 'instagram' && instagramBrowserPublishingApproved) return { allowed: true, reason: null };
  if (channel === 'tiktok' && tiktokBrowserPublishingApproved) return { allowed: true, reason: null };
  const reason = AUTOMATED_DELIVERY_HOLDS[channel];
  return reason
    ? { allowed: false, reason }
    : { allowed: true, reason: null };
}

export function isInstagramBrowserPublishingApproved(env = process.env) {
  return env.SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED === 'true'
    || env.META_INSTAGRAM_BROWSER_PUBLISHING_APPROVED === 'true';
}

export function isTikTokBrowserPublishingApproved(env = process.env) {
  return env.SOCIAL_ROBOT_TIKTOK_BROWSER_PUBLISHING_OWNER_APPROVED === 'true';
}

export function isInstagramBrowserInsightsApproved(env = process.env) {
  return env.META_INSTAGRAM_BROWSER_INSIGHTS_APPROVED === 'true';
}

export function isInstagramBrowserCommunityApproved(env = process.env) {
  return env.META_INSTAGRAM_BROWSER_COMMUNITY_APPROVED === 'true';
}

export function shouldHoldAutomatedSocialDelivery(channel, options = {}) {
  const { dryRun = false } = options;
  return !dryRun && !socialAutomatedDeliveryPolicy(channel, options).allowed;
}

export function partitionAutomatedDeliveryChannels(channels, options = {}) {
  const allowed = [];
  const held = [];
  for (const channel of channels) {
    const policy = socialAutomatedDeliveryPolicy(channel, options);
    if (policy.allowed) allowed.push(channel);
    else held.push({ channel, reason: policy.reason });
  }
  return { allowed, held };
}
