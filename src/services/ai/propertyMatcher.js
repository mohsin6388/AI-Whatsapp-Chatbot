const Property = require("../../models/Property");

/**
 * Finds and ranks properties matching the buyer's current question
 * and known requirements.
 *
 * Important:
 * - Current customer message has priority over old requirements.
 * - Project names are detected directly from the property inventory.
 * - "other city" questions ignore the previous city filter.
 * - "other property/project" questions exclude the project already mentioned.
 * - Specific project questions prioritize that exact project.
 * - Broad city/project questions return representative properties from
 *   different projects instead of repeatedly returning units from one project.
 */
async function matchProperties(
  {
    query = "",
    city,
    location,
    projectName,
    budgetMin,
    budgetMax,
    bhk,
    propertyType,
    amenities = [],
  },
  limit = 5,
) {
  const activeFilter = { isActive: true };

  // ---------------------------------------------------------
  // 1. Load active inventory first.
  // ---------------------------------------------------------
  let allProperties = await Property.find(activeFilter).limit(500).lean();

  if (!allProperties.length) return [];

  const normalizedQuery = normalize(query);

  // ---------------------------------------------------------
  // 2. Detect whether customer is asking for another city.
  //
  // Example:
  // "koi aur city me hai?"
  // "kisi aur city me property hai?"
  // "aur kisi shehar me?"
  //
  // In this case, DO NOT use the old Noida city filter.
  // ---------------------------------------------------------
  const askingOtherCity = isOtherCityQuestion(normalizedQuery);

  // ---------------------------------------------------------
  // 3. Detect whether customer is asking for other properties.
  //
  // Example:
  // "The Sunflower ke alawa koi aur property hai?"
  // ---------------------------------------------------------
  const askingOtherProperty = isOtherPropertyQuestion(normalizedQuery);

  // ---------------------------------------------------------
  // 4. Find exact/known project mentioned in current message.
  //
  // We search project names from DB instead of asking Gemini
  // to invent/extract the project name first.
  // ---------------------------------------------------------
  const detectedProject = findProjectMentioned(allProperties, normalizedQuery);

  // Explicit projectName from conversation memory has lower priority
  // than a project clearly mentioned in the CURRENT message.
  const activeProjectName = detectedProject?.projectName || projectName || null;

  // ---------------------------------------------------------
  // 5. Detect a city mentioned in the CURRENT message.
  //
  // Example:
  // Previous city = Noida
  // Customer = "Kanpur me kya hai?"
  //
  // Current city becomes Kanpur.
  // ---------------------------------------------------------
  const detectedCity = findCityMentioned(allProperties, normalizedQuery);

  let effectiveCity = city;

  if (detectedCity) {
    effectiveCity = detectedCity;
  }

  // "koi aur city" means search the whole inventory.
  if (askingOtherCity) {
    effectiveCity = null;
  }

  // ---------------------------------------------------------
  // 6. Decide if this is a broad inventory question.
  // ---------------------------------------------------------
  const askingCityProjects = isCityProjectListQuestion(normalizedQuery);

  const askingAllProjects = isAllProjectListQuestion(normalizedQuery);

  // ---------------------------------------------------------
  // 7. Build initial candidate pool.
  // ---------------------------------------------------------
  let candidates = allProperties;

  // Specific project mentioned:
  // search the whole inventory because the customer may ask
  // "Ivory" even when old conversation city was Noida.
  if (activeProjectName) {
    candidates = candidates.filter((property) =>
      sameProject(property.projectName, activeProjectName),
    );
  } else if (effectiveCity) {
    candidates = candidates.filter((property) =>
      sameCity(property.city, effectiveCity),
    );
  }

  // ---------------------------------------------------------
  // 8. "Other property" question.
  //
  // Example:
  // "The Sunflower ke alawa koi aur property hai?"
  //
  // If The Sunflower is detected, remove it from the results.
  // ---------------------------------------------------------
  if (askingOtherProperty && detectedProject?.projectName) {
    candidates = allProperties.filter((property) => {
      if (effectiveCity && !sameCity(property.city, effectiveCity)) {
        return false;
      }

      return !sameProject(property.projectName, detectedProject.projectName);
    });
  }

  // ---------------------------------------------------------
  // 9. If customer asks for another city and no explicit city
  // was mentioned, search entire inventory.
  // ---------------------------------------------------------
  if (askingOtherCity && !detectedCity) {
    candidates = allProperties;
  }

  // ---------------------------------------------------------
  // 10. Safety fallback.
  //
  // Never tell AI "no properties" merely because the old city
  // filter was too restrictive.
  // ---------------------------------------------------------
  if (!candidates.length) {
    candidates = allProperties;
  }

  // ---------------------------------------------------------
  // 11. Broad city/project listing.
  //
  // Example:
  // "Noida me kaun kaun se projects hain?"
  //
  // We want different projects, not 5 units of the same project.
  // ---------------------------------------------------------
  if (askingCityProjects || askingAllProjects) {
    return getUniqueProjects(candidates, limit);
  }

  // ---------------------------------------------------------
  // 12. Specific project question.
  //
  // Example:
  // "Ivory ka price kya hai?"
  // "Ivory ke paas metro hai?"
  //
  // Return all units of that project so Gemini has complete data.
  // ---------------------------------------------------------
  if (activeProjectName) {
    return candidates.slice(0, 20);
  }

  // ---------------------------------------------------------
  // 13. Normal requirement-based matching.
  // ---------------------------------------------------------
  const scored = candidates.map((property) => ({
    property,
    score: scoreMatch(property, {
      query: normalizedQuery,
      location,
      budgetMin,
      budgetMax,
      bhk,
      propertyType,
      amenities,
    }),
  }));

  scored.sort((a, b) => b.score - a.score);

  const positive = scored.filter((item) => item.score > 0);

  const pool = positive.length ? positive : scored;

  return pool.slice(0, limit).map((item) => item.property);
}

/**
 * Scores a property against known buyer requirements.
 */
function scoreMatch(
  property,
  { query, location, budgetMin, budgetMax, bhk, propertyType, amenities },
) {
  let score = 1;

  // ---------------------------------------------------------
  // Project name mentioned in current question
  // ---------------------------------------------------------
  if (
    query &&
    property.projectName &&
    containsText(query, property.projectName)
  ) {
    score += 10;
  }

  // ---------------------------------------------------------
  // Property type
  // ---------------------------------------------------------
  if (
    propertyType &&
    property.propertyType &&
    normalize(property.propertyType).includes(normalize(propertyType))
  ) {
    score += 3;
  }

  // ---------------------------------------------------------
  // Budget
  // ---------------------------------------------------------
  if (budgetMin != null || budgetMax != null) {
    const buyerMin = budgetMin ?? 0;
    const buyerMax = budgetMax ?? Number.MAX_SAFE_INTEGER;

    const propMin = property.budgetMin ?? 0;
    const propMax = property.budgetMax ?? Number.MAX_SAFE_INTEGER;

    const overlaps = propMin <= buyerMax && propMax >= buyerMin;

    if (overlaps) {
      score += 3;
    } else {
      const gap = propMin > buyerMax ? propMin - buyerMax : buyerMin - propMax;

      const referencePoint = buyerMax || buyerMin || propMax || 1;

      const gapRatio = gap / referencePoint;

      if (gapRatio <= 0.2) {
        score += 1;
      } else {
        score -= 2;
      }
    }
  }

  // ---------------------------------------------------------
  // BHK
  // ---------------------------------------------------------
  if (
    bhk &&
    property.bhk &&
    String(property.bhk)
      .toLowerCase()
      .includes(String(bhk).replace(/\D/g, "").toLowerCase())
  ) {
    score += 2;
  }

  // ---------------------------------------------------------
  // Location
  // ---------------------------------------------------------
  if (
    location &&
    property.location &&
    normalize(property.location).includes(normalize(location))
  ) {
    score += 2;
  }

  // ---------------------------------------------------------
  // Amenities
  // ---------------------------------------------------------
  if (
    Array.isArray(amenities) &&
    amenities.length &&
    Array.isArray(property.amenities)
  ) {
    const propertyAmenities = property.amenities.map((amenity) =>
      normalize(amenity),
    );

    const matched = amenities.filter((amenity) =>
      propertyAmenities.includes(normalize(amenity)),
    );

    score += matched.length;
  }

  return score;
}

/**
 * Finds a project name from the CURRENT customer message
 * using actual project names present in the database.
 *
 * This is much safer than letting the AI invent a project name.
 */
function findProjectMentioned(properties, query) {
  if (!query) return null;

  const uniqueProjects = [
    ...new Set(
      properties.map((property) => property.projectName).filter(Boolean),
    ),
  ];

  // Longest first so "The Sunflower Heights" gets checked
  // before "The Sunflower".
  uniqueProjects.sort((a, b) => String(b).length - String(a).length);

  const found = uniqueProjects.find((project) => containsText(query, project));

  return found ? { projectName: found } : null;
}

/**
 * Finds a city mentioned in the CURRENT customer message
 * using cities that actually exist in the property inventory.
 */
function findCityMentioned(properties, query) {
  if (!query) return null;

  const cities = [
    ...new Set(properties.map((property) => property.city).filter(Boolean)),
  ];

  cities.sort((a, b) => String(b).length - String(a).length);

  return cities.find((city) => containsText(query, city)) || null;
}

/**
 * Returns one representative property per project.
 *
 * Used for:
 * "Noida me kaun kaun se projects hain?"
 * "Projects kaun kaun se hain?"
 */
function getUniqueProjects(properties, limit = 20) {
  const seen = new Set();
  const result = [];

  for (const property of properties) {
    const projectKey = normalize(property.projectName || "");

    if (!projectKey) continue;
    if (seen.has(projectKey)) continue;

    seen.add(projectKey);
    result.push(property);

    if (result.length >= limit) break;
  }

  return result;
}

/**
 * Detect:
 * "koi aur city me"
 * "kisi aur city me"
 * "another city"
 * "other city"
 * "dusri city"
 */
function isOtherCityQuestion(query) {
  if (!query) return false;

  return (
    /\b(koi|kisi|kuch|another|other|different|dusri|dusre|doosri|doosre)\b.*\b(city|cities|shehar)\b/i.test(
      query,
    ) || /\b(aur|another|other|different)\s+(city|cities|shehar)\b/i.test(query)
  );
}

/**
 * Detect:
 * "The Sunflower ke alawa aur property?"
 * "aur koi property?"
 * "another project?"
 */
function isOtherPropertyQuestion(query) {
  if (!query) return false;

  return (
    /\b(ke alawa|ke ilawa|apart from|besides|other than)\b/i.test(query) ||
    /\b(koi|kuch|another|other|aur)\b.*\b(property|properties|project|projects)\b/i.test(
      query,
    )
  );
}

/**
 * Detect:
 * "Noida me kaun kaun se projects hain?"
 * "Noida ke projects batao"
 */
function isCityProjectListQuestion(query) {
  if (!query) return false;

  return (
    /\b(kaun|kon|konsa|konse|kaunse|which)\b.*\b(project|projects|property|properties)\b/i.test(
      query,
    ) ||
    /\b(project|projects|property|properties)\b.*\b(batao|dikhao|available|hain|hai)\b/i.test(
      query,
    )
  );
}

/**
 * Detect:
 * "projects kaun kaun se hain?"
 * "aapke paas kaunse projects hain?"
 */
function isAllProjectListQuestion(query) {
  if (!query) return false;

  return (
    /\b(aapke paas|tumhare paas|mere paas)\b.*\b(project|projects|property|properties)\b/i.test(
      query,
    ) ||
    /\b(project|projects)\b.*\b(kaun|kon|available|hain|hai)\b/i.test(query)
  );
}

function sameProject(a, b) {
  if (!a || !b) return false;

  return normalize(a) === normalize(b);
}

function sameCity(a, b) {
  if (!a || !b) return false;

  return normalize(a) === normalize(b);
}

function containsText(text, value) {
  if (!text || !value) return false;

  return normalize(text).includes(normalize(value));
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

module.exports = {
  matchProperties,
};
