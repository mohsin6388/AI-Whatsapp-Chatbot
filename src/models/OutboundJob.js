const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Bulk / auto-start WhatsApp messages ki persistent queue.
 * Har lead ke liye ek job. Worker (services/queue/bulkWorker.js) inhe
 * ek-ek karke, controlled speed se uthata hai.
 * Server restart hone par bhi jobs DB mein safe rehte hain.
 */
const outboundJobSchema = new Schema(
  {
    batchId: { type: String, required: true, index: true },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    leadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", "cancelled", "paused"],
      default: "pending",
    },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },

    // Retry / backoff ke liye: job isse pehle nahi uthega
    nextRunAt: { type: Date, default: Date.now },

    // Worker ne job kab uthaya (stuck job pehchanne ke liye)
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },

    lastError: { type: String, default: null },
    lastErrorCode: { type: String, default: null },
  },
  { timestamps: true },
);

// Worker ka main query: status=pending + nextRunAt <= now
outboundJobSchema.index({ status: 1, nextRunAt: 1 });
// Batch progress ke liye
outboundJobSchema.index({ batchId: 1, status: 1 });

module.exports = mongoose.model("OutboundJob", outboundJobSchema);
