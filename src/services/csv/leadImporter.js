const Papa = require('papaparse');
const Lead = require('../../models/Lead');

// Maps flexible/real-world CSV header spellings to our schema fields.
// Matching is case-insensitive and ignores spaces/underscores.
const HEADER_ALIASES = {
  name: ['name', 'fullname', 'customername', 'leadname'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact', 'whatsapp'],
  email: ['email', 'emailaddress'],
  city: ['city'],
  location: ['location', 'area', 'locality'],
  budget: ['budget'], // may be a single "budget" column like "50L-70L" or "5000000"
  budgetMin: ['budgetmin', 'minbudget', 'minimumbudget'],
  budgetMax: ['budgetmax', 'maxbudget', 'maximumbudget'],
  occupation: ['occupation', 'profession'],
  age: ['age'],
  source: ['leadsource', 'source'],
  notes: ['notes', 'remark', 'remarks', 'comment', 'comments'],
  requirements: ['requirements', 'requirement'],
};

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[\s_\-]/g, '');
}

function buildHeaderMap(rawHeaders) {
  const map = {}; // rawHeader -> canonicalField
  const normalizedHeaders = rawHeaders.map((h) => ({ raw: h, norm: normalizeKey(h) }));

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const match = normalizedHeaders.find((h) => aliases.includes(h.norm));
    if (match) map[match.raw] = field;
  }
  return map;
}

/** Parses a raw budget string like "50L", "50 Lakh", "5000000", "1.2 Cr" into a number (INR). */
function parseBudgetToken(token) {
  if (token === undefined || token === null || token === '') return null;
  const str = String(token).trim().toLowerCase();
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(num)) return null;

  if (str.includes('cr')) return Math.round(num * 10000000);
  if (str.includes('l')) return Math.round(num * 100000);
  return Math.round(num);
}

function parseBudgetRange(budgetStr) {
  if (!budgetStr) return { budgetMin: null, budgetMax: null };
  const parts = String(budgetStr).split(/-|to/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    return { budgetMin: parseBudgetToken(parts[0]), budgetMax: parseBudgetToken(parts[1]) };
  }
  const single = parseBudgetToken(parts[0]);
  return { budgetMin: single, budgetMax: single };
}

/**
 * Parses a raw CSV buffer into normalized row objects (not yet validated/persisted).
 */
function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf-8');
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (result.errors?.length) {
    const firstError = result.errors[0];
    throw new Error(`CSV parse error at row ${firstError.row + 1}: ${firstError.message}`);
  }

  const rawHeaders = result.meta.fields || [];
  const headerMap = buildHeaderMap(rawHeaders);

  if (!Object.values(headerMap).includes('name') || !Object.values(headerMap).includes('phone')) {
    throw new Error('CSV must include at least "Name" and "Phone" columns');
  }

  const rows = result.data.map((rawRow, idx) => {
    const normalized = { _rowNumber: idx + 2 }; // +2 accounts for header row + 1-index
    for (const [rawHeader, field] of Object.entries(headerMap)) {
      normalized[field] = (rawRow[rawHeader] ?? '').toString().trim();
    }

    const { budgetMin, budgetMax } = normalized.budgetMin || normalized.budgetMax
      ? { budgetMin: parseBudgetToken(normalized.budgetMin), budgetMax: parseBudgetToken(normalized.budgetMax) }
      : parseBudgetRange(normalized.budget);

    return {
      rowNumber: normalized._rowNumber,
      name: normalized.name || '',
      phone: (normalized.phone || '').replace(/[^\d+]/g, ''),
      email: normalized.email || '',
      city: normalized.city || '',
      location: normalized.location || '',
      budgetMin,
      budgetMax,
      occupation: normalized.occupation || '',
      age: normalized.age ? parseInt(normalized.age, 10) : null,
      source: normalized.source || 'csv_import',
      notes: normalized.notes || '',
      requirements: normalized.requirements || '',
    };
  });

  return rows;
}

const EMAIL_RE = /[^\s@,;|<>()]+@[^\s@,;|<>()]+\.[^\s@,;|<>()]+/;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;
const MAX_TEXT_ROWS = 5000;

/**
 * "Paste karke bulk add" ke liye smart parser. Har line mein name, phone aur
 * (optional) email kisi bhi order / separator (comma, tab, pipe, space) mein
 * ho sakta hai:
 *
 *   Rahul Sharma, 9876543210, rahul@gmail.com
 *   9876543210 | priya@x.com | Priya Singh
 *   Amit Verma 9812345678
 *
 * Email regex se, phone digits-pattern se nikalte hain; jo bacha wahi naam.
 * Output parseCsvBuffer jaisa hi shape deta hai, taaki analyzeRows() reuse ho.
 */
function parseLeadText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];

  lines.forEach((rawLine, idx) => {
    let line = rawLine.trim();
    if (!line) return;
    if (rows.length >= MAX_TEXT_ROWS) return;

    // Header line ("Name, Phone, Email") skip
    if (/name/i.test(line) && /(phone|mobile|number)/i.test(line) && !/\d{6,}/.test(line)) return;

    // Serial number prefix "1." / "2)" hatao
    line = line.replace(/^\d{1,4}[.)]\s+/, '');

    let email = '';
    const emailMatch = line.match(EMAIL_RE);
    if (emailMatch) {
      email = emailMatch[0].toLowerCase();
      line = line.replace(emailMatch[0], ' ');
    }

    let phone = '';
    const phoneMatch = line.match(PHONE_RE);
    if (phoneMatch) {
      phone = phoneMatch[0].replace(/[^\d+]/g, '');
      line = line.replace(phoneMatch[0], ' ');
    }

    const name = line
      .replace(/[,;|\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    rows.push({
      rowNumber: idx + 1, // line number
      name,
      phone,
      email,
      city: '',
      location: '',
      budgetMin: null,
      budgetMax: null,
      occupation: '',
      age: null,
      source: 'bulk_paste',
      notes: '',
      requirements: '',
    });
  });

  return rows;
}

/** Basic per-row validation (independent of DB state). */
function validateRow(row) {
  const errors = [];
  if (!row.name) errors.push('Name is required');
  const phoneDigits = (row.phone || '').replace(/\D/g, '');
  if (!row.phone || phoneDigits.length < 7) errors.push('Valid phone number is required');
  else if (phoneDigits.length > 15) errors.push('Phone number is too long');
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push('Invalid email format');
  if (row.age !== null && (Number.isNaN(row.age) || row.age < 0 || row.age > 120)) {
    errors.push('Invalid age');
  }
  return errors;
}

/**
 * Given normalized rows, flags: validation errors, duplicates against existing
 * DB leads for this owner, AND duplicates within the file itself.
 */
async function analyzeRows(ownerId, rows) {
  const phones = rows.map((r) => r.phone).filter(Boolean);
  const existingLeads = await Lead.find(
    { ownerId, phone: { $in: phones } },
    { phone: 1 }
  ).lean();
  const existingPhoneSet = new Set(existingLeads.map((l) => l.phone));

  const seenInFile = new Set();
  const analyzed = rows.map((row) => {
    const errors = validateRow(row);
    let isDuplicate = false;
    let duplicateReason = null;

    if (row.phone) {
      if (existingPhoneSet.has(row.phone)) {
        isDuplicate = true;
        duplicateReason = 'Already exists in your leads';
      } else if (seenInFile.has(row.phone)) {
        isDuplicate = true;
        duplicateReason = 'Duplicate phone number within this file';
      }
      seenInFile.add(row.phone);
    }

    let status = 'valid';
    if (errors.length) status = 'invalid';
    else if (isDuplicate) status = 'duplicate';

    return { ...row, errors, isDuplicate, duplicateReason, status };
  });

  const summary = {
    total: analyzed.length,
    valid: analyzed.filter((r) => r.status === 'valid').length,
    invalid: analyzed.filter((r) => r.status === 'invalid').length,
    duplicate: analyzed.filter((r) => r.status === 'duplicate').length,
  };

  return { rows: analyzed, summary };
}

module.exports = { parseCsvBuffer, parseLeadText, validateRow, analyzeRows };
