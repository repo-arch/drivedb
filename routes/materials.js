const express = require('express');
const multer = require('multer');
const fs = require('fs');
const db = require('../config/database');
const drive = require('../config/drive');

const router = express.Router();
const upload = multer({ dest: 'uploads-temp/' });

// Creates a Drive folder named after the material's unique code,
// nested inside the main GOOGLE_DRIVE_FOLDER_ID.
// Returns { id, link }.
async function createMaterialFolder(uniqueCode) {
  const response = await drive.files.create({
    requestBody: {
      name: uniqueCode,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    },
    fields: 'id, webViewLink',
  });
  return { id: response.data.id, link: response.data.webViewLink };
}

// =================================================================
// DROPDOWN DATA — bundled endpoint (mirrors the old loadAllDropdownData)
// Returns companies, products, dosageForms, stages in one call
// =================================================================
router.get('/dropdown-data', (req, res) => {
  try {
    const companies = db.prepare('SELECT company_name FROM company_master ORDER BY company_name').all()
      .map(r => r.company_name);

    const products = db.prepare('SELECT * FROM product_master ORDER BY product_code').all()
      .map(p => ({
        id: p.id,
        code: p.product_code,
        name: p.product_name,
        company: p.company_name,
        parameters: p.parameters ? JSON.parse(p.parameters) : [],
      }));

    const dosageFormsRow = db.prepare('SELECT config_value FROM dropdown_config WHERE config_key = ?').get('dosageForms');
    const stagesRow = db.prepare('SELECT config_value FROM dropdown_config WHERE config_key = ?').get('developmentStages');

    res.json({
      companies,
      products,
      dosageForms: dosageFormsRow ? JSON.parse(dosageFormsRow.config_value) : [],
      stages: stagesRow ? JSON.parse(stagesRow.config_value) : [],
    });
  } catch (err) {
    console.error('dropdown-data failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// COMPANY MASTER
// =================================================================
router.get('/companies', (req, res) => {
  const rows = db.prepare('SELECT * FROM company_master ORDER BY company_name').all();
  res.json(rows);
});

router.post('/companies', (req, res) => {
  const { company_name } = req.body;
  if (!company_name) return res.status(400).json({ error: 'company_name is required' });
  try {
    db.prepare('INSERT OR IGNORE INTO company_master (company_name) VALUES (?)').run(company_name);
    res.status(201).json({ company_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// PRODUCT MASTER
// =================================================================
router.get('/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM product_master ORDER BY product_code').all();
  res.json(rows.map(p => ({ ...p, parameters: p.parameters ? JSON.parse(p.parameters) : [] })));
});

router.post('/products', (req, res) => {
  try {
    const { product_code, product_name, company_name, parameters } = req.body;
    if (!product_code) return res.status(400).json({ error: 'product_code is required' });

    const id = product_code.replace(/[\/.]/g, '_');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO product_master (id, product_code, product_name, company_name, parameters, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_code=excluded.product_code,
        product_name=excluded.product_name,
        company_name=excluded.company_name,
        parameters=excluded.parameters,
        updated_at=excluded.updated_at
    `).run(id, product_code, product_name || '', company_name || '', JSON.stringify(parameters || []), now, now);

    res.status(201).json({ id, product_code, product_name, company_name, parameters });
  } catch (err) {
    console.error('create product failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// MATERIAL MASTER — the main sample records
// =================================================================

// List / filter
router.get('/materials', (req, res) => {
  const { status, company_name } = req.query;
  let query = 'SELECT * FROM material_master WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (company_name) { query += ' AND company_name = ?'; params.push(company_name); }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({
    ...r,
    parameters: r.parameters ? JSON.parse(r.parameters) : [],
    reference_codes: r.reference_codes ? JSON.parse(r.reference_codes) : [],
    allotments: r.allotments ? JSON.parse(r.allotments) : [],
  })));
});

// Get one
router.get('/materials/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM material_master WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...row,
    parameters: row.parameters ? JSON.parse(row.parameters) : [],
    reference_codes: row.reference_codes ? JSON.parse(row.reference_codes) : [],
    allotments: row.allotments ? JSON.parse(row.allotments) : [],
  });
});

// Create — replicates the old submitToFirebase() logic:
// 1. Assigns sequential Ref codes atomically using the counter in dropdown_config
// 2. Saves the material record
// 3. If it's a brand-new product, upserts product_master too
router.post('/materials', async (req, res) => {
  try {
    const {
      uniqueCode, companyName, productCode, productName, dosageForm,
      sampleDate, stage, arNo, batchNo, quantity, avgWeight,
      parameters, isNewProduct,
    } = req.body;

    if (!uniqueCode) return res.status(400).json({ error: 'uniqueCode is required' });
    if (!parameters || parameters.length === 0) {
      return res.status(400).json({ error: 'At least one parameter is required' });
    }

    const id = uniqueCode.replace(/[\/.]/g, '_');
    const now = new Date().toISOString();

    // Create (or reuse) a Drive folder named after this material's unique code.
    // This happens before the DB write so the folder id can be stored on the record.
    const existing = db.prepare('SELECT drive_folder_id, drive_folder_link FROM material_master WHERE id = ?').get(id);
    let driveFolderId = existing?.drive_folder_id || null;
    let driveFolderLink = existing?.drive_folder_link || null;

    if (!driveFolderId) {
      const folder = await createMaterialFolder(uniqueCode);
      driveFolderId = folder.id;
      driveFolderLink = folder.link;
    }

    // Run counter increment + insert as a single transaction so concurrent
    // submissions never get duplicate reference codes (this is what the
    // Firestore counter doc + merge:true was doing, just done atomically here).
    const result = db.transaction(() => {
      const counterRow = db.prepare('SELECT config_value FROM dropdown_config WHERE config_key = ?').get('lastRefNumber');
      let counter = counterRow ? parseInt(counterRow.config_value, 10) + 1 : 1;

      const parametersWithRef = parameters.map(p => ({
        ...p,
        referenceCode: 'Ref' + counter++,
      }));

      db.prepare('UPDATE dropdown_config SET config_value = ? WHERE config_key = ?')
        .run(String(counter - 1), 'lastRefNumber');

      const referenceCodes = parametersWithRef.map(p => p.referenceCode);

      db.prepare(`
        INSERT INTO material_master
          (id, unique_code, company_name, product_code, product_name, dosage_form, sample_date, stage,
           ar_no, batch_no, quantity, avg_weight, parameters, reference_codes, status, allotments,
           drive_folder_id, drive_folder_link, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          unique_code=excluded.unique_code, company_name=excluded.company_name, product_code=excluded.product_code,
          product_name=excluded.product_name, dosage_form=excluded.dosage_form, sample_date=excluded.sample_date,
          stage=excluded.stage, ar_no=excluded.ar_no, batch_no=excluded.batch_no, quantity=excluded.quantity,
          avg_weight=excluded.avg_weight, parameters=excluded.parameters, reference_codes=excluded.reference_codes,
          drive_folder_id=excluded.drive_folder_id, drive_folder_link=excluded.drive_folder_link,
          updated_at=excluded.updated_at
      `).run(
        id, uniqueCode, companyName || '', productCode || '', productName || '', dosageForm || '',
        sampleDate || '', stage || '', arNo || '', batchNo || '', quantity || '', avgWeight || '',
        JSON.stringify(parametersWithRef), JSON.stringify(referenceCodes),
        driveFolderId, driveFolderLink, now, now
      );

      // If this was a brand-new product, upsert it into product_master too
      if (isNewProduct && productCode) {
        const productId = productCode.replace(/[\/.]/g, '_');
        db.prepare(`
          INSERT INTO product_master (id, product_code, product_name, company_name, parameters, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            product_code=excluded.product_code, product_name=excluded.product_name,
            company_name=excluded.company_name, parameters=excluded.parameters, updated_at=excluded.updated_at
        `).run(
          productId, productCode, productName || '', companyName || '',
          JSON.stringify(parametersWithRef.map(p => ({ parameter: p.parameter, claim: p.claim, overages: p.overages }))),
          now, now
        );
      }

      return { id, parametersWithRef, referenceCodes };
    })();

    res.status(201).json({
      id: result.id,
      uniqueCode,
      productName,
      parameters: result.parametersWithRef,
      referenceCodes: result.referenceCodes,
      driveFolderId,
      driveFolderLink,
      createdAt: now,
    });
  } catch (err) {
    console.error('create material failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// =================================================================
// POST /materials/:id/files
// Uploads a file directly into that material's Drive folder
// (the folder created automatically when the material was submitted)
// Form field: file
// =================================================================
router.post('/materials/:id/files', upload.single('file'), async (req, res) => {
  const localPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided (field name must be "file")' });
    }

    const material = db.prepare('SELECT id, unique_code, drive_folder_id FROM material_master WHERE id = ?').get(req.params.id);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    if (!material.drive_folder_id) {
      return res.status(400).json({ error: 'This material has no Drive folder yet' });
    }

    const driveResponse = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [material.drive_folder_id],
      },
      media: {
        mimeType: req.file.mimetype,
        body: fs.createReadStream(localPath),
      },
      fields: 'id, webViewLink',
    });

    res.status(201).json({
      material_id: material.id,
      unique_code: material.unique_code,
      original_name: req.file.originalname,
      drive_file_id: driveResponse.data.id,
      drive_view_link: driveResponse.data.webViewLink,
    });
  } catch (err) {
    console.error('material file upload failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
});

module.exports = router;
