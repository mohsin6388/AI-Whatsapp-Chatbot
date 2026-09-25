const { z } = require('zod');
const Lead = require('../models/Lead');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const createLeadSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(150),
    phone: z.string().min(7, 'Valid phone number is required').max(20),
    email: z.string().email().optional().or(z.literal('')),
    city: z.string().max(100).optional(),
    location: z.string().max(150).optional(),
    budgetMin: z.number().nonnegative().nullable().optional(),
    budgetMax: z.number().nonnegative().nullable().optional(),
    occupation: z.string().max(100).optional(),
    age: z.number().int().min(0).max(120).nullable().optional(),
    source: z.string().max(50).optional(),
    notes: z.string().max(2000).optional(),
    requirements: z.string().max(2000).optional(),
    tags: z.array(z.string().max(40)).optional(),
    status: z.enum(Lead.STATUSES).optional(),
  }),
});

const updateLeadSchema = z.object({
  params: z.object({ id: objectId }),
  body: createLeadSchema.shape.body.partial(),
});

const listLeadsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    status: z.enum(Lead.STATUSES).optional(),
    city: z.string().optional(),
    tag: z.string().optional(),
    sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'leadScore']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

const bulkDeleteSchema = z.object({
  body: z.object({
    ids: z.array(objectId).min(1, 'At least one id is required'),
  }),
});

const tagsUpdateSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    add: z.array(z.string().max(40)).optional(),
    remove: z.array(z.string().max(40)).optional(),
  }),
});

// Rows coming back from the client after they reviewed the /import/preview response.
const importConfirmSchema = z.object({
  body: z.object({
    rows: z
      .array(
        z.object({
          name: z.string().min(1),
          phone: z.string().min(7),
          email: z.string().optional().default(''),
          city: z.string().optional().default(''),
          location: z.string().optional().default(''),
          budgetMin: z.number().nullable().optional(),
          budgetMax: z.number().nullable().optional(),
          occupation: z.string().optional().default(''),
          age: z.number().nullable().optional(),
          source: z.string().optional().default('csv_import'),
          notes: z.string().optional().default(''),
          requirements: z.string().optional().default(''),
        })
      )
      .min(1, 'No rows to import'),
  }),
});

const startConversationsSchema = z.object({
  body: z.object({
    leadIds: z.array(objectId).min(1, 'At least one leadId is required'),
  }),
});

module.exports = {
  createLeadSchema,
  updateLeadSchema,
  listLeadsQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  tagsUpdateSchema,
  importConfirmSchema,
  startConversationsSchema,
};
