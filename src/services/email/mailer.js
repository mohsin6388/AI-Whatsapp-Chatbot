const axios = require("axios");
const crypto = require("crypto");
const env = require("../../config/env");
const logger = require("../../utils/logger");

const RESEND_URL = "https://api.resend.com/emails";
const http = axios.create({ timeout: 20_000 });

function isResendConfigured() {
  return Boolean(env.resend.apiKey && env.resend.from);
}

function assertResendConfigured() {
  if (!env.resend.apiKey || !env.resend.from) {
    const err = new Error("Resend is not configured. Set RESEND_API_KEY and RESEND_FROM.");
    err.code = "RESEND_NOT_CONFIGURED";
    throw err;
  }
}

function normalizeApiError(err) {
  if (err?.code === "RESEND_NOT_CONFIGURED") return err;
  const status = err?.response?.status;
  const providerMessage = err?.response?.data?.message || err?.response?.data?.error?.message;
  const message = providerMessage || err?.message || "Resend email request failed";
  const result = new Error(String(message).slice(0, 500));
  result.status = status;
  result.response = err.response;
  result.code = status === 429 ? "RESEND_RATE_LIMIT" : status >= 500 ? "RESEND_TEMPORARY_ERROR" : (err?.response?.data?.name || "RESEND_API_ERROR");
  result.providerError = err?.response?.data || null;
  return result;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTemplate(text = "", vars = {}) {
  return String(text).replace(/{{\s*(\w+)\s*}}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : "",
  );
}

function textToHtml(text = "") {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function sendViaResend(payload, idempotencyKey) {
  assertResendConfigured();
  const headers = {
    Authorization: `Bearer ${env.resend.apiKey}`,
    "Content-Type": "application/json",
  };
  // Resend supports idempotency keys on sends; retries should not duplicate a
  // campaign email if the first API response was lost mid-flight.
  if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);

  try {
    const { data } = await http.post(RESEND_URL, payload, { headers });
    if (!data?.id) {
      const err = new Error("Resend accepted no email ID in its response");
      err.code = "RESEND_INVALID_RESPONSE";
      throw err;
    }
    return { messageId: data.id, providerMessageId: data.id, raw: data };
  } catch (err) {
    throw normalizeApiError(err);
  }
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  const subject = "Reset your password";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1e293b">
      <p>We received a request to reset your password.</p>
      <p><a href="${escapeHtml(resetLink)}">Click here to reset your password</a></p>
      <p>This link expires in ${env.resetTokenExpiresMin} minutes. If you didn't request this, you can ignore this email.</p>
    </div>`;

  if (!isResendConfigured()) {
    if (env.nodeEnv !== "production") {
      logger.info(`[mailer] (development only) Password reset requested for ${toEmail}; Resend is not configured.`);
      logger.info(`[mailer] Set RESEND_API_KEY and RESEND_FROM to deliver password-reset emails.`);
      return;
    }
    assertResendConfigured();
  }
  await sendViaResend({ from: env.resend.from, to: [toEmail], subject, html, text: `Reset your password: ${resetLink}` }, `password-reset-${crypto.createHash("sha256").update(`${toEmail}:${resetLink}`).digest("hex")}`);
}

/** One lead / one email API send. body is plain text and templates are escaped. */
async function sendCampaignEmail({ to, subject, body, vars = {}, companyName = "", replyTo, idempotencyKey, tags = [] }) {
  const finalSubject = renderTemplate(subject, vars);
  const finalBody = renderTemplate(body, vars);
  const footer = companyName ? `${companyName}\n` : "";
  const unsubscribeNote = "Agar aap ye emails nahi chahte to kripya sender se contact karke unsubscribe request karein.";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b">
      ${textToHtml(finalBody)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="font-size:12px;color:#64748b;line-height:1.5">${escapeHtml(footer)}${escapeHtml(unsubscribeNote)}</p>
    </div>`;
  const payload = {
    from: env.resend.from,
    to: [to],
    subject: finalSubject,
    html,
    text: `${finalBody}\n\n--\n${footer}${unsubscribeNote}`,
    ...(replyTo ? { reply_to: replyTo } : env.resend.replyTo ? { reply_to: env.resend.replyTo } : {}),
    ...(tags.length ? { tags: tags.map((tag) => ({ name: String(tag.name).slice(0, 256), value: String(tag.value).slice(0, 256) })) } : {}),
  };
  return sendViaResend(payload, idempotencyKey);
}

async function sendDirectEmail({ to, subject, text = "", html, replyTo, headers = {}, tags = [], idempotencyKey }) {
  const payload = {
    from: env.resend.from,
    to: [to],
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(replyTo ? { reply_to: replyTo } : env.resend.replyTo ? { reply_to: env.resend.replyTo } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(tags.length ? { tags: tags.map((tag) => ({ name: String(tag.name).slice(0, 256), value: String(tag.value).slice(0, 256) })) } : {}),
  };
  return sendViaResend(payload, idempotencyKey);
}

function makeReplyAddress(trackingId) {
  if (!env.resend.inboundDomain) return env.resend.replyTo || "";
  const domain = env.resend.inboundDomain.replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `reply+${trackingId}@${domain}`;
}

module.exports = {
  sendPasswordResetEmail,
  sendCampaignEmail,
  sendDirectEmail,
  renderTemplate,
  isResendConfigured,
  makeReplyAddress,
};
