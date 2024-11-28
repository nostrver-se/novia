#!/usr/bin/env node --no-warnings

import { Command } from "commander";
import { EntityManager, MikroORM, raw } from "@mikro-orm/sqlite";
import ormConfig from "./mikro-orm.config.js";
import { Queue } from "./entity/Queue.js";
import { formatDuration } from "./utils/utils.js";
import { Video } from "./entity/Video.js";
import { readConfigSync, validateConfig } from "./config.js";
import { scanDirectory, setupWatcher as setupNewVideoWatcher } from "./video-indexer.js";
import { Config, MediaStore } from "./types.js";
import { getPublicKey, nip19 } from "nostr-tools";
import debug from "debug";
import { startLocalServer } from "./server.js";
import { validateMissingSha256Hashes as validateHashes } from "./validation/validateHashes.js";
import { validateMetaData } from "./validation/validateMetaData.js";
import { queueAllVideosForNostrUpload, queueDownloadJob } from "./jobs/queue.js";
import { processCreateHashesJob } from "./jobs/processShaHashes.js";
import { processVideoDownloadJob } from "./jobs/processVideoDownloadJob.js";
import { processExtendMetaData } from "./jobs/processExtendMetaData.js";
import { processNostrUpload } from "./jobs/processNostrUpload.js";
import { startDVM } from "./dvm/index.js";
import { createNoviaConfig } from "./init-setup.js";

const logger = debug("novia");

const appConfig = readConfigSync();

// initialize the ORM, loading the config file dynamically
const orm = MikroORM.initSync({ ...ormConfig, dbName: appConfig.database });

let processingInterval: NodeJS.Timeout | null = null;

let inProgress = false;

export async function processJob(rootEm: EntityManager, config: Config, job: Queue) {
  const em = rootEm.fork();
  const { id, url, type } = job;
  console.log(`Processing ID: ${id}, URL: ${url}, type: ${type}`);

  job.status = "processing";
  await em.persistAndFlush(job);

  try {
    if (type == "download") {
      await processVideoDownloadJob(config, job.url);
    } else if (type == "extendmetadata") {
      await processExtendMetaData(rootEm, config, job);
    } else if (type == "createHashes") {
      await processCreateHashesJob(rootEm, config, job);
    } else if (type == "nostrUpload") {
      await processNostrUpload(rootEm, config, job);
    }

    // Update status to 'completed'
    job.status = "completed";
    job.processedAt = new Date();
    await em.persistAndFlush(job);
  } catch (error) {
    // Update status to 'failed'
    job.status = "failed";
    job.errorMessage = (error as Error).message || "";
    await em.persistAndFlush(job);

    console.error(`Failed to process ID: ${id}, URL: ${url}`, error);
  }
}

async function startQueueProcessing() {
  console.log("Starting queue processing...");

  processingInterval = setInterval(async () => {
    if (inProgress) {
      // console.log("There is a job in progress.");
      return;
    }
    inProgress = true;
    try {
      const em = orm.em.fork();
      const jobs = await em.findAll(Queue, {
        where: { status: "queued" },
        orderBy: { id: "ASC" },
        limit: 100,
      });

      for (const job of jobs) {
        await processJob(orm.em, appConfig, job);
      }
    } catch (err) {
      console.error(err);
    }
    inProgress = false;
  }, 500); // Check every second

  // Keep the process running
  process.stdin.resume();
}

async function stopProcessing() {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    console.log("Processing stopped.");
  } else {
    console.log("Processing is not running.");
  }
}


async function scanAllStoresForNewVideos(localStores: MediaStore[]) {
  for (const store of localStores) {
    if (store.path) {
      console.log(`Scanning path '${store.path}' for videos...'`);
      await scanDirectory(orm.em, localStores, store.path);
    }
  }
}

async function refreshMedia() {
  const localStores = appConfig.mediaStores.filter((s) => (s.type = "local"));

  await scanAllStoresForNewVideos(localStores);

  await validateMetaData(orm.em, localStores);

  // TODO this is dangerous when the files are missing
  // add some security checks.
  //await cleanDeletedVideos(orm.em, localStores);

  await validateHashes(orm.em, localStores);
}

const program = new Command();

program.name("queue-cli").description("CLI application for managing a job queue").version("1.0.0");

program
  .command("refresh")
  .description("Refresh the video index from disk")
  .action(async () => {
    refreshMedia();
    process.exit(0);
  });
program
  .command("init")
  .description("Create an inital novia.yaml config file")
  .action(async () => {
    await createNoviaConfig();
    process.exit(0);
  });

program
  .command("serve")
  .description("Run as a server and process downloads")
  .action(async () => {
    await validateConfig(appConfig);

    await setupNewVideoWatcher(
      orm.em,
      appConfig.mediaStores.filter((ms) => ms.type == "local"),
    );

    if (appConfig.server?.enabled) {
      startLocalServer(orm.em, appConfig.mediaStores);
    }

    await startQueueProcessing();

    // Scan for new videos and update missing content
    await refreshMedia();

    const em = orm.em.fork();
    await em.nativeDelete(Queue, { status: "completed" });

    // Uploads to blossom and local nostr relay
    if (appConfig.publish?.enabled) {
      await queueAllVideosForNostrUpload(orm.em);
    }

    await printStats();

    await startDVM(appConfig, orm.em);
  });

const queue = program.command("queue").description("Manage the job queue");

// Subcommand: queue add <url>
queue
  .command("add <url>")
  .description("Add URL to queue")
  .action(async (url) => {
    await queueDownloadJob(orm.em, url);
    process.exit(0);
  });

// Subcommand: queue ls
queue
  .command("ls")
  .description("List the contents of the queue")
  .action(async () => {
    await listQueue();
    process.exit(0);
  });

const videos = program.command("video").description("Manage videos");

// Subcommand: queue add <url>
videos
  .command("ls [text]")
  .description("List all videos")
  .action(async (text: string) => {
    await listVideos(text);
    process.exit(0);
  });

async function listQueue() {
  try {
    const em = orm.em.fork();
    const jobs = await em.findAll(Queue, { orderBy: { id: "ASC" } });

    if (jobs.length === 0) {
      console.log("The queue is empty.");
    } else {
      console.table(
        jobs.map((job) => ({
          ID: job.id,
          URL: job.url,
          Status: job.status,
          AddedAt: job.addedAt,
          ProcessedAt: job.processedAt,
        })),
      );
    }
  } catch (error) {
    console.error("Error listing the queue:", error);
  }
}

async function listVideos(seachText: string = "") {
  try {
    const em = orm.em.fork();
    const videos = await em.findAll(Video, {
      where: { title: { $like: `%${seachText}%` } },
      orderBy: { addedAt: "DESC" },
    });

    if (videos.length === 0) {
      console.log("No videos is found.");
    } else {
      console.table(
        videos.map((v) => ({
          ID: v.id,
          Store: v.store,
          URL: v.videoPath,
          Title: v.title,
          Duration: formatDuration(v.duration),
        })),
      );
    }
  } catch (error) {
    console.error("Error listing videos:", error);
  }
}

async function printStats() {
  const em = orm.em.fork();

  const res = (await em
    .createQueryBuilder(Video, "v")
    .select(["store", raw("sum(media_size)/1024.0/1024/1024 as sizeGB"), raw("count(*) as count")])
    .groupBy(["store"])
    .execute()) as { index: number; store: string; sizeGB: number; count: number }[];
  console.table(res.map((o) => ({ ...o, sizeGB: Math.floor(100 * o.sizeGB) / 100 })));
}

async function startup() {
  await orm.schema.updateSchema();
  //await orm.schema.refreshDatabase(); // ATTENTION DELETES EVERYTHING
  program.parse(process.argv);
}
startup();
/*
console.log(
  nip19.nsecEncode(
    Uint8Array.from(
      Buffer.from(
        "xxx",
        "hex"
      )
    )
  )
);
*/

if (appConfig.publish?.key) {
  const pubkeyHex = getPublicKey(nip19.decode(appConfig.publish?.key).data as Uint8Array);
  console.log(`Identity: ${nip19.npubEncode(pubkeyHex)} (Hex: ${pubkeyHex})`);
}

async function shutdown() {
  process.exit();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.once("SIGUSR2", shutdown);
