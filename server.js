const { google } = require('googleapis');
const express = require('express');
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const { OpenAI } = require('openai');
const { convert } = require('html-to-text');
const { Parser } = require('json2csv');
require('dotenv').config();

const options = { wordwrap: 130 };

const app = express();
const port = 3000;
app.use(cors());
const upload = multer({ dest: 'uploads/' });
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

const prompt = process.env.PROMPT_TEXT;

const credentials = {
  type: 'service_account',
  project_id: process.env.project_id,
  private_key_id: process.env.private_key_id,
  private_key: process.env.private_key.replace(/\\n/g, '\n'),
  client_email: process.env.client_email,
  client_id: process.env.client_id,
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: process.env.client_x509_cert_url,
  universe_domain: 'googleapis.com',
};

async function getAllPages(url) {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    const links = $('a');

    const pages = new Set();
    const baseUrl = new URL(url);

    links.each((index, element) => {
      const href = $(element).attr('href');
      if (href && href.startsWith('http')) {
        try {
          const absoluteUrl = new URL(href);
          if (absoluteUrl.hostname === baseUrl.hostname) {
            pages.add(absoluteUrl.href);
          }
        } catch (error) {
          console.error('Invalid URL:', href);
        }
      }
    });

    return Array.from(pages);
  } catch (error) {
    console.error('Error retrieving pages:', error);
    return [];
  }
}

function getBaseUrl(websiteUrl) {
  const parsedUrl = new URL(websiteUrl);
  return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
}

async function createAndMoveDocument(content, url, parentFolderId) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    const authClient = await auth.getClient();

    const docs = google.docs({ version: 'v1', auth: authClient });
    const drive = google.drive({ version: 'v3', auth: authClient });

    // Create a folder within the current folder
    const folderMetadata = {
      'name': 'Processed Documents',
      'parents': [parentFolderId],
      'mimeType': 'application/vnd.google-apps.folder'
    };

    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id'
    });

    const folderId = folder.data.id;

    // Create the document
    const docCreationResponse = await docs.documents.create({
      requestBody: {
        title: url
      }
    });

    const documentId = docCreationResponse.data.documentId;
    console.log(`Created document with ID: ${documentId}`);

    // Update the document content
    await docs.documents.batchUpdate({
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

    // Move the document to the created folder
    const fileMoveResponse = await drive.files.update({
      fileId: documentId,
      addParents: folderId,
      removeParents: 'root',
      fields: 'id, parents'
    });

    console.log(`Document moved to folder with ID: ${folderId}`);
    return `https://docs.google.com/document/d/${documentId}`;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

async function generateText(text) {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt + text }],
      model: process.env.GPT_MODEL,
    });

    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.log(error);
    return '';
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
    const docLink = await createAndMoveDocument(content, url);
    return { content, docLink };
  } catch (error) {
    console.log(error);
    return { content: '', docLink: null };
  }
}

async function getUrlsFromSitemap(sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl);
    const $ = cheerio.load(response.data, { xmlMode: true });

    // Check if the response is an index of sitemaps
    const sitemapIndex = $('sitemapindex');
    if (sitemapIndex.length > 0) {
      // If it's an index of sitemaps, extract individual sitemap URLs and retrieve their contents
      const sitemapUrls = [];
      sitemapIndex.find('sitemap loc').each((index, element) => {
        const sitemapUrl = $(element).text();
        sitemapUrls.push(sitemapUrl);
      });

      // Fetch URLs from individual sitemaps recursively
      const urls = [];
      for (const url of sitemapUrls) {
        const subUrls = await getUrlsFromSitemap(url);
        urls.push(...subUrls);
      }

      return urls;
    }

    // If it's a direct sitemap, extract URLs
    const urls = [];
    const maxUrls = 10; // Adjust this value as needed
    $('url loc').each((index, element) => {
      if (index >= maxUrls) return false;
      const url = $(element).text();
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
          const processedResults = await processRowsInParallel(results);
          sendCsvResponse(res, processedResults);
        });
    } else {
      // Direct request with 'url' and 'all_pages' fields
      const { url, all_pages } = req.body;

      if (!url || !all_pages) {
        return res.status(400).send('URL and all_pages fields are required.');
      }

      const processedResults = await processRowsInParallel([{ url, all_pages }]);
      sendCsvResponse(res, processedResults);
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
});

async function processRowsInParallel(rows) {
  const promises = rows.map(async (row) => {
    const { url, all_pages } = row;

    if (all_pages === 'yes') {
      const pages = await getUrlsFromSitemap(`${getBaseUrl(url)}/sitemap.xml`);
      const pageTexts = await Promise.all(
        pages.map(async (page) => {
          const text = await getPageText(page);
          return convert(text, options);
        })
      );
      const content = await generateText(pageTexts.join('\n'));
      const docLink = await createAndMoveDocument(content, url);
      console.log(`${url} - all pages`);
      return { ...row, doc_link: docLink };
    } else if (all_pages === 'no') {
      const { content, docLink } = await scrapeLocal(url);
      return { ...row, doc_link: docLink };
    } else {
      console.log(`Invalid value for "all_pages" for URL: ${url}`);
      return { ...row, doc_link: null };
    }
  });

  return Promise.all(promises);
}

async function getPageText(url) {
  try {
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

function sendCsvResponse(res, data) {
  const fields = Object.keys(data[0]);
  const parser = new Parser({ fields });
  const csv = parser.parse(data);

  res.header('Content-Type', 'text/csv');
  res.attachment('output.csv');
  res.send(csv);
}
