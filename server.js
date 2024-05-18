const { Worker } = require('worker_threads');
const express = require('express');
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { Parser } = require('json2csv');
require('dotenv').config();

const app = express();
const port = 3000;
const MAX_WORKERS = 4;  // Adjust based on your server's capacity
app.use(cors());
const upload = multer({ dest: 'uploads/' });
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/upload', upload.single('csv'), async (req, res) => {
  try {
    const results = [];
    if (req.file) {
      const filePath = req.file.path;
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          results.push(row);
        })
        .on('end', async () => {
          const processedResults = await processRowsInBatches(results);
          sendCsvResponse(res, processedResults);
        });
    } else {
      const { url, all_pages } = req.body;
      if (!url || !all_pages) {
        return res.status(400).send('URL and all_pages fields are required.');
      }
      const processedResults = await processRowsInBatches([{ url, all_pages }]);
      sendCsvResponse(res, processedResults);
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
});

function createWorker(row) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./worker.js');
    worker.postMessage(row);
    worker.on('message', (result) => {
      resolve(result);
    });
    worker.on('error', (error) => {
      reject(error);
    });
  });
}

