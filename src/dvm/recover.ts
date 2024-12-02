import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { DVM_VIDEO_UPLOAD_RESULT_KIND, FIVE_DAYS_IN_SECONDS, ONE_DAY_IN_SECONDS, RecoverJobContext } from "./types.js";
import debug from "debug";
import { decode, npubEncode } from "nostr-tools/nip19";
import { findFullPathsForVideo, formatDuration, getMimeTypeByPath, mergeServers, now } from "../utils/utils.js";
import { Video } from "../entity/Video.js";
import { publishStatusEvent } from "./publish.js";
import { uploadFile } from "../helpers/blossom.js";
import path from "path";
import { ensureEncrypted, getInputTag, getRelays } from "../helpers/dvm.js";
import { finalizeEvent, SimplePool } from "nostr-tools";
import { unique } from "../utils/array.js";
import { buildRecoverResult } from "../jobs/results.js";

const logger = debug("novia:dvm:recover");

let uploadSpeed = 2 * 1024 * 1024;

export async function doWorkForRecover(context: RecoverJobContext, config: Config, rootEm: EntityManager) {
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

  const uploadServers = mergeServers(...config.publish.videoUpload.map((s) => s.url), ...context.target);

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
        async (percentCompleted, speedMBs) => {
          const msg = `Upload to ${server}: ${percentCompleted.toFixed(2)}% done at ${speedMBs.toFixed(2)}MB/s`;
          logger(msg);
          if (!config.publish?.secret) {
            await publishStatusEvent(context, "partial", JSON.stringify({ msg }), [], secretKey, relays);
          }
        },
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
    try {
      const infoBlob = await uploadFile(
        fullPaths.infoPath,
        server,
        getMimeTypeByPath(fullPaths.infoPath),
        path.basename(fullPaths.infoPath),
        "Upload info json",
        secretKey,
        video.infoSha256,
      );
      logger(`Uploaded info json file: ${infoBlob.url}`);
    } catch (err) {
      const msg = `Upload of info json to ${server} failed.`;
      console.error(msg, err);
    }
  }

  if (!config.publish.secret) {
    const resultEvent = {
      kind: DVM_VIDEO_UPLOAD_RESULT_KIND,
      tags: [
        ["request", JSON.stringify(context.request)],
        ["e", context.request.id],
        ["p", context.request.pubkey],
        getInputTag(context.request),
        ["expiration", `${now() + FIVE_DAYS_IN_SECONDS}`],
      ],
      content: JSON.stringify(buildRecoverResult(video)),
      created_at: now(),
    };

    const event = await ensureEncrypted(secretKey, resultEvent, context.request.pubkey, context.wasEncrypted);
    const result = finalizeEvent(event, secretKey);

    // TODO add DVM error events for exeptions

    logger("Will publish event: ", result);

    const pool = new SimplePool();
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
