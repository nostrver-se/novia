// src/entity/Queue.ts

import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity()
export class Queue {
  @PrimaryKey()
  id!: number;

  @Property({ default: "download" })
  type!: "download" | "extendmetadata" | 'createHashes' | 'nostrUpload'

  @Property()
  url!: string;

  @Property({ default: "local" })
  owner: string = "local";

  @Property({ default: "queued" })
  status: "queued" | "completed" | "failed" | "processing" = "queued";

  @Property()
  errorMessage: string = "";

  @Property({ onCreate: () => new Date() })
  addedAt!: Date;

  @Property({ nullable: true })
  processedAt?: Date;
}
