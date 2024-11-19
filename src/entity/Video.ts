// src/entities/Video.ts
import { Entity, PrimaryKey, Property } from "@mikro-orm/core";
import { v4 as uuidv4 } from "uuid";

@Entity()
export class Video {
  @PrimaryKey({ type: "uuid" })
  id: string = uuidv4();

  @Property()
  store!: string;

  @Property()
  videoPath!: string;

  @Property()
  videoSha256: string = "";

  @Property()
  infoPath: string = "";

  @Property()
  infoSha256: string = "";

  @Property()
  thumbPath: string = "";

  @Property()
  thumbSha256: string = "";

  @Property()
  addedAt: Date = new Date();

  @Property()
  externalId!: string;

  @Property()
  source: string = "";

  @Property({ type: "text[]", nullable: true })
  category?: string[];

  @Property()
  channelId!: string;

  @Property()
  channelName: string = "";

  @Property({ type: "bigint" }) // Storing timestamp as bigint
  dateDownloaded!: number;

  @Property({ type: "integer" })
  duration!: number;

  @Property({ type: "text" })
  description!: string;

  @Property({ type: "integer" })
  mediaSize!: number;

  @Property({ type: "date" })
  published!: Date;

  @Property({ type: "text[]", nullable: true })
  tags?: string[];

  @Property()
  title!: string;

  @Property()
  vidType!: string;

  @Property({ type: "integer" })
  likeCount: number = 0;

  @Property({ type: "integer" })
  viewCount: number = 0;

  @Property({ type: "integer" })
  ageLimit: number = 0;

  @Property({ type: "integer" })
  width: number = 0;

  @Property({ type: "integer" })
  height: number = 0;

  @Property()
  event: string = "";

  @Property()
  language: string = "";
}
