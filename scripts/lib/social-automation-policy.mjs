const AUTOMATED_DELIVERY_HOLDS = Object.freeze({
  tiktok: 'TikTok automated delivery is held pending an eligible, policy-compliant publishing use case.',
  instagram: 'Instagram browser delivery is held until Meta express permission for this route is verified.',
});

export function socialAutomatedDeliveryPolicy(channel, { instagramBrowserPublishingApproved = false } = {}) {
  if (channel === 'instagram' && instagramBrowserPublishingApproved) {
    return { allowed: true, reason: null };
  }
  const reason = AUTOMATED_DELIVERY_HOLDS[channel];
  return reason
    ? { allowed: false, reason }
    : { allowed: true, reason: null };
}

export function isInstagramBrowserPublishingApproved(env = process.env) {
  return env.META_INSTAGRAM_BROWSER_PUBLISHING_APPROVED === 'true';
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
