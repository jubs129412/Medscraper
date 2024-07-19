const axios = require('axios');
const cheerio = require('cheerio');
const Sitemapper = require('sitemapper');
const sitemap = new Sitemapper();


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
        process.send([homeUrl])
      }
  
      process.send(result)
    } catch (error) {
      console.error('Error fetching sitemap:', error);
      process.send([])
    }
  }

  process.on('message', async (sitemapUrl) => {
    await getUrlsFromSitemap(sitemapUrl);
});