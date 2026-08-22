// ============================================================
// COMPANY REGISTRATION ROUTES — add these to your existing
// Railway Express server (the same one serving /dropdown-data
// and /materials for material_master).
//
// Assumes you already have a Postgres `pool` (pg) connected,
// e.g. via DATABASE_URL from Railway's Postgres plugin — the
// same pattern your /materials endpoint already uses.
// ============================================================

// const express = require('express');
// const router = express.Router();
// const pool = require('./db'); // however you already export your pg Pool

// ---- One-time table setup (run once, or via a migration) ----
/*
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  unique_id TEXT UNIQUE NOT NULL,
  company_name TEXT NOT NULL,
  contact_person TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_companies_name_lower
  ON companies (LOWER(company_name));
*/

// ---- GET /companies/next-id ----
// Returns the next WC#### id based on the highest existing unique_id.
router.get('/companies/next-id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT unique_id FROM companies
       WHERE unique_id LIKE 'WC%'
       ORDER BY LENGTH(unique_id) DESC, unique_id DESC
       LIMIT 1`
    );

    let nextNumber = 1;
    if (rows.length > 0) {
      const num = parseInt(rows[0].unique_id.substring(2), 10);
      if (!isNaN(num)) nextNumber = num + 1;
    }

    const nextId = 'WC' + String(nextNumber).padStart(4, '0');
    res.json({ nextId });
  } catch (err) {
    console.error('next-id error:', err);
    res.status(500).json({ error: 'Failed to generate next ID' });
  }
});

// ---- GET /companies/check-duplicate?name=... ----
router.get('/companies/check-duplicate', async (req, res) => {
  try {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.json({ isDuplicate: false });

    const { rows } = await pool.query(
      `SELECT 1 FROM companies WHERE LOWER(company_name) = LOWER($1) LIMIT 1`,
      [name]
    );

    res.json({ isDuplicate: rows.length > 0 });
  } catch (err) {
    console.error('check-duplicate error:', err);
    res.status(500).json({ error: 'Failed to check duplicate' });
  }
});

// ---- POST /companies ----
// Body: { companyName, contactPerson, phone, email, address }
router.post('/companies', async (req, res) => {
  const client = await pool.connect();
  try {
    const { companyName, contactPerson, phone, email, address } = req.body || {};

    if (!companyName || !contactPerson) {
      return res.status(400).json({ error: 'companyName and contactPerson are required' });
    }

    await client.query('BEGIN');

    // Re-check duplicate inside the transaction to avoid race conditions
    const dupCheck = await client.query(
      `SELECT 1 FROM companies WHERE LOWER(company_name) = LOWER($1) LIMIT 1`,
      [companyName.trim()]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Duplicate company name' });
    }

    // Generate next id inside the transaction (locks against concurrent inserts)
    const idResult = await client.query(
      `SELECT unique_id FROM companies
       WHERE unique_id LIKE 'WC%'
       ORDER BY LENGTH(unique_id) DESC, unique_id DESC
       LIMIT 1 FOR UPDATE`
    );
    let nextNumber = 1;
    if (idResult.rows.length > 0) {
      const num = parseInt(idResult.rows[0].unique_id.substring(2), 10);
      if (!isNaN(num)) nextNumber = num + 1;
    }
    const uniqueId = 'WC' + String(nextNumber).padStart(4, '0');

    const insertResult = await client.query(
      `INSERT INTO companies
        (unique_id, company_name, contact_person, phone, email, address, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING unique_id, company_name, created_at`,
      [
        uniqueId,
        companyName.trim(),
        contactPerson.trim(),
        (phone || '').trim(),
        (email || '').trim(),
        (address || '').trim()
      ]
    );

    await client.query('COMMIT');

    const row = insertResult.rows[0];
    res.status(201).json({
      uniqueId: row.unique_id,
      companyName: row.company_name,
      createdAt: row.created_at
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /companies error:', err);
    res.status(500).json({ error: 'Failed to save company' });
  } finally {
    client.release();
  }
});

// ---- GET /companies ----
// List all companies (for an admin panel, etc.)
router.get('/companies', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT unique_id, company_name, contact_person, phone, email, address, status, created_at
       FROM companies ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// module.exports = router;
// In your main server file:  app.use(router);
