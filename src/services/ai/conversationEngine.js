const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const Meeting = require("../../models/Meeting");
const Notification = require("../../models/Notification");
const OutboundJob = require("../../models/OutboundJob");
const Property = require("../../models/Property");

const settingsService = require("../settings/settingsService");
const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
const { recordOutboundMessage } = require("../whatsapp/messageStore");
const { matchProperties } = require("./propertyMatcher");
const { generateStructured } = require("./geminiClient");
const {
  buildSystemInstruction,
  REPLY_RESPONSE_SCHEMA,
  toGeminiHistory,
} = require("./promptBuilder");
const { analyzeConversationAsync } = require("./leadAnalyzer");
const {
  createCalendarEvent,
  updateCalendarEvent,
} = require("../calendar/googleCalendarService");
const { enqueueLeads } = require("../queue/outboundQueue");
const env = require("../../config/env");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

const HISTORY_LIMIT = 12; // most recent messages sent as context per turn — enough memory without blowing the token budget

function isBrochureRequest(text = "") {
  const normalized = String(text).toLowerCase().trim();

  const brochureKeywords = [
    "brochure",
    "pdf",
    "document",
    "brochure bhejo",
    "pdf bhejo",
    "brochure send",
    "pdf send",
    "brochure share",
    "pdf share",
  ];

  return brochureKeywords.some((keyword) => normalized.includes(keyword));
}

async function handleInbound({ conversation, lead, message }) {
  // Manual takeover or globally paused AI — the broker is handling this chat themselves.
  if (conversation.status === "manual" || conversation.status === "closed")
    return;

  const settings = await settingsService.getOrCreateSettings();
  if (settings.aiPaused || !settings.autoReplyEnabled) return;
  if (settings.whatsappDisconnected) return; // broker hit "Disconnect" on the Settings page

  const apiKey = await settingsService.getGeminiKey();
  if (!apiKey) {
    logger.warn(
      `[ai] No Gemini API key configured — skipping AI reply for lead ${lead._id}`,
    );
    return;
  }

  const recentMessages = await Message.find({
    conversationId: conversation._id,
  })
    .sort({ timestamp: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  recentMessages.reverse(); // oldest -> newest for the model

  // Pull in any properties that already look like a fit given what we know
  // so far, so the model can reference them by name instead of inventing details.

  const requirements = conversation.collectedRequirements || {};

  const currentMessage = message?.text || "";

  const candidateProperties = await matchProperties({
    query: currentMessage,

    city: requirements.city || lead.city,
    location: requirements.location || lead.location,

    projectName: requirements.projectName,

    budgetMin: requirements.budgetMin ?? lead.budgetMin,
    budgetMax: requirements.budgetMax ?? lead.budgetMax,

    bhk: requirements.bhk,
    propertyType: requirements.propertyType,
    amenities: requirements.amenities || [],
  });

  const systemInstruction = buildSystemInstruction({
    lead,
    settings,
    collectedRequirements: requirements,
    matchedProperties: candidateProperties,
    currentMessage,

    referralStatus: conversation.referralStatus || "none",

    referralPersonName:
      settings.referral?.personName || env.referral.personName,
  });

  let result;
  try {
    result = await generateStructured({
      apiKey,
      systemInstruction,
      history: toGeminiHistory(recentMessages),
      responseSchema: REPLY_RESPONSE_SCHEMA,
    });
  } catch (err) {
    logger.error(`[ai] Gemini reply generation failed for lead ${lead._id}`, {
      error: err.message,
    });
    return; // fail silently to the buyer — broker can still see & manually reply from the Conversations page
  }

  const { parsed, raw } = result;

  // Merge newly extracted requirements into what we already knew (never overwrite with blanks).
  const mergedRequirements = mergeRequirements(
    requirements,
    parsed.extractedRequirements,
  );
  conversation.collectedRequirements = mergedRequirements;
  conversation.lastIntent = parsed.intent;
  conversation.lastSentiment = parsed.sentiment;
  if (candidateProperties.length) {
    // Overwrite, not append — recommendedProperties always reflects the
    // CURRENT recommendation set, not a running history of everything ever
    // suggested. See Conversation model notes.
    conversation.recommendedProperties = candidateProperties.map((p) => p._id);
  }

  // Referral/handoff closing step ("kya aap Monica ko apne kaam ke liye
  // lena chahenge?"). The AI only ever DECIDES the stage transition
  // (referralStage) — the actual phone number is appended here, by code,
  // so it's always the real configured number and never something the LLM
  // could get wrong or hallucinate.
  let outboundText = parsed.reply;
  const referralPersonName =
    settings.referral?.personName || env.referral.personName;
  const referralContactNumber =
    settings.referral?.contactNumber || env.referral.contactNumber;
  const referralEnabled = settings.referral?.enabled ?? env.referral.enabled;

  if (
    referralEnabled &&
    conversation.referralStatus === "none" &&
    parsed.referralStage === "ask_now"
  ) {
    conversation.referralStatus = "asked";
    conversation.referralAskedAt = new Date();
  } else if (
    conversation.referralStatus === "asked" &&
    parsed.referralStage === "accepted"
  ) {
    conversation.referralStatus = "accepted";
    conversation.referralRespondedAt = new Date();
    if (referralContactNumber) {
      outboundText = `${parsed.reply}\n\n${referralPersonName} ka number: ${referralContactNumber}\nAap directly WhatsApp/call kar sakte hain 🙂`;
    } else {
      logger.warn(
        `[ai] Referral accepted for lead ${lead._id} but no referral contact number is configured (set REFERRAL_CONTACT_NUMBER or Settings.referral.contactNumber)`,
      );
    }
  } else if (
    conversation.referralStatus === "asked" &&
    parsed.referralStage === "declined"
  ) {
    conversation.referralStatus = "declined";
    conversation.referralRespondedAt = new Date();
  }

  // Mirror the key fields back onto Lead so existing list/filter/CSV export UI stays useful.
  const leadUpdates = {};
  if (mergedRequirements.city) leadUpdates.city = mergedRequirements.city;
  if (mergedRequirements.location)
    leadUpdates.location = mergedRequirements.location;
  if (mergedRequirements.budgetMin != null)
    leadUpdates.budgetMin = mergedRequirements.budgetMin;
  if (mergedRequirements.budgetMax != null)
    leadUpdates.budgetMax = mergedRequirements.budgetMax;
  if (Object.keys(leadUpdates).length) {
    await Lead.updateOne({ _id: lead._id }, { $set: leadUpdates });
  }

  // Small human-like "typing" pause before sending — kept tight at 3-4s
  // (randomized so every reply doesn't land at the exact same delay) rather
  // than the old 2/5/10s Settings dropdown, which could feel too slow.
  const replyDelayMs = 500 + Math.floor(Math.random() * 500); // 3000-4000ms
  await new Promise((resolve) => setTimeout(resolve, replyDelayMs));

  // Send the reply out through the Meta WhatsApp Cloud API. This is always a
  // free-text send here — an inbound customer message is exactly what opens
  // the 24h customer service window in the first place, so we're always
  // inside it at this point.
  let outbound;
  try {
    const { messageId } = await metaWhatsappClient.sendToLead({
      phone: lead.phone,
      text: outboundText,
    });

    outbound = await recordOutboundMessage({
      conversationId: conversation._id,
      leadId: lead._id,
      text: outboundText,
      sender: "ai",
      whatsappMessageId: messageId || null,
      aiPrompt: systemInstruction,
      aiResponseRaw: raw,
      intent: parsed.intent,
      sentiment: parsed.sentiment,
    });

    if (isBrochureRequest(currentMessage) && candidateProperties.length > 0) {
      const propertyWithBrochure = candidateProperties.find(
        (property) => property?.brochureUrl,
      );

      if (propertyWithBrochure?.brochureUrl) {
        try {
          const brochureResult = await metaWhatsappClient.sendDocumentMessage({
            phone: lead.phone,
            documentUrl: propertyWithBrochure.brochureUrl,
            filename:
              propertyWithBrochure.brochureName ||
              `${propertyWithBrochure.projectName || "property"}-brochure.pdf`,
            caption: `${
              propertyWithBrochure.projectName || "Property"
            } ka brochure 📄`,
          });

          logger.info(`[ai] Brochure sent to lead ${lead._id}`, {
            propertyId: propertyWithBrochure._id,
            projectName: propertyWithBrochure.projectName,
            messageId: brochureResult.messageId,
          });
        } catch (err) {
          logger.error(`[ai] Failed to send brochure to lead ${lead._id}`, {
            error: err.metaError || err.response?.data || err.message,
          });
        }
      } else {
        logger.info(`[ai] Brochure requested but no brochure available`, {
          leadId: lead._id,
          propertyId: candidateProperties[0]?._id,
        });
      }
    }
  } catch (err) {
    logger.error(
      `[ai] Failed to send AI reply for lead ${lead._id} via Meta WhatsApp Cloud API`,
      { error: err.response?.data || err.message },
    );
    await Notification.create({
      userId: conversation.ownerId,
      type: "whatsapp_send_failed",
      title: `Couldn't message ${lead.name || "lead"} — WhatsApp send failed`,
      body: `Sending via WhatsApp failed for ${lead.phone}: ${err.message}`,
      link: `/leads/${lead._id}`,
    });
    emitToUser(conversation.ownerId, "notification:new", { leadId: lead._id });
    return;
  }

  // Buyer just agreed to a site visit — create it automatically.
  if (parsed.wantsSiteVisit) {
    await createSiteVisit({
      lead,
      conversation,
      date: parsed.proposedDate,
      time: parsed.proposedTime,
      property: candidateProperties[0],
    });
  }

  conversation.requirementsComplete = !!parsed.readyForPropertyRecommendation;
  await conversation.save();

  emitToUser(conversation.ownerId, "conversation:aiReply", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  // Lead scoring + follow-up planning runs as a separate Gemini pass, fired
  // async so the buyer isn't kept waiting on a second model call.
  analyzeConversationAsync({
    leadId: lead._id,
    conversationId: conversation._id,
  }).catch((err) =>
    logger.error(`[ai] Async lead analysis failed for lead ${lead._id}`, {
      error: err.message,
    }),
  );
}

/**
 * Sends the very first outbound WhatsApp message to a lead.
 *
 * Ab yeh function queue worker (services/queue/bulkWorker.js) ke liye
 * banaya gaya hai, isliye:
 *   - Success par        -> { sent: true, usedTemplate }
 *   - Skip karna pade to -> { skipped: true, reason }
 *       reasons: not_ai_active | already_started | ai_paused | whatsapp_disconnected
 *   - Koi bhi ERROR par  -> THROW karta hai (err.code / err.metaError ke saath),
 *       taaki worker retry ya fail decide kar sake. Yahan koi error nigla nahi jata.
 *
 * Idempotent: agar outbound message pehle se ja chuka hai to dobara nahi bhejta
 * (isse retry par double message nahi jayega).
 */
async function startConversation({ lead, conversation }) {
  if (conversation.status !== "ai_active") {
    return { skipped: true, reason: "not_ai_active" };
  }

  const alreadyStarted = await Message.exists({
    conversationId: conversation._id,
    direction: "outbound",
  });
  if (alreadyStarted) return { skipped: true, reason: "already_started" };

  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.phoneNumberId) {
    const err = new Error(
      "Meta WhatsApp Cloud API is not configured (META_WHATSAPP_ACCESS_TOKEN / META_WHATSAPP_PHONE_NUMBER_ID)",
    );
    err.code = "META_NOT_CONFIGURED";
    throw err;
  }

  const settings = await settingsService.getOrCreateSettings();
  if (settings.aiPaused || !settings.autoReplyEnabled) {
    return { skipped: true, reason: "ai_paused" };
  }
  if (settings.whatsappDisconnected) {
    return { skipped: true, reason: "whatsapp_disconnected" };
  }

  const openingText =
    settings.openingText ||
    env.metaWhatsapp.openingText ||
    settings.greetingMessage ||
    "Hi! Thanks for your interest. I'm here to help you find the right property 🙂";

  let outbound = null;
  let usedTemplate = false;

  try {
    const lastInboundAt = conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt)
      : null;

    const isWindowOpen =
      lastInboundAt &&
      !Number.isNaN(lastInboundAt.getTime()) &&
      Date.now() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;

    if (isWindowOpen) {
      // Customer ne last 24 hours mein message kiya hai: normal text allowed.
      const { messageId } = await metaWhatsappClient.sendTextMessage({
        phone: lead.phone,
        text: openingText,
      });

      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: openingText,
        sender: "ai",
        whatsappMessageId: messageId || null,
      });

      logger.info(
        `[ai] Opening text sent via Meta Cloud API for lead ${lead._id}`,
        { phone: lead.phone, reason: "24h-window-open" },
      );
    } else {
      // New lead / closed 24-hour window: approved template first.
      // ENV value takes priority over an old template saved in Settings.
      const templateName =
        env.metaWhatsapp.openingTemplateName || settings.openingTemplate?.name;

      const templateLanguage =
        env.metaWhatsapp.openingTemplateLanguage ||
        settings.openingTemplate?.language;

      if (!templateName) {
        const err = new Error(
          "Opening template is not configured. Set META_WHATSAPP_OPENING_TEMPLATE_NAME.",
        );
        err.code = "OPENING_TEMPLATE_MISSING";
        throw err;
      }

      const components = [];

      // Use this only if the approved template has an IMAGE header.
      const imageUrl = process.env.META_WHATSAPP_OPENING_TEMPLATE_IMAGE_URL;

      if (imageUrl) {
        components.push({
          type: "header",
          parameters: [
            {
              type: "image",
              image: { link: imageUrl },
            },
          ],
        });
      }

      const { messageId } = await metaWhatsappClient.sendTemplateMessage({
        phone: lead.phone,
        templateName,
        languageCode: templateLanguage,
        components,
      });

      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: `[Template: ${templateName}]`,
        sender: "ai",
        whatsappMessageId: messageId || null,
      });

      usedTemplate = true;

      logger.info(`[ai] Opening WhatsApp template sent for lead ${lead._id}`, {
        templateName,
        templateLanguage,
        reason: "24h-window-closed",
      });
    }
  } catch (err) {
    logger.error(
      `[ai] Failed to send opening WhatsApp message for lead ${lead._id}`,
      {
        error: err.metaError || err.response?.data || err.message,
        code: err.code,
        phone: lead.phone,
      },
    );
    // IMPORTANT: error ko nigalna nahi hai — worker ko pata chalna chahiye.
    throw err;
  }

  conversation.templateSent = usedTemplate;
  conversation.templateSentAt = usedTemplate ? new Date() : null;
  conversation.lastMessageAt = new Date();
  await conversation.save();

  emitToUser(conversation.ownerId, "conversation:aiReply", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  return { sent: true, usedTemplate };
}

/**
 * Broker ke woh leads dhundhta hai jinka conversation ai_active hai lekin
 * abhi tak koi message nahi gaya, aur unhe QUEUE mein daal deta hai.
 * (Ab seedha message nahi bhejta — isse 100+ leads par parallel burst nahi hoga.)
 *
 * Skip karta hai:
 *   - jinka message pehle se ja chuka hai
 *   - jinka job pehle 'failed' ya 'cancelled' ho chuka hai
 *     (warna har server restart par woh dobara queue mein aa jate)
 *   - jinka job abhi pending/processing/paused hai (enqueueLeads khud handle karta hai)
 */
async function catchUpPendingConversations(brokerId) {
  const pending = await Conversation.find({
    ownerId: brokerId,
    status: "ai_active",
  })
    .select("_id leadId")
    .lean();
  if (!pending.length) return;

  const conversationIds = pending.map((c) => c._id);
  const leadIds = pending.map((c) => c.leadId);

  const [withMessages, blockedLeadIds] = await Promise.all([
    Message.distinct("conversationId", {
      conversationId: { $in: conversationIds },
    }),
    OutboundJob.distinct("leadId", {
      leadId: { $in: leadIds },
      status: { $in: ["failed", "cancelled"] },
    }),
  ]);

  const hasMessageSet = new Set(withMessages.map(String));
  const blockedSet = new Set(blockedLeadIds.map(String));

  const toQueue = pending
    .filter(
      (c) =>
        !hasMessageSet.has(String(c._id)) && !blockedSet.has(String(c.leadId)),
    )
    .map((c) => c.leadId);

  if (!toQueue.length) return;

  const { queued } = await enqueueLeads({
    ownerId: brokerId,
    leadIds: toQueue,
  });

  if (queued) {
    logger.info(
      `[ai] Catch-up: ${queued} pending conversation(s) queued for broker ${brokerId}`,
    );
  }
}

function mergeRequirements(existing, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Creates a Meeting the first time a buyer agrees to a site visit for this
 * lead, and simply UPDATES that same Meeting on every later turn instead of
 * inserting a new one — e.g. if the AI re-confirms the date/time again a
 * few messages later, or the buyer changes the time mid-conversation. Only
 * an already-finished meeting (visited / not_visited / cancelled) is left
 * alone and a fresh one started, since that's a genuinely new visit.
 */
async function createSiteVisit({ lead, conversation, date, time, property }) {
  const preferredDate =
    date || new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10); // default: 2 days out if not specified yet
  const preferredTime = time || "11:00";

  let meeting = await Meeting.findOne({
    leadId: lead._id,
    status: { $in: ["scheduled", "rescheduled"] },
  }).sort({ createdAt: -1 });

  let isNew = false;
  if (meeting) {
    meeting.preferredDate = preferredDate;
    meeting.preferredTime = preferredTime;
    if (property?._id) meeting.propertyId = property._id;
    meeting.status = "scheduled";
    await meeting.save();
  } else {
    isNew = true;
    meeting = await Meeting.create({
      leadId: lead._id,
      ownerId: conversation.ownerId,
      propertyId: property?._id || null,
      preferredDate,
      preferredTime,
      status: "scheduled",
    });
  }

  // Cached copy on Conversation for quick UI reads — Meeting model remains
  // the source of truth. Keep this in sync any time Meeting.status changes
  // elsewhere too (e.g. a broker marking a visit as done/cancelled).
  conversation.meetingStatus = "scheduled";
  await Lead.updateOne({ _id: lead._id }, { $set: { status: "site_visit" } });

  // Book/update the real calendar event. Best-effort: a Calendar failure
  // must never block the WhatsApp conversation or lose the Meeting record.
  try {
    if (meeting.googleEventId) {
      const event = await updateCalendarEvent({
        eventId: meeting.googleEventId,
        date: preferredDate,
        time: preferredTime,
      });
      if (event) {
        meeting.googleEventLink = event.eventLink;
        await meeting.save();
      }
    } else {
      const event = await createCalendarEvent({
        summary: `Site Visit — ${lead.name || lead.phone}${property ? ` (${property.projectName})` : ""}`,
        description: [
          `Lead: ${lead.name || "N/A"} (${lead.phone})`,
          property
            ? `Property: ${property.projectName}, ${property.city || ""}`
            : null,
          "Booked automatically by the AI WhatsApp assistant.",
        ]
          .filter(Boolean)
          .join("\n"),
        date: preferredDate,
        time: preferredTime,
      });
      if (event) {
        meeting.googleEventId = event.eventId;
        meeting.googleEventLink = event.eventLink;
        await meeting.save();
      }
    }
  } catch (err) {
    logger.error(
      `[calendar] Failed to sync Google Calendar event for lead ${lead._id}`,
      { error: err.message },
    );
  }

  if (isNew) {
    await Notification.create({
      userId: conversation.ownerId,
      type: "site_visit_scheduled",
      title: `Site visit scheduled — ${lead.name}`,
      body: `${preferredDate} at ${preferredTime}${property ? ` for ${property.projectName}` : ""}`,
      link: `/leads/${lead._id}`,
    });
  }

  emitToUser(conversation.ownerId, "meeting:created", { meeting });

  return meeting;
}

module.exports = {
  handleInbound,
  createSiteVisit,
  startConversation,
  catchUpPendingConversations,
};
