const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const { toWhatsAppNumber } = require("../whatsapp/metaWhatsappClient");

/**
 * Validated rows ko DB mein Lead + Conversation ke roop mein insert karta hai.
 * CSV import (confirmImport) aur Campaign launch dono yahi use karte hain.
 *
 * Duplicate-safe: insertMany({ ordered: false }) + unique (ownerId, phone) index.
 * `inserted` upload ke order mein aata hai (campaign ka per-day order isi se banta hai).
 */
async function importLeadRows(ownerId, rows) {
  const docs = [];
  let invalid = 0;

  for (const r of rows) {
    let phone;
    try {
      phone = toWhatsAppNumber(r.phone);
    } catch (err) {
      invalid += 1; // ek kharab number poore import ko 500 na kare
      continue;
    }
    docs.push({
      ownerId,
      name: r.name,
      phone,
      email: r.email || undefined,
      city: r.city || undefined,
      location: r.location || undefined,
      budgetMin: r.budgetMin ?? null,
      budgetMax: r.budgetMax ?? null,
      occupation: r.occupation || undefined,
      age: r.age ?? null,
      source: r.source || "csv_import",
      notes: r.notes || undefined,
      requirements: r.requirements || undefined,
    });
  }

  let inserted = [];
  let skipped = 0;

  try {
    inserted = await Lead.insertMany(docs, { ordered: false });
  } catch (err) {
    // ordered:false -> jo unique index violate nahi karte woh phir bhi insert
    // ho jate hain; err.insertedDocs mein wahi hote hain.
    if (err.writeErrors) {
      inserted = err.insertedDocs || [];
      skipped = err.writeErrors.length;
    } else {
      throw err;
    }
  }

  // Har nayi lead ka apna khaali Conversation shell
  if (inserted.length) {
    try {
      await Conversation.insertMany(
        inserted.map((lead) => ({ leadId: lead._id, ownerId: lead.ownerId })),
        { ordered: false },
      );
    } catch (err) {
      // Pehle se exist karta ho to baaki sab phir bhi insert ho chuke hote hain.
      if (!err.writeErrors) throw err;
    }
  }

  return { inserted, skipped, invalid };
}

module.exports = { importLeadRows };
