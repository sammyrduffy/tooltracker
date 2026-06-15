// ---------------------------------------------------------------------------
// lib/photos.js  —  Where tool/site photos are stored.
//
// Two modes, picked automatically:
//   • LOCAL (your PC):  photos are saved into public/uploads, exactly as before.
//   • CLOUD (Cloudinary): when the CLOUDINARY_* secrets are set (e.g. on Render),
//     photos are pushed up to Cloudinary instead. Render's free disk is wiped on
//     every restart, so anything saved locally there would vanish — Cloudinary
//     keeps them forever (free tier).
//
// The rest of the app doesn't care which mode is on: a tool's `photo` column
// holds either a bare filename ("photo-123.jpg", local) OR a full https URL
// (Cloudinary). The photoSrc() helper turns either one into a usable <img src>.
// ---------------------------------------------------------------------------

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Cloudinary is "on" if it has credentials — either the single CLOUDINARY_URL
// or the three separate values. (cloudinary auto-reads CLOUDINARY_URL.)
const cloudEnabled = !!(
  process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET)
);

let cloudinary = null;
if (cloudEnabled) {
  cloudinary = require('cloudinary').v2;
  if (!process.env.CLOUDINARY_URL) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
}

// In cloud mode we hold the upload in memory just long enough to forward it to
// Cloudinary; on the PC we write straight to disk like before.
const storage = cloudEnabled
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: path.join(__dirname, '..', 'public', 'uploads'),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${file.fieldname}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
      },
    });

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype)); // only accept image files
  },
});

// Middleware to run right AFTER upload.single('photo'). In cloud mode it pushes
// the in-memory file up to Cloudinary and stashes the resulting URL on
// req.file.filename — so the route handlers can keep reading req.file.filename
// without knowing or caring which mode is active. In local mode it's a no-op.
function uploadToCloud(req, res, next) {
  if (!cloudEnabled || !req.file || !req.file.buffer) return next();
  const stream = cloudinary.uploader.upload_stream(
    { folder: 'tooltracker', resource_type: 'image' },
    (err, result) => {
      if (err) return next(err);
      req.file.filename = result.secure_url; // full https URL, stored in the DB
      next();
    }
  );
  stream.end(req.file.buffer);
}

// Turn a stored photo value into something an <img src> can use. Cloudinary
// values are already full URLs; local values are bare filenames under /uploads.
function photoSrc(photo) {
  if (!photo) return '';
  return /^https?:\/\//i.test(photo) ? photo : `/uploads/${photo}`;
}

module.exports = { upload, uploadToCloud, photoSrc, cloudEnabled };
