const { google } = require('googleapis');
const express = require('express');
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const url = require('url');
const { OpenAI } = require("openai");
require('dotenv').config();
const { convert } = require('html-to-text');
const options = {
  wordwrap: 130,
};

const app = express();
const port = 3000;
app.use(cors());
const upload = multer({ dest: 'uploads/' });
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
 
const prompt = process.env.PROMPT_TEXT;

const credentials = {
  "type": "service_account",
  "project_id": process.env.project_id,
  "private_key_id": process.env.private_key_id,
  "private_key": process.env.private_key,
  "client_email": process.env.client_email,
  "client_id": process.env.client_id,
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": process.env.client_x509_cert_url,
  "universe_domain": "googleapis.com"
}

async function getAllPages(pageUrl) {
console.log(pageUrl)
  try {
    const response = await axios.get(pageUrl);
    console.log("finished!")
    const $ = cheerio.load(response.data);
    const parsedUrl = url.parse(pageUrl);
    const baseDomain = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
    const foundUrls = new Set();

    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (href && href.startsWith(baseDomain)) {
        console.log(href)
        foundUrls.add(href);
      }
    });

    return Array.from(foundUrls);
  } catch (error) {
    console.error('Error:', error);
    return [];
  }

}

// Function to check if a URL is valid
function isValidURL(url) {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

// Example usage:
getAllPages('https://example.com')
  .then(pages => console.log(pages))
  .catch(error => console.error(error));

function getBaseUrl(websiteUrl) {
  const parsedUrl = new URL(websiteUrl);
  return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
}

async function createAndMoveDocument(content, url) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive'
      ]
    });

    const authClient = await auth.getClient();

    const docs = google.docs({ version: 'v1', auth: authClient });
    const drive = google.drive({ version: 'v3', auth: authClient });

    const docCreationResponse = await docs.documents.create({
      requestBody: {
        title: url
      }
    });

    const documentId = docCreationResponse.data.documentId;
    console.log(`Created document with ID: ${documentId}`);

    const updateResponse = await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: {
                index: 1
              },
              text: content
            }
          }
        ]
      }
    });

    console.log("Text updated in document.");

    const folderId = process.env.G_DRIVE_FOLDER;

    const fileMoveResponse = await drive.files.update({
      fileId: documentId,
      addParents: folderId,
      removeParents: 'root',
      fields: 'id, parents'
    });

    console.log(`Document moved to folder with ID: ${folderId}`);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

async function generateText(text) {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    //console.log(prompt + text)
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt + text }],
      model: process.env.GPT_MODEL
    });
    //console.log(chatCompletion.choices[0].message.content);
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.log(error);
  }
}

async function scrapeLocal(url) {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    $('script').remove();
    $('style').remove();
    const text = $('body').text();
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    const content = await generateText(cleanedText);
    //console.log(content);
    createAndMoveDocument(content, url);
    return content;
  } catch (error) {
    console.log(error);
  }
}

async function getUrlsFromSitemap(sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl);
    const $ = cheerio.load(response.data, { xmlMode: true });
    const urls = [];
    
    $('url loc').each((index, element) => {
      const url = $(element).text();
      console.log(url);
      urls.push(url);
    });
    
    return urls;
  } catch (error) {
    console.error('Error fetching sitemap:', error);
    return [];
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/upload', upload.single('csv'), async (req, res) => {
  try {
    if (req.file) {
      // CSV file upload case
      const filePath = req.file.path;
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', async (row) => {
          await processRow(row);
        })
        .on('end', () => {
          console.log('CSV file processing done.');
          res.send('CSV file processing done.');
        });
    } else {
      // Direct request with 'url' and 'all_pages' fields
      const { url, all_pages } = req.body;

      if (!url || !all_pages) {
        return res.status(400).send('URL and all_pages fields are required.');
      }

      await processRow({ url, all_pages });

      console.log('Direct request processed successfully.');
      res.send('Direct request processed successfully.');
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
});

async function processRow(row) {
  const { url, all_pages } = row;

  if (all_pages === 'yes') {
    console.log(`this is all pages ${url}`)
    const pages = await getAllPages(url);
    const pageTexts = await Promise.all(pages.map(async (page) => {
      const text = await getPageText(page);
      return convert(text, options);
    }));
    const content = await generateText(pageTexts.join('\n'));
    createAndMoveDocument(content, url);
    console.log(`${url} - all pages`);
  } else if (all_pages === 'no') {
    console.log(url);
    const content = await scrapeLocal(url);
    //console.log(content);
  } else {
    console.log(`Invalid value for "all_pages" for URL: ${url}`);
  }
}

async function getPageText(url) {
  try {
    console.log(`this is not all pages ${url}`)
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    $('script').remove();
    $('style').remove();
    const text = $('body').text();
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    return cleanedText;
  } catch (error) {
    console.error('Error retrieving page text:', error);
    return '';
  }
}
