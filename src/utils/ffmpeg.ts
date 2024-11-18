import { exec } from "child_process";
import { mkdirSync } from "fs";
import path from "path";
import { promisify } from "util";

type MetaData = {
  streams: {
    index: number;
    codec_name: string;
    codec_long_name: string;
    profile?: string;
    codec_type: string;
    codec_tag_string: string;
    codec_tag: string;
    width: number;
    height: number;
    coded_width?: number;
    coded_height?: number;
    closed_captions: number;
    film_grain: number;
    has_b_frames: number;
    sample_aspect_ratio?: string;
    display_aspect_ratio?: string;
    pix_fmt?: string;
    is_avc?: string;
    duration: string;
    bit_rate: string;
    bits_per_raw_sample: string;
  }[];
  format: {
    filename: string;
    nb_streams: number;
    nb_programs: number;
    format_name: string;
    format_long_name: string;
    start_time: string;
    duration: string;
    size: string;
    bit_rate: string;
    probe_score: number;
    tags: {
      major_brand: string;
      minor_version: string;
      compatible_brands: string;
      creation_time: string;
    };
  };
};

const execAsync = promisify(exec);

export async function extractVideoMetadata(videoUrl: string): Promise<MetaData> {
  try {
    // Construct the command to extract metadata using ffprobe
    const command = `ffprobe -v quiet -print_format json -show_format -show_streams "${videoUrl}"`;

    // Execute the command
    const { stdout, stderr } = await execAsync(command);

    // Check for any errors
    if (stderr) {
      throw new Error(stderr);
    }

    // Parse the JSON output
    const metadata = JSON.parse(stdout);

    return metadata;
  } catch (error: any) {
    throw new Error(`Failed to extract video metadata: ${error.message}`);
  }
}

export type ThumbnailContent = {
  thumbnailPaths: string[];
  tempDir: string;
};

export async function extractThumbnails(
  videoUrl: string,
  numFrames: number = 1,
  outputFormat: 'jpg'|'png'|'webp' = "jpg",
  options: string = "",
): Promise<ThumbnailContent> {
  try {
    // Create a temporary directory with a random name
    const tempDir = path.join(process.cwd(), "temp" + Math.random().toString(36).substring(2));
    mkdirSync(tempDir);

    // Construct the command to extract thumbnails using ffmpeg
    const filenameTemplate = "thumbnail%02d." + outputFormat;
    const command = `ffmpeg -v error -i "${videoUrl}" -vf "thumbnail" -frames:v ${numFrames} -ss 00:00:01 -vf fps=1/4 ${options} "${path.join(tempDir, filenameTemplate)}"`;

    // Execute the command
    const { stdout, stderr } = await execAsync(command);

    // Check for any errors
    if (stderr) {
      throw new Error(stderr);
    }

    // Generate array of thumbnail file paths
    const thumbnailPaths: string[] = [];
    for (let i = 1; i <= numFrames; i++) {
      thumbnailPaths.push(path.join(tempDir, `thumbnail${i.toString().padStart(2, "0")}.${outputFormat}`));
    }

    return { thumbnailPaths, tempDir };
  } catch (error: any) {
    throw new Error(`Failed to extract thumbnails: ${error.message}`);
  }
}
