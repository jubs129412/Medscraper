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

    const folderId = process.env.G_DRIVE_FOLDER;

    await drive.files.update({
      fileId: documentId,
      addParents: folderId,
      removeParents: 'root',
      fields: 'id, parents',
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
    const $ = cheerio.load(response.data,
