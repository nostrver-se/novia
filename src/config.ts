import { accessSync, existsSync, readFileSync } from "fs";
import { Config } from "./types.js";
import * as yaml from "js-yaml";

export function readConfigSync(): Config {
  const configPaths = ["./novia.yaml", "/data/novia.yaml"];
  let config: Config | undefined;

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      console.log(`Reading config from ${configPath}`);
      const fileContents = readFileSync(configPath, "utf8");
      config = yaml.load(fileContents) as Config;
      break;
    }
  }

  if (!config) {
    console.warn("Config not found! Using fallback config...");

    config = {
      mediaStores: [{ id: "store", type: "local", path: "./media", watch: true }],
      download: { enabled: true, ytdlpPath: "ytdlp", tempPath: "./temp", targetStoreId: "store" },
      database: "./novia.db",
      server: { enabled: true, port: 9090 },
    };
  }

  if (config.mediaStores.find((ms) => ms.id == config.download?.targetStoreId) == undefined) {
    throw new Error(`Download store ${config.download?.targetStoreId} not found in media stores.`);
  }

  // Ensure media folder exists
  for (const store of config.mediaStores.filter((ms) => ms.type == "local")) {
    if (store.path) {
      accessSync(store.path);
    } else {
      throw new Error(`Media store ${store.id} has no path configured.`);
    }
  }

  return config;
}
