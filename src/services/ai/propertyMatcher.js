const Property = require('../../models/Property');

/**
 * Finds and ranks properties matching a buyer's known requirements.
 * Single-tenant app: searches the whole (one) active inventory — no org
 * scoping needed.
 *
 * Scoring is intentionally simple and explainable (not another AI call) —
 * budget overlap and location/city/bhk matches are exact, cheap, and easy
 * to reason about; Gemini then explains the *why* in natural language.
 */
async function matchProperties({ city, location, budgetMin, budgetMax, bhk, amenities = [] }, limit = 5) {
  const filter = { isActive: true };

  // Soft city match instead of an exact "^City$" match: buyers/leads type
  // things like "noida", "Noida ", "Greater Noida" etc., and an exact match
  // was silently wiping out every candidate the moment casing/whitespace/
  // a locality suffix didn't line up perfectly.
  if (city) filter.city = new RegExp(escapeRegex(city.trim()), 'i');

  let candidates = await Property.find(filter).limit(200).lean();

  // If a (possibly slightly-off) city still returns nothing, don't leave the
  // AI with an empty database — fall back to the full active inventory so
  // it can still have a real, honest conversation instead of wrongly
  // claiming "we have nothing available".
  if (!candidates.length) {
    candidates = await Property.find({ isActive: true }).limit(200).lean();
  }
  if (!candidates.length) return [];

  const scored = candidates.map((p) => ({ property: p, score: scoreMatch(p, { location, budgetMin, budgetMax, bhk, amenities }) }));

  scored.sort((a, b) => b.score - a.score);

  // Prefer genuine matches (score > 0), but if literally nothing scored above
  // zero (e.g. buyer's budget is outside every listing), still surface the
  // closest options rather than telling the buyer we have nothing at all —
  // the AI is instructed to be upfront that these are the closest fit.
  const positive = scored.filter((s) => s.score > 0);
  const pool = positive.length ? positive : scored;

  return pool.slice(0, limit).map((s) => s.property);
}

function scoreMatch(property, { location, budgetMin, budgetMax, bhk, amenities }) {
  let score = 1; // base score — already scoped to this city bucket

  if (budgetMin != null || budgetMax != null) {
    const buyerMin = budgetMin ?? 0;
    const buyerMax = budgetMax ?? Number.MAX_SAFE_INTEGER;
    const propMin = property.budgetMin ?? 0;
    const propMax = property.budgetMax ?? Number.MAX_SAFE_INTEGER;
    const overlaps = propMin <= buyerMax && propMax >= buyerMin;

    if (overlaps) {
      score += 3;
    } else {
      // Near-budget properties are still worth showing (e.g. buyer said 50L,
      // property starts at 55L) — penalize instead of hard-excluding so the
      // AI has something honest to offer rather than nothing.
      const gap = propMin > buyerMax ? propMin - buyerMax : buyerMin - propMax;
      const referencePoint = buyerMax || buyerMin || propMax || 1;
      const gapRatio = gap / referencePoint;
      if (gapRatio <= 0.2) {
        score += 1; // within ~20% of budget — close enough to mention
      } else {
        score -= 2; // clearly out of range — rank last, but don't erase
      }
    }
  }

  if (bhk && property.bhk && String(property.bhk).includes(String(bhk).replace(/\D/g, ''))) {
    score += 2;
  }

  if (location && property.location && property.location.toLowerCase().includes(location.toLowerCase())) {
    score += 2;
  }

  if (amenities?.length && property.amenities?.length) {
    const propAmenitiesLower = property.amenities.map((a) => a.toLowerCase());
    const matched = amenities.filter((a) => propAmenitiesLower.includes(a.toLowerCase()));
    score += matched.length;
  }

  return score;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { matchProperties };
