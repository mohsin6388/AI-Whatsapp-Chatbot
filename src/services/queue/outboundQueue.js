const { randomUUID } = require("crypto");
const mongoose = require("mongoose");
const OutboundJob = require("../../models/OutboundJob");
const Campaign = require("../../models/Campaign");

const STATUSES = [
  "pending",
  "processing",
  "sent",
  "failed",
  "cancelled",
  "paused",
];
const CHANNELS = ["whatsapp", "email"];
const IST_OFFSET = "+05:30"; // India mein DST nahi hota, isliye fixed offset safe hai
const INSERT_CHUNK = 1000;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/* ------------------------------------------------------------------ */
/* Time helpers (Asia/Kolkata)                                         */
/* ------------------------------------------------------------------ */

/** Aaj ki date IST mein, 'YYYY-MM-DD' */
function todayIST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** startDate + dayIndex din ka `sendTime` (IST) ek UTC Date ke roop mein */
function runAtForDay(startDate, sendTime, dayIndex) {
  const [y, m, d] = startDate.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + dayIndex))
    .toISOString()
    .slice(0, 10);
  return new Date(`${day}T${sendTime}:00${IST_OFFSET}`);
}

/* ------------------------------------------------------------------ */
/* Stats helpers                                                       */
/* ------------------------------------------------------------------ */

function emptyStats() {
  // scheduled = pending jobs jinka time abhi aaya nahi (future din / backoff)
  const stats = { total: 0, scheduled: 0 };
  for (const s of STATUSES) stats[s] = 0;
  return stats;
}

function emptyByChannel() {
  return { whatsapp: emptyStats(), email: emptyStats() };
}

function addRow(target, channel, status, future, count) {
  const s = target[channel];
  if (!s || !(status in s)) return;
  s[status] += count;
  s.total += count;
  if (status === "pending" && future) s.scheduled += count;
}

/** { whatsapp: {...stats}, email: {...stats} } for any $match */
async function aggregateByChannel(match) {
  const now = new Date();
  const rows = await OutboundJob.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          channel: { $ifNull: ["$channel", "whatsapp"] },
          status: "$status",
          future: { $gt: ["$nextRunAt", now] },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const out = emptyByChannel();
  for (const r of rows) {
    addRow(out, r._id.channel, r._id.status, r._id.future, r.count);
  }
  return out;
}

/** Ek campaign ka live progress, channel ke hisab se */
function getCampaignStats(campaignId) {
  return aggregateByChannel({ campaignId: oid(campaignId) });
}

/** Purane (campaign-less) batch ka progress, saare channels mila kar */
async function getBatchStats(batchId) {
  const byChannel = await aggregateByChannel({ batchId });
  const merged = emptyStats();
  for (const ch of CHANNELS) {
    for (const key of Object.keys(merged)) merged[key] += byChannel[ch][key];
  }
  return merged;
}

/** Sidebar / header ke liye: owner ke saare jobs ka channel-wise summary */
async function getOutreachSummary(ownerId) {
  const match = { ownerId: oid(ownerId) };
  const [byChannel, activeCampaigns, nextWa, nextEmail] = await Promise.all([
    aggregateByChannel(match),
    Campaign.countDocuments({ ownerId, status: { $in: ["active", "paused"] } }),
    OutboundJob.findOne({ ...match, channel: "whatsapp", status: "pending" })
      .sort({ nextRunAt: 1 })
      .select("nextRunAt")
      .lean(),
    OutboundJob.findOne({ ...match, channel: "email", status: "pending" })
      .sort({ nextRunAt: 1 })
      .select("nextRunAt")
      .lean(),
  ]);

  return {
    whatsapp: { ...byChannel.whatsapp, nextRunAt: nextWa?.nextRunAt || null },
    email: { ...byChannel.email, nextRunAt: nextEmail?.nextRunAt || null },
    activeCampaigns,
  };
}

/* ------------------------------------------------------------------ */
/* Enqueue                                                             */
/* ------------------------------------------------------------------ */

/**
 * Legacy / single-lead enqueue (manual "Start", naya lead, catch-up sweep).
 * Turant return karta hai. Jis lead ka WhatsApp job already
 * pending/processing/paused hai, use dobara nahi daalta.
 */
async function enqueueLeads({ ownerId, leadIds, batchId }) {
  if (!Array.isArray(leadIds) || !leadIds.length) {
    return { batchId: null, queued: 0, skipped: 0 };
  }

  const id = batchId || randomUUID();

  const activeLeadIds = await OutboundJob.find({
    leadId: { $in: leadIds },
    channel: { $in: ["whatsapp", null] },
    status: { $in: ["pending", "processing", "paused"] },
  }).distinct("leadId");
  const activeSet = new Set(activeLeadIds.map(String));

  const now = new Date();
  const docs = leadIds
    .filter((leadId) => !activeSet.has(String(leadId)))
    .map((leadId, i) => ({
      batchId: id,
      ownerId,
      leadId,
      channel: "whatsapp",
      priority: 0,
      seq: i,
      status: "pending",
      scheduledFor: now,
      nextRunAt: now,
    }));

  if (docs.length) {
    await OutboundJob.insertMany(docs, { ordered: false });
  }

  return {
    batchId: id,
    queued: docs.length,
    skipped: leadIds.length - docs.length,
  };
}

/**
 * Campaign ke saare jobs ek baar mein schedule karta hai.
 *
 * leads: [{ _id, hasEmail }] — upload ke order mein.
 * Lead #i ka din = floor(i / dailyLimit). Us din ke `sendTime` par uske jobs
 * "due" ho jate hain; worker ek-ek karke bhejta hai (WhatsApp pehle, phir Email).
 */
async function scheduleCampaignJobs({ campaign, leads }) {
  const now = new Date();
  const perDay = campaign.dailyLimit > 0 ? campaign.dailyLimit : 0;
  const wantWa = campaign.channels.whatsapp;
  const wantEmail = campaign.channels.email;

  const docs = [];
  let waCount = 0;
  let emailCount = 0;
  let maxDay = 0;
  let firstRunAt = null;
  let lastRunAt = null;

  leads.forEach((lead, i) => {
    const dayIndex = perDay ? Math.floor(i / perDay) : 0;
    let runAt = perDay
      ? runAtForDay(campaign.startDate, campaign.sendTime, dayIndex)
      : now;
    if (runAt < now) runAt = now; // aaj ka time nikal chuka hai -> abhi se shuru
    maxDay = Math.max(maxDay, dayIndex);
    if (!firstRunAt || runAt < firstRunAt) firstRunAt = runAt;
    if (!lastRunAt || runAt > lastRunAt) lastRunAt = runAt;

    const common = {
      batchId: String(campaign._id),
      ownerId: campaign.ownerId,
      leadId: lead._id,
      campaignId: campaign._id,
      seq: i,
      dayNumber: dayIndex + 1,
      status: "pending",
      scheduledFor: runAt,
      nextRunAt: runAt,
    };

    if (wantWa) {
      docs.push({ ...common, channel: "whatsapp", priority: 0 });
      waCount += 1;
    }
    if (wantEmail && lead.hasEmail) {
      docs.push({ ...common, channel: "email", priority: 1 });
      emailCount += 1;
    }
  });

  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    await OutboundJob.insertMany(docs.slice(i, i + INSERT_CHUNK), {
      ordered: false,
    });
  }

  return {
    whatsapp: waCount,
    email: emailCount,
    totalDays: maxDay + 1,
    firstRunAt,
    lastRunAt,
  };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

/** Owner ke recent campaigns + har ek ka channel-wise progress */
async function listCampaigns(ownerId, { limit = 20 } = {}) {
  const campaigns = await Campaign.find({ ownerId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  if (!campaigns.length) return [];

  const now = new Date();
  const rows = await OutboundJob.aggregate([
    { $match: { campaignId: { $in: campaigns.map((c) => c._id) } } },
    {
      $group: {
        _id: {
          campaignId: "$campaignId",
          channel: { $ifNull: ["$channel", "whatsapp"] },
          status: "$status",
          future: { $gt: ["$nextRunAt", now] },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const statsById = new Map();
  for (const r of rows) {
    const key = String(r._id.campaignId);
    if (!statsById.has(key)) statsById.set(key, emptyByChannel());
    addRow(statsById.get(key), r._id.channel, r._id.status, r._id.future, r.count);
  }

  return campaigns.map((c) => ({
    ...c,
    stats: statsById.get(String(c._id)) || emptyByChannel(),
  }));
}

/** Ek job ko frontend-friendly shape mein badalta hai */
function mapJob(j, now = new Date()) {
  return {
    id: String(j._id),
    leadId: j.leadId?._id ? String(j.leadId._id) : null,
    name: j.leadId?.name || "(deleted lead)",
    phone: j.leadId?.phone || "",
    email: j.leadId?.email || "",
    channel: j.channel || "whatsapp",
    campaignId: j.campaignId ? String(j.campaignId) : null,
    status: j.status,
    scheduled: j.status === "pending" && new Date(j.nextRunAt) > now,
    attempts: j.attempts,
    dayNumber: j.dayNumber,
    scheduledFor: j.scheduledFor,
    nextRunAt: j.nextRunAt,
    sentAt: j.sentAt,
    lastError: j.lastError,
  };
}

/**
 * Campaign ki lead-wise list: har lead ek row, usme WhatsApp + Email dono ka status.
 * Lead ka order `seq` (0-based) hai, isliye page = seq ki range.
 */
async function listCampaignLeads(ownerId, { campaignId, page = 1, limit = 25 }) {
  const campaign = await Campaign.findOne({ _id: campaignId, ownerId }).lean();
  if (!campaign) return null;

  const from = (page - 1) * limit;
  const jobs = await OutboundJob.find({
    campaignId: campaign._id,
    seq: { $gte: from, $lt: from + limit },
  })
    .populate("leadId", "name phone email")
    .lean();

  const now = new Date();
  const bySeq = new Map();
  for (const j of jobs) {
    const m = mapJob(j, now);
    if (!bySeq.has(j.seq)) {
      bySeq.set(j.seq, {
        seq: j.seq,
        leadId: m.leadId,
        name: m.name,
        phone: m.phone,
        leadEmail: m.email,
        dayNumber: j.dayNumber,
        scheduledFor: j.scheduledFor,
        jobs: { whatsapp: null, email: null },
      });
    }
    bySeq.get(j.seq).jobs[m.channel] = m;
  }

  return {
    leads: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    pagination: {
      page,
      limit,
      total: campaign.totalLeads,
      totalPages: Math.ceil(campaign.totalLeads / limit),
    },
  };
}

/**
 * Outreach page ki lead-wise list.
 * statusFilter: sent | failed | processing | paused | cancelled
 *               | pending (abhi due) | scheduled (future)
 */
async function listJobs(
  ownerId,
  { channel, campaignId, status, page = 1, limit = 50 } = {},
) {
  const filter = { ownerId: oid(ownerId) };
  if (channel) filter.channel = channel;
  if (campaignId) filter.campaignId = oid(campaignId);

  const now = new Date();
  if (status === "scheduled") {
    filter.status = "pending";
    filter.nextRunAt = { $gt: now };
  } else if (status === "pending") {
    filter.status = "pending";
    filter.nextRunAt = { $lte: now };
  } else if (status) {
    filter.status = status;
  }

  const [jobs, total] = await Promise.all([
    OutboundJob.find(filter)
      .sort({ scheduledFor: 1, seq: 1, priority: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("leadId", "name phone email")
      .lean(),
    OutboundJob.countDocuments(filter),
  ]);

  return {
    jobs: jobs.map((j) => mapJob(j, now)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/* ------------------------------------------------------------------ */
/* Controls (campaign level)                                           */
/* ------------------------------------------------------------------ */

async function findCampaign(ownerId, campaignId) {
  return Campaign.findOne({ _id: campaignId, ownerId });
}

/** Pending jobs ko rok do (jo chal chuka hai woh nahi rukega) */
async function pauseCampaign(ownerId, campaignId) {
  const campaign = await findCampaign(ownerId, campaignId);
  if (!campaign) return null;
  const res = await OutboundJob.updateMany(
    { campaignId: campaign._id, status: "pending" },
    { $set: { status: "paused" } },
  );
  if (campaign.status === "active") {
    campaign.status = "paused";
    await campaign.save();
  }
  return { campaign, modified: res.modifiedCount };
}

/** Schedule waisa hi rehta hai — jo time nikal chuka woh turant chalega */
async function resumeCampaign(ownerId, campaignId) {
  const campaign = await findCampaign(ownerId, campaignId);
  if (!campaign) return null;
  const res = await OutboundJob.updateMany(
    { campaignId: campaign._id, status: "paused" },
    { $set: { status: "pending" } },
  );
  if (campaign.status === "paused") {
    campaign.status = "active";
    await campaign.save();
  }
  return { campaign, modified: res.modifiedCount };
}

async function cancelCampaign(ownerId, campaignId) {
  const campaign = await findCampaign(ownerId, campaignId);
  if (!campaign) return null;
  const res = await OutboundJob.updateMany(
    { campaignId: campaign._id, status: { $in: ["pending", "paused"] } },
    { $set: { status: "cancelled" } },
  );
  if (campaign.status !== "completed") {
    campaign.status = "cancelled";
    await campaign.save();
  }
  return { campaign, modified: res.modifiedCount };
}

/** Failed jobs ko dobara pending banata hai (optional: sirf ek channel) */
async function retryFailed(ownerId, campaignId, channel) {
  const campaign = await findCampaign(ownerId, campaignId);
  if (!campaign) return null;

  const filter = { campaignId: campaign._id, status: "failed" };
  if (channel) filter.channel = channel;

  const res = await OutboundJob.updateMany(filter, {
    $set: {
      status: "pending",
      attempts: 0,
      nextRunAt: new Date(),
      lastError: null,
      lastErrorCode: null,
    },
  });

  if (res.modifiedCount && ["completed", "cancelled"].includes(campaign.status)) {
    campaign.status = "active";
    campaign.completedAt = null;
    await campaign.save();
  }
  return { campaign, modified: res.modifiedCount };
}

/**
 * Server crash/restart ke baad 'processing' mein atke jobs ko wapas pending karta hai.
 * Server start par aur worker loop mein periodically chalta hai.
 */
async function recoverStuckJobs(olderThanMs = 5 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await OutboundJob.updateMany(
    { status: "processing", lockedAt: { $lt: cutoff } },
    { $set: { status: "pending", nextRunAt: new Date() } },
  );
  return res.modifiedCount;
}

module.exports = {
  CHANNELS,
  STATUSES,
  todayIST,
  runAtForDay,
  enqueueLeads,
  scheduleCampaignJobs,
  getBatchStats,
  getCampaignStats,
  getOutreachSummary,
  listCampaigns,
  listJobs,
  listCampaignLeads,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  retryFailed,
  recoverStuckJobs,
};
