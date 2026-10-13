const nodemailer = require('nodemailer');
const env = require('../../config/env');
const logger = require('../../utils/logger');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!env.smtp.host || !env.smtp.user) {
    logger.warn('[mailer] SMTP not configured — emails will be logged, not sent.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });
  return transporter;
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  const t = getTransporter();
  const subject = 'Reset your password';
  const html = `
    <p>We received a request to reset your password.</p>
    <p><a href="${resetLink}">Click here to reset your password</a></p>
    <p>This link expires in ${env.resetTokenExpiresMin} minutes. If you didn't request this, you can ignore this email.</p>
  `;

  if (!t) {
    logger.info(`[mailer] (dev fallback) Reset link for ${toEmail}: ${resetLink}`);
    return;
  }

  await t.sendMail({ from: env.smtp.from, to: toEmail, subject, html });
}

/* ------------------------------------------------------------------ */
/* Bulk / campaign email                                               */
/* ------------------------------------------------------------------ */

function isSmtpConfigured() {
  return Boolean(env.smtp.host && env.smtp.user);
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** {{name}}, {{firstName}}, {{phone}} placeholders ko lead ki values se bharta hai */
function renderTemplate(text = '', vars = {}) {
  return String(text).replace(/{{\s*(\w+)\s*}}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  );
}

function textToHtml(text = '') {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function fromAddressOnly() {
  const m = String(env.smtp.from || '').match(/<([^>]+)>/);
  return (m ? m[1] : env.smtp.from || '').trim();
}

/**
 * Ek lead ko campaign email bhejta hai. SMTP configured nahi hai to ERROR
 * throw karta hai (password-reset jaisa "log karke chhod do" nahi) — warna
 * worker job ko galti se 'sent' mark kar deta.
 */
async function sendCampaignEmail({ to, subject, body, vars = {}, companyName = '' }) {
  const t = getTransporter();
  if (!t) {
    const err = new Error('SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const finalSubject = renderTemplate(subject, vars);
  const finalBody = renderTemplate(body, vars);
  const footer = companyName ? `${companyName}\n` : '';
  const unsubscribeNote =
    'Agar aap ye emails nahi chahte to is email ka reply karke "STOP" likh dijiye.';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b">
      ${textToHtml(finalBody)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="font-size:12px;color:#64748b;line-height:1.5">${escapeHtml(footer)}${escapeHtml(unsubscribeNote)}</p>
    </div>`;
  const text = `${finalBody}\n\n--\n${footer}${unsubscribeNote}`;

  const fromAddr = fromAddressOnly();
  const info = await t.sendMail({
    from: env.smtp.from,
    to,
    subject: finalSubject,
    html,
    text,
    headers: fromAddr
      ? { 'List-Unsubscribe': `<mailto:${fromAddr}?subject=STOP>` }
      : undefined,
  });

  return { messageId: info.messageId };
}

module.exports = { sendPasswordResetEmail, sendCampaignEmail, renderTemplate, isSmtpConfigured };
