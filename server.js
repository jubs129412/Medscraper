const { google } = require('googleapis');
const express = require('express');
const https = require('https');     
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios').create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});
//const cheerio = require('cheerio');
const cheerio = require('whacko');
const multer = require('multer');
const { OpenAI } = require('openai');
const { convert } = require('html-to-text');
const { Parser } = require('json2csv');
const pLimit = require('p-limit');
require('dotenv').config();
const MAX_RECURSION_DEPTH = 5;

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

async function retryWithBackoff(fn, retries = 5, delay = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      const waitTime = delay * Math.pow(2, i);
      console.warn(`Retrying in ${waitTime / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
}

async function createNewFolder(parentFolderId, folderName) {
  const createFolder = async () => {
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
  };

  try {
    return await retryWithBackoff(createFolder);
  } catch (error) {
    console.error('Error creating folder:', error);
    return null;
  }
}

async function makeFolderPublic(folderId) {
  const makePublic = async () => {
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
  };

  try {
    await retryWithBackoff(makePublic);
  } catch (error) {
    console.error('Error making folder public:', error);
  }
}

async function createAndMoveDocument(content, url, parentFolderId) {
  const createDocument = async () => {
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
  };

  try {
    return await retryWithBackoff(createDocument);
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
    $.root().empty();
    return { content, docLink };
  } catch (error) {
    console.log(error);
    $.root().empty();
    $ = null; // Nullify Cheerio object
  response = null; // Nullify axios response object
  cleanedText = null; // Nullify cleaned text variable
    return { content: '', docLink: null };
  }
}


async function getUrlsFromSitemap(sitemapUrl) {
  let urls = [];
  let stack = [sitemapUrl];
  const mediaContentTypes = ['image/', 'video/', 'audio/'];
  let processedSitemaps = new Set();

  while (stack.length > 0 && urls.length < 10) {
    const currentUrl = stack.pop();

    try {
      const response = await axios.get(currentUrl);

      const $ = cheerio.load(response.data, { xmlMode: true });

      if ($('sitemapindex').length > 0) {
        $('sitemapindex sitemap loc').each((index, element) => {
          const subSitemapUrl = $(element).text();
          if (!processedSitemaps.has(subSitemapUrl)) {
            stack.push(subSitemapUrl);
            processedSitemaps.add(subSitemapUrl);
          }
        });
      } else {
        $('url loc').each(async (index, element) => {
          if (urls.length >= 10) return false;
          const url = $(element).text();
          if (!(await isMediaUrl(url, mediaContentTypes))) {
            urls.push(url);
          }
        });
      }
    } catch (error) {
      console.error('Error fetching or processing sitemap:', error);
    }
  }

  console.log(urls);
  return urls;
}

async function isMediaUrl(url, mediaContentTypes) {
  try {
    const response = await axios.head(url);
    const contentType = response.headers['content-type'];
    return mediaContentTypes.some(type => contentType.startsWith(type));
  } catch (error) {
    console.error('Error checking content type:', error);
    return false; // Treat as non-media URL if there's an error
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
      res.send('url processing.');

      const parentFolderId = process.env.G_DRIVE_FOLDER;
      //const newFolderName = `${url}`;
      //const newFolderId = await createNewFolder(parentFolderId, newFolderName);
        //await makeFolderPublic(newFolderId);
        const processedResults = await processRowsInParallel([{ url, all_pages }], parentFolderId);
        //await uploadCsvToDrive(parentFolderId, `output-${new Date().toISOString()}`, processedResults);

    }
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Internal Server Error');
  }
});

async function processRowsInParallel(rows, parentFolderId) {
  const limit = pLimit(3); 

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
      if (pageTexts.join('\n').length > 100){
      var content = await generateText(pageTexts.join('\n'));
      var docLink = await createAndMoveDocument(content, url, parentFolderId);
      
    }
    else {
      console.log("content too short! not adding")
    }
      

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
  const uploadCsv = async () => {
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

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    console.log(`CSV file uploaded with ID: ${file.data.id}`);
  };

  try {
    await retryWithBackoff(uploadCsv);
  } catch (error) {
    console.error('Error uploading CSV file:', error);
  }
}
