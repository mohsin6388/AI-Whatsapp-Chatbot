const { z } = require("zod");
const { importRowSchema } = require("./leadValidators");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const launchCampaignSchema = z.object({
  body: z
    .object({
      rows: z
        .array(importRowSchema)
        .min(1, "No rows to import")
        .max(5000, "Ek campaign mein max 5000 leads"),
      name: z.string().trim().min(1, "Campaign name required").max(120),
      channels: z
        .object({ whatsapp: z.boolean(), email: z.boolean() })
        .refine((c) => c.whatsapp || c.email, "Kam se kam ek channel chuno"),
      // 0 = koi limit nahi, sab abhi bhejo
      dailyLimit: z.number().int().min(0).max(5000).default(0),
      sendTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "sendTime must be HH:mm")
        .default("10:00"),
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
        .optional(),
      emailSubject: z.string().trim().max(200).optional().default(""),
      emailBody: z.string().trim().max(5000).optional().default(""),
    })
    .superRefine((b, ctx) => {
      if (b.channels.email) {
        if (!b.emailSubject)
          ctx.addIssue({
            code: "custom",
            path: ["emailSubject"],
            message: "Email subject required",
          });
        if (!b.emailBody)
          ctx.addIssue({
            code: "custom",
            path: ["emailBody"],
            message: "Email body required",
          });
      }
    }),
});

const campaignIdSchema = z.object({
  params: z.object({ id: objectId }),
});

const retrySchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({ channel: z.enum(["whatsapp", "email"]).optional() })
    .optional()
    .default({}),
});

const listJobsQuerySchema = z.object({
  query: z.object({
    channel: z.enum(["whatsapp", "email"]).optional(),
    campaignId: objectId.optional(),
    status: z
      .enum([
        "pending",
        "scheduled",
        "processing",
        "sent",
        "failed",
        "paused",
        "cancelled",
      ])
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

const campaignLeadsQuerySchema = z.object({
  query: z.object({
    campaignId: objectId,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }),
});

module.exports = {
  campaignLeadsQuerySchema,
  launchCampaignSchema,
  campaignIdSchema,
  retrySchema,
  listJobsQuerySchema,
};
