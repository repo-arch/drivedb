const express = require('express');
const multer = require('multer');
const fs = require('fs');
const drive = require('../config/drive');
const db = require('../config/database');

const router = express.Router();

// Temp local storage before pushing to Drive
const upload = multer({ dest: 'uploads-temp/' });

// ---------------------------------------------------------------
// POST /files/upload
// Uploads a file to Google Drive, stores metadata + Drive fileId in SQLite
// Form fields: file (the file), category (optional text), uploaded_by (optional text)
// ---------------------------------------------------------------
router.post('/upload', upload.single('file'), async (req, res) => {
  const localPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided (field name must be "file")' });
    }

    const { category, uploaded_by } = req.body;

    // 1. Upload file bytes to Google Drive
    const driveResponse = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: req.file.mimetype,
        body: fs.createReadStream(localPath),
      },
      fields: 'id, webViewLink',
    });

    const driveFileId = driveResponse.data.id;
    const driveViewLink = driveResponse.data.webViewLink;

    // 2. Write the structured record to SQLite (the "real DB" part)
    const stmt = db.prepare(`
      INSERT INTO files (original_name, drive_file_id, drive_view_link, category, uploaded_by, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      req.file.originalname,
      driveFileId,
      driveViewLink,
      category || null,
      uploaded_by || null,
      req.file.mimetype,
      req.file.size
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      original_name: req.file.originalname,
      drive_file_id: driveFileId,
      drive_view_link: driveViewLink,
      category: category || null,
      uploaded_by: uploaded_by || null,
    });
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  } finally {
    // Always clean up the local temp file, upload succeeded or not
    if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
});

// ---------------------------------------------------------------
// GET /files
// Lists file records from the DB (fast — no Drive calls needed for listing)
// Optional query params: ?category=xyz&uploaded_by=abc
// ---------------------------------------------------------------
router.get('/', (req, res) => {
  const { category, uploaded_by } = req.query;

  let query = 'SELECT * FROM files WHERE archived = 0';
  const params = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (uploaded_by) {
    query += ' AND uploaded_by = ?';
    params.push(uploaded_by);
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// ---------------------------------------------------------------
// GET /files/:id
// Get a single record by DB id
// ---------------------------------------------------------------
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ---------------------------------------------------------------
// DELETE /files/:id
// Deletes the file from Drive AND removes the DB record
// ---------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  try {
    await drive.files.delete({ fileId: row.drive_file_id });
    db.prepare('DELETE FROM files WHERE id = ?').run(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: 'Delete failed', details: err.message });
  }
});

module.exports = router;
