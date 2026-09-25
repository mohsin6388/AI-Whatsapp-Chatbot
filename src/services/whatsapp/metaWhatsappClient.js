const axios = require('axios');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Thin wrapper around the official Meta WhatsApp Cloud API
 * (https://developers.facebook.com/docs/whatsapp/cloud-api).
 *
 * Replaces the old Unipile integration entirely. There is no "chat_id" or
 * per-thread session concept here like Unipile had — every send just needs
 * the buyer's phone number, and Meta itself tracks the 24-hour "customer
 * service window" per phone number on their side.
 *
 * IMPORTANT — Meta's rule that shapes this whole file:
 *   - You may send a free-text (or any non-template) message to a user ONLY
 *     within 24 hours of their LAST message to you.
 *   - Outside that window (including the very first message ever, before
 *     they've messaged you at all), you MUST send an approved message
 *     TEMPLATE. A free-text send outside the window is rejected by Meta
 *     with error code 131047 ("Re-engagement message").
 *   That's why sendTemplateMessage() and sendTextMessage() are kept as two
 *   separate functions instead of one "just send whatever" helper — the
 *   caller (conversationEngine) has to know which situation it's in.
 */

const http = axios.create({ timeout: 20_000 });

function assertConfigured() {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.phoneNumberId) {
    throw new Error(
      'Meta WhatsApp Cloud API is not configured — set META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID in the environment'
    );
  }
}

function baseUrl() {
  return `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.phoneNumberId}`;
}

function headers() {
  return {
    Authorization: `Bearer ${env.metaWhatsapp.accessToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Normalizes a lead's stored phone number into the bare-digits, country-code
 * prefixed format the Cloud API's `to` field expects (e.g. "919876543210" —
 * no "+", no spaces/dashes). Same canonical shape used across the app for
 * storing phone numbers.
 */
function toWhatsAppNumber(phone) {
  if (!phone) throw new Error('Phone number is required');
  let digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) throw new Error(`Phone number "${phone}" has no digits`);

  // If a lead was entered as a plain 10-digit Indian mobile number, make it
  // WhatsApp-ready automatically. International numbers with an explicit
  // country code are left untouched.
  if (digits.length === 10 && env.metaWhatsapp.defaultCountryCode) {
    digits = `${env.metaWhatsapp.defaultCountryCode}${digits}`;
  }

  return digits;
}

function extractMessageId(data) {
  return data?.messages?.[0]?.id || null;
}

function isWithin24HourWindow(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return false;
  const inbound = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(inbound)) return false;
  const elapsed = now - inbound;
  return elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000;
}

/**
 * Sends an approved message TEMPLATE. This is the ONLY legal way to send the
 * very first, business-initiated message to a lead (see file header) — used
 * by conversationEngine.startConversation() for the opening message, and can
 * also be used to re-open a conversation that's gone stale past 24h.
 *
 * `components` follows Meta's template-components shape exactly, e.g. for a
 * template with one body variable:
 *   [{ type: 'body', parameters: [{ type: 'text', text: lead.name }] }]
 * Pass [] / omit if the approved template has no variables.
 */
async function sendTemplateMessage({ phone, templateName, languageCode, components = [] }) {
  assertConfigured();
  if (!templateName) {
    throw new Error(
      'No WhatsApp template name configured — set META_WHATSAPP_OPENING_TEMPLATE_NAME once your template is approved in WhatsApp Manager'
    );
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: toWhatsAppNumber(phone),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || env.metaWhatsapp.openingTemplateLanguage },
      ...(components.length ? { components } : {}),
    },
  };

  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, { headers: headers() });
    return { messageId: extractMessageId(data), raw: data };
  } catch (err) {
    const metaError = err.response?.data?.error;
    const message = metaError?.message || err.message || 'Meta WhatsApp template send failed';
    const apiError = new Error(message);
    apiError.code = metaError?.code || 'META_TEMPLATE_SEND_FAILED';
    apiError.metaError = metaError || null;
    apiError.response = err.response;
    throw apiError;
  }
}

/**
 * Sends a plain free-text message. Only valid within the 24h customer
 * service window (i.e. after the lead has messaged us — this is what every
 * AI/manual reply uses once a real conversation is underway).
 */
async function sendTextMessage({ phone, text }) {
  assertConfigured();

  const payload = {
    messaging_product: 'whatsapp',
    to: toWhatsAppNumber(phone),
    type: 'text',
    text: { body: text, preview_url: false },
  };

  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, { headers: headers() });
    return { messageId: extractMessageId(data), raw: data };
  } catch (err) {
    const metaError = err.response?.data?.error;
    // 131047 = "Message failed to send because more than 24 hours have
    // passed since the customer last replied" — surface this distinctly so
    // callers can decide whether to fall back to a template instead of just
    // logging a generic axios error.
    if (metaError?.code === 131047) {
      const windowErr = new Error('WHATSAPP_24H_WINDOW_CLOSED: ' + (metaError.message || 'Re-engagement message'));
      windowErr.code = 'WHATSAPP_24H_WINDOW_CLOSED';
      windowErr.metaError = metaError;
      throw windowErr;
    }

    const apiError = new Error(metaError?.message || err.message || 'Meta WhatsApp message send failed');
    apiError.code = metaError?.code || 'META_WHATSAPP_SEND_FAILED';
    apiError.metaError = metaError || null;
    apiError.response = err.response;
    throw apiError;
  }
}

/**
 * Single entry point for an ongoing conversation reply. It intentionally sends
 * plain text only. For opening a lead conversation, conversationEngine tries
 * plain text first and falls back to an approved template only when Meta returns
 * the 24-hour-window-closed error.
 */
async function sendToLead({ phone, text }) {
  const { messageId, raw } = await sendTextMessage({ phone, text });
  return { messageId, raw };
}

/** Marks an inbound message as "read" (blue ticks) — optional but makes the bot feel more human. */
async function markAsRead(whatsappMessageId) {
  if (!whatsappMessageId) return;
  assertConfigured();
  try {
    await http.post(
      `${baseUrl()}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: whatsappMessageId },
      { headers: headers() }
    );
  } catch (err) {
    logger.warn('[meta-whatsapp] Failed to mark message as read (non-fatal)', { error: err.response?.data || err.message });
  }
}

/**
 * GET /{phone_number_id} — used by the Settings page's "WhatsApp Settings"
 * panel to show the actually-connected number and its live quality/status,
 * instead of just "configured: true/false".
 */

/**
 * Ensures this Meta app is subscribed to the configured WABA so Meta can
 * deliver inbound messages/status webhooks to our webhook URL. This is safe
 * to call repeatedly; Meta returns success when the subscription already
 * exists.
 */
async function ensureWabaSubscription() {
  assertConfigured();
  if (!env.metaWhatsapp.businessAccountId) {
    throw new Error('META_WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
  }

  try {
    const { data } = await http.post(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/subscribed_apps`,
      {},
      { headers: headers() }
    );
    return data;
  } catch (err) {
    const metaError = err.response?.data?.error;
    const apiError = new Error(metaError?.message || err.message || 'Failed to subscribe Meta app to WhatsApp Business Account');
    apiError.code = metaError?.code || 'META_WABA_SUBSCRIBE_FAILED';
    apiError.metaError = metaError || null;
    apiError.response = err.response;
    throw apiError;
  }
}

async function getAccountInfo() {
  assertConfigured();

  const { data } = await http.get(`https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.phoneNumberId}`, {
    headers: headers(),
    params: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status' },
  });

  return {
    phoneNumber: data?.display_phone_number || null,
    verifiedName: data?.verified_name || null,
    status: data?.code_verification_status || null,
    qualityRating: data?.quality_rating || null,
    raw: data,
  };
}

async function getWabaPhoneNumbers() {
  assertConfigured();
  if (!env.metaWhatsapp.businessAccountId) {
    throw new Error('META_WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
  }
  try {
    const { data } = await http.get(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/phone_numbers`,
      { headers: headers() }
    );
    return data;
  } catch (err) {
    const metaError = err.response?.data?.error;
    const apiError = new Error(metaError?.message || err.message || 'Failed to read WABA phone numbers');
    apiError.code = metaError?.code || 'META_WABA_PHONE_NUMBERS_FAILED';
    apiError.metaError = metaError || null;
    apiError.response = err.response;
    throw apiError;
  }
}

async function verifyConfiguration() {
  const account = await getAccountInfo();
  let wabaPhoneNumbers = null;
  if (env.metaWhatsapp.businessAccountId) {
    wabaPhoneNumbers = await getWabaPhoneNumbers();
  }
  const ids = (wabaPhoneNumbers?.data || []).map((item) => String(item.id));
  return {
    account,
    wabaPhoneNumbers,
    phoneNumberBelongsToWaba: env.metaWhatsapp.businessAccountId ? ids.includes(String(env.metaWhatsapp.phoneNumberId)) : null,
  };
}

module.exports = {
  sendTemplateMessage,
  sendTextMessage,
  sendToLead,
  markAsRead,
  getAccountInfo,
  toWhatsAppNumber,
  isWithin24HourWindow,
  ensureWabaSubscription,
  getWabaPhoneNumbers,
  verifyConfiguration,
};
