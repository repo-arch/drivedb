# Drive + SQLite File System

Files are stored in **Google Drive**. Structured metadata (filename, category,
uploader, Drive file ID, timestamps) is stored in a **SQLite database**
(`data.db`). This is the "Drive as blob storage + real DB" pattern.

## How it works

- Upload a file → it goes to a Google Drive folder via a service account
- A record is written to SQLite with the Drive file ID + your metadata
- Listing/filtering/searching happens against SQLite (fast, no Drive API calls)
- Only when you need the actual file do you use the stored Drive link/ID

## 1. Set up a Google Cloud service account

1. Go to https://console.cloud.google.com/ → create or select a project
2. Enable the **Google Drive API** (APIs & Services → Library → search "Drive API" → Enable)
3. Go to **APIs & Services → Credentials → Create Credentials → Service Account**
4. Give it a name (e.g. `drive-db-uploader`), no special roles needed
5. Open the service account → **Keys** tab → **Add Key → Create new key → JSON**
6. This downloads a `.json` file — save it as `config/service-account-key.json`
   (this file is git-ignored, never commit it)

## 2. Create and share a Drive folder

1. In Google Drive, create a folder for uploads (e.g. "App Uploads")
2. Open the folder, copy the ID from the URL:
   `https://drive.google.com/drive/folders/THIS_PART_IS_THE_ID`
3. **Share this folder** with the service account's email address
   (found in the JSON key file as `client_email`, looks like
   `drive-db-uploader@your-project.iam.gserviceaccount.com`) — give it **Editor** access.
   Without this step, uploads will fail with a permissions error.

## 3. Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:
```
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./config/service-account-key.json
GOOGLE_DRIVE_FOLDER_ID=paste_your_folder_id_here
PORT=3000
DATABASE_PATH=./data.db
```

## 4. Run it

```bash
npm start
```

Server runs at `http://localhost:3000`. SQLite file (`data.db`) is created
automatically on first run.

## 5. Try it

**Upload a file:**
```bash
curl -X POST http://localhost:3000/files/upload \
  -F "file=@/path/to/some-file.pdf" \
  -F "category=QC-Report" \
  -F "uploaded_by=crius"
```

**List files:**
```bash
curl http://localhost:3000/files
```

**Filter by category:**
```bash
curl "http://localhost:3000/files?category=QC-Report"
```

**Get one record:**
```bash
curl http://localhost:3000/files/1
```

**Delete a file (removes from Drive + DB):**
```bash
curl -X DELETE http://localhost:3000/files/1
```

## Extending this

- Add more columns to the `files` table in `config/database.js` for your
  actual use case (e.g. `material_code`, `qc_stage`, `status`)
- Swap SQLite for Postgres/Supabase later — the Drive logic doesn't change,
  only `config/database.js` and the queries in `routes/files.js`
- Add auth (API key, JWT, or session-based) before exposing this publicly
- If deploying (not just local testing), put this behind HTTPS and don't
  expose port 3000 directly to the internet

## Notes

- The service account key file and `.env` are git-ignored on purpose — set
  them up locally after cloning, never commit real credentials
- `data.db` is also git-ignored since it's local state, not source code
