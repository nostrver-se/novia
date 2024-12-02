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
  ytdlpCookies?: string;
  tempPath: string;
  targetStoreId: string;
  secret?: boolean;
}

export interface PublishConfig {
  enabled: boolean;
  key: string;
  thumbnailUpload: string[];
  videoUpload: {
    url: string;
    maxUploadSizeMB: number;
    cleanUpMaxAgeDays: number;
    cleanUpKeepSizeUnderMB: number;
  }[];
  relays: string[];
  secret?: boolean;
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
