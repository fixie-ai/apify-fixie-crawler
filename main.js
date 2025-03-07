/**
 * This is an Apify Actor (using the Apify v3 SDK, based on crawlee) for crawling
 * web content. It extracts the body, title, and other metadata from pages it crawls.
 * In addition, it handles PDF files by downloading the raw data and saving it as
 * base64-encoded data to the dataset.
 */

import { Actor } from "apify";
import { PlaywrightCrawler } from "crawlee";
import got from "got";

await Actor.init();

// The number of concurrent browser instances to be used in a single crawl is determined
// by these settings.
const MIN_CONCURRENCY = 4;

// The types of files for which we support simple download.
const DOWNLOAD_FILE_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "epub",
  "ppt",
  "pptx",
  "txt",
  "md",
];
const DOWNLOAD_FILE_REGEX = `\.(${DOWNLOAD_FILE_EXTENSIONS.join("|")})\$`

let {
  startUrls,
  datasetName,
  maxCrawlDepth,
  maxCrawlPages,
  includeGlobPatterns,
  excludeGlobPatterns,
} = await Actor.getInput();

// Our APIs interpret "maxDepth = 1" as "only crawl the direct source" but
// Playwright uses 0 for this meaning. This corrects the off-by-one difference.
maxCrawlDepth = Math.max(maxCrawlDepth - 1, 0);

console.log(`Requested maxCrawlDepth is ${maxCrawlDepth}`);
console.log(`Requested maxCrawlPages is ${maxCrawlPages}`);
console.log(`Requested datasetName is ${datasetName}`);
console.log(
  `Requested includeGlobPatterns is ${JSON.stringify(includeGlobPatterns)}`
);
console.log(
  `Requested excludeGlobPatterns is ${JSON.stringify(excludeGlobPatterns)}`
);

// Note: Deep inside Crawlee, the `minimatch` library is used for glob matching,
// with `{ nocase: true }` as the default options.
// https://github.com/isaacs/minimatch

if (!includeGlobPatterns || includeGlobPatterns.length == 0) {
  // Apify requires that glob patterns be non-empty, so the only way to express
  // an empty include-glob set is to set excludePatterns to "**".
  console.warn(
    'Empty includeGlobPatterns - setting excludeGlobPatterns to "**"'
  );
  excludeGlobPatterns = [{ glob: "**" }];
  // We need to set includeGlobPatterns to a nonempty value for enqueueLinks() to consider
  // excludeGlobPatterns as well.
  includeGlobPatterns = [{ glob: "unused" }];
}

const dataset = await Actor.openDataset(datasetName);

/** Download the raw file from the given URL and save to the dataset. */
async function downloadFile(crawler, url) {
  console.log(`Downloading file: ${url}`);
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
      mime_type: getMimeTypeForDownload(response, url),
      content_length: response.headers["content-length"],
      encoding: "base64",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `There was a problem with the fetch operation for ${url}: ${error}`
    );
  }
}

/**
 * Tries to determine the mime_type for a downloaded file, accounting for file-hosting sites.
 * Note that this "response" object is from got, not Playwright!
 */
function getMimeTypeForDownload(response, url) {
  const contentType = response.headers['content-type'];
  // File hosting sites often make no promises about the content of hosted files
  // by labeling them as application/octet-stream. In such cases, we try to infer
  // the intended mime type from the fileName.
  if (contentType && contentType !== 'application/octet-stream') {
    return contentType.split(';')[0];
  }
  
  const contentDisposition = response.headers['content-disposition'];
  let filename = undefined;
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="?([^";]+)"?/)
    if (match && match[1]) {
      filename = match[1];
    }
  }

  if (!filename) {
    filename = `${url}`; // Be really sure url is a string
  }

  const extension = filename.split('.').pop().toLowerCase();
  switch (extension) {
    case 'pdf': return 'application/pdf';
    case 'doc': case 'docx': return 'application/msword';
    case 'xls': case 'xlsx': return 'application/vnd.ms-excel';
    case 'ppt': case 'pptx': return 'application/vnd.ms-powerpoint';
    case 'txt': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'html': return 'text/html';
    case 'md': return 'text/markdown';
    case 'json': return 'application/json';
    case 'epub': return 'application/epub+zip';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'zip': return 'application/zip';
    case 'rar': return 'application/x-rar-compressed';
    default:
      console.log(`Failed to determine mime_type for ${url}. contentType=${contentType}, contentDisposition=${contentDisposition}, filename=${filename}, extension=${extension}`)
      return 'application/octet-stream';
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
  const header = await response.headerValue("content-language");
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

// Configure Apify proxy.
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['AUTO'],
  countryCode: 'US',
});

/** This is the main crawler. */
const crawler = new PlaywrightCrawler({
  proxyConfiguration,

  minConcurrency: MIN_CONCURRENCY,
  // Maximum number of pages to crawl.
  maxRequestsPerCrawl: maxCrawlPages,

  // This is useful for debugging.
  // preNavigationHooks: [
  //   (crawlingContext, gotoOptions) => {
  //     console.log(`Navigating to ${crawlingContext.request.url}`);
  //     console.log(`proxyInfo is ${JSON.stringify(crawlingContext.proxyInfo)}`);
  //   },
  // ],

  // This handler is called on each page navigation.
  async requestHandler({ request, response, page, enqueueLinks, proxyInfo }) {
    const state = await crawler.useState({ downloadedUrls: [] });
    if (
      state.downloadedUrls &&
      state.downloadedUrls.indexOf(request.loadedUrl) != -1
    ) {
      console.warn(`Skipping already downloaded page: ${request.loadedUrl}`);
      return;
    }

    const title = await page.title();
    if (request.url != request.loadedUrl) {
      console.log(
        `Crawled ${request.loadedUrl} (redirected from ${request.url})`
      );
    } else {
      console.log(`Crawled ${request.loadedUrl}`);
    }

    const contentType = await response.headerValue('content-type');
    const mimeType = contentType ? contentType.split(';')[0] : contentType;
    
    await dataset.pushData({
      // This *must* be the request.url (as opposed to request.loadedUrl) because we
      // need a *unique* key to ensure we load all records from the result data set.
      // While the code above attempts to deduplicate based on loadedUrls, it can't
      // account for concurrent instances. The request.url on the other hand is
      // guaranteed to be unique because Apify uses it as the request deduplication
      // key itself by default: https://crawlee.dev/api/core/class/Request
      public_url: request.url,
      title: await page.title(),
      description: await getDescription(page),
      language: await getLanguage(page, response),
      published: await getPublished(page),
      mime_type: mimeType,
      content_length: await response.headerValue('content-length'),
      content: await page.content(),
      timestamp: new Date().toISOString(),
    });
    state.downloadedUrls.push(request.loadedUrl);

    // Only follow links if we have not reached the max crawl depth.
    const curDepth = request.userData?.depth || 0;
    if (curDepth < maxCrawlDepth) {
      await enqueueLinks({
        strategy: "all",
        globs: includeGlobPatterns,
        exclude: excludeGlobPatterns,
        userData: { depth: curDepth + 1 },
      });
    } else {
      console.warn(
        `Exceeded max crawl depth ${curDepth} - not following links`
      );
    }
  },

  // This handler is called when there's an error on the headless browser navigating
  // to a URL.
  async errorHandler({ crawler, request }) {
    // If there is an error fetching a URL, it might be because the underlying
    // headless browser does not support file downloads. For now, we try to download
    // any file that might be a PDF and add it to the dataset.

    // Avoid downloading files multiple times.
    const state = await crawler.useState({ downloadedUrls: [] });
    if (
      state.downloadedUrls &&
      state.downloadedUrls.indexOf(request.url) != -1
    ) {
      console.warn(`Skipping already downloaded file: ${request.url}`);
      return;
    }
    if (request.url.match(DOWNLOAD_FILE_REGEX)) {
      await downloadFile(crawler, request.url);
      state.downloadedUrls.push(request.url);
      request.noRetry = true; // Don't retry this request.
    } else {
      console.log(`Not downloading ${request.url} becuase its extension is not whitelisted by the Fixie actor.`)
    }
  },
});

console.log(`Starting crawl with startUrls: ${JSON.stringify(startUrls)}`);
await crawler.run(startUrls);
await Actor.exit();
