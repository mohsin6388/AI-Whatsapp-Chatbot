const express = require("express");
const router = express.Router();
const resendWebhook = require("../controllers/resendWebhookController");

// Public endpoint authenticated with Resend's Svix signature; must remain
// unauthenticated because Resend cannot present a PropAI user JWT.
router.post("/resend", resendWebhook.handler);
module.exports = router;
