import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { ArchiveJobContext, DVM_VIDEO_ARCHIVE_RESULT_KIND, ONE_DAY_IN_SECONDS } from "./types.js";
import { decode } from "nostr-tools/nip19";
import debug from "debug";
import { publishStatusEvent } from "./publish.js";
import { processVideoDownloadJob } from "../jobs/processVideoDownloadJob.js";
import { processFile } from "../video-indexer.js";
import { doComputeSha256 } from "../jobs/processShaHashes.js";
import { doNostrUploadForVideo } from "../jobs/processNostrUpload.js";
import { ensureEncrypted, getInputTag, getRelays } from "../helpers/dvm.js";
import { finalizeEvent, SimplePool } from "nostr-tools";
import { unique } from "../utils/array.js";
import { now } from "../utils/utils.js";

const logger = debug("novia:dvm:archive");

export async function doWorkForArchive(context: ArchiveJobContext, config: Config, rootEm: EntityManager) {
  const secretKey = decode(config.publish?.key || "").data as Uint8Array;
  const relays = config.publish?.relays || [];

  const msg = `Starting archive download job for ${context.url}`;
  logger(msg);

  if (!config.download?.secret) {
    await publishStatusEvent(context, "processing", JSON.stringify({ msg }), [], secretKey, relays);
  }

  try {
    const targetVideoPath = await processVideoDownloadJob(config, context.url, false, async (dl) => {
      const msg = `Download in progress: ${dl.percentage}% done at ${dl.speedMiBps}MB/s`;
      logger(msg);
      if (!config.download?.secret) {
        await publishStatusEvent(context, "partial", JSON.stringify({ msg }), [], secretKey, relays);
      }
    });
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
            ["expiration", `${now() + ONE_DAY_IN_SECONDS}`],
          ],
          content: JSON.stringify(nostrResult),
          created_at: now(),
        };

        logger(resultEvent);

        const event = await ensureEncrypted(secretKey, resultEvent, context.request.pubkey, context.wasEncrypted);
        const result = finalizeEvent(event, secretKey);

        const pool = new SimplePool();

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
