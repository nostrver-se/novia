import { readFile, stat, writeFile } from "fs/promises";
import path, { parse, resolve } from "path";
import { MediaStore } from "../types.js";
import fsx from "fs-extra";
import { exec } from "child_process";
import util from "util";
import debug from "debug";
import { Video } from "../entity/Video.js";

const logger = debug("novia:utils");

// Promisify exec for use with async/await
const execPromise = util.promisify(exec);

/**
 * Removes specified fields from each object in a JSON array and saves it back to the same file.
 * @param {string} filePath - The path to the JSON file.
 * @param {string[]} fieldsToRemove - An array of field names to remove from each object.
 */
export async function removeFieldsFromJson(filePath: string, fieldsToRemove: string[]) {
  try {
    // Resolve the absolute path
    const absolutePath = resolve(filePath);

    // Read the JSON file
    const data = await readFile(absolutePath, "utf-8");

    // Parse the JSON data
    let jsonObject = JSON.parse(data);

    // Iterate over each object and remove the specified fields

    fieldsToRemove.forEach((field) => {
      if (field in jsonObject) {
        delete jsonObject[field];
      }
    });

    // Convert the modified array back to JSON string with indentation for readability
    const modifiedData = JSON.stringify(jsonObject, null, 2);

    // Write the modified JSON back to the same file
    await writeFile(absolutePath, modifiedData, "utf-8");
  } catch (error) {
    console.error(`Error processing the file`, error);
  }
}

export function getFileStats(filePath: string) {
  try {
    const jsonFilePath = resolve(filePath);

    const stats = fsx.statSync(jsonFilePath, {});

    return stats;
  } catch (error) {
    console.error("Error getting file stats:", error);
  }
}

export function findStoreForFilePath(stores: MediaStore[], filePath: string): MediaStore | undefined {
  return stores.find((st) => st.type == "local" && st.path && filePath.startsWith(st.path.replace(/^\.\//, "")));
}

export function findFullPathsForVideo(video: Video, stores: MediaStore[]) {
  const store = stores.find((st) => st.id == video.store);
  if (!store || !store.path) {
    return undefined; // store not found
  }

  const videoPath = path.join(store.path, video.videoPath);
  const thumbPath = path.join(store.path, video.thumbPath);
  const infoPath = path.join(store.path, video.infoPath);

  return { videoPath, thumbPath, infoPath };
}

export function removeStorePathPrefixFromFilePath(store: MediaStore, filePath: string): string {
  if (!store.path) return filePath;

  // remove the ./ prefix for relative paths
  let storePath = store.path.replace(/^\.\//, "");

  // Add a trailing slash if needed
  storePath = storePath.endsWith("/") ? storePath : `${storePath}/`;

  if (filePath.startsWith(storePath)) {
    return filePath.substring(storePath.length);
  }
  return filePath;
}

/**
 * Formats a duration from seconds to "m:ss" format.
 *
 * @param {number} totalSeconds - The total duration in seconds.
 * @returns {string} The formatted duration as "m:ss".
 */
export function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  // Pad seconds with leading zero if less than 10
  const paddedSeconds = seconds.toString().padStart(2, "0");

  return `${minutes}m${paddedSeconds}s`;
}

/**
 * Computes the SHA-256 hash of a file using the 'shasum -a 256' command.
 *
 * @param {string} filePath - The absolute or relative path to the file.
 * @returns {Promise<string>} - A promise that resolves to the SHA-256 hash in hexadecimal format.
 */
export async function computeSha256(filePath: string) {
  try {
    logger(`shasum -a 256 "${filePath}"`);
    // Execute the shasum command
    const { stdout, stderr } = await execPromise(`shasum -a 256 "${filePath}"`);

    // Check for errors in stderr
    if (stderr) {
      throw new Error(stderr);
    }

    // The output format of shasum -a 256 is: <hash>  <filename>
    const hash = stdout.split(" ")[0].trim();

    // Validate the hash format (should be 64 hexadecimal characters)
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
      throw new Error("Invalid SHA-256 hash format received.");
    }

    logger("Found hash: " + hash);

    return hash;
  } catch (error) {
    // Handle errors (e.g., file not found, shasum not installed)
    throw new Error(`Failed to compute SHA-256 hash: ${(error as Error).message}`);
  }
}

/**
 * Returns the MIME type based on the file extension.
 *
 * @param path - The file path or name.
 * @returns The corresponding MIME type as a string.
 */
export function getMimeTypeByPath(path: string): string {
  const { ext } = parse(path.toLowerCase());

  switch (ext) {
    // Image MIME types
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".tiff":
    case ".tif":
      return "image/tiff";
    case ".ico":
      return "image/vnd.microsoft.icon";
    case ".heic":
      return "image/heic";
    case ".avif":
      return "image/avif";

    // Video MIME types
    case ".mp4":
      return "video/mp4";
    case ".avi":
      return "video/x-msvideo";
    case ".mov":
      return "video/quicktime";
    case ".wmv":
      return "video/x-ms-wmv";
    case ".flv":
      return "video/x-flv";
    case ".mkv":
      return "video/x-matroska";
    case ".webm":
      return "video/webm";
    case ".mpeg":
    case ".mpg":
      return "video/mpeg";
    case ".3gp":
      return "video/3gpp";
    case ".3g2":
      return "video/3gpp2";
    case ".m4v":
      return "video/x-m4v";

    default:
      return "application/octet-stream"; // Default binary type
  }
}
