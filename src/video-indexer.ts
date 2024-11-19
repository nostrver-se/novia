// src/index.ts
import chokidar from "chokidar";
import path from "path";
import { Video } from "./entity/Video.js"; // Ensure the correct path and extension
import { EntityManager } from "@mikro-orm/sqlite";
import { analyzeVideoFolder } from "./utils/ytdlp.js";
import { findStoreForFilePath, getFileStats, removeStorePathPrefixFromFilePath } from "./utils/utils.js";
import { MediaStore } from "./types.js";
import debug from "debug";
import { queueExtendMetaDataJob, queueSHAUpdateJob } from "./jobs/queue.js";
import debounce from "lodash/debounce.js";
import { readdir } from "fs/promises";

const logger = debug("novia:indexer");

export async function updateVideoMetaData(vid: Video, filePath: string, videoStore: MediaStore) {
  logger("updateVideoMetaData", vid, filePath, videoStore);
  const videoStats = await getFileStats(filePath);
  const relativePath = videoStore ? removeStorePathPrefixFromFilePath(videoStore, filePath) : filePath;

  const videoFolder = path.dirname(filePath);
  const videoFileName = path.parse(filePath).name;
  const meta = await analyzeVideoFolder(videoFolder, false, true, videoFileName);

  const inf = meta.infoData;

  // Create new Video entity and save to database
  vid.videoPath = relativePath;
  vid.store = videoStore?.id || "";
  vid.externalId = inf?.id || "";
  vid.source = inf?.extractor.toLocaleLowerCase() || "";
  vid.category = inf?.categories;
  vid.channelId = inf?.channel_id || inf?.uploader_id || inf?.uploader || "";
  vid.channelName = inf?.uploader || "";
  vid.dateDownloaded = videoStats !== undefined ? videoStats.ctime.getTime() : Date.now();
  vid.description = inf?.description || "";
  vid.mediaSize = videoStats?.size || 0;
  vid.duration = inf?.duration || 0;
  vid.published = new Date(inf?.timestamp || 0);
  vid.tags = inf?.tags;
  vid.title = inf?.title || "";
  vid.vidType = inf?._type || "video";
  vid.likeCount = inf?.like_count || 0;
  vid.viewCount = inf?.view_count || 0;
  vid.ageLimit = inf?.age_limit || 0;
  vid.width = inf?.width || 0; // TODO for twitch clips the sizes are wrong
  vid.height = inf?.height || 0;
  vid.language = inf?.language || "";

  vid.thumbPath =
    meta.thumbnailPath && videoStore ? removeStorePathPrefixFromFilePath(videoStore, meta.thumbnailPath) : "";
  vid.infoPath = meta.infoPath && videoStore ? removeStorePathPrefixFromFilePath(videoStore, meta.infoPath) : "";
}

/**
 * Processes a given file:
 * - Checks if it's an mp4 file
 * - Checks if it's already in the database
 * - If not, adds it to the database
 * @param filePath Absolute path to the file
 */
export const processFile = async (
  rootEm: EntityManager,
  stores: MediaStore[],
  filePath: string,
  triggerJobs = true,
) => {
  try {
    if (
      path.extname(filePath).toLowerCase().endsWith(".mp4") ||
      path.extname(filePath).toLowerCase().endsWith(".webm")
    ) {
      // Check if the file already exists in the database
      const em = rootEm.fork();

      const store = findStoreForFilePath(stores, filePath);
      if (!store) {
        throw new Error(`Store for video ${filePath} not found.`);
      }

      const relativePath = store ? removeStorePathPrefixFromFilePath(store, filePath) : filePath;

      const existingVideo = await em.findOne(Video, {
        videoPath: relativePath,
      });

      if (!existingVideo) {
        const vid = new Video();

        await updateVideoMetaData(vid, filePath, store);
        await em.persistAndFlush(vid);

        if (triggerJobs) {
          if (!vid.thumbPath || !vid.infoPath) {
            await queueExtendMetaDataJob(rootEm, vid.id);
          } else {
            await queueSHAUpdateJob(rootEm, vid.id);
          }
        }

        console.log(`Added new mp4 file to database: ${filePath}`);
        return vid;
      } else {
        // TODO archive job fails here without any error or notice
        logger(`File already exists in database: ${filePath}`);
      }
    }
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
  }
};

// Initialize and run the application
export const setupWatcher = async (rootEm: EntityManager, storesToWatch: MediaStore[]) => {
  try {
    const foldersToWatch = storesToWatch.filter((st) => !!st.path && st.watch).map((st) => st.path as string);

    if (foldersToWatch.length === 0) {
      console.warn("No folders to watch.");
      return;
    }

    // Define glob patterns for relevant file types
    const fileGlobs = foldersToWatch.map((folder) => path.join(folder, "*.{mp4,m4a}"));

    // Initialize chokidar watcher with optimized settings
    const watcher = chokidar.watch(fileGlobs, {
      persistent: true,
      ignoreInitial: true, // Ignore existing files
      depth: 0, // Watch only the specified directories, not subdirectories
      awaitWriteFinish: {
        stabilityThreshold: 2000, // Time in ms for a file to be considered fully written
        pollInterval: 100, // Interval in ms for polling
      },
      ignored: (filePath) => {
        const normalizedPath = path.normalize(filePath);
        const segments = normalizedPath.split(path.sep);

        // Ignore hidden directories and unwanted file types
        return segments.some((segment) => segment.startsWith(".")) || !/\.(mp4|m4a)$/.test(filePath);
      },
      // Optionally, use polling to reduce file handle usage
      // usePolling: true,
      // interval: 500,
    });

    // Debounce the processFile function to prevent rapid successive calls
    const debouncedProcessFile = debounce((filePath: string) => {
      processFile(rootEm, storesToWatch, filePath);
    }, 500); // Adjust the delay as needed

    // Listen for 'add' events (new files)
    watcher.on("add", (filePath) => {
      console.log(`New file detected: ${filePath}`);
      debouncedProcessFile(filePath);
    });

    // Handle watcher errors
    watcher.on("error", (error) => {
      console.error("Error watching folders:", error);
    });

    console.log(`Watching for new video files in: ${foldersToWatch.join(", ")} ...`);
  } catch (error) {
    console.error("Error initializing application:", error);
    process.exit(1);
  }
};

/**
 * Recursively scans a directory and processes all mp4 files,
 * ignoring hidden directories (directories starting with '.')
 * @param dirPath Absolute path to the directory
 */
export const scanDirectory = async (rootEm: EntityManager, stores: MediaStore[], dirPath: string) => {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Ignore hidden directories
      if (entry.isDirectory() && entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        await scanDirectory(rootEm, stores, fullPath);
      } else if (entry.isFile()) {
        // Process the file
        await processFile(rootEm, stores, fullPath);
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dirPath}:`, error);
  }
};
