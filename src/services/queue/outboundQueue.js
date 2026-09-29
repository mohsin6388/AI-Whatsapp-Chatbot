const { randomUUID } = require("crypto");
const mongoose = require("mongoose");
const OutboundJob = require("../../models/OutboundJob");

const STATUSES = [
  "pending",
  "processing",
  "sent",
  "failed",
  "cancelled",
  "paused",
];

/**
 * Leads ko queue mein daalta hai. Turant return karta hai (message nahi bhejta).
 * Jis lead ka job already pending/processing/paused hai, use dobara nahi daalta.
 */
async function enqueueLeads({ ownerId, leadIds, batchId }) {
  if (!Array.isArray(leadIds) || !leadIds.length) {
    return { batchId: null, queued: 0, skipped: 0 };
  }

  const id = batchId || randomUUID();

  const activeLeadIds = await OutboundJob.find({
    leadId: { $in: leadIds },
    status: { $in: ["pending", "processing", "paused"] },
  }).distinct("leadId");
  const activeSet = new Set(activeLeadIds.map(String));

  const docs = leadIds
    .filter((leadId) => !activeSet.has(String(leadId)))
    .map((leadId) => ({
      batchId: id,
      ownerId,
      leadId,
      status: "pending",
      nextRunAt: new Date(),
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

function emptyStats() {
  const stats = { total: 0 };
  for (const s of STATUSES) stats[s] = 0;
  return stats;
}

/** Ek batch ka live progress: { total, pending, processing, sent, failed, cancelled, paused } */
async function getBatchStats(batchId) {
  const rows = await OutboundJob.aggregate([
    { $match: { batchId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const stats = emptyStats();
  for (const r of rows) {
    stats[r._id] = r.count;
    stats.total += r.count;
  }
  return stats;
}

/** Owner ke recent batches (progress bar list ke liye) */
async function listBatches(ownerId, limit = 10) {
  const rows = await OutboundJob.aggregate([
    { $match: { ownerId: new mongoose.Types.ObjectId(String(ownerId)) } },
    {
      $group: {
        _id: { batchId: "$batchId", status: "$status" },
        count: { $sum: 1 },
        createdAt: { $min: "$createdAt" },
      },
    },
  ]);

  const byBatch = new Map();
  for (const r of rows) {
    const key = r._id.batchId;
    if (!byBatch.has(key)) {
      byBatch.set(key, {
        batchId: key,
        createdAt: r.createdAt,
        ...emptyStats(),
      });
    }
    const b = byBatch.get(key);
    b[r._id.status] = r.count;
    b.total += r.count;
    if (r.createdAt < b.createdAt) b.createdAt = r.createdAt;
  }

  return [...byBatch.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

/** Pending jobs ko rok do (jo chal chuka hai woh nahi rukega) */
async function pauseBatch(ownerId, batchId) {
  const res = await OutboundJob.updateMany(
    { ownerId, batchId, status: "pending" },
    { $set: { status: "paused" } },
  );
  return res.modifiedCount;
}

async function resumeBatch(ownerId, batchId) {
  const res = await OutboundJob.updateMany(
    { ownerId, batchId, status: "paused" },
    { $set: { status: "pending", nextRunAt: new Date() } },
  );
  return res.modifiedCount;
}

async function cancelBatch(ownerId, batchId) {
  const res = await OutboundJob.updateMany(
    { ownerId, batchId, status: { $in: ["pending", "paused"] } },
    { $set: { status: "cancelled" } },
  );
  return res.modifiedCount;
}

/** Failed jobs ko dobara pending banata hai */
async function retryFailed(ownerId, batchId) {
  const res = await OutboundJob.updateMany(
    { ownerId, batchId, status: "failed" },
    {
      $set: {
        status: "pending",
        attempts: 0,
        nextRunAt: new Date(),
        lastError: null,
        lastErrorCode: null,
      },
    },
  );
  return res.modifiedCount;
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
  enqueueLeads,
  getBatchStats,
  listBatches,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  retryFailed,
  recoverStuckJobs,
};
