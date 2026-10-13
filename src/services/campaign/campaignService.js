const Campaign = require("../../models/Campaign");
const AuditLog = require("../../models/AuditLog");
const ApiError = require("../../utils/ApiError");
const { importLeadRows } = require("../leads/leadImportService");
const { scheduleCampaignJobs, todayIST } = require("../queue/outboundQueue");
const { emitToUser } = require("../../sockets");

/**
 * Bulk upload -> Campaign.
 *
 *  1. Leads (name + phone + optional email) insert hoti hain.
 *  2. Campaign banta hai (channels, daily limit, send time, email template).
 *  3. Saare jobs ek baar mein schedule ho jate hain: lead #i -> din floor(i/dailyLimit),
 *     us din ke sendTime par. Worker unhe ek-ek karke bhejta hai.
 */
async function launchCampaign({ ownerId, userId, ip, rows, config }) {
  const { inserted, skipped, invalid } = await importLeadRows(ownerId, rows);

  if (!inserted.length) {
    throw ApiError.badRequest(
      "Koi nayi lead insert nahi hui — saari rows duplicate ya invalid thi.",
    );
  }

  const today = todayIST();
  // Beeta hua din na ho
  const startDate =
    config.startDate && config.startDate >= today ? config.startDate : today;

  const campaign = await Campaign.create({
    ownerId,
    name: config.name,
    channels: config.channels,
    dailyLimit: config.dailyLimit,
    sendTime: config.sendTime,
    startDate,
    email: { subject: config.emailSubject, body: config.emailBody },
    totalLeads: inserted.length,
  });

  const withoutEmail = inserted.filter((l) => !l.email).length;

  const plan = await scheduleCampaignJobs({
    campaign,
    leads: inserted.map((l) => ({ _id: l._id, hasEmail: Boolean(l.email) })),
  });

  campaign.leadsWithoutEmail = config.channels.email ? withoutEmail : 0;
  campaign.totalDays = plan.totalDays;
  campaign.firstRunAt = plan.firstRunAt;
  campaign.lastRunAt = plan.lastRunAt;
  await campaign.save();

  await AuditLog.create({
    userId,
    action: "campaign.launch",
    entityType: "Campaign",
    entityId: campaign._id,
    meta: {
      leads: inserted.length,
      skippedDuplicates: skipped,
      invalid,
      channels: config.channels,
      dailyLimit: config.dailyLimit,
      sendTime: config.sendTime,
    },
    ip,
  });

  emitToUser(ownerId, "outreach:campaign", {
    campaignId: String(campaign._id),
    status: "active",
  });

  return {
    campaign,
    insertedCount: inserted.length,
    skipped,
    invalid,
    queued: { whatsapp: plan.whatsapp, email: plan.email },
    withoutEmail: campaign.leadsWithoutEmail,
    totalDays: plan.totalDays,
    firstRunAt: plan.firstRunAt,
    lastRunAt: plan.lastRunAt,
  };
}

module.exports = { launchCampaign };
