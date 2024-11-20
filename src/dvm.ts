#!/usr/bin/env node
import { NostrEvent, Filter, finalizeEvent, nip04, EventTemplate, SimplePool, getPublicKey } from "nostr-tools";
import { listBlobs, uploadFile, deleteBlob } from "./helpers/blossom.js";
import path from "path";
import { Subscription } from "nostr-tools/abstract-relay";
import { getInput, getInputParam, getInputParams, getInputTag, getOutputType, getRelays } from "./helpers/dvm.js";
import { unique } from "./utils/array.js";
import debug from "debug";
import { Config, PublishConfig } from "./types.js";
import { decode, npubEncode } from "nostr-tools/nip19";
import { EntityManager } from "@mikro-orm/sqlite";
import { Video } from "./entity/Video.js";
import { findFullPathsForVideo, formatDuration, getMimeTypeByPath } from "./utils/utils.js";
import { processVideoDownloadJob } from "./jobs/processVideoDownloadJob.js";
import { processFile } from "./video-indexer.js";
import { doComputeSha256 } from "./jobs/processShaHashes.js";
import { doNostrUploadForVideo } from "./jobs/processNostrUpload.js";

export const DVM_STATUS_KIND = 7000;

export const DVM_VIDEO_ARCHIVE_REQUEST_KIND = 5205;
export const DVM_VIDEO_ARCHIVE_RESULT_KIND = 6205;

export const BLOSSOM_AUTH_KIND = 24242;

export const pool = new SimplePool();

interface BaseJobContext {
  request: NostrEvent;
  wasEncrypted: boolean;
}

// Subtype for "archive"
export interface ArchiveJobContext extends BaseJobContext {
  type: "archive";
  url: string;
}

// Subtype for "upload"
export interface UploadJobContext extends BaseJobContext {
  type: "upload";
  x: string;
  eventId: string;
  target: string[];
}

// Union type
export type JobContext = ArchiveJobContext | UploadJobContext;

let uploadSpeed = 2 * 1024 * 1024;

const logger = debug("novia:dvm");

const now = () => Math.floor(new Date().getTime() / 1000);

async function shouldAcceptJob(request: NostrEvent): Promise<JobContext> {
  const input = getInput(request);

  if (input.type === "event" && input.marker == "upload") {
    const x = getInputParam(request, "x");
    const target = getInputParams(request, "target");
    return { type: "upload", x, eventId: input.value, target, request, wasEncrypted: false };
  } else if (input.type === "url" && input.marker == "archive") {
    // TODO check allowed URLs (regexs in config?)
    return { type: "archive", url: input.value, request, wasEncrypted: false };
  } else throw new Error(`Unknown input type ${input.type} ${input.marker}`);
}

export async function publishStatusEvent(
  context: JobContext,
  status: "payment-required" | "processing" | "error" | "success" | "partial",
  data = "",
  additionalTags: string[][] = [],
  secretKey: Uint8Array,
  relays: string[],
) {
  const tags = [
    ["status", status],
    ["e", context.request.id],
    ["p", context.request.pubkey],
  ];
  tags.push(...additionalTags);

  const statusEvent = {
    kind: DVM_STATUS_KIND, // DVM Status
    tags,
    content: data,
    created_at: now(),
  };
  logger("statusEvent", statusEvent);

  // const event = await ensureEncrypted(resultEvent, context.request.pubkey, context.wasEncrypted);
  const result = finalizeEvent(statusEvent, secretKey);

  await Promise.all(
    pool.publish(unique([...getRelays(context.request), ...relays]), result).map((p) => p.catch((e) => {})),
  );
}

const mergeServers = (...aBunchOfServers: string[]) => {
  return unique(aBunchOfServers.filter((s) => !!s).map((s) => s.replace(/\/$/, "")));
};

async function doWorkForArchive(context: ArchiveJobContext, config: Config, rootEm: EntityManager) {
  const secretKey = decode(config.publish?.key || "").data as Uint8Array;
  const relays = config.publish?.relays || [];

  const msg = `Starting archive download job for ${context.url}`;
  logger(msg);

  if (!config.download?.secret) {
    publishStatusEvent(context, "processing", JSON.stringify({ msg }), [], secretKey, relays);
  }

  try {
    const targetVideoPath = await processVideoDownloadJob(config, context.url);
    logger(targetVideoPath);

    if (!config.download?.secret) {
      publishStatusEvent(
        context,
        "partial",
        JSON.stringify({ msg: "Download finished. Processing and uploading to NOSTR..." }),
        [],
        secretKey,
        relays,
      );
    }

    if (!targetVideoPath) {
      throw new Error("Download of video has failed.");
    }
    const video = await processFile(rootEm, config.mediaStores, targetVideoPath, false);

    if (video) {
      await doComputeSha256(video, config.mediaStores);
      const nostrResult = await doNostrUploadForVideo(video, config);

      if (!nostrResult) {
        throw new Error("Could not create nostr video event");
      }

      video.event = nostrResult?.eventId;
      const em = rootEm.fork();
      em.persistAndFlush(video);

      if (!config.download?.secret) {
        const resultEvent = {
          kind: DVM_VIDEO_ARCHIVE_RESULT_KIND,
          tags: [
            ["request", JSON.stringify(context.request)],
            ["e", context.request.id],
            ["p", context.request.pubkey],
            getInputTag(context.request),
          ],
          content: JSON.stringify(nostrResult),
          created_at: now(),
          // TODO add expiration tag when request had an expiration tag
        };

        logger(resultEvent);

        const event = await ensureEncrypted(secretKey, resultEvent, context.request.pubkey, context.wasEncrypted);
        const result = finalizeEvent(event, secretKey);

        const pubRes = await Promise.all(
          pool
            .publish(unique([...getRelays(context.request), ...(config.publish?.relays || [])]), result)
            .map((p) => p.catch((e) => {})),
        );
        logger(pubRes);
      }
    }
  } catch (e) {
    const msg = "Download from the video source failed.";
    publishStatusEvent(context, "error", JSON.stringify({ msg }), [], secretKey, relays);
    console.error(msg, e);
  }
}

async function doWorkForUpload(context: UploadJobContext, config: Config, rootEm: EntityManager) {
  if (!config.publish) {
    throw new Error("publish config not found.");
  }
  logger(`Starting work for ${context.request.id}`);
  const secretKey = decode(config.publish?.key || "").data as Uint8Array;
  const relays = config.publish?.relays || [];

  const startTime = now();

  const em = rootEm.fork();
  const video = await em.findOne(Video, { videoSha256: context.x });

  if (!video) {
    logger(`Requested video not found in database. Ignoring the request. eventID: ${context.eventId} x: ${context.x}`);
    return; // End processing
  }

  const fullPaths = findFullPathsForVideo(video, config.mediaStores);

  if (!fullPaths) {
    if (!config.publish.secret) {
      await publishStatusEvent(
        context,
        "error",
        JSON.stringify({ msg: "Requested video found in database but the file is currently not available." }),
        [],
        secretKey,
        relays,
      );
    }

    return;
  }

  if (!config.publish.secret) {
    await publishStatusEvent(
      context,
      "processing",
      JSON.stringify({
        msg: `Starting video upload. Estimated time ${formatDuration(Math.floor(video?.mediaSize / uploadSpeed))}...`,
      }),
      [],
      secretKey,
      relays,
    );
  }
  const { videoPath, thumbPath } = fullPaths;

  const uploadServers = mergeServers(...config.publish.videoUpload.map(s=>s.url), ...context.target);

  console.log(
    `Request for video ${video.id} by ${npubEncode(context.request.pubkey)}. Uploading to ${uploadServers.join(", ")}`,
  );

  for (const server of uploadServers) {
    const resultTags: string[][] = [];
    try {
      const videoBlob = await uploadFile(
        fullPaths.videoPath,
        server,
        getMimeTypeByPath(fullPaths.videoPath),
        path.basename(fullPaths.videoPath),
        "Upload Video",
        secretKey,
        video.videoSha256,
      );
      logger(`Uploaded video file: ${videoBlob.url}`);
    } catch (err) {
      const msg = `Upload of video to ${server} failed.`;
      console.error(msg, err);

      if (!config.publish.secret) {
        await publishStatusEvent(
          context,
          "error",
          JSON.stringify({
            msg,
          }),
          [],
          secretKey,
          relays,
        );
      }
    }
    try {
      const thumbBlob = await uploadFile(
        fullPaths.thumbPath,
        server,
        getMimeTypeByPath(fullPaths.thumbPath),
        path.basename(fullPaths.thumbPath),
        "Upload Thumbnail",
        secretKey,
        video.thumbSha256,
      );
      logger(`Uploaded thumbnail file: ${thumbBlob.url}`);
    } catch (err) {
      const msg = `Upload of tumbnails to ${server} failed.`;
      console.error(msg, err);
    }
  }

  if (!config.publish.secret) {
    const resultEvent = {
      kind: DVM_VIDEO_ARCHIVE_RESULT_KIND,
      tags: [
        ["request", JSON.stringify(context.request)],
        ["e", context.request.id],
        ["p", context.request.pubkey],
        getInputTag(context.request),
      ],
      content: "",
      created_at: now(),
      // TODO add expiration tag when request had an expiration tag
    };

    const event = await ensureEncrypted(secretKey, resultEvent, context.request.pubkey, context.wasEncrypted);
    const result = finalizeEvent(event, secretKey);

    // TODO add DVM error events for exeptions

    logger("Will publish event: ", result);

    await Promise.all(
      pool
        .publish(unique([...getRelays(context.request), ...(config.publish?.relays || [])]), result)
        .map((p) => p.catch((e) => {})),
    );
  }

  const endTime = now();

  if (endTime - startTime > 2) {
    // min. 2s download to get good data
    uploadSpeed = Math.floor(uploadSpeed * 0.3 + (0.7 * video.mediaSize) / (endTime - startTime));
    logger(`Setting upload speed to ${uploadSpeed} bytes/s`);
  }
  logger(`${`Finished work for ${context.request.id} in ` + (endTime - startTime)} seconds`);
}

async function doWork(context: JobContext, config: Config, rootEm: EntityManager) {
  if (context.type == "archive") {
    await doWorkForArchive(context, config, rootEm);
  } else if (context.type == "upload") {
    await doWorkForUpload(context, config, rootEm);
  }
}

async function ensureEncrypted(
  secretKey: Uint8Array,
  event: EventTemplate,
  recipentPubKey: string,
  wasEncrypted: boolean,
) {
  if (!wasEncrypted) return event;

  const tagsToEncrypt = event.tags.filter((t) => t[0] !== "p" && t[0] !== "e");
  const encText = await nip04.encrypt(secretKey, recipentPubKey, JSON.stringify(tagsToEncrypt));

  return {
    ...event,
    content: encText,
    tags: (event.tags = [...event.tags.filter((t) => t[0] == "e"), ["p", recipentPubKey], ["encrypted"]]),
  };
}

async function ensureDecrypted(secretKey: Uint8Array, event: NostrEvent) {
  const encrypted = event.tags.some((t) => t[0] == "encrypted");
  if (encrypted) {
    const encryptedTags = await nip04.decrypt(secretKey, event.pubkey, event.content);
    return {
      wasEncrypted: true,
      event: {
        ...event,
        tags: event.tags.filter((t) => t[0] !== "encrypted").concat(JSON.parse(encryptedTags)),
      },
    };
  }
  return { wasEncrypted: false, event };
}

const seenEvents = new Set<string>();

async function handleEvent(event: NostrEvent, config: Config, rootEm: EntityManager) {
  const secretKey = decode(config.publish?.key || "").data as Uint8Array;

  if (!seenEvents.has(event.id)) {
    try {
      seenEvents.add(event.id);
      if (event.kind === DVM_VIDEO_ARCHIVE_REQUEST_KIND) {
        const { wasEncrypted, event: decryptedEvent } = await ensureDecrypted(secretKey, event);
        const context = await shouldAcceptJob(decryptedEvent);
        context.wasEncrypted = wasEncrypted;
        try {
          await doWork(context, config, rootEm);
        } catch (e) {
          if (e instanceof Error) {
            logger(`Failed to process request ${decryptedEvent.id} because`, e.message);
            console.log(e);
          }
        }
      }
      /*
      if (event.kind === kinds.GiftWrap) {
        const dmEvent = unwrapGiftWrapDM(event);
        await processPaymentAndRunJob(dmEvent.pubkey, dmEvent.content);
      }
        */
    } catch (e) {
      if (e instanceof Error) {
        logger(`Skipped request ${event.id} because`, e.message);
      }
    }
  }
}

const subscriptions: { [key: string]: Subscription } = {};

const filters: Filter[] = [{ kinds: [DVM_VIDEO_ARCHIVE_REQUEST_KIND], since: now() - 60 }]; // look 60s back

async function ensureSubscriptions(config: Config, rootEm: EntityManager) {
  const relays = config.publish?.relays || [];
  logger(
    `ensureSubscriptions`,
    JSON.stringify(Object.entries(subscriptions).map(([k, v]) => ({ k, closed: v.closed }))),
  );
  for (const url of relays) {
    const existing = subscriptions[url];

    if (!existing || existing.closed) {
      if (existing?.closed) {
        logger(`Reconnecting to ${url}`);
      }
      delete subscriptions[url];
      try {
        const relay = await pool.ensureRelay(url);
        const sub = relay.subscribe(filters, {
          onevent: (e) => handleEvent(e, config, rootEm),
          onclose: () => {
            logger("Subscription to", url, "closed");
            if (subscriptions[url] === sub) delete subscriptions[url];
          },
        });

        logger("Subscribed to", url);
        subscriptions[url] = sub;

        logger(
          `subscriptions after set`,
          JSON.stringify(Object.entries(subscriptions).map(([k, v]) => ({ k, closed: v.closed }))),
        );
      } catch (error: any) {
        logger("Failed to reconnect to", url, error.message);
        delete subscriptions[url];
      }
    }
  }
}

async function cleanupBlobs(publishConfig: PublishConfig) {
  const secretKey = decode(publishConfig.key || "").data as Uint8Array;
  const pubkey = getPublicKey(secretKey);
  const uploadServers = mergeServers(...publishConfig.videoUpload.map(s=>s.url), ...publishConfig.thumbnailUpload);

  for (const server of uploadServers) {
    const blobs = await listBlobs(server, pubkey, secretKey); // TODO add from/until to filter by timestamp

    const serverConfig = publishConfig.videoUpload.find(s=>s.url.startsWith(server));
    if (serverConfig?.cleanUpMaxAgeDays) {
      const videoBlobCutoffSizeLimit = (serverConfig?.cleanUpKeepSizeUnderMB || 0) * 1024 * 1024;
      const videoBlobCutoffAgeLimit = now() - 60 * 60 * 24 * serverConfig.cleanUpMaxAgeDays;
      const videoBlobCutoffMimeType = "video/mp4";
  
      for (const blob of blobs) {
        if (
          blob.created < videoBlobCutoffAgeLimit &&
          blob.size > videoBlobCutoffSizeLimit &&
          blob.type == videoBlobCutoffMimeType
        ) {
          // delete >2MB videos
          logger(`Deleting expired blob ${blob.url}`);
          await deleteBlob(server, blob.sha256, secretKey);
        }
      }
  
    }


    // TODO stats for all blossom servers, maybe group for images/videos
    const storedSize = blobs.reduce((prev, val) => prev + val.size, 0);
    logger(`Currently stored ${Math.floor((100 * storedSize) / 1024 / 1024 / 1024) / 100} GB on ${server}.`);
  }
}

export async function startDVM(config: Config, rootEm: EntityManager) {
  if (!config.publish?.enabled) {
    logger("DVM Publishing is not enabled.");
    return;
  }

  await cleanupBlobs(config.publish);
  setInterval(() => config.publish && cleanupBlobs(config.publish), 60 * 60 * 1000); // Clean up blobs every hour

  await ensureSubscriptions(config, rootEm);
  setInterval(() => ensureSubscriptions(config, rootEm), 30_000); // Ensure connections every 30s

  async function shutdown() {
    process.exit();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.once("SIGUSR2", shutdown);
}

// console.log(nip19.nsecEncode(NOSTR_PRIVATE_KEY));
