import { Actor } from "apify";
import { PlaywrightCrawler } from "crawlee";
import got from "got";

await Actor.init();

const {
  startUrls,
  datasetName,
  maxCrawlDepth,
  maxCrawlPages,
  includeGlobPatterns,
  excludeGlobPatterns,
} = await Actor.getInput();

// TODO(mdw): Respect maxCrawlDepth and maxCrawlPages.
console.log(`Requested maxCrawlDepth is ${maxCrawlDepth}`);
console.log(`Requested maxCrawlPages is ${maxCrawlPages}`);
console.log(`Requested datasetName is ${datasetName}`);
console.log(`Requested includeGlobPatterns is ${includeGlobPatterns}`);
console.log(`Requested excludeGlobPatterns is ${excludeGlobPatterns}`);

const dataset = await Actor.openDataset(datasetName);

/** Download the raw file from the given URL and save to the dataset. */
async function downloadFile(url) {
  console.log(`Downloading file: ${url}`);
  const state = await crawler.useState({ downloadedFiles: Set });
  if (state.downloadedFiles.has(url)) {
    console.log(`Skipping already downloaded file: ${url}`);
    return;
  }
  try {
    const response = await got(url);
    if (!response || !response.ok) {
      throw new Error(`Error fetching ${url}: ${response}`);
    }
    const rawData = response.rawBody;
    const b64Data = rawData.toString("base64");
    console.log(`Successfully downloaded ${url}: ${rawData.length} bytes`);
    await dataset.pushData({
      public_url: url,
      content: b64Data,
      mimeType: response.headers["content-type"],
      contentLength: response.headers["content-length"],
      timestamp: new Date().toISOString(),
    });
    state.downloadedFiles.add(url);
  } catch (error) {
    console.error(
      `There was a problem with the fetch operation for ${url}: ${error}`
    );
  }
}

/** Return the value of the given meta tag. */
async function getMetaTag(page, name) {
  try {
    return await page.$eval(
      `meta[name="${name}"]`,
      (element) => element.content
    );
  } catch (e) {}
  return undefined;
}

/** Get metadata description for this page. */
async function getDescription(page) {
  return (
    getMetaTag(page, "description") ||
    getMetaTag(page, "og:description") ||
    getMetaTag(page, "twitter:description")
  );
}

/** Get language for this page. */
async function getLanguage(page, response) {
  const header = await response.headers["content-language"];
  const htmlTagLang = await page.$eval("html", (element) => element.lang);
  return (
    header ||
    htmlTagLang ||
    getMetaTag("og:locale") ||
    getMetaTag("docusaurus_locale") ||
    getMetaTag("docsearch:language")
  );
}

/** Get publication date of this page. */
async function getPublished(page) {
  return (
    getMetaTag(page, "article:published_time") ||
    getMetaTag(page, "book:release_date")
  );
}

/** Get the MIME type of this response. */
async function getMimeType(response) {
  return await response.headers["content-type"];
}

/** This is the main crawler. */
const crawler = new PlaywrightCrawler({
  // This handler is called on each page navigation.
  async requestHandler({ request, response, page, enqueueLinks }) {
    const title = await page.title();
    console.log(`Crawled ${request.loadedUrl}`);
    await Actor.pushData({
      title,
      public_url: request.loadedUrl,
      title: await page.title(),
      description: await getDescription(page),
      language: await getLanguage(page, response),
      published: await getPublished(page),
      mime_type: await getMimeType(response),
      content: await page.content(),
    });

    await enqueueLinks({
      globs: includeGlobPatterns,
      exclude: excludeGlobPatterns,
    });
  },

  // This handler is called when there's an error on the headless browser navigating
  // to a URL.
  async errorHandler({ request }) {
    // If there is an error fetching a URL, it might be because the underlying
    // headless browser does not support file downloads. For now, we try to download
    // any file that might be a PDF and add it to the dataset.
    if (request.url.match(/\.pdf$/)) {
      await downloadFile(request.url);
      request.noRetry = true; // Don't retry this request.
    }
  },
});

console.log(`Starting crawl with startUrls: ${startUrls}`);
await crawler.run(startUrls);
await Actor.exit();
