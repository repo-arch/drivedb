const Database = require('better-sqlite3');
require('dotenv').config();

const db = new Database(process.env.DATABASE_PATH || './data.db');

// Create the files table if it doesn't exist yet.
// This is your "structured metadata" — the real DB part.
// Add whatever columns your actual use case needs
// (e.g. material_code, qc_stage, uploaded_by, status, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    drive_file_id TEXT NOT NULL UNIQUE,
    drive_view_link TEXT,
    category TEXT,
    uploaded_by TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    archived INTEGER DEFAULT 0
  )
`);

module.exports = db;
