const express = require('express');
const cors = require('cors');
require('dotenv').config();
const filesRouter = require('./routes/files');
const companiesRouter = require('./routes/companies');

const app = express();

// Explicit CORS config so preflight (OPTIONS) requests always get proper
// headers back — this matters especially for embedded contexts like
// Google Sites, which loads your page inside a sandboxed iframe with a
// randomly-generated googleusercontent.com origin each time.
app.use(cors({
  origin: true,        // reflect back whatever origin made the request
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Make sure preflight OPTIONS requests are handled for every route
app.options('*', cors());

app.use(express.json());
app.use('/files', filesRouter);
app.use('/companies', companiesRouter);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Drive + SQLite file system is running' });
});

// Prevent one bad async error (e.g. a Drive auth hiccup) from crashing
// and restarting the whole server, which would explain intermittent
// "Application failed to respond" / 502 errors.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
