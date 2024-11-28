import debug from "debug";
import { now } from "../utils/utils.js";
import { DVM_STATUS_KIND, JobContext, ONE_DAY_IN_SECONDS } from "./types.js";
import { finalizeEvent, SimplePool } from "nostr-tools";
import { getRelays } from "../helpers/dvm.js";
import { unique } from "../utils/array.js";

const logger = debug("novia:dvm:publish");

export async function publishStatusEvent(
  context: JobContext,
  status: "payment-required" | "processing" | "error" | "success" | "partial",
  data = "",
  additionalTags: string[][] = [],
  secretKey: Uint8Array,
  relays: string[],
) {
  const tags = [
    ["status", status],
    ["e", context.request.id],
    ["p", context.request.pubkey],
    ["expiration", `${now() + ONE_DAY_IN_SECONDS}`],
  ];
  tags.push(...additionalTags);

  const statusEvent = {
    kind: DVM_STATUS_KIND, // DVM Status
    tags,
    content: data,
    created_at: now(),
  };
  logger("statusEvent", statusEvent);

  // const event = await ensureEncrypted(resultEvent, context.request.pubkey, context.wasEncrypted);
  const result = finalizeEvent(statusEvent, secretKey);

  const pool = new SimplePool();
  await Promise.all(
    pool.publish(unique([...getRelays(context.request), ...relays]), result).map((p) => p.catch((e) => {})),
  );
}
