const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const FollowUp = require('../models/FollowUp');

function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/** GET /api/followups — pending follow-ups queue, oldest-due first. */
const listFollowUps = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { status, page, limit } = req.query;

  const filter = { ownerId };
  filter.status = status || 'pending';

  const [followUps, total] = await Promise.all([
    FollowUp.find(filter)
      .populate('leadId', 'name phone city leadScore status')
      .sort({ nextFollowUpDate: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    FollowUp.countDocuments(filter),
  ]);

  return new ApiResponse(200, {
    followUps,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/** PATCH /api/followups/:id — mark done/skipped, or manually adjust date/message. */
const updateFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const followUp = await FollowUp.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  return new ApiResponse(200, { followUp }, 'Follow-up updated').send(res);
});

/** DELETE /api/followups/:id — permanently removes a follow-up from the queue. */
const deleteFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const followUp = await FollowUp.findOneAndDelete({ _id: req.params.id, ownerId });
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  return new ApiResponse(200, null, 'Follow-up deleted').send(res);
});

module.exports = { listFollowUps, updateFollowUp, deleteFollowUp };
