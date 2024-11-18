import { EntityManager } from "@mikro-orm/sqlite";
import { queueSHAUpdateJob } from "../jobs/queue.js";
import { Video } from "../entity/Video.js";
import { MediaStore } from "../types.js";

export const validateMissingSha256Hashes = async (
  rootEm: EntityManager,
  stores: MediaStore[]
) => {
  const em = rootEm.fork();

  // Retrieve all Video entries from the database
  const allVideos = await em.findAll(Video, {
    where: {
      $or: [
        {
          $and: [{ videoSha256: { $eq: "" } }, { videoPath: { $ne: "" } }],
        },
        { $and: [{ infoSha256: { $eq: "" } }, { infoPath: { $ne: "" } }] },
        {
          $and: [{ thumbSha256: { $eq: "" } }, { thumbPath: { $ne: "" } }],
        },
      ],
    },
  });

  if (allVideos.length === 0) {
    console.log(`No missing hashes to compute.`);
    return;
  }

  console.log(
    `Starting computing of hashes for (${allVideos.length} files) ...`
  );

  for (const video of allVideos) {
    await queueSHAUpdateJob(rootEm, video.id);
  }
};
