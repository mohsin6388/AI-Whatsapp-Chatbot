const OutboundJob = require("../../models/OutboundJob");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Notification = require("../../models/Notification");

const conversationEngine = require("../ai/conversationEngine");
const { getBatchStats, recoverStuckJobs } = require("./outboundQueue");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

/**
 * Bulk WhatsApp worker.
 *
 * - Ek hi loop, ek time par SIRF ek message (1 msg/sec default) -> burst nahi hota.
 * - Jobs DB mein hain, isliye restart/crash par kuch nahi khota.
 * - Errors 4 tarah ke hote hain:
 *     rate_limit  -> poora worker thodi der rukta hai, job dobara try hota hai (attempt burn nahi)
 *     fatal_pause -> token/payment/config problem: worker 10 min rukta hai, job safe rehta hai
 *     retry       -> temporary problem: backoff ke saath retry (attempt burn hota hai)
 *     permanent   -> number invalid etc: job seedha 'failed'
 *
 * Tuning (optional, .env mein):
 *   BULK_SEND_INTERVAL_MS=1000   (do messages ke beech ka gap)
 */

const SEND_INTERVAL_MS = parseInt(
  process.env.BULK_SEND_INTERVAL_MS || "1000",
  10,
);
const IDLE_POLL_MS = 2000;
const RATE_LIMIT_PAUSE_MS = 60 * 1000;
const FATAL_PAUSE_MS = 10 * 60 * 1000;
const RETRY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const RECOVER_EVERY_MS = 60 * 1000;

// Meta error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const RATE_LIMIT_CODES = new Set(["130429", "131056", "80007", "4"]);
const FATAL_PAUSE_CODES = new Set([
  "190", // access token invalid/expired
  "102", // session/token problem
  "10", // permission denied
  "131042", // payment / business eligibility problem
  "131031", // account locked
  "131048", // spam rate limit hit
  "133010", // phone number not registered
  "META_NOT_CONFIGURED",
  "OPENING_TEMPLATE_MISSING",
]);
const TEMP_RETRY_CODES = new Set(["131000", "131016", "131057"]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

let running = false;
let pausedUntil = 0; // global pause (timestamp ms)
let lastFatalNotifyAt = 0;
let lastRecoverAt = 0;
const notifiedBatches = new Set(); // batch-complete notification sirf ek baar

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error ko 4 categories mein baant-ta hai */
function classifyError(err) {
  const code = String(err?.metaError?.code ?? err?.code ?? "");
  const status = err?.response?.status;

  if (RATE_LIMIT_CODES.has(code) || status === 429) return "rate_limit";
  if (FATAL_PAUSE_CODES.has(code)) return "fatal_pause";
  if (TEMP_RETRY_CODES.has(code)) return "retry";
  if (NETWORK_ERROR_CODES.has(code)) return "retry";
  if (status >= 500) return "retry";
  if (!err?.response && !err?.metaError && !code) return "retry"; // unknown/network type error
  return "permanent";
}

function shortError(err) {
  const msg = err?.metaError?.message || err?.message || "Unknown error";
  return String(msg).slice(0, 500);
}

/** Atomic claim: do worker kabhi same job nahi uthayenge */
async function claimNext() {
  return OutboundJob.findOneAndUpdate(
    { status: "pending", nextRunAt: { $lte: new Date() } },
    {
      $set: { status: "processing", lockedAt: new Date() },
      $inc: { attempts: 1 },
    },
    { sort: { nextRunAt: 1 }, new: true },
  );
}

async function emitProgress(job) {
  try {
    const stats = await getBatchStats(job.batchId);
    emitToUser(job.ownerId, "bulk:progress", {
      batchId: job.batchId,
      ...stats,
    });
    return stats;
  } catch (err) {
    logger.warn("[queue] Could not emit bulk progress", { error: err.message });
    return null;
  }
}

/** Batch poora khatam ho jaye to broker ko ek summary notification */
async function notifyIfBatchDone(job, stats) {
  if (!stats || notifiedBatches.has(job.batchId)) return;
  if (stats.pending > 0 || stats.processing > 0 || stats.paused > 0) return;

  notifiedBatches.add(job.batchId);

  try {
    await Notification.create({
      userId: job.ownerId,
      type: "bulk_batch_done",
      title: `Bulk messaging complete — ${stats.sent}/${stats.total} sent`,
      body: stats.failed
        ? `${stats.failed} lead(s) failed. Leads page se failed list dekh kar retry kar sakte ho.`
        : "Sab messages successfully chale gaye.",
      link: "/leads",
    });
    emitToUser(job.ownerId, "notification:new", { batchId: job.batchId });
  } catch (err) {
    logger.warn("[queue] Could not create batch-done notification", {
      error: err.message,
    });
  }
}

async function markSent(job) {
  await OutboundJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "sent",
        sentAt: new Date(),
        lockedAt: null,
        lastError: null,
        lastErrorCode: null,
      },
    },
  );
}

async function markFailed(job, err, reason) {
  await OutboundJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "failed",
        lockedAt: null,
        lastError: reason || shortError(err),
        lastErrorCode: String(err?.metaError?.code ?? err?.code ?? "") || null,
      },
    },
  );
}

/** Job ko dobara pending karta hai (retry / global pause ke liye) */
async function requeue(job, err, delayMs, { burnAttempt }) {
  await OutboundJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "pending",
        lockedAt: null,
        nextRunAt: new Date(Date.now() + delayMs),
        lastError: shortError(err),
        lastErrorCode: String(err?.metaError?.code ?? err?.code ?? "") || null,
      },
      // claim par attempts +1 ho chuka hai; rate limit/fatal mein wapas kam kar do
      ...(burnAttempt ? {} : { $inc: { attempts: -1 } }),
    },
  );
}

async function notifyFatal(job, err) {
  // 10 min mein ek hi baar, warna notification spam ho jayega
  if (Date.now() - lastFatalNotifyAt < FATAL_PAUSE_MS) return;
  lastFatalNotifyAt = Date.now();

  try {
    await Notification.create({
      userId: job.ownerId,
      type: "whatsapp_send_failed",
      title: "Bulk messaging paused — WhatsApp problem",
      body: `Meta error: ${shortError(err)}. Worker 10 minute ke liye ruka hai, jobs safe hain. Token/payment/template check karo.`,
      link: "/whatsapp",
    });
    emitToUser(job.ownerId, "notification:new", { batchId: job.batchId });
  } catch (nErr) {
    logger.warn("[queue] Could not create fatal notification", {
      error: nErr.message,
    });
  }
}

/** Ek job process karta hai */
async function processJob(job) {
  const [lead, conversation] = await Promise.all([
    Lead.findById(job.leadId),
    Conversation.findOne({ leadId: job.leadId }),
  ]);

  if (!lead || !conversation) {
    await markFailed(job, null, "Lead ya conversation delete ho chuka hai");
    return;
  }

  try {
    const result = await conversationEngine.startConversation({
      lead,
      conversation,
    });

    if (result?.sent || result?.reason === "already_started") {
      await markSent(job);
      return;
    }

    if (result?.skipped) {
      // AI pause ya WhatsApp disconnect: batch ko 'paused' kar do, broker resume kar lega
      if (
        result.reason === "ai_paused" ||
        result.reason === "whatsapp_disconnected"
      ) {
        await OutboundJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: "paused",
              lockedAt: null,
              lastError: `Skipped: ${result.reason}`,
            },
            $inc: { attempts: -1 },
          },
        );
        return;
      }
      // not_ai_active (manual/closed): ab message bhejna sahi nahi
      await OutboundJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "cancelled",
            lockedAt: null,
            lastError: `Skipped: ${result.reason}`,
          },
        },
      );
      return;
    }

    await markSent(job);
  } catch (err) {
    const kind = classifyError(err);

    if (kind === "rate_limit") {
      pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      logger.warn(
        `[queue] Rate limit hit — worker ${RATE_LIMIT_PAUSE_MS / 1000}s ke liye ruk raha hai`,
        {
          code: err?.metaError?.code ?? err?.code,
        },
      );
      await requeue(job, err, RATE_LIMIT_PAUSE_MS, { burnAttempt: false });
      return;
    }

    if (kind === "fatal_pause") {
      pausedUntil = Date.now() + FATAL_PAUSE_MS;
      logger.error(
        `[queue] Fatal WhatsApp error — worker ${FATAL_PAUSE_MS / 60000} min ke liye ruk raha hai`,
        {
          error: shortError(err),
          code: err?.metaError?.code ?? err?.code,
        },
      );
      await requeue(job, err, FATAL_PAUSE_MS, { burnAttempt: false });
      await notifyFatal(job, err);
      return;
    }

    if (kind === "retry") {
      if (job.attempts >= job.maxAttempts) {
        await markFailed(job, err, `Max attempts reached: ${shortError(err)}`);
        return;
      }
      const delay =
        RETRY_BACKOFF_MS[
          Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)
        ];
      await requeue(job, err, delay, { burnAttempt: true });
      return;
    }

    // permanent
    await markFailed(job, err);
  }
}

async function loop() {
  while (running) {
    try {
      // Periodically stuck jobs recover karo
      if (Date.now() - lastRecoverAt > RECOVER_EVERY_MS) {
        lastRecoverAt = Date.now();
        const recovered = await recoverStuckJobs();
        if (recovered)
          logger.warn(`[queue] ${recovered} stuck job(s) wapas pending kiye`);
      }

      // Global pause chal raha hai to kuch mat uthao
      if (Date.now() < pausedUntil) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const job = await claimNext();
      if (!job) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      await processJob(job);

      const stats = await emitProgress(job);
      await notifyIfBatchDone(job, stats);

      // Do messages ke beech gap (+ thoda random jitter, bot jaisa na lage)
      await sleep(SEND_INTERVAL_MS + Math.floor(Math.random() * 300));
    } catch (err) {
      logger.error("[queue] Worker loop error", { error: err.message });
      await sleep(5000); // crash-loop se bachne ke liye
    }
  }
  logger.info("[queue] Bulk worker stopped");
}

async function startBulkWorker() {
  if (running) return;
  running = true;

  try {
    const recovered = await recoverStuckJobs(0); // boot par saare 'processing' jobs purane hain
    if (recovered)
      logger.warn(
        `[queue] Boot recovery: ${recovered} job(s) wapas pending kiye`,
      );
  } catch (err) {
    logger.error("[queue] Boot recovery failed", { error: err.message });
  }

  lastRecoverAt = Date.now();
  logger.info(`[queue] Bulk worker started (interval ~${SEND_INTERVAL_MS}ms)`);
  loop(); // background mein chalta rahega (await nahi)
}

function stopBulkWorker() {
  running = false;
}

module.exports = { startBulkWorker, stopBulkWorker };
