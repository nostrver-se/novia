# novia - NOstr VIdeo Archive

novia is the glue that connects video archive tools to NOSTR. It can be used
as a **standalone archive tool** or extend other open source tools like:

- tubearchivist
- pinchflat

novia is running as a service and is able to

- download videos (with `yt-dlp`) by REST API or requests posted via NOSTR.
- scan existing videos on disk downloaded by other tools
- manage a library of the video metadata
- publish video events to NOSTR relays and
- answer requests for videos and upload them to blossom server.

# Archive structure

novia follows a few simple rules:

- filesystem first - all video, image and metadata is stored in a folder structure.
- Archive contents can be therefore be synched, copied and backuped in a conventional way.
- The default folder structure is:
  ```sh
  <source>/<user or channel>/<videoId>/videoId.mp4 (the video)
  <source>/<user or channel>/<videoId>/videoId.webp (a thumbnail)
  <source>/<user or channel>/<videoId>/videoId.info.json (ytdlp metadata)
  ```
  A concrete example would be:
  ```sh
  youtube/UClw9f0QDkIw2jrQ2_5QSMGw/dnDC3uWjhlo/dnDC3uWjhlo.mp4
  youtube/UClw9f0QDkIw2jrQ2_5QSMGw/dnDC3uWjhlo/dnDC3uWjhlo.webp
  youtube/UClw9f0QDkIw2jrQ2_5QSMGw/dnDC3uWjhlo/dnDC3uWjhlo.info.json
  ```
- Other folder structures are supported as well, as long all the content files have a unique name
- novia uses an SQLlite database as an index but the database could be restored from metadata at any time.

# Components

- **Filesystem scan** scans defined folders for video and metadata.
- **Filesystem watcher** watches for changes in the folder and processes files immediately.
- **Metadata extension** if a video doesn't have a thumbail or metadata it is fetched and stored in the filesystem alongside the video.
- **Hashing** For every file a unique hash (SHA256) is created.
- **Download** new videos based on a link and add them to the archive.
- **Publish video events** of archived videos on NOSTR.
- **Offer download services** to other users via NOSTR DVMs.
- **Offer video upload services** to users requesting a specific video.

# Setting it up

## Running in Docker

To use docker to run novia you have to mount the media folders as well as a folder with the config and database into the container. The easiest setup is as follows:

- Create a `./data` folder
- Create a folder `./data/media` where the video content will go.
- Create a config file `./data/novia.yaml`:

  ````yaml
  mediaStores:
  - id: media
    type: local
    path: /data/media
    watch: true

  database: /data/novia.db

  download:
    enabled: true
    ytdlpPath: yt-dlp
    ytdlpCookies: ./cookies.txt
    tempPath: ./temp
    targetStoreId: media
    secret: false

  publish:
    enabled: true
    key: nsecxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    thumbnailUpload:
    - https://nostr.download
    videoUpload:
      - url: https://nostr.download
        maxUploadSizeMB: 300
        cleanUpMaxAgeDays: 5
        cleanUpKeepSizeUnderMB: 2
    relays:
      - <a relay for the video events>
    secret: false
    autoUpload:
      enabled: true
      maxVideoSizeMB: 100

  fetch:
    enabled: false
    fetchVideoLimitMB: 10
    match:
      - nostr

  server:
    port: 9090
    enabled: true

      ```

  **Notice:** The paths point to `/data/` here. The service will automatically look for the config file in `/data/novia.db` or `./novia.db`. For docker setups it is easiest to just mount the `/data` folder.
  ````

Now you can run docker to start the novia service:

```sh
docker run -it --rm -p 9090:9090 -v ./data:/data teamnovia/novia
```

or for running in background

```sh
docker run -it --rm -p 9090:9090 -v ./data:/data teamnovia/novia
```

Use the `-e DEBUG=novia*` for more debugging output in the logs.

## Running with nodejs locally

### Prerequsites

Required NodeJS version is 21 (novia relies on it's websocket client support)

There are a few tools that novia uses for video download, conversion and hash calculation.
It expects the following tools to be installed:

- yt-dlp (https://github.com/yt-dlp/yt-dlp)
- ffmpeg (https://ffmpeg.org/)
- shasum (https://www.gnu.org/software/coreutils/ usually preinstalled on most systems)

### Configuration

When running with nodejs there is a helpful init tool that helps you to create the config file:

```bash
npx novia init
```

After answering the questions you should get a `novia.yaml` that looks something like this:

```yaml
mediaStores:
  - id: media
    type: local
    path: ./media
    watch: true
database: ./novia.db
download:
  enabled: true
  ytdlpPath: yt-dlp
  tempPath: ./temp
  targetStoreId: media
publish:
  enabled: true
  key: nsec188j2c3e0tdk7w6vapd0fcdn0g9fq653vzpj2zufgwx659qt49euqjlwnu0
  thumbnailUpload:
    - https://nostr.download
  videoUpload:
    - url: https://nostr.download
      cleanUpKeepSizeUnderMB: 2
      cleanUpMaxAgeDays: 10
      maxUploadSizeMB: 500
  relays:
    - my-video-relay.org
server:
  enabled: true
  port: 9090
```

If the media folder that you have specified doesn't already exist, go ahead and create it now.

```sh
mkdir ./media
```

Then you can run `serve` to start the service and answer video requests.

```bash
npx novia serve
```

# Known issues / limitations

There are several issues that have not been solved yet, here the most important:

- Currently all running novia instances download a video triggered by an archive request. There is no coordination or circuit
  breaker, when someone else is downloading the video.
- There is currently no way to share an archived video with another
  archive (incl. metadata and thumbnail).
- All novia instances that download a video also publish the video, i.e. there will be
  multiple video events from different novia instances. Additional checks if a video already
  exists, might be needed.
- Blossom servers don't upload of support large files. A possible solution is chunking of
  files (cherry tree).
- There are not many blossom servers that support large amounts of content. This will hopefully
  be improved with payed blossom servers (soon).

# NOSTR events

## Video Events

Novia creates video events according to nip71 (https://github.com/nostr-protocol/nips/blob/master/71.md) but with a few specifics:

- Videos created with novia are usually **not online**, i.e. the events are created without the video `url` but only with the `x` tag which contains the videos's sha256 hash. Clients have to try requesting the video's hash from known blossom servers.
- A c-tag `["c", "<channel name or uploader>", "author"]` is used to mark the
  original author, e.g. Youtube channel.
- Another c-tag `["c", "<source>", "source"]` is used to store the source website where this video was archived from. This is usually the `extractor` fields from `yt-dlp`.
- An `["l", "en", "ISO-639-1"]` is added to specify the language of the video if available.
- An additional tag `["info", "<hash>"]` is used to store a blossom hash for video metadata that is created by `yt-dlp`. This can be used to restore an archive entry with the full meta data information that is not contained in the nostr event.

## DVM Archive (aka Download) Request (Kind 5205)

| name  | tag | description                                                          |
| ----- | --- | -------------------------------------------------------------------- |
| input | i   | An input of type URL of a website a video should be downloaded from. |

```json
{
  "kind": 5205,
  "tags": [["i", "https://www.youtube.com/watch?v=CQ4G2wLdGSE", "url"]]
}
```

## DVM Archive (aka Download) Repsonse (Kind 6205)

| name    | tag | description                              |
| ------- | --- | ---------------------------------------- |
| content | i   | `JSON block with video data, see below.` |

```json
{
  "kind": 6205,
  "content": "{\"eventId\":\"6641da6a8f8d20acdad49b2bdbef3f57cf51f4e145be6a472903560f51a7bd4b\",\"video\":\"33528c883ea0f8b74f5f7433c7797ca36b9747799231aa7a9489423cbabfb217\",\"thumb\":\"ce1681a9bd006a2a9456f92fecad47372a5eb921488826856451c5f0ed8fac29\",\"info\":\"c674b4a2d431c34372ac9364a1e9207ee6fee82b36d392b4b52cff0c007f0604\",\"naddr\":{\"identifier\":\"youtube-5hPtU8Jbpg0\",\"pubkey\":\"3d70ed1c5f9a9103487c16f575bcd21d7cf4642e2e86539915cee78b2d68948c\",\"relays\":[\"wss://vidono.apps.slidestr.net/\"],\"kind\":34235}}",
  "tags": [
    ["request", "...   "],
    ["e", "170d42b31da8bd582b6797b3a74a2df8238538a65433baee7e59f746df1de9f1"],
    ["p", "..."],
    ["i", "https://www.youtube.com/watch?v=5hPtU8Jbpg0", "url"],
    ["expiration", "1733264732"]
  ]
}
```

### JSON Content

```json
{
  "eventId": "6641da6a8f8d20acdad49b2bdbef3f57cf51f4e145be6a472903560f51a7bd4b",
  "video": "33528c883ea0f8b74f5f7433c7797ca36b9747799231aa7a9489423cbabfb217",
  "thumb": "ce1681a9bd006a2a9456f92fecad47372a5eb921488826856451c5f0ed8fac29",
  "info": "c674b4a2d431c34372ac9364a1e9207ee6fee82b36d392b4b52cff0c007f0604",
  "naddr": {
    "identifier": "youtube-5hPtU8Jbpg0",
    "pubkey": "...",
    "relays": ["wss://some.relay.net/"],
    "kind": 34235
  }
}
```

## DVM Recover (aka Upload) Request (Kind 5206)

| name  | tag    |  multipe | description                                                                                                                                                                                                                                              |
| ----- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| input | i      | no       | A video event the author is looking for (including event id and relay )                                                                                                                                                                                  |
| param | x      | no       | The sha256 hash of the video that the author is looking for (required).                                                                                                                                                                                  |
| param | target | yes      | A blossom server the author wants the video to be uploaded. There can be issues with authentication and the novia service can decide to upload on a different server. The target param can appear multiple times, to request upload to multiple servers. |

```json
{
  "kind": 5206,
  "tags": [
    ["i", "0d1664a9709d385e2dc50e24de0d82fc6394bf93dfc60707dcf0bba2013f14f9", "event", "wss://some-video-relay.net/"],
    ["param", "x", "9bc58f0248ecfe4e2f3aa850edcb17725b9ac91bbe1b8d337617f431c66b8366"],
    ["param", "target", "https://nostr.download/"]
  ]
}
```

## DVM Recover (aka Upload) Repsonse (Kind 6206)

```json
{
  "kind": 6206,

  "content": "{\"eventId\":\"6a6fc428642d277bb487f2992c2e0c8d33895841a8ac5c6b4d214708340d78d1\",\"video\":\"bab588bb3cb018080a49921d8bbf1775cccbb16c8e934efe5b65ee56289d3892\",\"thumb\":\"05e12717f17a39cca9b44e2f4a745dd3314308fbc2e78e716b49f89dec879386\",\"info\":\"963d1681a8021bf315c7b633655cfdd53c3f530f80d8ce4b7c404b60a8cfe7a6\"}",
  "created_at": 1733177725,
  "id": "9fc75cbbc8a06f4069e37077e920e4a6b0f41af6a279b98493da6a6ed897d27c",
  "tags": [
    ["request", "..."],
    ["e", "da766329f00d71b73c94317db31688d4e3f74c35a2523e1dc016806d5ee9d866"],
    ["p", "..."],
    ["i", "6a6fc428642d277bb487f2992c2e0c8d33895841a8ac5c6b4d214708340d78d1", "event", "wss://some-video-relay.net/"],
    ["expiration", "1733609725"]
  ]
}
```

### JSON Content

```json
{
  "eventId": "6a6fc428642d277bb487f2992c2e0c8d33895841a8ac5c6b4d214708340d78d1",
  "video": "bab588bb3cb018080a49921d8bbf1775cccbb16c8e934efe5b65ee56289d3892",
  "thumb": "05e12717f17a39cca9b44e2f4a745dd3314308fbc2e78e716b49f89dec879386",
  "info": "963d1681a8021bf315c7b633655cfdd53c3f530f80d8ce4b7c404b60a8cfe7a6"
}
```

## DVM Mirror Request (Kind 5207) ???

```json
{
  "kind": 5207,
  "tags": [
    ["i", "0d1664a9709d385e2dc50e24de0d82fc6394bf93dfc60707dcf0bba2013f14f9", "event", "wss://some-video-relay.net/"],
    ["param", "x", "9bc58f0248ecfe4e2f3aa850edcb17725b9ac91bbe1b8d337617f431c66b8366"],
    ["param", "target", "https://nostr.download/"]
  ]
}
```
