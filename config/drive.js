const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

// Service account auth — supports two ways of providing credentials:
// 1. GOOGLE_SERVICE_ACCOUNT_KEY_JSON — the full JSON key pasted as an env var
//    (use this on Railway/Render/etc. where you can't upload a file)
// 2. GOOGLE_SERVICE_ACCOUNT_KEY_PATH — a path to the JSON key file
//    (use this for local development)
let authConfig = { scopes: ['https://www.googleapis.com/auth/drive'] };

if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
  authConfig.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
} else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH) {
  authConfig.keyFile = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH);
} else {
  throw new Error(
    'Missing Google credentials: set either GOOGLE_SERVICE_ACCOUNT_KEY_JSON or GOOGLE_SERVICE_ACCOUNT_KEY_PATH in your environment.'
  );
}

const auth = new google.auth.GoogleAuth(authConfig);

const drive = google.drive({ version: 'v3', auth });

module.exports = drive;
