import { EntityManager } from "@mikro-orm/sqlite";
import { MediaStore } from "../types.js";
import { Video } from "../entity/Video.js";
import { queueExtendMetaDataJob } from "../jobs/queue.js";

export const validateMetaData = async (
    rootEm: EntityManager,
    stores: MediaStore[]
  ) => {
    const em = rootEm.fork();
    console.log("Checking for missing metadata...");
  
    // Retrieve all Video entries from the database
    const metaMissing = await em.findAll(Video, {
      where: {
        $or: [{ infoPath: { $eq: "" } }, { thumbPath: { $eq: "" } }],
      },
    });
  
    if (metaMissing.length === 0) {
      console.log("No videos found in the database to clean.");
      return;
    }
  
    for (const video of metaMissing) {
       await queueExtendMetaDataJob(rootEm, video.id);
    }
    await em.flush();
  };
  