const express = require('express');
const { Readable } = require('stream');
const drive = require('../config/drive');
const db = require('../config/database');

const router = express.Router();

// ---------------------------------------------------------------
// Serialize all Drive API calls made from this file. The Google
// auth library can throw a spurious "invalid_grant: Invalid JWT
// Signature" when two calls request a token at nearly the same
// instant (e.g. a manual save happening while the periodic Drive
// sync is also running). Running everything through this queue
// guarantees only one Drive call is ever in flight at a time.
// ---------------------------------------------------------------
let driveQueue = Promise.resolve();
function runExclusive(fn) {
  const result = driveQueue.then(fn, fn);
  driveQueue = result.then(() => {}, () => {}); // never let a rejection break the chain
  return result;
}

// ---------------------------------------------------------------
// Helper: retry a Drive API call once if it fails with the
// intermittent "invalid_grant: Invalid JWT Signature" error.
// Combined with runExclusive above, this should be rare now.
// ---------------------------------------------------------------
async function withDriveRetry(fn, label) {
  return runExclusive(async () => {
    try {
      return await fn();
    } catch (err) {
      const isJwtRace = err.message && err.message.includes('invalid_grant');
      if (!isJwtRace) throw err;

      console.warn(`${label}: transient invalid_grant, retrying once...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return await fn();
    }
  });
}

// ---------------------------------------------------------------
// Helper: push a JSON snapshot of a company record to Google Drive
// as its own file, named after the unique_id (e.g. WC0001.json).
// Failure here is logged but never blocks the API response — the
// SQLite row is still the source of truth if Drive is briefly down.
// ---------------------------------------------------------------
async function backupCompanyToDrive(companyRow) {
  try {
    const jsonContent = JSON.stringify(companyRow, null, 2);

    await withDriveRetry(() => {
      const stream = Readable.from([jsonContent]);
      return drive.files.create({
        requestBody: {
          name: `${companyRow.unique_id}.json`,
          parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
        },
        media: {
          mimeType: 'application/json',
          body: stream,
        },
        fields: 'id',
      });
    }, `backupCompanyToDrive(${companyRow.unique_id})`);

    console.log(`Drive backup succeeded for ${companyRow.unique_id}`);
  } catch (err) {
    console.error(`Drive backup failed for ${companyRow.unique_id}:`, err.message);
    if (err.response && err.response.data) {
      console.error('Full Google error response:', JSON.stringify(err.response.data));
    }
    if (err.stack) {
      console.error('Stack:', err.stack);
    }
  }
}

// ---------------------------------------------------------------
// Helper: pull the latest content of every companyId.json file in
// the Drive folder and write any changes back into SQLite.
// Matches files by unique_id embedded in the JSON (or filename).
// ---------------------------------------------------------------
async function syncFromDrive() {
  try {
    const listRes = await withDriveRetry(
      () => drive.files.list({
        q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and name contains '.json' and trashed = false`,
        fields: 'files(id, name, modifiedTime)',
        pageSize: 1000,
      }),
      'syncFromDrive.list'
    );

    const files = listRes.data.files || [];

    for (const file of files) {
      try {
        // Only bother re-checking files modified since our last successful sync
        if (lastSyncTime && file.modifiedTime <= lastSyncTime) continue;

        const contentRes = await withDriveRetry(
          () => drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'text' }
          ),
          `syncFromDrive.get(${file.name})`
        );

        let parsed;
        try {
          parsed = typeof contentRes.data === 'string'
            ? JSON.parse(contentRes.data)
            : contentRes.data;
        } catch (parseErr) {
          console.error(`Skipping ${file.name}: not valid JSON (${parseErr.message})`);
          continue;
        }

        const uniqueId = parsed.unique_id || file.name.replace(/\.json$/i, '');
        const existing = db.prepare('SELECT * FROM companies WHERE unique_id = ?').get(uniqueId);
        if (!existing) {
          console.log(`Skipping ${file.name}: no matching company with unique_id ${uniqueId}`);
          continue;
        }

        db.prepare(`
          UPDATE companies
          SET company_name = ?, contact_person = ?, phone = ?, email = ?, address = ?, status = ?
          WHERE unique_id = ?
        `).run(
          parsed.company_name ?? existing.company_name,
          parsed.contact_person ?? existing.contact_person,
          parsed.phone ?? existing.phone,
          parsed.email ?? existing.email,
          parsed.address ?? existing.address,
          parsed.status ?? existing.status,
          uniqueId
        );

        console.log(`Synced ${uniqueId} from Drive edit (${file.name})`);
      } catch (fileErr) {
        console.error(`Failed syncing ${file.name}:`, fileErr.message);
      }
    }

    lastSyncTime = new Date().toISOString();
  } catch (err) {
    console.error('Drive → DB sync failed:', err.message);
  }
}

let lastSyncTime = null;

// Poll every 10 minutes, and don't run the first sync until 2 minutes
// after startup — this avoids colliding with manual testing right
// after a deploy, which is what triggered the JWT race earlier.
const DRIVE_SYNC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(syncFromDrive, DRIVE_SYNC_INTERVAL_MS);
setTimeout(syncFromDrive, 2 * 60 * 1000);

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
// GET /companies/drive-diagnostic
// Isolated test: tries a few different Drive calls separately so
// we can see exactly which one fails and with what detail.
// ---------------------------------------------------------------
router.get('/drive-diagnostic', async (req, res) => {
  const results = {};

  // Test 1: simplest possible authenticated call, no folder involved
  try {
    const about = await drive.about.get({ fields: 'user' });
    results.aboutGet = { ok: true, user: about.data.user?.emailAddress };
  } catch (err) {
    results.aboutGet = { ok: false, message: err.message, detail: err.response?.data || null };
  }

  // Test 2: list files in the target folder (no write, just read)
  try {
    const list = await drive.files.list({
      q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 5,
    });
    results.listFolder = { ok: true, fileCount: list.data.files?.length ?? 0 };
  } catch (err) {
    results.listFolder = { ok: false, message: err.message, detail: err.response?.data || null };
  }

  // Test 3: actually create a tiny test file in the folder
  try {
    const stream = Readable.from(['{"test":true}']);
    const created = await drive.files.create({
      requestBody: {
        name: `diagnostic-test-${Date.now()}.json`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      },
      media: { mimeType: 'application/json', body: stream },
      fields: 'id',
    });
    results.createFile = { ok: true, fileId: created.data.id };
  } catch (err) {
    results.createFile = { ok: false, message: err.message, detail: err.response?.data || null };
  }

  res.json({
    folderIdUsed: process.env.GOOGLE_DRIVE_FOLDER_ID,
    results,
  });
});

// ---------------------------------------------------------------
// GET /companies/next-id
// Returns the next WC#### id based on the highest existing one
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
// Body: { companyName, contactPerson, phone, email, address }
// ---------------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const { companyName, contactPerson, phone, email, address } = req.body || {};

    if (!companyName || !contactPerson) {
      return res.status(400).json({ error: 'companyName and contactPerson are required' });
    }

    const cleanName = companyName.trim();

    // Duplicate check
    const dup = db.prepare(`
      SELECT 1 FROM companies WHERE LOWER(company_name) = LOWER(?) LIMIT 1
    `).get(cleanName);

    if (dup) {
      return res.status(409).json({ error: 'Duplicate company name' });
    }

    // Generate next id
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

    // Fire-and-forget: don't make the user wait on Drive before seeing success
    backupCompanyToDrive(saved);

    res.status(201).json({
      uniqueId: saved.unique_id,
      companyName: saved.company_name,
      createdAt: saved.created_at
    });

  } catch (err) {
    // SQLite unique constraint race (two submits at once) lands here too
    console.error('POST /companies failed:', err);
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Duplicate company name or ID collision, please retry' });
    }
    res.status(500).json({ error: 'Failed to save company', details: err.message });
  }
});

// ---------------------------------------------------------------
// PATCH /companies/:id
// Update one or more fields of an existing company record.
// Body can include any of: companyName, contactPerson, phone, email, address, status
// ---------------------------------------------------------------
router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const { companyName, contactPerson, phone, email, address, status } = req.body || {};

    // If renaming, make sure the new name isn't already used by a different company
    if (companyName && companyName.trim().toLowerCase() !== existing.company_name.toLowerCase()) {
      const dup = db.prepare(`
        SELECT 1 FROM companies WHERE LOWER(company_name) = LOWER(?) AND id != ? LIMIT 1
      `).get(companyName.trim(), id);
      if (dup) {
        return res.status(409).json({ error: 'Another company already uses that name' });
      }
    }

    const updated = {
      company_name: companyName !== undefined ? companyName.trim() : existing.company_name,
      contact_person: contactPerson !== undefined ? contactPerson.trim() : existing.contact_person,
      phone: phone !== undefined ? phone.trim() : existing.phone,
      email: email !== undefined ? email.trim() : existing.email,
      address: address !== undefined ? address.trim() : existing.address,
      status: status !== undefined ? status.trim() : existing.status,
    };

    db.prepare(`
      UPDATE companies
      SET company_name = ?, contact_person = ?, phone = ?, email = ?, address = ?, status = ?
      WHERE id = ?
    `).run(
      updated.company_name,
      updated.contact_person,
      updated.phone,
      updated.email,
      updated.address,
      updated.status,
      id
    );

    const saved = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);

    // Refresh the Drive copy so it reflects the edit
    backupCompanyToDrive(saved);

    res.json(saved);

  } catch (err) {
    console.error('PATCH /companies/:id failed:', err);
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Duplicate company name' });
    }
    res.status(500).json({ error: 'Failed to update company', details: err.message });
  }
});

// ---------------------------------------------------------------
// POST /companies/sync-from-drive
// Manually trigger a Drive → DB sync right now (for testing, or a
// "Refresh from Drive" button in an admin UI)
// ---------------------------------------------------------------
router.post('/sync-from-drive', async (req, res) => {
  try {
    await syncFromDrive();
    res.json({ synced: true });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

// ---------------------------------------------------------------
// GET /companies
// List all companies
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
