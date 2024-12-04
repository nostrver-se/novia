import { spawn } from "child_process";
import debug from "debug";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { DownloadConfig } from "../types.js";
import debounce from "lodash/debounce.js";
import { createTempDir } from "./utils.js";

const logger = debug("novia:ytdlp");

export interface YoutubeVideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  description: string;
  channel_id: string;
  channel_url: string;
  duration: number;
  view_count: number;
  age_limit: number;
  webpage_url: string;
  categories: string[];
  tags: string[];
  playable_in_embed: boolean;
  live_status: string;
  release_timestamp: number;
  _format_sort_fields: string[];
  comment_count: number;
  like_count: number;
  channel: string;
  channel_follower_count: number;
  channel_is_verified: boolean;
  uploader: string;
  uploader_id: string;
  uploader_url: string;
  upload_date: string;
  timestamp: number;
  availability: string;
  webpage_url_basename: string;
  webpage_url_domain: string;
  extractor: string;
  extractor_key: string;
  display_id: string;
  fulltitle: string;
  duration_string: string;
  release_date: string;
  release_year: number;
  is_live: boolean;
  was_live: boolean;
  epoch: number;
  format: string;
  format_id: string;
  ext: string;
  protocol: string;
  language: string;
  format_note: string;
  filesize_approx: number;
  tbr: number;
  width: number;
  height: number;
  resolution: string;
  fps: number;
  dynamic_range: string;
  vcodec: string;
  vbr: number;
  aspect_ratio: number;
  acodec: string;
  abr: number;
  asr: number;
  audio_channels: number;
  _type: string;
  _version: {
    version: string;
    release_git_head: string;
    repository: string;
  };
}

export type VideoContent = {
  folder: string;
  videoPath?: string;
  infoData?: YoutubeVideoInfo;
  infoPath?: string;
  thumbnailPath?: string;
};

/**
 * Finds a file based on the base name and desired extensions.
 * If not found, searches for any file with the desired extensions.
 *
 * @param {string} baseName - The base name of the file (without extension).
 * @param {string[]} preferredExtensions - Array of preferred extensions to look for first.
 * @param {string[]} fallbackExtensions - Array of fallback extensions to search if preferred not found.
 * @param {string[]} files - Array of all filenames in the directory.
 * @returns {string|null} - The found filename or null if not found.
 */
function findFile(
  baseName: string | undefined,
  preferredExtensions: string[],
  fallbackExtensions: string[],
  files: string[],
) {
  logger(baseName, preferredExtensions, fallbackExtensions, files);
  if (baseName) {
    // Attempt to find the file with the same base name and preferred extensions
    for (const ext of preferredExtensions) {
      const fileName = `${baseName}${ext}`;
      if (files.includes(fileName)) {
        return fileName;
      }
    }
  }
  // If not found, search for any file with the fallback extensions
  const possibleFallbackFiles = files.filter((file) => fallbackExtensions.some((ext) => file.endsWith(ext)));
  logger(possibleFallbackFiles);
  if (possibleFallbackFiles.length == 1) {
    return possibleFallbackFiles[0];
  }
  return undefined;
}

export type AnalysisResult = {
  folder: string;
  videoPath: string | undefined;
  infoData: YoutubeVideoInfo | undefined;
  infoPath: string | undefined;
  thumbnailPath: string | undefined;
};

export async function analyzeVideoFolder(
  folder: string,
  skipVideo = false,
  exactMetaMatch = true,
  videoFileName?: string,
): Promise<AnalysisResult> {
  logger("analyzeVideoFolder", folder, skipVideo);
  // Read the temp directory to find the first .mp4, .json, and .webp files
  const files = readdirSync(folder);
  logger(files);
  const videoFile = files.find(
    (file) =>
      (videoFileName == undefined || file.startsWith(videoFileName)) &&
      (file.endsWith(".mp4") || file.endsWith(".webm")),
  );

  if (!skipVideo && !videoFile) {
    throw new Error("Video not found in folder: " + folder);
  }
  const videoPath = videoFile ? path.join(folder, videoFile) : undefined;
  // 2. Extract the base name (filename without extension)
  const baseName = videoFile ? path.parse(videoFile).name : undefined;
  logger(`Base name extracted: ${baseName}`);

  const infoFile = findFile(
    baseName,
    [".info.json", ".json"], // Preferred extensions with base name
    exactMetaMatch ? [] : [".info.json", ".json"], // Fallback extensions (same in this case)
    files,
  );

  const infoPath = infoFile && path.join(folder, infoFile);

  const thumbnailFile = findFile(
    baseName,
    [".webp", ".jpg", ".image"], // Preferred extensions with base name
    exactMetaMatch ? [] : [".webp", ".jpg", ".image"], // Fallback extensions (same in this case)
    files,
  );

  const thumbnailPath = thumbnailFile && path.join(folder, thumbnailFile);

  // Read the JSON data from the info file
  const infoData = infoPath ? (JSON.parse(readFileSync(infoPath, "utf-8")) as YoutubeVideoInfo) : undefined;

  return {
    folder,
    videoPath,
    infoData,
    infoPath,
    thumbnailPath,
  };
}

// Define an interface for the extracted download information
export interface DownloadInfo {
  percentage: number;
  totalSizeMiB: number;
  speedMiBps: number;
  etaSeconds: number; // ETA in seconds
  fragCurrent: number;
  fragTotal: number;
}

/**
 * Parses a console output string to extract download information.
 * @param input - The console output string to parse, potentially containing multiple lines.
 * @returns An array of DownloadInfo objects with extracted numbers.
 */
function parseDownloadInfo(line: string): DownloadInfo | undefined {
  // Regular expression to match and capture the required parts of the string
  const regex =
    /^\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~\s+(\d+(?:\.\d+)?)MiB\s+at\s+(\d+(?:\.\d+)?)MiB\/s\s+ETA\s+(\d{2}):(\d{2})\s+\(frag\s+(\d+)\/(\d+)\)(?:\s+\+\d+ms)?$/;

  const results: DownloadInfo[] = [];

  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) return;

  const match = trimmedLine.match(regex);
  if (!match) {
    // If the line doesn't match the expected format, ignore it
    return;
  }

  // Destructure the captured groups from the regex match
  const [
    _fullMatch,
    percentageStr,
    totalSizeStr,
    speedStr,
    etaMinutesStr,
    etaSecondsStr,
    fragCurrentStr,
    fragTotalStr,
  ] = match;

  // Parse the captured strings into appropriate numerical types
  const percentage = parseFloat(percentageStr);
  const totalSizeMiB = parseFloat(totalSizeStr);
  const speedMiBps = parseFloat(speedStr);
  const etaMinutes = parseInt(etaMinutesStr, 10);
  const etaSeconds = parseInt(etaSecondsStr, 10);
  const fragCurrent = parseInt(fragCurrentStr, 10);
  const fragTotal = parseInt(fragTotalStr, 10);

  // Convert ETA to total seconds
  const totalEtaSeconds = etaMinutes * 60 + etaSeconds;

  return {
    percentage,
    totalSizeMiB,
    speedMiBps,
    etaSeconds: totalEtaSeconds,
    fragCurrent,
    fragTotal,
  };
}

export async function downloadYoutubeVideo(
  videoUrl: string,
  skipVideo = false,
  config: DownloadConfig,
  onProgress?: (info: DownloadInfo) => Promise<void>,
): Promise<VideoContent> {

  const publishProgress = onProgress && debounce(onProgress, 5000, {
    maxWait: 0
  });

  return new Promise((resolve, reject) => {
    try {
      const tempDir = createTempDir(config.tempPath);
      logger(`Temporary directory created at: ${tempDir}`);

      // Define yt-dlp arguments
      const args = [
        "-f",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--write-info-json",
        "--write-thumbnail",
        videoUrl,
      ];

      if (skipVideo) {
        args.push("--skip-download");
      }

      if (config.ytdlpCookies) {
        args.push("--cookies");
        args.push(config.ytdlpCookies);
      }

      // Optionally, use the absolute path to yt-dlp
      const ytDlpPath = config.ytdlpPath || "yt-dlp";
      logger(`Spawning yt-dlp '${config.ytdlpPath}' with args: ${args.join(" ")}`);

      // Spawn the yt-dlp process
      const ytDlp = spawn(ytDlpPath, args, { cwd: tempDir, shell: false });

      let stdout = "";
      let stderr = "";

      ytDlp.stdout.on("data", async (data) => {
        // logger(data.toString());
        const line = data.toString();

        if (publishProgress) {
          const downloadInfo = parseDownloadInfo(line);
          if (downloadInfo) {
            await publishProgress(downloadInfo);
          }
        }


        stdout += line;
      });

      ytDlp.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ytDlp.on("error", (err) => {
        logger(`Error spawning yt-dlp: ${err.message}`);
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });

      ytDlp.on("close", async (code) => {
        logger(`yt-dlp exited with code ${code}`);
        if (code !== 0) {
          logger(`yt-dlp stderr: ${stderr}`);
          return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        }

        try {
          const result = await analyzeVideoFolder(tempDir, skipVideo, false);
          logger(`Video analysis result: ${JSON.stringify(result)}`);
          resolve(result);
        } catch (analyzeError) {
          logger(`Error analyzing video folder: ${(analyzeError as Error).message}`);
          reject(analyzeError);
        }
      });
    } catch (error: any) {
      logger(`Unexpected error: ${error.message}`);
      reject(new Error(`Failed to download video: ${error.message}`));
    }
  });
}
