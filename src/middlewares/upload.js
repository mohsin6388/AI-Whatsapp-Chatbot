const multer = require('multer');
const ApiError = require('../utils/ApiError');

// Files are kept in memory only (never written to disk) — parsed immediately
// and discarded. Fine for CSVs in the tens-of-thousands-of-rows range.
const storage = multer.memoryStorage();

const csvFileFilter = (req, file, cb) => {
  const isCsv =
    file.mimetype === 'text/csv' ||
    file.mimetype === 'application/vnd.ms-excel' ||
    file.originalname.toLowerCase().endsWith('.csv');

  if (!isCsv) {
    return cb(ApiError.badRequest('Only .csv files are accepted'));
  }
  cb(null, true);
};

const uploadCsv = multer({
  storage,
  fileFilter: csvFileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

module.exports = { uploadCsv };
