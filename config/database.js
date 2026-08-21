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

// ---- Material Master system tables (replaces Firestore collections) ----

// company_master — list of companies for dropdown
db.exec(`
  CREATE TABLE IF NOT EXISTS company_master (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// product_master — product catalog with parameters stored as JSON text
db.exec(`
  CREATE TABLE IF NOT EXISTS product_master (
    id TEXT PRIMARY KEY,
    product_code TEXT,
    product_name TEXT,
    company_name TEXT,
    parameters TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// dropdown_config — key/value settings store (dosage forms, stages, etc.)
// and also holds the atomic reference counter as a special row
db.exec(`
  CREATE TABLE IF NOT EXISTS dropdown_config (
    config_key TEXT PRIMARY KEY,
    config_value TEXT
  )
`);

// Seed default dropdown config if not present
const seedConfig = db.prepare(`INSERT OR IGNORE INTO dropdown_config (config_key, config_value) VALUES (?, ?)`);
seedConfig.run('dosageForms', JSON.stringify(['Tablet', 'Capsule', 'Syrup', 'Injection', 'Cream', 'Ointment']));
seedConfig.run('developmentStages', JSON.stringify(['R&D', 'Pilot', 'Clinical', 'Commercial', 'Stability']));
seedConfig.run('lastRefNumber', '0');

// material_master — the main sample records (mirrors material_master1 Firestore collection)
db.exec(`
  CREATE TABLE IF NOT EXISTS material_master (
    id TEXT PRIMARY KEY,
    unique_code TEXT,
    company_name TEXT,
    product_code TEXT,
    product_name TEXT,
    dosage_form TEXT,
    sample_date TEXT,
    stage TEXT,
    ar_no TEXT,
    batch_no TEXT,
    quantity TEXT,
    avg_weight TEXT,
    parameters TEXT,
    reference_codes TEXT,
    status TEXT DEFAULT 'active',
    allotments TEXT DEFAULT '[]',
    drive_folder_id TEXT,
    drive_folder_link TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Safe migration for databases created before drive_folder_id existed
try {
  db.exec(`ALTER TABLE material_master ADD COLUMN drive_folder_id TEXT`);
} catch (e) { /* column already exists — ignore */ }
try {
  db.exec(`ALTER TABLE material_master ADD COLUMN drive_folder_link TEXT`);
} catch (e) { /* column already exists — ignore */ }

module.exports = db;
