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
  mediaStores: - id: media
  type: local
  path: /data/media
  watch: true

      database: /data/novia.db

      download:
        enabled: true
        ytdlpPath: yt-dlp
        tempPath: ./temp
        targetStoreId: media

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

## DVM Archive (aka Download) Request

| name  | tag | description                                                          |
| ----- | --- | -------------------------------------------------------------------- |
| input | i   | An input of type URL of a website a video should be downloaded from. |

```json
{
  "kind": 5205,
  "tags": [["i", "https://www.youtube.com/watch?v=CQ4G2wLdGSE", "url"]]
}
```

## DVM Recover (aka Upload) Request

| name  | tag    |  multipe | description                                                                                                                                                                                                                                              |
| ----- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| input | i      | no       | A video event the author is looking for (including event id and relay )                                                                                                                                                                                  |
| param | x      | no       | The sha256 hash of the video that the author is looking for (required).                                                                                                                                                                                  |
| param | target | yes      | A blossom server the author wants the video to be uploaded. There can be issues with authentication and the novia service can decode to upload on a different server. The target param can appear multiple times, to request upload to multiple servers. |

```json
{
  "kind": 5206,
  "tags": [
    [
      "i",
      "0d1664a9709d385e2dc50e24de0d82fc6394bf93dfc60707dcf0bba2013f14f9",
      "event",
      "wss://some-video-relay.net/"
    ],
    ["param", "x", "9bc58f0248ecfe4e2f3aa850edcb17725b9ac91bbe1b8d337617f431c66b8366"],
    ["param", "target", "https://nostr.download/"]
  ]
}
```
