import { nip19, NostrEvent } from "nostr-tools";
import { HORIZONZAL_VIDEO_KIND } from "../dvm/types.js";

export type VideoFormat = "widescreen" | "vertical";

export type VideoData = {
  eventId: string;
  archivedByNpub: string;
  identifier: string;
  x?: string;
  url: string | undefined;
  published_at: number;
  published_year: string;
  image: string | undefined;
  author?: string;
  source?: string;
  title: string | undefined;
  duration: number;
  description?: string;
  size: number;
  originalUrl?: string;
  dim?: string;
  tags: string[];
  format: VideoFormat;
  relayUrl?: string;
  contentWarning?: string;
  language?: string;
  info?: string;
};

export const getTagValue = (ev: NostrEvent, tagKey: string, postfix?: string): string | undefined => {
  const tag = ev.tags.find((t) => t[0] == tagKey && (postfix == undefined || postfix == t[2]));
  if (!tag) return undefined;
  return tag[1];
};

export function mapVideoData(ev: NostrEvent): VideoData {
  const pub = parseInt(getTagValue(ev, "published_at") || "0", 10);

  //`dim ${video.width}x${video.height}`,

  const iMetaTags = ev.tags.filter((t) => t[0] == "imeta");

  let dim = undefined;
  if (iMetaTags.length > 0) {
    const dimField = iMetaTags[0].find((s) => s.startsWith("dim "));
    if (dimField) {
      dim = dimField.substring(4);
    }
  }

  return {
    eventId: ev.id,
    archivedByNpub: nip19.npubEncode(ev.pubkey),
    identifier: getTagValue(ev, "d") || ev.id,
    x: getTagValue(ev, "x"),
    url: getTagValue(ev, "url"), // todo add imeta parsing
    published_at: pub,
    published_year: `${new Date(pub * 1000).getUTCFullYear()}`,
    image: getTagValue(ev, "image"), // todo add imeta parsing
    title: getTagValue(ev, "title"),
    duration: parseInt(getTagValue(ev, "duration") || "0", 10),
    source: getTagValue(ev, "c", "source"),
    author: getTagValue(ev, "c", "author"),
    description: getTagValue(ev, "summary"),
    size: parseInt(getTagValue(ev, "size") || "0", 10),
    originalUrl: getTagValue(ev, "r"),
    tags: ev.tags.filter((t) => t[0] == "t").map((t) => t[1]),
    format: ev.kind == HORIZONZAL_VIDEO_KIND ? "widescreen" : "vertical",
    contentWarning: getTagValue(ev, "content-warning"),
    language: getTagValue(ev, "l", "ISO-639-1"),
    info: getTagValue(ev, "info"),
    dim,
  };
}
