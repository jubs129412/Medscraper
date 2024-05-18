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
const pLimit = require('p-limit');
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
  try {
    const parsedUrl = new URL(websiteUrl);
    return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
  } catch (error) {
    console.error('Invalid URL:', websiteUrl, error);
    return null;
  }
}

async function createNewFolder(parentFolderId, folderName) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    };

    const folder = await drive.files.create({
      resource: fileMetadata,
      fields: 'id',
    });

    console.log(`Folder created with ID: ${folder.data.id}`);
    return folder.data.id;
  } catch (error) {
    console.error('Error creating folder:', error);
    return null;
  }
}

async function makeFolderPublic(folderId) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    await drive.permissions.create({
      fileId: folderId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    console.log(`Folder with ID: ${folderId} is now public.`);
  } catch (error) {
    console.error('Error making folder public:', error);
  }
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

    const docCreationResponse = await docs.documents.create({
      requestBody: {
        title: url,
      },
    });

    const documentId = docCreationResponse.data.documentId;
    console.log(`Created document with ID: ${documentId}`);

    await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: {
                index: 1,
              },
              text: content,
            },
          },
        ],
      },
    });

    console.log('Text updated in document.');

    await drive.files.update({
      fileId: documentId,
      addParents: parentFolderId,
      removeParents: 'root',
      fields: 'id, parents',
    });

    console.log(`Document moved to folder with ID: ${parentFolderId}`);
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

async function scrapeLocal(url, parentFolderId) {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    $('script').remove();
    $('style').remove();
    const text = $('body').text();
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    const content = await generateText(cleanedText);
    const docLink = await createAndMoveDocument(content, url, parentFolderId);
    return { content, docLink };
  } catch (error) {
    console.log(error);
    return { content: '', docLink: null };
  }
}

async function getUrlsFromSitemap(sitemapUrl) {
  try {
    sitemapUrl = sitemapUrl.replace(/^http:\/\//i, 'https://');
    let response = await axios.get(sitemapUrl);
    const $ = cheerio.load(response.data, { xmlMode: true });
    
    const sitemapIndex = $('sitemapindex');
    if (sitemapIndex.length > 0) {
      const sitemapUrls = [];
      sitemapIndex.find('sitemap loc').each((index, element) => {
        const sitemapUrl = $(element).text();
        sitemapUrls.push(sitemapUrl);
      });

      const urls = [];
      for (const url of sitemapUrls) {
        const subUrls = await getUrlsFromSitemap(url);
        urls.push(...subUrls);
      }
      return urls;
    }

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
    if (sitemapUrl.includes('www.')) {
      try {
        sitemapUrl = sitemapUrl.replace('www.', '');
        const response = await axios.get(sitemapUrl);
        const $ = cheerio.load(response.data, { xmlMode: true });

        const urls = [];
        const maxUrls = 10; // Adjust this value as needed
        $('url loc').each((index, element) => {
          if (index >= maxUrls) return false;
          const url = $(element).text();
          urls.push(url);
        });

        return urls;
      } catch (error) {
        console.error('Error fetching sitemap without www:', error);
        return [];
      }
    }
    return [];
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/upload', upload.single('csv'), async (req, res) => {
  try {
    const results = [];
    if (req.file) {
      const filePath = req.file.path;
      const fileName = req.file.originalname.split('.').slice(0, -1).join('.');
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          results.push(row);
        })
        .on('end', async () => {
          res.send('CSV file processing done.');
          const parentFolderId = process.env.G_DRIVE_FOLDER;
          const newFolderName = fileName;
          const newFolderId = await createNewFolder(parentFolderId, newFolderName);
          if (newFolderId) {
            await makeFolderPublic(newFolderId);
            const processedResults = await processRowsInParallel(results, newFolderId);
            await uploadCsvToDrive(newFolderId, fileName, processedResults);
          } else {
            res.status(500).send('Error creating new folder.');
          }
        });
    } else {
      const { url, all_pages } = req.body;

      if (!url || !all_pages) {
        return res.status(400).send('URL and all_pages fields are required.');
      }

      const parentFolderId = process.env.G_DRIVE_FOLDER;
      const newFolderName = `Uploaded Websites - ${new Date().toISOString()}`;
      const newFolderId = await createNewFolder(parentFolderId, newFolderName);
      if (newFolderId) {
        await makeFolderPublic(newFolderId);
        const processedResults = await processRowsInParallel([{ url, all_pages }], newFolderId);
        await uploadCsvToDrive(newFolderId, `output-${new Date().toISOString()}`, processedResults);
      } else {
        res.status(500).send('Error creating new folder.');
      }
    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
});

async function processRowsInParallel(rows, parentFolderId) {
  const limit = pLimit(10); // Limit to 10 promises in parallel

  const promises = rows.map((row) => limit(async () => {
    const { url, all_pages } = row;

    if (all_pages === 'yes') {
      let pages = await getUrlsFromSitemap(`${getBaseUrl(url)}/sitemap.xml`);
      if (pages.length === 0) {
        pages = [url];
      }
      const pageTexts = await Promise.all(
        pages.map(async (page) => {
          const text = await getPageText(page);
          return convert(text, options);
        })
      );
      const content = await generateText(pageTexts.join('\n'));
      const docLink = await createAndMoveDocument(content, url, parentFolderId);
      console.log(`${url} - all pages`);
      return { ...row, doc_link: docLink };
    } else if (all_pages === 'no') {
      const { content, docLink } = await scrapeLocal(url, parentFolderId);
      return { ...row, doc_link: docLink };
    } else {
      console.log(`Invalid value for "all_pages" for URL: ${url}`);
      return { ...row, doc_link: null };
    }
  }));

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

async function uploadCsvToDrive(folderId, fileName, data) {
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  const fields = Object.keys(data[0]);
  const parser = new Parser({ fields });
  const csvContent = parser.parse(data);

  const fileMetadata = {
    name: `${fileName}.csv`,
    parents: [folderId],
  };

  const media = {
    mimeType: 'text/csv',
    body: csvContent,
  };

  try {
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    console.log(`CSV file uploaded with ID: ${file.data.id}`);
  } catch (error) {
    console.error('Error uploading CSV file:', error);
  }
}
