import { EntityManager } from "@mikro-orm/sqlite";
import { Config, MediaStore } from "../types.js";
import { Queue } from "../entity/Queue.js";
import { Video } from "../entity/Video.js";
import path from "path";
import { computeSha256 } from "../utils/utils.js";
import { queueNostrUpload } from "./queue.js";

export async function doComputeSha256(video: Video, stores: MediaStore[]) {

  const store = stores.find((st) => st.id == video.store);
  if (!store || !store.path) {
    return; // skip if store is not found
  }

  const videoFullPath = path.join(store.path, video.videoPath);
  video.videoSha256 = await computeSha256(videoFullPath);

  const thumbFullPath = path.join(store.path, video.thumbPath);
  video.thumbSha256 = await computeSha256(thumbFullPath);

  const infoFullPath = path.join(store.path, video.infoPath);
  video.infoSha256 = await computeSha256(infoFullPath);
}

export async function processCreateHashesJob(
  rootEm: EntityManager,
  config: Config,
  job: Queue
) {
  const em = rootEm.fork();

  const { url: videoId } = job;

  const video = await em.findOne(Video, videoId);

  if (video == null) {
    throw new Error(`Video with ID ${videoId} not found.`);
  }
  
  await doComputeSha256(video, config.mediaStores);

  await em.persistAndFlush(video);

  // TODO validate???
  if (config.publish?.enabled) {
    await queueNostrUpload(rootEm, video.id);
  }
}
