const express = require('express');
const db = require('../config/database');

const router = express.Router();

// ---------------------------------------------------------------
// Make sure the companies table exists (runs once, harmless if
// it already exists). Mirrors however config/database.js already
// creates the "files" table.
// ---------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unique_id TEXT UNIQUE NOT NULL,
    company_name TEXT NOT NULL,
    contact_person TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ---------------------------------------------------------------
// GET /companies/next-id
// ---------------------------------------------------------------
router.get('/next-id', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT unique_id FROM companies
      WHERE unique_id LIKE 'WC%'
      ORDER BY LENGTH(unique_id) DESC, unique_id DESC
      LIMIT 1
    `).get();

    let nextNumber = 1;
    if (row) {
      const num = parseInt(row.unique_id.substring(2), 10);
      if (!isNaN(num)) nextNumber = num + 1;
    }

    const nextId = 'WC' + String(nextNumber).padStart(4, '0');
    res.json({ nextId });
  } catch (err) {
    console.error('next-id failed:', err);
    res.status(500).json({ error: 'Failed to generate next ID', details: err.message });
  }
});

// ---------------------------------------------------------------
// GET /companies/check-duplicate?name=...
// ---------------------------------------------------------------
router.get('/check-duplicate', (req, res) => {
  try {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.json({ isDuplicate: false });

    const row = db.prepare(`
      SELECT 1 FROM companies WHERE LOWER(company_name) = LOWER(?) LIMIT 1
    `).get(name);

    res.json({ isDuplicate: !!row });
  } catch (err) {
    console.error('check-duplicate failed:', err);
    res.status(500).json({ error: 'Failed to check duplicate', details: err.message });
  }
});

// ---------------------------------------------------------------
// POST /companies
// ---------------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const { companyName, contactPerson, phone, email, address } = req.body || {};

    if (!companyName || !contactPerson) {
      return res.status(400).json({ error: 'companyName and contactPerson are required' });
    }

    const cleanName = companyName.trim();

    const dup = db.prepare(`
      SELECT 1 FROM companies WHERE LOWER(company_name) = LOWER(?) LIMIT 1
    `).get(cleanName);

    if (dup) {
      return res.status(409).json({ error: 'Duplicate company name' });
    }

    const lastRow = db.prepare(`
      SELECT unique_id FROM companies
      WHERE unique_id LIKE 'WC%'
      ORDER BY LENGTH(unique_id) DESC, unique_id DESC
      LIMIT 1
    `).get();

    let nextNumber = 1;
    if (lastRow) {
      const num = parseInt(lastRow.unique_id.substring(2), 10);
      if (!isNaN(num)) nextNumber = num + 1;
    }
    const uniqueId = 'WC' + String(nextNumber).padStart(4, '0');

    const stmt = db.prepare(`
      INSERT INTO companies (unique_id, company_name, contact_person, phone, email, address, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);
    const result = stmt.run(
      uniqueId,
      cleanName,
      contactPerson.trim(),
      (phone || '').trim(),
      (email || '').trim(),
      (address || '').trim()
    );

    const saved = db.prepare('SELECT * FROM companies WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      uniqueId: saved.unique_id,
      companyName: saved.company_name,
      createdAt: saved.created_at
    });

  } catch (err) {
    console.error('POST /companies failed:', err);
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Duplicate company name or ID collision, please retry' });
    }
    res.status(500).json({ error: 'Failed to save company', details: err.message });
  }
});

// ---------------------------------------------------------------
// GET /companies
// ---------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM companies ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    console.error('GET /companies failed:', err);
    res.status(500).json({ error: 'Failed to fetch companies', details: err.message });
  }
});

module.exports = router;
