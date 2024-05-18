const { Worker } = require('worker_threads');
const { google } = require('googleapis');
const express = require('express');
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { Parser } = require('json2csv');
require('dotenv').config();

const app = express();
const port = 3000;
app.use(cors());
const upload = multer({ dest: 'uploads/' });
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MAX_WORKERS = 4; // Adjust based on your server's capacity

app.post('/upload', upload.single('csv'), async (req, res) => {
  try {
    const results = [];
    if (req.file) {
      // CSV file upload case
      const filePath = req.file.path;
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          results.push(row);
        })
        .on('end', async () => {
          const processedResults = await processRows(results);
          sendCsvResponse(res, processedResults);
        });
    } else {
      // Direct request with 'url' and 'all_pages' fields
      const { url, all_pages } = req.body;

      if (!url || !all_pages) {
        return res.status(400).send('URL and all_pages fields are required.');
      }

      const processedResults = await processRows([{ url, all_pages }]);
      sendCsvResponse(res, processedResults);
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
});

function createWorker() {
  return new Worker('./worker.js');
}

async function processRows(rows) {
  const workerPool = [];
  const workerPromises = [];
  const results = [];

  for (let i = 0; i < MAX_WORKERS; i++) {
    workerPool.push(createWorker());
  }

  for (const row of rows) {
    const worker = workerPool.pop();
    const workerPromise = new Promise((resolve, reject) => {
      worker.postMessage(row);
      worker.on('message', (result) => {
        results.push(result);
        workerPool.push(worker);
        resolve();
      });
      worker.on('error', (error) => {
        workerPool.push(worker);
        reject(error);
      });
    });
    workerPromises.push(workerPromise);
  }

  await Promise.all(workerPromises);

  for (const worker of workerPool) {
    worker.terminate();
  }

  return results;
}

function sendCsvResponse(res, data) {
  const fields = Object.keys(data[0]);
  const parser = new Parser({ fields });
  const csv = parser.parse(data);

  res.header('Content-Type', 'text/csv');
  res.attachment('output.csv');
  res.send(csv);
}
