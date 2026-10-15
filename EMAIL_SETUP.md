# Resend bulk email + inbound reply tracking

This project now uses Resend's HTTPS API for bulk email and password reset email. Gmail SMTP is not used. Email and WhatsApp sending remain separate campaign channels, while the CRM stores all contact rows in the same Leads collection.

## Required backend environment

```dotenv
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
RESEND_FROM="Property Team <campaigns@mail.yourcompany.com>"
EMAIL_REPLY_TO=info@yourcompany.com
```

- Verify the sender domain in Resend. Add the exact SPF/DKIM records Resend gives you to your DNS provider. Do not create a second SPF record; merge SPF includes into the existing record if a record already exists.
- Keep Globehost's normal mailbox/MX records unchanged for your ordinary company inbox.
- The `RESEND_API_KEY` must be a backend-only secret. Never put it in a `VITE_` frontend variable or commit it to source control.
- Configure DMARC for your domain after SPF/DKIM are validated. Start with a policy appropriate for the domain's existing mail streams before moving to enforcement.

## In-dashboard replies are a separate receiving setup

Sending email and receiving email are separate capabilities. The `Email Replies` page can show a reply only after an incoming message reaches the backend. To correlate a reply with the exact campaign lead, this implementation adds a unique Reply-To address such as `reply+<tracking-token>@replies.yourcompany.com` to each outgoing tracked email.

Configure these backend values:

```dotenv
EMAIL_INBOUND_DOMAIN=replies.yourcompany.com
RESEND_WEBHOOK_SECRET=whsec_...
```

Then:

1. In Resend, enable/set up inbound email receiving for `replies.yourcompany.com` (or a Resend-provided inbound address supported by your account) and add only the receiving-domain DNS records Resend shows. Use a dedicated subdomain to avoid overriding Globehost's main-domain MX records.
2. Create a Resend webhook pointing to `https://YOUR_API_HOST/api/webhooks/resend`.
3. Subscribe it to `email.received` and the outbound delivery events you want recorded (`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.opened`, `email.clicked`).
4. Copy the webhook signing secret (`whsec_...`) into `RESEND_WEBHOOK_SECRET`, redeploy, then send a test campaign email and reply to it from another mailbox.
5. Verify the `Email Replies` view changes to Replied and displays the incoming message. Test webhook delivery/signature verification from the Resend dashboard before going live.

**Plan/cost note:** Resend's free sending tier advertises 3,000 emails/month and a 100-email daily limit. Inbound receiving appears separately in Resend's product/pricing controls, so check that receiving is enabled for your account/plan before promising zero-cost reply capture. Each incoming reply is also an email event/received message. If inbound receiving is not available on your Resend plan, keep `EMAIL_REPLY_TO` pointed at the Globehost mailbox and arrange an IMAP/mailbox sync integration, or enable a receiving plan; outbound send tracking will still work, but replies won't appear in this page until inbound sync is configured.

## Application behavior

- `EmailMessage` stores every campaign send and its reply thread.
- `GET /api/email/status` returns a secret-safe configuration status for Settings.
- `GET /api/email/replies` returns the spreadsheet-like email tracker, including no-reply rows.
- `GET /api/email/replies/:id` returns the conversation.
- `POST /api/email/replies/:id/reply` sends a reply from the dashboard via Resend.
- `POST /api/webhooks/resend` verifies Resend/Svix signatures with a 5-minute replay window. Do not disable signature verification in production.
- Only email messages sent after this version creates tracking records appear in the tracker. Previously sent Gmail emails are not automatically imported/backfilled.

## Production preflight

- Set `NODE_ENV=production`, unique JWT secrets, a strong encryption key, `CLIENT_URL`, `APP_BASE_URL`, and database credentials.
- Restrict CORS to the real frontend domain; set secure cookies for the deployment topology.
- Set an email daily limit compatible with your actual Resend plan. Do not use an unrestricted “send all now” bulk campaign when on a 100/day tier.
- Configure provider webhooks and test delivered, bounce, failed, and inbound reply cases.
- Add a clear consent/source trail and unsubscribe suppression process for marketing campaigns. Do not send unsolicited bulk email.
- Back up MongoDB before the lead-index migration described below.

## Existing MongoDB index migration for email-only leads

Older installs may still have a unique `ownerId_1_phone_1` index. That index can reject multiple email-only leads because they have a missing/null phone. Back up the database, deploy this code, and run once:

```bash
npm run migrate:lead-contact-indexes
```

The script removes the old unfiltered owner+phone unique index, normalizes blank/missing phone fields to `null`, and creates `owner_phone_unique_nonempty` (unique only for string phone values). It does not delete leads. Verify the new index in MongoDB before opening email-only imports to clients.

## CSV contact format

Accepted headers include `Name`, `Phone` / `WhatsApp` / `Mobile`, and `Email`. Name is optional; each row needs a valid phone or email. Rows may be phone-only, email-only, or both. The CRM keeps the contact row, but the sender queues a WhatsApp job only for a row with a phone and an email job only for a row with an email.
