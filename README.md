# novia - Videos on NOSTR

novia is the glue that connects video archive tools to NOSTR. It be used
as a **standalone archive tool** or extend other open source tools like:
- tubearchivist 
- pinchflat

novia is running as a service and is able to 
- download videos (with `yt-dlp`)
- manage a library of video and 
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


