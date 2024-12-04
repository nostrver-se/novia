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
  autoUpload?: {
    enabled: boolean;
    maxVideoSizeMB: number;
  };
}

export interface ServerConfig {
  enabled: boolean;
  port: number;
}

export interface FetchConfig {
  enabled: boolean;
  match?: string[];
  relays?: string[];
}

export interface Config {
  mediaStores: MediaStore[];
  database: string;
  download?: DownloadConfig;
  publish?: PublishConfig;
  server?: ServerConfig;
  fetch?: FetchConfig;
}
