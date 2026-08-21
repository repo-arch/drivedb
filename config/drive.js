const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

// Service account auth — same JWT-based pattern used elsewhere in your stack,
// just handled by the googleapis library instead of hand-rolled Web Crypto.
const auth = new google.auth.GoogleAuth({
  keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH),
  scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });

module.exports = drive;
