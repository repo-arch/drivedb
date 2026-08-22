const express = require('express');
const cors = require('cors');
require('dotenv').config();

const filesRouter = require('./routes/files');
const companiesRouter = require('./routes/companies');   // ADD THIS LINE


const app = express();
app.use(cors());
app.use(express.json());

app.use('/files', filesRouter);
app.use('/companies', companiesRouter);                   // ADD THIS LINE

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Drive + SQLite file system is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
