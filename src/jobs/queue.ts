import { EntityManager } from "@mikro-orm/sqlite";
import debug from "debug";
import { Queue } from "../entity/Queue.js";
import { Video } from "../entity/Video.js";
import { nip19, NostrEvent } from "nostr-tools";

const logger = debug("novia:queue");

export async function queueDownloadJob(rootEm: EntityManager, url: string) {
  logger("addToQueue function called");
  try {
    const em = rootEm.fork();

    const exitingJob = await em.findAll(Queue, {
      where: {
        $and: [{ type: "download" }, { status: "queued" }, { url }],
      },
    });

    if (exitingJob.length == 0) {
      const job = new Queue();
      job.url = url;
      job.owner = "local";
      job.type = "download";
      em.persist(job);
      await em.flush();
      console.log(`Added URL to queue: ${url}`);
    }
  } catch (error) {
    console.error("Error adding URL to queue:", error);
  }
}

export async function queueExtendMetaDataJob(rootEm: EntityManager, videoId: string) {
  const em = rootEm.fork();
  try {
    const exitingJob = await em.findAll(Queue, {
      where: {
        $and: [{ type: "extendmetadata" }, { status: "queued" }, { url: videoId }],
      },
    });

    if (exitingJob.length == 0) {
      const q = new Queue();
      q.owner = "local";
      q.status = "queued";
      q.type = "extendmetadata";
      q.url = videoId;
      await em.persistAndFlush(q);
    }
  } catch (error) {
    console.error("Error adding extend meta job to queue:", error);
  }
}

export async function queueSHAUpdateJob(rootEm: EntityManager, videoId: string) {
  const em = rootEm.fork();
  try {
    const exitingJob = await em.findAll(Queue, {
      where: {
        $and: [{ type: "createHashes" }, { status: "queued" }, { url: videoId }],
      },
    });

    if (exitingJob.length == 0) {
      const q = new Queue();
      q.owner = "local";
      q.status = "queued";
      q.type = "createHashes";
      q.url = videoId;
      await em.persistAndFlush(q);
    }
  } catch (error) {
    console.error("Error adding extend meta job to queue:", error);
  }
}

export async function queueNostrUpload(rootEm: EntityManager, videoId: string) {
  const em = rootEm.fork();
  try {
    const exitingJob = await em.findAll(Queue, {
      where: {
        $and: [{ type: "nostrUpload" }, { status: "queued" }, { url: videoId }],
      },
    });

    if (exitingJob.length == 0) {
      const q = new Queue();
      q.owner = "local";
      q.status = "queued";
      q.type = "nostrUpload";
      q.url = videoId;
      await em.persistAndFlush(q);
    }
  } catch (error) {
    console.error("Error adding nostr upload job to queue:", error);
  }
}

export async function queueAllVideosForNostrUpload(rootEm: EntityManager) {
  const em = rootEm.fork();

  const videos = await em.findAll(Video, {
    where: {
      $and: [
        { thumbPath: { $ne: "" } },
        { thumbSha256: { $ne: "" } },
        { title: { $ne: "" } },
        { event: { $eq: "" } }, // Skip when the event already has been published.
      ],
    },
  });

  // TODO check somehow which have already been uploaded!?!?!
  for (const video of videos) {
    await queueNostrUpload(rootEm, video.id);
  }
}

export async function queueMirrorJob(rootEm: EntityManager, nevent: string ) {
  logger("queueMirrorJob function called");
  try {
    const em = rootEm.fork();

    const exitingJob = await em.findAll(Queue, {
      where: {
        $and: [{ type: "mirrorVideo" }, { status: "queued" }, { url: nevent }],
      },
    });

    if (exitingJob.length == 0) {
      const job = new Queue();
      job.url = nevent;
      job.owner = "local";
      job.type = "mirrorVideo";
      em.persist(job);
      await em.flush();
      console.log(`Added mirror job to queue for: ${nevent}`);
    }
  } catch (error) {
    console.error("Error mirror job to queue:", error);
  }
}
