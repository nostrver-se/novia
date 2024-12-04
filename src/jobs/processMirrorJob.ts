import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { Video } from "../entity/Video.js";
import { Queue } from "../entity/Queue.js";
import debug from "debug";
import { EventPointer } from "nostr-tools/nip19";
import { nip19, NostrEvent, SimplePool } from "nostr-tools";
import { processFile } from "../video-indexer.js";
import { createTempDir } from "../utils/utils.js";
import { downloadFromServers } from "../helpers/blossom.js";
import { mapVideoData } from "../utils/mapvideodata.js";

const logger = debug("novia:mirrorjob");

function videoMatchesFetchCriteria(videoEvent: NostrEvent, matchCriteria: string[]): boolean {
  const title = videoEvent.tags.find((t) => t[0] == "title")?.[1];
  const author = videoEvent.tags.find((t) => t[0] == "c" && t[2] == "author")?.[1];

  if (matchCriteria.length == 0) return true;

  for (const regex of matchCriteria) {
    const r = new RegExp(regex);
    if (title && title.match(r)) {
      return true;
    }
    if (author && author.match(r)) {
      return true;
    }
  }
  return false;
}

export async function processMirrorJob(rootEm: EntityManager, config: Config, job: Queue) {
  const em = rootEm.fork();
  if (!config.fetch) {
    console.error("Fetch settings are not defined in config.");
    return;
  }

  const { url: nevent } = job;

  const { id, relays } = nip19.decode(nevent).data as EventPointer;

  const pool = new SimplePool();

  const videoEvent = await pool.get(relays || config.publish?.relays || [], { ids: [id] });
  logger(videoEvent);
  if (!videoEvent) {
    logger(`Video event ${id} not found on relays ${relays}.`);
    return;
  }

  const video = await em.findOne(Video, { event: videoEvent.id });
  if (video) {
    logger(`Video for event ${id} already exists in the database. No mirroring needed.`);
    return;
  }

  logger(`Mirroring video event ${id}`);

  // check if video should be mirror (title filter, channel, pubkey of author)

  if (videoMatchesFetchCriteria(videoEvent, config.fetch.match || [])) {
    const videoData = mapVideoData(videoEvent);
    if (!videoData.x) {
      throw new Error("Video hash not found in video event.");
    }
    logger(`Downloading blob ${videoData.x}: ${videoData.title}`);

    const tempDir = createTempDir(config.download?.tempPath);

    // TODO get the blossom server from the uploader 10063, cache for 10min
    const blossomServers = config.publish?.videoUpload.map((s) => s.url) || [];
    await downloadFromServers(blossomServers, videoData.x, tempDir, `${videoData.x}.mp4`);
    if (videoData.image) {
      await downloadFromServers(blossomServers, videoData.image, tempDir, `${videoData.x}.jpg`);
    }
    if (videoData.info) {
      await downloadFromServers(blossomServers, videoData.info, tempDir, `${videoData.x}.info.json`);
    }
    const fullPath = ""; // TODO SET PATH
    await processFile(rootEm, config.mediaStores, fullPath, true);
  }

  // create a temp folder
  // download the 3 files into the temp folder
  // move to target
  // import normaly into database
  // set event id AND sha256 sums in DB
  // delete temp
}
