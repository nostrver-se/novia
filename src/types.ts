export interface MediaStore {
  id: string;
  type: "local" | "blossom";
  path?: string;
  url?: string;
  watch?: boolean;
}

export interface DownloadConfig {
  enabled: boolean;
  ytdlpPath: string;
  tempPath: string;
  targetStoreId: string;
}

export interface PublishConfig {
  enabled: boolean;
  key: string;
  blossomThumbnails: string[];
  blossomVideos: string[];
  relays: string[];
  videoBlobExpirationDays: number;
  videoBlobCutoffSizeLimitMB: number;
}

export interface ServerConfig {
  enabled: boolean;
  port: number;
}

export interface Config {
  mediaStores: MediaStore[];
  database: string;
  download?: DownloadConfig;
  publish?: PublishConfig;
  server?: ServerConfig;
}
