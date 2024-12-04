import { EntityManager } from "@mikro-orm/sqlite";
import { Config } from "../types.js";
import { Queue } from "../entity/Queue.js";
import { Video } from "../entity/Video.js";
import { downloadYoutubeVideo } from "../utils/ytdlp.js";
import debug from "debug";
import path from "path";
import { rmSync } from "fs";
import { updateVideoMetaData } from "../video-indexer.js";
import { move } from "../utils/move.js";
import { queueSHAUpdateJob } from "./queue.js";
import { removeFieldsFromJson } from "../utils/utils.js";

const logger = debug("novia:processExtendMetaData");

export function extractDownloadUrlFromVideoPath(videoPath: string, source?: string): string | undefined {
  if (source == undefined || source == "youtube") {
    const youtubeId = path.parse(videoPath).name;
    return "https://www.youtube.com/watch?v=" + youtubeId;
  }
  return;
}

export async function processExtendMetaData(rootEm: EntityManager, config: Config, job: Queue) {
  const em = rootEm.fork();

  const { url: videoId } = job;

  const video = await em.findOne(Video, videoId);

  if (video == null) {
    throw new Error(`Video with ID ${videoId} not found.`);
  }

  const url = extractDownloadUrlFromVideoPath(video.videoPath);

  if (url == undefined) {
    throw new Error(`Could not extract download url from path '${video.videoPath}'.`);
  }

  if (config.download == undefined) {
    throw new Error(`Download config is not defined.`);
  }

  logger("Downloading additional meta data (info/thumb) for " + url);

  const download = await downloadYoutubeVideo(url, true, config.download);

  if (!download.infoPath || !download.infoData) {
    throw new Error("Required files not found in the temporary directory.");
  }

  await removeFieldsFromJson(download.infoPath, [
    "thumbnails",
    "formats",
    "automatic_captions",
    "heatmap",
  ]);

  const videoStore = config.mediaStores.find((ms) => ms.type == "local" && ms.id == video.store);
  if (!videoStore || !videoStore.path) {
    throw new Error(`Store for video ${videoId} not found.`);
  }

  const targetFolder = path.join(videoStore.path, path.parse(video.videoPath).dir);

  if (download.infoPath && !video.infoPath) {
    const targetInfoPath = path.join(targetFolder, `${path.parse(video.videoPath).name}.info.json`);
    logger(`move`, download.infoPath, targetInfoPath);
    await move(download.infoPath, targetInfoPath);
  }

  if (download.thumbnailPath && !video.thumbPath) {
    const targetThumbPath = path.join(
      targetFolder,
      `${path.parse(video.videoPath).name}${path.extname(download.thumbnailPath)}`,
    );
    logger(`move`, download.thumbnailPath, targetThumbPath);
    await move(download.thumbnailPath, targetThumbPath);
  }

  // remove the temp dir
  rmSync(download.folder, { recursive: true });

  await updateVideoMetaData(video, path.join(videoStore.path, video.videoPath), videoStore);

  await em.persistAndFlush(video);

  if (video.thumbPath && video.infoPath) {
    await queueSHAUpdateJob(rootEm, video.id);
  } else {
    console.warn("Thumbail or info.json still not found after extendMetaData for video " + video.id);
  }
}
