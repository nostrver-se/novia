import { EntityManager } from "@mikro-orm/sqlite";
import { MediaStore } from "../types.js";
import { Video } from "../entity/Video.js";
import path from "path";
import { promises as fs } from "fs";
import { deleteBlob } from "../helpers/blossom.js";

/**
 * Cleans up the database by removing entries for videos that no longer exist on the filesystem.
 * @param em - The MikroORM EntityManager instance.
 */
export const cleanDeletedVideos = async (rootEm: EntityManager, stores: MediaStore[]) => {
  try {
    const em = rootEm.fork();
    console.log("Starting cleanup of deleted videos...");

    // Retrieve all Video entries from the database
    const allVideos = await em.find(Video, {});

    if (allVideos.length === 0) {
      console.log("No videos found in the database to clean.");
      return;
    }

    // Array to hold videos that need to be removed
    const videosToRemove: Video[] = [];

    // Iterate over each Video entry
    for (const video of allVideos) {
      const store = stores.find((st) => st.id == video.store);
      if (!store || !store.path) {
        continue; // skip if store is not found
      }

      const fullPath = path.join(store.path, video.videoPath);
      try {
        // Check if the file exists
        await fs.access(fullPath);
        // If no error, the file exists; do nothing
      } catch (err) {
        // If an error occurs, the file does not exist
        console.log(`File not found. Removing from database: ${video.id} ${store.path} ${video.videoPath} ${fullPath}`);
        videosToRemove.push(video);
      }
    }

    if (videosToRemove.length > 0) {
      for (const video of videosToRemove) {
        // fetch event from relay (video.event)
        // TODO remove from blossom
        // deleteBlob();

        // TODO remove from NOSTR relays (delete event)
        em.remove(video);
      }

      // Remove the videos from the database
      await em.flush();
      console.log(`Removed ${videosToRemove.length} video(s) from the database.`);
    } else {
      console.log("No deleted videos found. Cleanup complete.");
    }
  } catch (error) {
    console.error("Error during cleanup of deleted videos:", error);
  }
};
