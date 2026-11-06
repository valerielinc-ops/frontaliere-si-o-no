const AUTOMATED_DELIVERY_HOLDS = Object.freeze({
  tiktok: 'TikTok automated delivery is held pending an eligible, policy-compliant publishing use case.',
});

export function socialAutomatedDeliveryPolicy(channel) {
  const reason = AUTOMATED_DELIVERY_HOLDS[channel];
  return reason
    ? { allowed: false, reason }
    : { allowed: true, reason: null };
}

export function shouldHoldAutomatedSocialDelivery(channel, { dryRun = false } = {}) {
  return !dryRun && !socialAutomatedDeliveryPolicy(channel).allowed;
}

export function partitionAutomatedDeliveryChannels(channels) {
  const allowed = [];
  const held = [];
  for (const channel of channels) {
    const policy = socialAutomatedDeliveryPolicy(channel);
    if (policy.allowed) allowed.push(channel);
    else held.push({ channel, reason: policy.reason });
  }
  return { allowed, held };
}
