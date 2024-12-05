import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { Video } from "../entity/Video.js";
import { Queue } from "../entity/Queue.js";
import debug from "debug";
import { EventPointer } from "nostr-tools/nip19";
import { nip19, NostrEvent, SimplePool } from "nostr-tools";
import { processFile } from "../video-indexer.js";
import { createTempDir } from "../utils/utils.js";
import { downloadFromServers, getHashFromURL } from "../helpers/blossom.js";
import { mapVideoData } from "../utils/mapvideodata.js";
import uniq from "lodash/uniq.js";
import { analyzeVideoFolder } from "../utils/ytdlp.js";
import { moveFilesToTargetFolder } from "./processVideoDownloadJob.js";
import { rmSync } from "fs";

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
  logger(`starting processMirrorJob`);

  const em = rootEm.fork();
  if (!config.fetch) {
    console.error("Fetch settings are not defined in config.");
    return;
  }
  if (!config.download) {
    console.error("Download settings are not defined in config.");
    return;
  }

  const { url: nevent } = job;

  const { id, relays } = nip19.decode(nevent).data as EventPointer;

  const pool = new SimplePool();

  const effectiveRelays = uniq([...(relays || []), ...(config.fetch?.relays || []), ...(config.publish?.relays || [])]);
  logger(`Looking for video event ${nevent} on ${effectiveRelays?.join(", ")}`);

  const videoEvent = await pool.get(effectiveRelays, { ids: [id] });
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
    const blossomServers = uniq(
      [...(config.fetch.blossom || []), ...(config.publish?.videoUpload.map((s) => s.url) || [])].map((s) =>
        s.replace(/\/$/, ""),
      ),
    );
    await downloadFromServers(blossomServers, videoData.x, tempDir, `${videoData.x}.mp4`);

    const imageHash = videoData.image && getHashFromURL(videoData.image);
    if (imageHash) {
      await downloadFromServers(blossomServers, imageHash, tempDir, `${videoData.x}.jpg`);
    } else {
      logger(`Could not find sha265 hash in url ${videoData.image}`);
    }

    if (videoData.info) {
      await downloadFromServers(blossomServers, videoData.info, tempDir, `${videoData.x}.info.json`);
    }

    const download = await analyzeVideoFolder(tempDir, false, false);

    const { targetFolder, targetVideoPath } = await moveFilesToTargetFolder(
      config.mediaStores,
      config.download,
      download,
      false,
    );

    if (!targetVideoPath) {
      throw Error("Error finding the stored video. " + targetVideoPath);
    }

    // remove the temp dir
    rmSync(download.folder, { recursive: true });

    console.log(`Downloaded content saved to ${targetFolder}`);

    await processFile(rootEm, config.mediaStores, targetVideoPath, false, (video) => {
      video.event = id;
      if (imageHash) {
        video.thumbSha256 = imageHash;
      }
      if (videoData.x) {
        video.videoSha256 = videoData.x;
      }
      if (videoData.info) {
        video.infoSha256 = videoData.info;
      }
    });
  }
}
