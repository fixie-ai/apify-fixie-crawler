import { Actor } from "apify";
import { PlaywrightCrawler } from "crawlee";
import got from "got";

await Actor.init();

const { startUrls, datasetName } = await Actor.getInput();
console.log(`Requested dataset name is ${datasetName}`);
const dataset = await Actor.openDataset(datasetName);

async function fetchUrl(url) {
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
      //content: b64Data,
      mimeType: response.headers["content-type"],
      contentLength: response.headers["content-length"],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `There was a problem with the fetch operation for ${url}: ${error}`
    );
  }
}

const crawler = new PlaywrightCrawler({
  async requestHandler({ request, page, enqueueLinks }) {
    const title = await page.title();
    console.log(`Title of ${request.loadedUrl} is '${title}'`);
    await Actor.pushData({ title, public_url: request.loadedUrl });
    await enqueueLinks();
  },

  async failedRequestHandler({ request }) {
    console.log(`MDW: Request ${request.url} failed too many times`);
  },
});

console.log(`Starting crawl with startUrls: ${startUrls}`);
await crawler.run(startUrls);
await Actor.exit();
