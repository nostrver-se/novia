import { NostrEvent } from "nostr-tools";

export const ONE_HOUR_IN_MILLISECS = 60 * 60 * 1000;
export const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

export const DVM_STATUS_KIND = 7000;
export const DVM_VIDEO_ARCHIVE_REQUEST_KIND = 5205;
export const DVM_VIDEO_ARCHIVE_RESULT_KIND = 6205;
export const DVM_VIDEO_UPLOAD_REQUEST_KIND = 5206;
export const DVM_VIDEO_UPLOAD_RESULT_KIND = 6206;

export const BLOSSOM_AUTH_KIND = 24242;

interface BaseJobContext {
    request: NostrEvent;
    wasEncrypted: boolean;
  }

// Subtype for "archive"
export interface ArchiveJobContext extends BaseJobContext {
    type: "archive";
    url: string;
  }
  
  // Subtype for "recover"
  export interface RecoverJobContext extends BaseJobContext {
    type: "recover";
    x: string;
    eventId: string;
    target: string[];
  }
  
  // Union type
  export type JobContext = ArchiveJobContext | RecoverJobContext;
  