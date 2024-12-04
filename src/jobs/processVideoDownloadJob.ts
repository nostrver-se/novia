import path from "path";
import { extractThumbnails, ThumbnailContent } from "../utils/ffmpeg.js";
import { Config } from "../types.js";
import { removeFieldsFromJson } from "../utils/utils.js";
import { DownloadInfo, downloadYoutubeVideo } from "../utils/ytdlp.js";
import { mkdir } from "fs/promises";
import { move } from "../utils/move.js";
import { rmSync } from "fs";

export async function processVideoDownloadJob(
  config: Config,
  url: string,
  skipVideo: boolean = false,
  onProgress?: (info: DownloadInfo) => Promise<void>,
) {
  if (config.download == undefined) {
    throw new Error(`Download config is not defined.`);
  }

  const download = await downloadYoutubeVideo(url, skipVideo, config.download, onProgress);

  if ((!skipVideo && !download.videoPath) || !download.infoPath || !download.infoData) {
    throw new Error("Required files not found in the temporary directory.");
  }

  await removeFieldsFromJson(download.infoPath, ["thumbnails", "formats", "automatic_captions", "heatmap"]);

  const videoId = download.infoData.id;

  const downloadStore = config.mediaStores.find((ms) => ms.type == "local" && ms.id == config.download?.targetStoreId);

  if (!downloadStore || !downloadStore.path) {
    throw new Error(`Download folder for store ${config.download?.targetStoreId} not found.`);
  }

  let generatedThumb: ThumbnailContent | undefined = undefined;
  if (download.videoPath && !download.thumbnailPath) {
    generatedThumb = await extractThumbnails(config.download, download.videoPath, 1, "webp");
    download.thumbnailPath = generatedThumb.thumbnailPaths[0];
  }

  const targetFolder = path.join(
    downloadStore.path,
    `${download.infoData.extractor.toLocaleLowerCase()}`,
    `${download.infoData.channel_id || download.infoData.uploader_id || download.infoData.uploader}`,
    `${videoId}`,
  );
  await mkdir(targetFolder, { recursive: true });

  const targetVideoPath =
    download.videoPath && path.join(targetFolder, `${videoId}${path.extname(download.videoPath)}`);
  if (download.videoPath && targetVideoPath) {
    await move(download.videoPath, targetVideoPath);
  }
  if (download.infoPath) {
    await move(download.infoPath, path.join(targetFolder, `${videoId}.info.json`));
  }

  if (download.thumbnailPath) {
    await move(download.thumbnailPath, path.join(targetFolder, `${videoId}${path.extname(download.thumbnailPath)}`));
  }

  // remove the temp dir
  rmSync(download.folder, { recursive: true });

  if (generatedThumb && generatedThumb.tempDir) {
    rmSync(generatedThumb.tempDir, { recursive: true });
  }
  console.log(`Downloaded content saved to ${targetFolder}`);

  return targetVideoPath;
}
