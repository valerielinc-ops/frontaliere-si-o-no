/**
 * AWS SES Event Webhook Handler (via SNS)
 *
 * Receives SES event notifications forwarded through SNS and maps them
 * to the same Firestore tracking schema used by the Resend webhook handler.
 * This ensures consistent analytics regardless of email provider.
 *
 * SES event flow: SES → SNS → HTTPS (this Cloud Function)
 *
 * Supported SES events:
 *   Send, Delivery, Bounce, Complaint, Reject,
 *   Open, Click, DeliveryDelay, Subscription, Rendering Failure
 */

import { applyResendWebhookEvent, getAdminDb } from './newsletterResendWebhookCore.js';

/**
 * Map SES event type → our internal event type (same as Resend's schema)
 */
function mapSesEventType(sesType) {
  switch (String(sesType || '').toLowerCase()) {
    case 'send':
      return 'email.sent';
    case 'delivery':
      return 'email.delivered';
    case 'bounce':
      return 'email.bounced';
    case 'complaint':
      return 'email.complained';
    case 'reject':
      return 'email.failed';
    case 'open':
      return 'email.opened';
    case 'click':
      return 'email.clicked';
    case 'deliverydelay':
    case 'delivery_delay':
      return 'email.delivery_delayed';
    case 'rendering_failure':
    case 'renderingfailure':
      return 'email.failed';
    case 'subscription':
      return 'email.suppressed';
    default:
      return null;
  }
}

/**
 * Extract email tags from SES message headers or mail.tags.
 * SES stores tags as { name: value } pairs in the mail object.
 */
function extractSesTags(mail) {
  const tags = [];
  if (mail?.tags) {
    for (const [name, values] of Object.entries(mail.tags)) {
      const value = Array.isArray(values) ? values[0] : values;
      if (name && value) {
        tags.push({ name, value: String(value) });
      }
    }
  }
  return tags;
}

/**
 * Convert an SES event (from SNS notification) into the Resend-compatible
 * format that `applyResendWebhookEvent()` expects.
 */
function sesEventToResendFormat(sesEvent) {
  const eventType = sesEvent.eventType || sesEvent.notificationType;
  const mappedType = mapSesEventType(eventType);
  if (!mappedType) return null;

  const mail = sesEvent.mail || {};
  const recipients = mail.destination || [];
  const tags = extractSesTags(mail);
  const messageId = mail.messageId || null;

  // SES sends one event per recipient group, but we need per-recipient processing
  // For most events, recipients are in the event-specific block
  let eventRecipients = recipients;
  let bounceType = null;
  let complaintFeedbackType = null;
  let clickUrl = null;

  if (sesEvent.bounce) {
    eventRecipients = (sesEvent.bounce.bouncedRecipients || []).map(r => r.emailAddress);
    bounceType = sesEvent.bounce.bounceType; // Permanent, Transient, Undetermined
  } else if (sesEvent.complaint) {
    eventRecipients = (sesEvent.complaint.complainedRecipients || []).map(r => r.emailAddress);
    complaintFeedbackType = sesEvent.complaint.complaintFeedbackType;
  } else if (sesEvent.delivery) {
    eventRecipients = sesEvent.delivery.recipients || recipients;
  } else if (sesEvent.open) {
    // Open events don't have per-recipient lists — use mail.destination
    eventRecipients = recipients;
  } else if (sesEvent.click) {
    eventRecipients = recipients;
    clickUrl = sesEvent.click.link || null;
  } else if (sesEvent.deliveryDelay) {
    eventRecipients = (sesEvent.deliveryDelay.delayedRecipients || []).map(r => r.emailAddress);
  } else if (sesEvent.reject) {
    eventRecipients = recipients;
  }

  // Return one Resend-format event per recipient
  return eventRecipients.map(email => ({
    type: mappedType,
    data: {
      email,
      email_id: messageId,
      message_id: messageId,
      created_at: mail.timestamp || sesEvent.mail?.timestamp || new Date().toISOString(),
      tags,
      // Click-specific
      ...(clickUrl ? { click: { link: clickUrl }, link: clickUrl, url: clickUrl } : {}),
      // Bounce metadata
      ...(bounceType ? { bounce_type: bounceType } : {}),
      ...(complaintFeedbackType ? { complaint_feedback_type: complaintFeedbackType } : {}),
    },
    _source: 'ses',
    _raw: sesEvent,
  }));
}

/**
 * Handle an SNS HTTP notification from AWS.
 *
 * SNS sends 3 types of messages:
 *   1. SubscriptionConfirmation — must be auto-confirmed
 *   2. Notification — contains SES event payload
 *   3. UnsubscribeConfirmation — acknowledged
 */
export async function handleSesWebhookRequest({ body, headers }) {
  const messageType = headers?.['x-amz-sns-message-type']
    || headers?.['X-Amz-Sns-Message-Type']
    || '';

  // Parse the SNS envelope
  let snsMessage;
  if (typeof body === 'string') {
    snsMessage = JSON.parse(body);
  } else {
    snsMessage = body;
  }

  // 1. Auto-confirm SNS subscription
  if (messageType === 'SubscriptionConfirmation') {
    const subscribeUrl = snsMessage.SubscribeURL;
    if (subscribeUrl) {
      // Confirm by fetching the URL
      await fetch(subscribeUrl);
      console.log(`[SES Webhook] SNS subscription confirmed: ${snsMessage.TopicArn}`);
    }
    return { handled: true, type: 'subscription_confirmed' };
  }

  // 2. Acknowledge unsubscribe
  if (messageType === 'UnsubscribeConfirmation') {
    console.log(`[SES Webhook] SNS unsubscribe confirmed: ${snsMessage.TopicArn}`);
    return { handled: true, type: 'unsubscribe_confirmed' };
  }

  // 3. Process notification (SES event)
  if (messageType === 'Notification' || !messageType) {
    const sesEvent = typeof snsMessage.Message === 'string'
      ? JSON.parse(snsMessage.Message)
      : snsMessage.Message || snsMessage;

    const resendEvents = sesEventToResendFormat(sesEvent);
    if (!resendEvents || resendEvents.length === 0) {
      return { handled: false, reason: 'unsupported_ses_event', eventType: sesEvent.eventType };
    }

    const results = [];
    for (const event of resendEvents) {
      try {
        const result = await applyResendWebhookEvent(event);
        results.push(result);
      } catch (err) {
        console.error(`[SES Webhook] Error processing event for ${event.data?.email}:`, err);
        results.push({ handled: false, error: err.message });
      }
    }

    return {
      handled: true,
      type: 'notification',
      eventType: sesEvent.eventType,
      results,
    };
  }

  return { handled: false, reason: 'unknown_message_type', messageType };
}
