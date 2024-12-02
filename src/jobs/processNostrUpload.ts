import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { Video } from "../entity/Video.js";
import { Queue } from "../entity/Queue.js";
import path from "path";
import { BlobDescriptor, uploadFile } from "../helpers/blossom.js";
import { EventTemplate, finalizeEvent, nip19, SimplePool } from "nostr-tools";
import debug from "debug";
import { findFullPathsForVideo, getMimeTypeByPath } from "../utils/utils.js";
import { buildArchiveResult } from "./results.js";

const logger = debug("novia:nostrupload");

function createOriginalWebUrl(video: Video) {
  if (video.source == "youtube") {
    return `https://www.youtube.com/watch?v=${video.externalId}`;
  }

  if (video.source == "tiktok") {
    return `https://www.tiktok.com/@${video.channelName}/video/${video.externalId}`;
  }

  if (video.source == "twitter") {
    return ``; // TODO fix?
  }
  // TODO add more
  return ``;
}

export function createTemplateVideoEvent(video: Video, thumbBlobs: BlobDescriptor[]): EventTemplate {
  const thumbUrls = thumbBlobs.map((thumbBlob) =>
    thumbBlob.url.endsWith(".webp") || thumbBlob.url.endsWith(".jpg") ? thumbBlob.url : thumbBlob.url + ".webp",
  ); // TODO fix for other formats;

  const videoMimeType = getMimeTypeByPath(video.videoPath);

  const imeta = [
    "imeta",
    `dim ${video.width}x${video.height}`,
    `x ${video.videoSha256}`,
    `m ${videoMimeType}`, // TODO extract from extension or add to DB
  ];
  for (let i = 0; i < thumbUrls.length; i++) {
    imeta.push(`image ${thumbUrls[i]}`);
  }

  const event = {
    created_at: Math.floor(Date.now() / 1000), // TODO should this be today / now?
    kind: video.width >= video.height ? 34235 : 34236,
    tags: [
      ["d", `${video.source}-${video.externalId}`],
      ["x", video.videoSha256], // deprecated
      ["title", video.title],
      ["summary", video.description], // deprecated
      ["alt", video.description], // deprecated
      ["published_at", `${video.published.getTime()}`],
      ["client", "nostr-video-archive"],
      ["m", videoMimeType],
      ["size", `${video.mediaSize}`],
      ["duration", `${video.duration}`],
      ["c", video.channelName, "author"], // TODO check if c or l tag is better
      ["c", video.source, "source"], // TODO check if c or l tag is better
      imeta,
      ["r", createOriginalWebUrl(video)],
      ...(video.tags || []).map((tag) => ["t", tag]),
      ["client", "novia"],
      ["info", video.infoSha256], // non standard field - but there is not great way to store the info json data.
    ],
    content: video.title,
  };

  if (video.language) {
    event.tags.push(["l", video.language, "ISO-639-1"]);
  }

  for (let i = 0; i < thumbUrls.length; i++) {
    event.tags.push(["thumb", thumbUrls[i]]); // deprecated?
    event.tags.push(["image", thumbUrls[i]]); // deprecated?
  }

  if (video.ageLimit >= 18) {
    event.tags.push(["content-warning", `NSFW adult content`]);
  }

  return event;
}

export async function doNostrUploadForVideo(video: Video, config: Config) {
  if (!config.publish) {
    console.error("Publish settings are not defined in config.");
    return;
  }

  const secretKey = nip19.decode(config.publish.key).data as Uint8Array;

  const fullPaths = findFullPathsForVideo(video, config.mediaStores);
  if (!fullPaths) {
    console.error("Could not resolve the full paths for the video. " + video.id);
    return;
  }

  const thumbnailServers = config.publish.thumbnailUpload;
  const thumbBlobs: BlobDescriptor[] = [];

  for (const blossomServer of thumbnailServers) {
    console.log(`Uploading ${fullPaths.thumbPath} to ${blossomServer}`);

    try {
      const thumbBlob = await uploadFile(
        fullPaths.thumbPath,
        blossomServer,
        getMimeTypeByPath(path.extname(video.thumbPath)),
        path.basename(video.thumbPath),
        "Upload Thumbnail",
        secretKey,
        video.thumbSha256,
      );
      thumbBlobs.push(thumbBlob);
    } catch (err) {
      console.log(err);
    }

    console.log(`Uploading ${fullPaths.infoPath} to ${blossomServer}`);

    try {
      const infoBlob = await uploadFile(
        fullPaths.infoPath,
        blossomServer,
        getMimeTypeByPath(path.extname(video.infoPath)),
        path.basename(video.infoPath),
        "Upload info json",
        secretKey,
        video.infoSha256,
      );
      console.log(infoBlob);
    } catch (err) {
      console.log(err);
    }
  }

  if (thumbBlobs.length == 0) {
    throw new Error(`Failed uploading thumbnails for video ${video.id}`);
  }

  if (config.publish.autoUpload && config.publish.autoUpload.enabled) {
    if (video.mediaSize < config.publish.autoUpload.maxVideoSizeMB * 1024 * 1024) {
      const videoServers = config.publish.videoUpload;

      for (const blossomServer of videoServers) {
        if (video.mediaSize < blossomServer.maxUploadSizeMB * 1024 * 1024) {
          console.log(`Uploading video ${fullPaths.videoPath} to ${blossomServer}`);

          try {
            const videoBlob = await uploadFile(
              fullPaths.videoPath,
              blossomServer.url,
              getMimeTypeByPath(path.extname(video.videoPath)),
              path.basename(video.videoPath),
              "Upload video",
              secretKey,
              video.videoSha256,
            );
            console.log(videoBlob);
          } catch (err) {
            console.log(err);
          }
        } else {
          logger.log(`Skipping upload to ${blossomServer.url} due to size limit <${blossomServer.maxUploadSizeMB}MB`);
        }
      }
    } else {
      logger.log(`Skippin auto publishing: ${JSON.stringify(config.publish.autoUpload)}`);
    }
  }

  const event = createTemplateVideoEvent(video, thumbBlobs);
  const signedEvent = finalizeEvent({ ...event }, secretKey);
  logger(signedEvent);

  const pool = new SimplePool();

  console.log(`Publishing video ${video.id} to NOSTR ${config.publish.relays.join(", ")}`);

  const data = await Promise.allSettled(pool.publish(config.publish.relays, signedEvent));
  logger(data);
  return buildArchiveResult(signedEvent, config.publish.relays, video);
}

export async function processNostrUpload(rootEm: EntityManager, config: Config, job: Queue) {
  const em = rootEm.fork();
  if (!config.publish) {
    console.error("Publish settings are not defined in config.");
    return;
  }

  const { url: videoId } = job;

  const video = await em.findOne(Video, videoId);
  if (video == null) {
    throw new Error(`Video with ID ${videoId} not found.`);
  }

  const result = await doNostrUploadForVideo(video, config);

  if (result && result.eventId) {
    video.event = result.eventId;
    em.persistAndFlush(video);
  }
}
