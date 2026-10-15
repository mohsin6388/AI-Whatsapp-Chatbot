const crypto = require("crypto");
const axios = require("axios");
const EmailMessage = require("../models/EmailMessage");
const logger = require("../utils/logger");
const env = require("../config/env");
const { emitToUser } = require("../sockets");
const Notification = require("../models/Notification");

function verifySignature(req) {
  const secret = env.resend.webhookSecret;
  if (!secret || !Buffer.isBuffer(req.rawBody)) return false;
  const id = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signature = req.headers["svix-signature"];
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false;

  try {
    const encoded = secret.replace(/^whsec_/, "");
    const key = Buffer.from(encoded, "base64");
    const signed = `${id}.${timestamp}.${req.rawBody.toString("utf8")}`;
    const expected = crypto.createHmac("sha256", key).update(signed).digest("base64");
    const candidates = String(signature).split(/\s+/).map((part) => part.split(",")).filter((part) => part.length === 2 && part[0] === "v1").map((part) => part[1]);
    return candidates.some((candidate) => {
      const a = Buffer.from(expected);
      const b = Buffer.from(candidate || "");
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
  } catch {
    return false;
  }
}

function extractEmail(value) {
  const match = String(value || "").match(/[^\s<>;,]+@[^\s<>;,]+\.[^\s<>;,]+/);
  return match ? match[0].replace(/[>,]+$/, "").trim().toLowerCase() : String(value || "").trim().toLowerCase();
}

function headerValue(headers, wanted) {
  if (!headers) return "";
  if (Array.isArray(headers)) {
    const hit = headers.find((h) => String(h?.name || h?.key || "").toLowerCase() === wanted.toLowerCase());
    return String(hit?.value || "");
  }
  const key = Object.keys(headers).find((name) => name.toLowerCase() === wanted.toLowerCase());
  return key ? String(headers[key]) : "";
}

async function fetchReceivedContent(emailId) {
  if (!env.resend.apiKey || !emailId) return null;
  try {
    const { data } = await axios.get(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${env.resend.apiKey}` }, timeout: 12000,
    });
    return data?.data || data;
  } catch (err) {
    logger.warn("[resend-webhook] Could not fetch received email body from Resend API", { emailId, error: err.message });
    return null;
  }
}

async function processReceived(event, eventId) {
  const data = event.data || {};
  if (eventId && await EmailMessage.exists({ providerEventId: eventId })) return;

  const recipients = Array.isArray(data.to) ? data.to : [data.to].filter(Boolean);
  let matched = null;
  for (const recipient of recipients) {
    const match = String(recipient).match(/reply\+([a-f0-9]{32})@/i);
    if (match) {
      matched = await EmailMessage.findOne({ trackingId: match[1].toLowerCase(), direction: "outbound" });
      if (matched) break;
    }
  }

  // If a mail client preserves standard threading headers, use the RFC
  // Message-ID reference as a fallback. Never guess a tenant from sender-only.
  const headers = data.headers || {};
  const refs = `${headerValue(headers, "In-Reply-To")} ${headerValue(headers, "References")}`.trim();
  if (!matched && refs) {
    const referenced = refs.split(/\s+/).filter(Boolean);
    matched = await EmailMessage.findOne({ direction: "outbound", rfcMessageId: { $in: referenced } }).sort({ createdAt: -1 });
  }
  if (!matched) {
    logger.warn("[resend-webhook] Received email could not be correlated to an outbound PropAI email", { emailId: data.email_id, recipients });
    return;
  }

  const rootId = matched.threadId || matched._id;
  const root = await EmailMessage.findOne({ _id: rootId });
  if (!root) return;

  let content = data;
  if (!data.text && !data.html) {
    content = (await fetchReceivedContent(data.email_id)) || data;
  }
  const receivedAt = data.created_at || event.created_at || new Date().toISOString();
  const from = extractEmail(content.from || data.from);
  const to = recipients.map(extractEmail).join(", ");
  const inbound = new EmailMessage({
    ownerId: root.ownerId,
    leadId: root.leadId,
    campaignId: root.campaignId || undefined,
    direction: "inbound",
    kind: "received",
    threadId: rootId,
    parentMessageId: matched._id,
    providerMessageId: content.email_id || data.email_id || undefined,
    providerEventId: eventId || undefined,
    rfcMessageId: content.message_id || data.message_id || headerValue(content.headers || headers, "Message-ID") || undefined,
    from,
    to,
    subject: content.subject || data.subject || "",
    text: content.text || content.text_body || "",
    html: content.html || content.html_body || "",
    status: "received",
    receivedAt: new Date(receivedAt),
  });

  try {
    await inbound.save();
  } catch (err) {
    if (err.code === 11000) return; // webhook delivery is at-least-once
    throw err;
  }
  await EmailMessage.updateOne({ _id: rootId }, { $set: { replyStatus: "replied", lastReplyAt: inbound.receivedAt }, $inc: { replyCount: 1 } });

  try {
    await Notification.create({
      userId: root.ownerId,
      type: "email_reply_received",
      title: `Email reply from ${from || "a lead"}`,
      body: String(inbound.subject || inbound.text || "New customer email reply").slice(0, 240),
      link: "/email-replies",
    });
  } catch (err) {
    logger.warn("[resend-webhook] Could not create reply notification", { error: err.message });
  }
  emitToUser(root.ownerId, "email:reply", { threadId: String(rootId), messageId: String(inbound._id), leadId: String(root.leadId || "") });
}

async function handler(req, res) {
  if (!env.resend.webhookSecret) {
    logger.error("[resend-webhook] RESEND_WEBHOOK_SECRET is missing");
    return res.status(503).json({ success: false, message: "Resend webhook is not configured" });
  }
  if (!verifySignature(req)) return res.status(400).json({ success: false, message: "Invalid webhook signature" });

  const event = req.body || {};
  const type = String(event.type || "");
  const data = event.data || {};
  const eventId = String(req.headers["svix-id"] || "");

  try {
    if (type === "email.received") {
      await processReceived(event, eventId);
      return res.status(200).json({ success: true, received: true });
    }

    const providerId = data.email_id || data.id;
    if (providerId) {
      const statusMap = {
        "email.sent": "sent",
        "email.delivered": "delivered",
        "email.delivery_delayed": "delivery_delayed",
        "email.bounced": "bounced",
        "email.complained": "complained",
        "email.failed": "failed",
        "email.suppressed": "suppressed",
      };
      const status = statusMap[type];
      const update = {};
      if (data.message_id) update.rfcMessageId = data.message_id;
      if (type === "email.opened") update.openedAt = new Date(data.created_at || event.created_at || Date.now());
      if (type === "email.clicked") update.clickedAt = new Date(data.created_at || event.created_at || Date.now());
      if (["email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(type)) {
        update.errorMessage = data.bounce?.message || data.reason || data.failed?.reason || data.suppressed?.reason || type.replace("email.", "");
      }

      // Resend delivery webhooks can race the API response that stores providerId.
      // Correlate by our custom message/job tags if the provider id is not saved yet.
      let tracked = await EmailMessage.findOne({ providerMessageId: providerId, direction: "outbound" }).select("_id").lean();
      if (!tracked) {
        const tags = data.tags || {};
        const tagMessageId = tags.propai_message_id || (Array.isArray(tags) ? tags.find((tag) => tag?.name === "propai_message_id")?.value : null);
        const tagJobId = tags.propai_job_id || (Array.isArray(tags) ? tags.find((tag) => tag?.name === "propai_job_id")?.value : null);
        if (tagMessageId && /^[0-9a-fA-F]{24}$/.test(String(tagMessageId))) {
          tracked = await EmailMessage.findById(tagMessageId).select("_id").lean();
        } else if (tagJobId && /^[0-9a-fA-F]{24}$/.test(String(tagJobId))) {
          tracked = await EmailMessage.findOne({ outboundJobId: tagJobId, direction: "outbound" }).select("_id").lean();
        }
      }

      if (tracked && (Object.keys(update).length || status)) {
        const filter = { _id: tracked._id, direction: "outbound" };
        // Ignore late events that would downgrade a stronger/terminal state.
        if (status) {
          update.status = status;
          const allowedPrevious = {
            sent: ["queued", "sending", "sent"],
            delivery_delayed: ["queued", "sending", "sent", "delivery_delayed"],
            delivered: ["queued", "sending", "sent", "delivery_delayed", "delivered"],
            bounced: ["queued", "sending", "sent", "delivery_delayed", "bounced"],
            complained: ["queued", "sending", "sent", "delivery_delayed", "delivered", "complained"],
            failed: ["queued", "sending", "sent", "delivery_delayed", "failed"],
            suppressed: ["queued", "sending", "sent", "delivery_delayed", "suppressed"],
          };
          if (allowedPrevious[status]) filter.status = { $in: allowedPrevious[status] };
        }
        await EmailMessage.updateOne(
          filter,
          { $set: update, ...(eventId ? { $addToSet: { eventIds: eventId } } : {}) },
        );
      }
    }
    return res.status(200).json({ success: true, received: true });
  } catch (err) {
    logger.error("[resend-webhook] Event processing failed", { type, eventId, error: err.message });
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
}

module.exports = { handler };
