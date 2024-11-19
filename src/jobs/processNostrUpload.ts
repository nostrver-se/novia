import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { Video } from "../entity/Video.js";
import { Queue } from "../entity/Queue.js";
import path from "path";
import { BlobDescriptor, uploadFile } from "../helpers/blossom.js";
import { EventTemplate, finalizeEvent, nip19, SimplePool } from "nostr-tools";
import debug from "debug";
import { AddressPointer } from "nostr-tools/nip19";
import { getMimeTypeByPath } from "../utils/utils.js";

const logger = debug("novia:nostrupload");

function createOriginalWebUrl(video: Video) {
  if (video.source == "youtube") {
    return `https://www.youtube.com/watch?v=${video.externalId}`;
  }

  if (video.source == "tiktok") {
    return `https://www.tiktok.com/@${video.channelName}/video/${video.externalId}`;
  }

  if (video.source == "twitter") {
    return ``;
  }
  // TODO add more
  return ``;
}

export function createTemplateVideoEvent(video: Video, thumbBlobs: BlobDescriptor[]): EventTemplate {
  const videoBlobUrl = "http://localhost:9090/" + video.videoSha256 + ".mp4"; // TODO only for local demo

  const url =
    video.videoPath.endsWith(".mp4") || video.videoPath.endsWith(".webm") ? videoBlobUrl : videoBlobUrl + ".mp4"; // TODO fix for other formats

  const thumbUrls = thumbBlobs.map((thumbBlob) =>
    thumbBlob.url.endsWith(".webp") || thumbBlob.url.endsWith(".jpg") ? thumbBlob.url : thumbBlob.url + ".webp",
  ); // TODO fix for other formats;

  const imeta = [
    "imeta",
    `dim ${video.width}x${video.height}`,
    `url ${url}`,
    `x ${video.videoSha256}`,
    `m video/mp4`, // TODO extract from extension or add to DB
  ];
  for (let i = 0; i < thumbUrls.length; i++) {
    imeta.push(`image ${thumbUrls[i]}`);
  }

  const event = {
    created_at: Math.floor(Date.now() / 1000), // TODO should this be today / now?
    kind: video.width >= video.height ? 34235 : 34236,
    tags: [
      ["d", `${video.source}-${video.externalId}`],
      ["url", url], // deprecated
      ["x", video.videoSha256], // deprecated
      ["title", video.title],
      ["summary", video.description], // deprecated
      ["alt", video.description], // deprecated
      ["published_at", `${video.published.getTime()}`],
      ["client", "nostr-video-archive"],
      ["m", "video/mp4"], // TODO fix for other formats
      ["size", `${video.mediaSize}`],
      ["duration", `${video.duration}`],
      ["c", video.channelName, "author"],
      ["c", video.source, "source"],
      imeta,
      ["r", createOriginalWebUrl(video)],
      ...(video.tags || []).map((tag) => ["t", tag]),
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

  const store = config.mediaStores.find((st) => st.id == video.store);
  if (!store || !store.path) {
    return; // skip if store is not found
  }

  const fullPath = path.join(store.path, video.thumbPath);
  const blossomServers = config.publish.blossomThumbnails;
  const thumbBlobs: BlobDescriptor[] = [];

  for (const blossomServer of blossomServers) {
    console.log(`Uploading ${fullPath} to ${blossomServer}`);

    try {
      const thumbBlob = await uploadFile(
        fullPath,
        blossomServer,
        getMimeTypeByPath(path.extname(video.thumbPath)),
        path.basename(video.thumbPath),
        "Upload Thumbnail",
        secretKey,
        video.thumbSha256, // optional
      );
      thumbBlobs.push(thumbBlob);
    } catch (err) {
      console.log(err);
    }
  }

  if (thumbBlobs.length == 0) {
    throw new Error(`Failed uploading thumbnails for video ${video.id}`);
  }

  const event = createTemplateVideoEvent(video, thumbBlobs);
  const signedEvent = finalizeEvent({ ...event }, secretKey);
  logger(signedEvent);

  const pool = new SimplePool();

  console.log(`Publishing video ${video.id} to NOSTR ${config.publish.relays.join(", ")}`);

  const data = await Promise.allSettled(pool.publish(config.publish.relays, signedEvent));
  const identifier = signedEvent.tags.find((t) => t[0] == "d")![1];
  logger(data);
  return {
    naddr: {
      identifier,
      pubkey: signedEvent.pubkey,
      relays: config.publish.relays,
      kind: signedEvent.kind,
    } as AddressPointer,
    eventId: signedEvent.id,
  };
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
