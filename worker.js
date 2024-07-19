const axios = require('axios');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

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

function logMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  console.log(`Memory Usage: RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB, Heap Total: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB, Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
}

async function getPageText(url) {
  try {
    console.log(url);
    logMemoryUsage();
    if (await isMedia(url)) {
      const response = await axios.get(url, { responseType: 'text' });
      console.log("Page received, response size:", response.data.length);

      const responseSizeInMB = response.data.length / (1024 * 1024);
      logMemoryUsage();

      if (responseSizeInMB > 5) {
        console.log(`Page size exceeds 5MB (${responseSizeInMB.toFixed(2)} MB). Returning empty string.`);
        process.send('');
        return;
      }
      logMemoryUsage();

      console.log("Page received");
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
      console.log('presave');
      const pageText = Array.from(dom.querySelectorAll("h1, h2, h3, h4, h5, h6, p")).map((x) => x.textContent).join('\n');
      process.send(pageText);
    } else {
      console.log(`The URL points to a media file. ${url}`);
      process.send('');
    }
  } catch (error) {
    console.error('Error retrieving page text:', error);
    process.send('');
  }
}

process.on('message', async (url) => {
  await getPageText(url);
});
