const multer = require("multer");

const ApiError = require("../utils/ApiError");

// Files memory mein rahengi.
// Controller/service inhe Cloudinary ya kisi storage par upload karega.
const storage = multer.memoryStorage();

/* =========================
   CSV UPLOAD
========================= */

const csvFileFilter = (req, file, cb) => {
  const isCsv =
    file.mimetype === "text/csv" ||
    file.mimetype === "application/vnd.ms-excel" ||
    file.originalname.toLowerCase().endsWith(".csv");

  if (!isCsv) {
    return cb(ApiError.badRequest("Only .csv files are accepted"));
  }

  cb(null, true);
};

const uploadCsv = multer({
  storage,
  fileFilter: csvFileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

/* =========================
   BROCHURE + PROPERTY IMAGES
========================= */

const brochureFileFilter = (req, file, cb) => {
  const isPdf =
    file.mimetype === "application/pdf" ||
    file.originalname.toLowerCase().endsWith(".pdf");

  const isImage = file.mimetype.startsWith("image/");

  // Brochure PDF
  if (file.fieldname === "brochure") {
    if (!isPdf) {
      return cb(ApiError.badRequest("Brochure must be a PDF file"));
    }

    return cb(null, true);
  }

  // Property images
  if (file.fieldname === "images") {
    if (!isImage) {
      return cb(
        ApiError.badRequest("Property images must be valid image files"),
      );
    }

    return cb(null, true);
  }

  return cb(
    ApiError.badRequest('Invalid upload field. Use "brochure" or "images"'),
  );
};

const uploadBrochure = multer({
  storage,
  fileFilter: brochureFileFilter,
  limits: {
    // PDF max 20MB
    fileSize: 20 * 1024 * 1024,

    // Maximum number of files
    files: 11,
  },
});

module.exports = {
  uploadCsv,
  uploadBrochure,
};
