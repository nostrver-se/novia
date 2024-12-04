#!/usr/bin/env node
import { NostrEvent, Filter, nip04, SimplePool, getPublicKey } from "nostr-tools";
import { listBlobs, deleteBlob } from "../helpers/blossom.js";
import { Subscription } from "nostr-tools/abstract-relay";
import { getInput, getInputParam, getInputParams } from "../helpers/dvm.js";
import debug from "debug";
import { Config, PublishConfig } from "../types.js";
import { decode } from "nostr-tools/nip19";
import { EntityManager } from "@mikro-orm/sqlite";
import {
  DVM_VIDEO_ARCHIVE_REQUEST_KIND,
  DVM_VIDEO_RECOVER_REQUEST_KIND as DVM_VIDEO_RECOVER_REQUEST_KIND,
  HORIZONZAL_VIDEO_KIND,
  JobContext,
  ONE_HOUR_IN_MILLISECS,
  VERTICAL_VIDEO_KIND,
} from "./types.js";
import { doWorkForRecover } from "./recover.js";
import { mergeServers, now } from "../utils/utils.js";
import { doWorkForArchive } from "./archive.js";
import { queueMirrorJob } from "../jobs/queue.js";
import { unique } from "../utils/array.js";

const pool = new SimplePool();

const logger = debug("novia:dvm");

const subscriptions: { [key: string]: Subscription } = {};

const filters: Filter[] = [
  {
    kinds: [DVM_VIDEO_ARCHIVE_REQUEST_KIND, DVM_VIDEO_RECOVER_REQUEST_KIND, HORIZONZAL_VIDEO_KIND, VERTICAL_VIDEO_KIND],
    since: now() - 60,
  },
]; // look 60s back

async function shouldAcceptJob(request: NostrEvent): Promise<JobContext> {
  const input = getInput(request);

  if (input.type === "event" && request.kind == DVM_VIDEO_RECOVER_REQUEST_KIND) {
    const x = getInputParam(request, "x");
    const target = getInputParams(request, "target");
    return { type: "recover", x, eventId: input.value, relay: input.relay, target, request, wasEncrypted: false };
  } else if (input.type === "url" && request.kind == DVM_VIDEO_ARCHIVE_REQUEST_KIND) {
    // TODO check allowed URLs (regexs in config?)
    return { type: "archive", url: input.value, request, wasEncrypted: false };
  } else throw new Error(`Unknown input type ${input.type} ${request.kind}`);
}

async function doWork(context: JobContext, config: Config, rootEm: EntityManager) {
  if (context.type == "archive") {
    await doWorkForArchive(context, config, rootEm);
  } else if (context.type == "recover") {
    await doWorkForRecover(context, config, rootEm);
  }
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
      if (event.kind === DVM_VIDEO_ARCHIVE_REQUEST_KIND || event.kind === DVM_VIDEO_RECOVER_REQUEST_KIND) {
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
      if (event.kind === HORIZONZAL_VIDEO_KIND || event.kind === VERTICAL_VIDEO_KIND) {
        if (config.fetch?.enabled) {
          const relays = config.publish?.relays || []; // TODO use read/inbox relays
          queueMirrorJob(rootEm, event, relays);
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
        console.error(e);
        logger(`Skipped request ${event.id} because`, e.message);
      }
    }
  }
}

async function ensureSubscriptions(config: Config, rootEm: EntityManager) {
  const relays = unique([...(config.publish?.relays || []), ...(config.fetch?.relays || [])]); // TODO use read/inbox relays vs outbox/publish relays
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
  const uploadServers = mergeServers(...publishConfig.videoUpload.map((s) => s.url), ...publishConfig.thumbnailUpload);

  for (const server of uploadServers) {
    const blobs = await listBlobs(server, pubkey, secretKey); // TODO add from/until to filter by timestamp

    const serverConfig = publishConfig.videoUpload.find((s) => s.url.startsWith(server));
    if (serverConfig?.cleanUpMaxAgeDays !== undefined) {
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

    // TODO stats for all blossom servers, maybe groups for images/videos
    const storedSize = blobs.reduce((prev, val) => prev + val.size, 0);
    console.log(
      `Currently stored ${blobs.length} blobs in ${Math.floor((100 * storedSize) / 1024 / 1024 / 1024) / 100} GB on ${server}.`,
    );
  }
}

export async function startDVM(config: Config, rootEm: EntityManager) {
  if (!config.publish?.enabled) {
    logger("DVM Publishing is not enabled.");
    return;
  }

  await cleanupBlobs(config.publish);
  setInterval(() => config.publish && cleanupBlobs(config.publish), ONE_HOUR_IN_MILLISECS);

  await ensureSubscriptions(config, rootEm);
  setInterval(() => ensureSubscriptions(config, rootEm), 30_000); // Ensure connections every 30s
}
