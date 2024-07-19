const { google } = require('googleapis');
const express = require('express');
const https = require('https');     
const GetSitemapLinks = require("get-sitemap-links").default;
const Sitemapper = require('sitemapper');
const sitemap = new Sitemapper();
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const { fork } = require('child_process');
const axios = require('axios').create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});
//const cheerio = require('cheerio');
const cheerio = require('whacko');
const multer = require('multer');
const { OpenAI } = require('openai');
const { convert } = require('html-to-text');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
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
  console.log("testing?");
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

    const lines = content.split('\n');
    const requests = [];

    let index = 1; // Start index at 1 to avoid the initial section break

    for (const line of lines) {
      let request = null;
      if (line.startsWith('#### ')) {
        request = {
          insertText: {
            location: {
              index: index,
            },
            text: line.replace('#### ', '') + '\n',
          },
        };
        requests.push(request);
        index += line.replace('#### ', '').length + 1;

        request = {
          updateParagraphStyle: {
            range: {
              startIndex: index - (line.replace('#### ', '').length + 1),
              endIndex: index,
            },
            paragraphStyle: {
              namedStyleType: 'HEADING_4',
            },
            fields: 'namedStyleType',
          },
        };
      } else if (line.startsWith('### ')) {
        request = {
          insertText: {
            location: {
              index: index,
            },
            text: line.replace('### ', '') + '\n',
          },
        };
        requests.push(request);
        index += line.replace('### ', '').length + 1;

        request = {
          updateParagraphStyle: {
            range: {
              startIndex: index - (line.replace('### ', '').length + 1),
              endIndex: index,
            },
            paragraphStyle: {
              namedStyleType: 'HEADING_3',
            },
            fields: 'namedStyleType',
          },
        };
      } else {
        request = {
          insertText: {
            location: {
              index: index,
            },
            text: line + '\n',
          },
        };
        requests.push(request);
        index += line.length + 1;
      }
      requests.push(request);
    }

    await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: {
        requests: requests,
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
const logMemoryUsage = () => {
  const memoryUsage = process.memoryUsage();
  console.log('Memory Usage:');
  console.log(`RSS: ${memoryUsage.rss / 1024 / 1024} MB`);
  console.log(`Heap Total: ${memoryUsage.heapTotal / 1024 / 1024} MB`);
  console.log(`Heap Used: ${memoryUsage.heapUsed / 1024 / 1024} MB`);
  console.log(`External: ${memoryUsage.external / 1024 / 1024} MB`);
  console.log(`Array Buffers: ${memoryUsage.arrayBuffers / 1024 / 1024} MB`);
};

async function generateText(text) {
  console.log("begin generate!")
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt + text }],
      model: process.env.GPT_MODEL,
    });
    console.log("generate complete!")
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.log(error);
    return '';
  }
}

async function scrapeLocal(url, parentFolderId) {
  let response = null;
  let $ = null;
  let cleanedText = null;

  try {
    response = await axios.get(url);
    $ = cheerio.load(response.data);

    // Remove script and style tags
    $('script').remove();
    $('style').remove();

    // Extract text from the body and clean it up
    const text = $('body').text();
    cleanedText = text.replace(/\s+/g, ' ').trim();

    // Extract specific content using cheerio selectors
    const content = Array.from($("h1, h2, h3, h4, h5, h6, p")).map((x) => $(x).text()).join('\n');
    const generatedText = await generateText(content);
    console.log("generate complete after call!")

    // Create and move the document
    const docLink = await createAndMoveDocument(generatedText, url, parentFolderId);

    // Clear the cheerio root
    $.root().empty();

    return { content: generatedText, docLink };
  } catch (error) {
    console.log(error);

    if ($) {
      $.root().empty();
    }

    return { content: '', docLink: null };
  } finally {
    // Clear references to potentially large objects
    response = null;
    $ = null;
    cleanedText = null;
  }
}


async function getUrlsFromSitemap(sitemapUrl) {
  let urls = [];
  try {
    let array = await sitemap.fetch(sitemapUrl);
    array = array.sites;
    console.log(array);

    // Function to check if URL contains certain words
    const containsForbiddenWords = url => {
      const forbiddenWords = ['mp4', 'mp3', 'png', 'jpg', 'jpeg'];
      for (const word of forbiddenWords) {
        if (url.includes(word)) {
          return true;
        }
      }
      return false;
    };

    for (const url of array) {
      // Check if the URL contains forbidden words
      if (!containsForbiddenWords(url)) {
        urls.push(url);
      }
    }

    // Return the 10 most recent URLs if there are more than 10
    const result = urls.slice(0, 10);
    console.log(result);

    // Clear memory by setting arrays to null when done
    array = null;
    urls = null;
    if (global.gc) {
      console.log("cleaning")
      global.gc();
      global.gc();
      global.gc();
      global.gc();
      global.gc();
      console.log("cleaned")
    }

    // Wait for 500ms to ensure garbage collection has taken place
    await new Promise(resolve => setTimeout(resolve, 500));
    // Return home URL if no valid URLs are found
    if (result.length === 0) {
      const homeUrl = new URL(sitemapUrl).origin;
      console.log([homeUrl]);
      return [homeUrl];
    }

    return result;
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
            console.log("postproc")
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
 
  const limit = pLimit(2); 

  const promises = rows.map((row) => limit(async () => {
    const { url, all_pages } = row;

    if (all_pages === 'yes') {
      let pages = await getUrlsFromSitemap(`${getBaseUrl(url)}/sitemap.xml`);
      if (pages.length === 0) {
        pages = [url];
      }
      
      let pageTexts = [];

      for (const [index, page] of pages.entries()) {
        console.log(`Running getPageText for index: ${index}`);
        try {
          const text = await getPageText(page);
          console.log(text);
          pageTexts.push(text);
        } catch (error) {
          console.error(`Failed to get text for ${page} at index ${index}`, error);
        }
      }
      logMemoryUsage();

      console.log("heap beofre")
      if (pageTexts.join('\n').length > 100){
        pageTexts = pageTexts.join('\n')
        console.log("heap")
      var content = await generateText(pageTexts);
      console.log("generate complete pre doclink!")
      logMemoryUsage();
      var docLink = await createAndMoveDocument(content, url, parentFolderId);
      
    }
    else {
      console.log(pageTexts.join('\n'))
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


async function isMedia(url) {
  try {
    const response = await axios.head(url);
    const contentType = response.headers['content-type'];
    console.log(contentType);
    return contentType.toLowerCase().startsWith('text/html');
  } catch (error) {
    console.error('Error checking media type:', error);
    return false;
  }
}
function getPageText(url) {
  return new Promise((resolve, reject) => {
    const worker = fork('./worker.js');
      
    worker.on('message', async (pageText) => {
      resolve(pageText);
      worker.kill();
      global.gc();global.gc();global.gc();global.gc();global.gc();
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    worker.on('error', async (error) => {
      worker.kill();
      global.gc();global.gc();global.gc();global.gc();global.gc();
      await new Promise(resolve => setTimeout(resolve, 500));
      return ''; // Returning an empty string on rejection
    });

    worker.on('exit', async (code) => {
      if (code !== 0) {
        global.gc();global.gc();global.gc();global.gc();global.gc();
        await new Promise(resolve => setTimeout(resolve, 500));
        return ''; // Returning an empty string on rejection
      }
    });

    worker.send(url);
  });
}
async function getPageText2(url) {
  try {
    console.log(url)
    logMemoryUsage();
    if ((await isMedia(url))) {
      const response = await axios.get(url, { responseType: 'text' });
      console.log("Page received, response size:", response.data.length);

      const responseSizeInMB = response.data.length / (1024 * 1024);
      logMemoryUsage();

      if (responseSizeInMB > 5) {
        console.log(`Page size exceeds 5MB (${responseSizeInMB.toFixed(2)} MB). Returning empty string.`);
        return '';
      }
      logMemoryUsage();

      console.log("page recieved")
      const dom = new JSDOM(response.data, {
        runScripts: 'outside-only',
        resources: 'usable',
        virtualConsole: new jsdom.VirtualConsole().sendTo(console, { omitJSDOMErrors: true }),
        beforeParse(window) {
          window.document.addEventListener('DOMContentLoaded', () => {
            const links = window.document.querySelectorAll('link[rel="stylesheet"], style');
            links.forEach(link => link.parentNode.removeChild(link));
            window.close();
          });
        },
      }).window.document;
      console.log('presave')
      return Array.from(dom.querySelectorAll("h1, h2, h3, h4, h5, h6, p")).map((x) => x.textContent).join('\n');
    } else {
      console.log(`The URL points to a media file. ${url}`);
      return '';
    }
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
