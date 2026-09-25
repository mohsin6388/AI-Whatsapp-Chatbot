const { Parser: CsvParser } = require('json2csv');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const AuditLog = require('../models/AuditLog');
const { parseCsvBuffer, analyzeRows } = require('../services/csv/leadImporter');
const conversationEngine = require('../services/ai/conversationEngine');
const logger = require('../utils/logger');
const { toWhatsAppNumber } = require('../services/whatsapp/metaWhatsappClient');

/**
 * Scoping helper: brokers only ever see/act on their own leads.
 * Admins can pass ?ownerId= to view a specific broker's leads; builders
 * don't own leads at all (they view leads via property-match reporting,
 * not this resource) — enforced in the route via roleGuard.
 */
function scopeToOwner(req) {
  if (req.user.role === 'admin' && req.query.ownerId) {
    return { ownerId: req.query.ownerId };
  }
  return { ownerId: req.user.id };
}

/**
 * POST /api/leads/import/preview
 * Upload a CSV, get back every row annotated as valid/invalid/duplicate.
 * Nothing is written to the DB at this step.
 */
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('CSV file is required (field name: "file")');

  let rows;
  try {
    rows = parseCsvBuffer(req.file.buffer);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);

  return new ApiResponse(200, { rows: analyzed, summary }, 'CSV parsed').send(res);
});

/**
 * POST /api/leads/import/confirm
 * Client sends back the rows it wants imported (typically the "valid" subset
 * from the preview step, possibly after manual edits). Duplicate-safe via
 * insertMany({ ordered: false }) + the unique (ownerId, phone) index.
 */
const confirmImport = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  const ownerId = req.user.id;

  const docs = rows.map((r) => ({
    ownerId,
    name: r.name,
    phone: toWhatsAppNumber(r.phone),
    email: r.email || undefined,
    city: r.city || undefined,
    location: r.location || undefined,
    budgetMin: r.budgetMin ?? null,
    budgetMax: r.budgetMax ?? null,
    occupation: r.occupation || undefined,
    age: r.age ?? null,
    source: r.source || 'csv_import',
    notes: r.notes || undefined,
    requirements: r.requirements || undefined,
  }));

  let inserted = [];
  let skipped = 0;

  try {
    inserted = await Lead.insertMany(docs, { ordered: false });
  } catch (err) {
    // insertMany with ordered:false throws a BulkWriteError but still inserts
    // everything that didn't violate the unique index; err.insertedDocs holds those.
    if (err.writeErrors) {
      inserted = err.insertedDocs || [];
      skipped = err.writeErrors.length;
    } else {
      throw err;
    }
  }

  // Every newly-created lead gets its own empty Conversation shell so the
  // AI/WhatsApp phase can start writing into it immediately.
  let conversations = [];
  if (inserted.length) {
    try {
      conversations = await Conversation.insertMany(
        inserted.map((lead) => ({ leadId: lead._id, ownerId: lead.ownerId })),
        { ordered: false }
      );
    } catch (err) {
      // A conversation may already exist if this lead was re-imported — with
      // ordered:false, everything that DIDN'T conflict still got inserted;
      // capture those instead of silently discarding the whole batch.
      conversations = err.insertedDocs || [];
    }
  }

  await AuditLog.create({
    userId: req.user.id,
    action: 'lead.import',
    entityType: 'Lead',
    meta: { insertedCount: inserted.length, skipped },
    ip: req.ip,
  });

  // Auto-start every newly imported lead. The conversation engine sends the
  // approved Meta opening TEMPLATE (not free-text) and records the outbound
  // message only after Meta accepts it. We deliberately run this in the
  // background so a CSV import does not wait on Meta's network response.
  if (inserted.length) {
    const conversationByLead = new Map(
      conversations.map((c) => [c.leadId.toString(), c])
    );

    (async () => {
      for (const lead of inserted) {
        const conversation = conversationByLead.get(lead._id.toString());
        if (!conversation) continue;
        try {
          await conversationEngine.startConversation({ lead, conversation });
        } catch (err) {
          logger.error(`[leads] Auto-start failed for imported lead ${lead._id}`, {
            error: err.metaError || err.response?.data || err.message,
            code: err.code,
          });
        }
      }
    })().catch((err) => {
      logger.error('[leads] Imported-lead WhatsApp auto-start worker failed', { error: err.message });
    });
  }

  return new ApiResponse(
    201,
    { insertedCount: inserted.length, skipped, leadIds: inserted.map((l) => l._id), autoStartQueued: inserted.length },
    `Imported ${inserted.length} leads${skipped ? `, skipped ${skipped} duplicates` : ''}. WhatsApp opening messages queued automatically.`
  ).send(res);
});

/**
 * POST /api/leads/start-conversations
 * Body: { leadIds: [...] }
 * Kicks off the opening WhatsApp message for a batch of leads (typically
 * the leadIds just returned by /import/confirm, once the broker clicks
 * "Start") — or for any lead whose conversation hasn't been started yet.
 * Safe to call more than once: startConversation() no-ops for leads that
 * already have messages.
 */
const startConversations = asyncHandler(async (req, res) => {
  const { leadIds } = req.body;
  if (!Array.isArray(leadIds) || !leadIds.length) throw ApiError.badRequest('leadIds is required');

  const ownerId = req.user.id;
  const leads = await Lead.find({ _id: { $in: leadIds }, ownerId });
  const leadById = new Map(leads.map((l) => [l._id.toString(), l]));

  const conversations = await Conversation.find({ leadId: { $in: leads.map((l) => l._id) } });

  let started = 0;
  for (const conversation of conversations) {
    const lead = leadById.get(conversation.leadId.toString());
    if (!lead) continue;
    started += 1;
    conversationEngine.startConversation({ lead, conversation }).catch((err) =>
      logger.error(`[leads] Failed to start WhatsApp conversation for lead ${lead._id}`, { error: err.message })
    );
  }

  return new ApiResponse(200, { queued: started }, `Starting conversations for ${started} lead(s)`).send(res);
});

/**
 * POST /api/leads
 */

const createLead = asyncHandler(async (req, res) => {
  let phone;
  try {
    phone = toWhatsAppNumber(req.body.phone);
  } catch (err) {
    throw ApiError.badRequest(err.message || 'Valid phone number is required');
  }

  const existing = await Lead.findOne({ ownerId: req.user.id, phone });
  if (existing) throw ApiError.conflict('A lead with this phone number already exists');

  const lead = await Lead.create({
    ...req.body,
    phone,
    ownerId: req.user.id,
  });

  const conversation = await Conversation.create({ leadId: lead._id, ownerId: lead.ownerId });

  conversationEngine.startConversation({ lead, conversation }).catch((err) =>
    logger.error(`[leads] Failed to auto-start WhatsApp conversation for lead ${lead._id}`, { error: err.message })
  );

  return new ApiResponse(201, { lead }, 'Lead created').send(res);
});


/**
 * GET /api/leads
 */
const listLeads = asyncHandler(async (req, res) => {
  const { page, limit, search, status, city, tag, sortBy, sortOrder } = req.query;

  const filter = { ...scopeToOwner(req) };
  if (status) filter.status = status;
  if (city) filter.city = new RegExp(`^${city}$`, 'i');
  if (tag) filter.tags = tag;
  if (search) filter.$text = { $search: search };

  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [leads, total] = await Promise.all([
    Lead.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
  ]);

  // conversationStarted lets the frontend show a "Start" button for any lead
  // that's been imported/created but whose opening WhatsApp message hasn't
  // gone out yet (see POST /leads/start-conversations).
  const conversations = await Conversation.find(
    { leadId: { $in: leads.map((l) => l._id) } },
    'leadId lastMessageAt'
  ).lean();
  const lastMessageByLead = new Map(conversations.map((c) => [c.leadId.toString(), c.lastMessageAt]));
  const leadsWithStatus = leads.map((l) => ({
    ...l,
    conversationStarted: Boolean(lastMessageByLead.get(l._id.toString())),
  }));

  return new ApiResponse(200, {
    leads: leadsWithStatus,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/leads/:id
 */
const getLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound('Lead not found');
  return new ApiResponse(200, { lead }).send(res);
});

/**
 * PATCH /api/leads/:id
 */
const updateLead = asyncHandler(async (req, res) => {
  if (req.body.phone) {
    const dupe = await Lead.findOne({
      ownerId: req.user.id,
      phone: req.body.phone,
      _id: { $ne: req.params.id },
    });
    if (dupe) throw ApiError.conflict('Another lead already uses this phone number');
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, ...scopeToOwner(req) },
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!lead) throw ApiError.notFound('Lead not found');

  return new ApiResponse(200, { lead }, 'Lead updated').send(res);
});

/**
 * DELETE /api/leads/:id
 */
const deleteLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOneAndDelete({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound('Lead not found');

  await Conversation.deleteOne({ leadId: lead._id });

  return new ApiResponse(200, null, 'Lead deleted').send(res);
});

/**
 * POST /api/leads/bulk-delete
 */
const bulkDeleteLeads = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const filter = { _id: { $in: ids }, ...scopeToOwner(req) };

  const result = await Lead.deleteMany(filter);
  await Conversation.deleteMany({ leadId: { $in: ids } });

  return new ApiResponse(200, { deletedCount: result.deletedCount }, 'Leads deleted').send(res);
});

/**
 * POST /api/leads/:id/tags   body: { add?: string[], remove?: string[] }
 */
const updateTags = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound('Lead not found');

  const { add = [], remove = [] } = req.body;
  let tags = new Set(lead.tags);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  lead.tags = Array.from(tags);
  await lead.save();

  return new ApiResponse(200, { lead }, 'Tags updated').send(res);
});

/**
 * GET /api/leads/export
 * Exports the current filtered view as a downloadable CSV (same filters as listLeads).
 */
const exportLeads = asyncHandler(async (req, res) => {
  const { search, status, city, tag } = req.query;
  const filter = { ...scopeToOwner(req) };
  if (status) filter.status = status;
  if (city) filter.city = new RegExp(`^${city}$`, 'i');
  if (tag) filter.tags = tag;
  if (search) filter.$text = { $search: search };

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  const fields = [
    'name', 'phone', 'email', 'city', 'location', 'budgetMin', 'budgetMax',
    'occupation', 'age', 'source', 'status', 'leadScore', 'tags', 'notes',
    'requirements', 'createdAt',
  ];
  const parser = new CsvParser({ fields });
  const csv = parser.parse(leads.map((l) => ({ ...l, tags: (l.tags || []).join('|') })));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${Date.now()}.csv"`);
  return res.send(csv);
});

module.exports = {
  previewImport,
  confirmImport,
  startConversations,
  createLead,
  listLeads,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
};
