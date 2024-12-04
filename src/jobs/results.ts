import { nip19, NostrEvent } from "nostr-tools";
import { AddressPointer } from "nostr-tools/nip19";
import { Video } from "../entity/Video.js";

export type RecoverResult = {
  nevent: string;
  video: string;
  thumb: string;
  info: string;
};

export type ArchiveResult = RecoverResult & {
  naddr: string;
};

export const buildRecoverResult = (eventId: string, relays: string[], video: Video) => {
  return {
    nevent: nip19.neventEncode({
      id: eventId,
      relays: relays,
    }),
    video: video.videoSha256,
    thumb: video.thumbSha256,
    info: video.infoSha256,
  } as RecoverResult;
};

export const buildArchiveResult = (event: NostrEvent, relays: string[], video: Video) => {
  const identifier = event.tags.find((t) => t[0] == "d")![1];

  return {
    ...buildRecoverResult(event.id, relays, video),
    naddr: nip19.naddrEncode({
      identifier,
      pubkey: event.pubkey,
      relays: relays,
      kind: event.kind,
    } as AddressPointer),
  } as ArchiveResult;
};
