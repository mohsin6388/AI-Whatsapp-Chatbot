# Bulk outreach (WhatsApp + Email, per-day schedule)

## Flow
1. Leads page -> **Import** -> CSV upload *ya* "Paste numbers" (name, phone, email kisi bhi order mein).
2. Sending plan: channels (WhatsApp / Email), leads per day, send time (IST), start date, email template.
3. `POST /api/campaigns/launch` leads save karta hai aur **saare jobs ek baar mein schedule** kar deta hai:
   eligible lead #i (selected channel ka contact available) -> din `floor(i / dailyLimit)`, us din ke `sendTime` par.
4. `bulkWorker` ek time par ek message bhejta hai. Same din mein pehle WhatsApp, phir Email.
5. Sidebar -> **WhatsApp Leads / Email Leads** par live progress (Socket.IO).

## API
| Method | Path | Kaam |
|---|---|---|
| POST | `/api/leads/import/parse-text` | Pasted text -> preview rows |
| POST | `/api/campaigns/launch` | Leads import + campaign + schedule |
| GET  | `/api/campaigns` | Campaigns + channel-wise progress |
| POST | `/api/campaigns/:id/(pause\|resume\|cancel\|retry-failed)` | Controls |
| GET  | `/api/outreach/summary` | Sidebar badges (sent/total per channel) |
| GET  | `/api/outreach/jobs?channel=&campaignId=&status=&page=` | Lead-wise status list |

## Socket events (server -> client)
- `outreach:job` `{ jobId, channel, status, name, phone, email, ... }` — har lead ka processing -> sent/failed
- `outreach:progress` `{ campaignId, stats: { whatsapp, email } }`
- `outreach:campaign` `{ campaignId, status }`

## .env
```
# Email sending (Resend HTTP API — Gmail/SMTP replaced)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
RESEND_FROM="Campaigns <campaigns@mail.yourcompany.com>"
EMAIL_REPLY_TO=info@yourcompany.com

# Optional inbound reply tracking. Configure receiving domain + MX + webhook in Resend.
EMAIL_INBOUND_DOMAIN=replies.yourcompany.com
RESEND_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxx

# Optional frontend base URL (frontend build-time variable)
VITE_API_BASE_URL=https://your-api.example.com/api/
```

## Notes
- Worker server ke andar chalta hai. Server band/sleep (e.g. Render free tier) ho to us time ke jobs
  server wapas chalne par turant chal jate hain (schedule DB mein safe hai).
- WhatsApp rate-limit hone par sirf WhatsApp rukta hai, Email chalta rehta hai (aur ulta).
- Resend quota/auth error par Email channel pause/retry policy apply hoti hai aur notification aata hai.
- `EmailMessage` records track each outbound campaign email; `Email Replies` page shows sent status, replies, bounce/failure and lets brokers respond.
- Customer replies require a configured inbound receiving domain and the signed `email.received` webhook. Check `EMAIL_SETUP.md` for DNS and webhook steps.
- CSV upload accepts Phone/WhatsApp OR Email; Name is optional and is generated from the contact when missing. Channel jobs are only queued when that lead has the selected channel's contact.
