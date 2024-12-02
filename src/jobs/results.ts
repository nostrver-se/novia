import { NostrEvent } from "nostr-tools";
import { AddressPointer } from "nostr-tools/nip19";
import { Video } from "../entity/Video.js";


export type RecoverResult = {
    eventId: string;
    video: string;
    thumb: string;
    info: string;
  };
  
  export type ArchiveResult = RecoverResult & {
    naddr: AddressPointer;
  };
  
  export const buildRecoverResult = (video: Video) => {
    return {
      eventId: video.event,
      video: video.videoSha256,
      thumb: video.thumbSha256,
      info: video.infoSha256,
    } as RecoverResult;
  };
  
  export const buildArchiveResult = (event: NostrEvent, relays: string[], video: Video) => {
    const identifier = event.tags.find((t) => t[0] == "d")![1];
  
    return {
      ...buildRecoverResult(video),
      naddr: {
        identifier,
        pubkey: event.pubkey,
        relays: relays,
        kind: event.kind,
      } as AddressPointer,
      eventId: event.id,
    } as ArchiveResult;
  };
  