const { parentPort } = require('worker_threads');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const { convert } = require('html-to-text');
const { OpenAI } = require('openai');
require('dotenv').config();

const options = { wordwrap: 130 };

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

async function getUrlsFromSitemap(sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl);
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
    const maxUrls = 10;
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

async function createAndMoveDocument(content, url) {
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
      requestBody: { title: url },
    });

    const documentId = docCreationResponse.data.documentId;

    await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text: content } }],
      },
    });

    const folderId = process.env.G_DRIVE_FOLDER;

    await drive.files.update({
      fileId: documentId,
      addParents: folderId,
      removeParents: 'root',
      fields: 'id, parents',
    });

    return `https://docs.google.com/document/d/${documentId}`;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

async function processRow(row) {
  const { url, all_pages } = row;

  if (all_pages === 'yes') {
    const pages = await getUrlsFromSitemap(`${getBaseUrl(url)}/sitemap.xml`);
    const pageTexts = await Promise.all(pages.map(async (page) => {
      const text = await getPageText(page);
      return convert(text, options);
    }));
    const content = await generateText(pageTexts.join('\n'));
    const docLink = await createAndMoveDocument(content, url);
    return { ...row, doc_link: docLink };
  } else if (all_pages === 'no') {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    $('script').remove();
    $('style').remove();
    const text = $('body').text();
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    const content = await generateText(cleanedText);
    const docLink = await createAndMoveDocument(content, url);
    return { ...row, doc_link: docLink };
  } else {
    return { ...row, doc_link: null };
  }
}

function getBaseUrl(websiteUrl) {
  const parsedUrl = new URL(websiteUrl);
  return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
}

parentPort.on('message', async (row) => {
  const result = await processRow(row);
  parentPort.postMessage(result);
});
