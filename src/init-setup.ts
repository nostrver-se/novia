import { outputFile, pathExists } from "fs-extra";
import inquirer from "inquirer";
import { generateSecretKey, nip19 } from "nostr-tools";
import path from "path";
import { Config, DownloadConfig, PublishConfig, ServerConfig } from "./types.js";
import * as yaml from "js-yaml";

/**
 * Prompts the user for configuration settings and writes the novia.yaml file.
 */
export async function createNoviaConfig() {
  const configPath = path.resolve(process.cwd(), "novia.yaml");

  // Check if novia.yaml exists
  if (await pathExists(configPath)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: "Overwrite novia.yaml? Are you sure?",
        default: false,
      },
    ]);

    if (!overwrite) {
      console.log("Operation cancelled. novia.yaml was not overwritten.");
      return;
    }
  }

  // Initial prompts
  const initialAnswers = await inquirer.prompt([
    {
      type: "list",
      name: "secOption",
      message: "Enter nsec or generate a new private key?",
      choices: [
        { name: "Enter private key manually", value: "manual" },
        { name: "Generate a new private key", value: "generate" },
      ],
    },
    {
      type: "input",
      name: "storagePath",
      message: "Storage path for videos:",
      default: "./media",
      validate: (input: string) => input.trim() !== "" || "Storage path cannot be empty.",
    },
    {
      type: "confirm",
      name: "publishEnabled",
      message: "Enable publishing of video events to NOSTR? (yes/no)",
      default: false,
    },
  ]);

  // SEC handling
  let nsec: string;
  if (initialAnswers.secOption === "manual") {
    const { manualnsec } = await inquirer.prompt([
      {
        type: "input",
        name: "manualnsec",
        message: "Enter your nsec (private key):",
        validate: (input: string) =>
          /^nsec[a-z0-9]$/.test(input) ||
          'Invalid nsec format. It should start with "nsec" followed by numbers or characters.',
      },
    ]);
    nsec = manualnsec;
  } else {
    const key = generateSecretKey();
    nsec = nip19.nsecEncode(key);
    console.log(`Generated new nsec: ${nsec}`);
  }

  // Publish-related prompts
  let publishConfig: PublishConfig = {
    enabled: false,
    key: "",
    thumbnailUpload: [],
    videoUpload: [],
    relays: [],
  };

  if (initialAnswers.publishEnabled) {
    const publishAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "relayUrls",
        message: "Relay URLs to publish to (comma-separated):",
        validate: (input: string) =>
          input
            .split(",")
            .map((url) => url.trim())
            .filter((url) => url !== "").length > 0 || "At least one relay URL is required.",
      },
      {
        type: "input",
        name: "blossomThumbnails",
        message: "Blossom server to publish thumbnails:",
        default: "https://nostr.download",
        validate: (input: string) => input.trim() !== "" || "Blossom server URL cannot be empty.",
      },
      {
        type: "input",
        name: "blossomVideos",
        message: "Blossom server to publish videos:",
        default: "https://nostr.download",
        validate: (input: string) => input.trim() !== "" || "Blossom server URL cannot be empty.",
      },
    ]);

    // Process relay URLs
    const relayList = (publishAnswers.relayUrls as string)
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url !== "");

    publishConfig = {
      enabled: true,
      key: nsec,
      thumbnailUpload: [publishAnswers.blossomThumbnails],
      videoUpload: [
        { url: publishAnswers.blossomVideos, cleanUpKeepSizeUnderMB: 2, cleanUpMaxAgeDays: 10, maxUploadSizeMB: 500 },
      ],
      relays: relayList,
    };
  }

  // Assemble the configuration object
  const config: Config = {
    mediaStores: [
      {
        id: "media",
        type: "local",
        path: initialAnswers.storagePath,
        watch: true,
      },
    ],
    database: "./novia.db",
    download: {
      enabled: true,
      ytdlpPath: "yt-dlp",
      tempPath: "./temp",
      targetStoreId: "media",
    } as DownloadConfig,
    publish: publishConfig.enabled ? publishConfig : undefined,
    server: {
      enabled: true,
      port: 9090,
    } as ServerConfig,
  };

  // Convert the configuration object to YAML
  const yamlStr = yaml.dump(config);

  // Write the YAML to novia.yaml
  try {
    await outputFile(configPath, yamlStr);
    console.log(`Configuration written to ${configPath}`);
  } catch (error) {
    console.error("Failed to write novia.yaml:", error);
  }
}
