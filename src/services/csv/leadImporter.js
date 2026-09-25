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

/** Basic per-row validation (independent of DB state). */
function validateRow(row) {
  const errors = [];
  if (!row.name) errors.push('Name is required');
  if (!row.phone || row.phone.length < 7) errors.push('Valid phone number is required');
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

module.exports = { parseCsvBuffer, validateRow, analyzeRows };
