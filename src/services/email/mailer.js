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

module.exports = { sendPasswordResetEmail };
