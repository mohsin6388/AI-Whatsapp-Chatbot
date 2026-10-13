# Bulk outreach (WhatsApp + Email, per-day schedule)

## Flow
1. Leads page -> **Import** -> CSV upload *ya* "Paste numbers" (name, phone, email kisi bhi order mein).
2. Sending plan: channels (WhatsApp / Email), leads per day, send time (IST), start date, email template.
3. `POST /api/campaigns/launch` leads save karta hai aur **saare jobs ek baar mein schedule** kar deta hai:
   lead #i -> din `floor(i / dailyLimit)`, us din ke `sendTime` par.
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
# Email (zaroori agar email channel use karna hai)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@domain.com
SMTP_PASS=app-password
SMTP_FROM="Deific Digital <you@domain.com>"

# Optional tuning
BULK_SEND_INTERVAL_MS=1000        # WhatsApp: do messages ke beech gap
BULK_EMAIL_INTERVAL_MS=2000       # Email: do emails ke beech gap
```

## Notes
- Worker server ke andar chalta hai. Server band/sleep (e.g. Render free tier) ho to us time ke jobs
  server wapas chalne par turant chal jate hain (schedule DB mein safe hai).
- WhatsApp rate-limit hone par sirf WhatsApp rukta hai, Email chalta rehta hai (aur ulta).
- Email quota/auth error par Email channel 1 ghante / 10 min ke liye rukta hai aur notification aata hai.
