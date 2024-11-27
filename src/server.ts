import { FilterQuery } from "@mikro-orm/core";
import express, { NextFunction, Request, Response } from "express";
import { access, constants, createReadStream, stat } from "fs";
import { Video } from "./entity/Video.js";
import { EntityManager } from "@mikro-orm/sqlite";
import debug from "debug";
import { MediaStore } from "./types.js";
import path from "path";
import { promisify } from "util";
import { queueDownloadJob } from "./jobs/queue.js";
import cors from "cors"; // Import the CORS package

// Promisify fs functions for better async/await handling
const accessAsync = promisify(access);
const statAsync = promisify(stat);

const logger = debug("novia:server");

export function startLocalServer(rootEm: EntityManager, mediaStores: MediaStore[], port: number = 9090) {
  const app = express();

  // Middleware to parse JSON requests
  app.use(express.json());

  // Apply CORS middleware with default settings (allow all origins)
  app.use(cors());

  app.get("/add/:url", async (req: Request, res: Response, next: NextFunction) => {
    const { url } = req.params;
    await queueDownloadJob(rootEm, url);
    res.status(200);
    res.send();
  });

  app.get("/videos", async (req: Request, res: Response, next: NextFunction) => {
    const { search, store } = req.query;
    const queries: FilterQuery<Video>[] = [];
    if (search) {
      queries.push({
        $or: [{ title: { $like: `%${search}%` } }, { description: { $like: `%${search}%` } }],
      });
    }
    if (store) {
      queries.push({ store: { $eq: store } } as FilterQuery<Video>);
    }
    logger(queries);
    const em = rootEm.fork();
    res.json(await em.findAll(Video, { where: { $and: queries }, limit: 100 }));
  });

  // Define your route with Range and HEAD request support
  app.get("/:originalHash", async (req: Request, res: Response, next: NextFunction) => {
    const originalHash = req.params.originalHash;
    // Regular expression to extract hash and optional extension
    const hashRegex = /^([a-fA-F0-9]{64})(?:\.(\w+))?$/;
    const match = originalHash.match(hashRegex);

    if (!match) {
      res.status(400).json({ error: "Invalid SHA-256 hash format." });
      return;
    }

    const hash = match[1];
    const extension = match[2]; // This can be undefined if no extension is provided

    try {
      const em = rootEm.fork(); // Assuming rootEm is defined elsewhere
      const video = await em.findOne(Video, {
        $or: [{ videoSha256: { $eq: hash } }, { infoSha256: { $eq: hash } }, { thumbSha256: { $eq: hash } }],
      });

      if (!video) {
        res.status(404).json({ error: "File for hash not found." });
        return;
      }

      const store = mediaStores.find((st) => st.id == video.store);
      if (!store || !store.path) {
        res.status(500).json({ error: "Storage path for file not found." });
        return;
      }

      const [fullPath, mimeType] =
        video.videoSha256 == hash
          ? [path.join(store.path, video.videoPath), "video/mp4"]
          : video.infoSha256 == hash
            ? [path.join(store.path, video.infoPath), "application/json"]
            : [path.join(store.path, video.thumbPath), "image/webp"];

      logger(`Serving file '${fullPath}' for '/${originalHash}'`);

      // Check if the file exists and is accessible
      try {
        await accessAsync(fullPath, constants.R_OK);
      } catch (err) {
        console.error("File access error:", err);
        res.status(503).json({ error: "File not found or temporarily inaccessible." });
        return;
      }

      // Get file stats to set headers like Content-Length
      let stats;
      try {
        stats = await statAsync(fullPath);
      } catch (err) {
        console.error("File stat error:", err);
        res.status(500).json({ error: "Error retrieving file information." });
        return;
      }

      const fileSize = stats.size;
      const range = req.headers.range;
      const isHeadRequest = req.method === "HEAD";

      if (range) {
        // Example of a Range header: "bytes=0-1023"
        const bytesPrefix = "bytes=";
        if (!range.startsWith(bytesPrefix)) {
          res.status(400).json({ error: "Malformed Range header." });
          return;
        }

        const rangeParts = range.substring(bytesPrefix.length).split("-");
        const start = parseInt(rangeParts[0], 10);
        const end = rangeParts[1] ? parseInt(rangeParts[1], 10) : fileSize - 1;

        // Validate range
        if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
          res
            .status(416)
            .header({
              "Content-Range": `bytes */${fileSize}`,
            })
            .json({ error: "Requested Range Not Satisfiable" });
          return;
        }

        const chunkSize = end - start + 1;
        res.status(206).header({
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": mimeType,
        });

        if (isHeadRequest) {
          // For HEAD requests, end the response after setting headers
          res.end();
          return;
        }

        const readStream = createReadStream(fullPath, { start, end });

        // Handle stream errors
        readStream.on("error", (streamErr) => {
          console.error("Stream error:", streamErr);
          if (!res.headersSent) {
            res.status(500).json({ error: "Error reading the file." });
          }
        });

        // Pipe the read stream to the response
        readStream.pipe(res);
      } else {
        // No Range header present, send the entire file
        res.header({
          "Content-Length": fileSize,
          "Content-Type": mimeType,
          "Accept-Ranges": "bytes",
        });

        if (isHeadRequest) {
          // For HEAD requests, end the response after setting headers
          res.status(200).end();
          return;
        }

        const readStream = createReadStream(fullPath);

        // Handle stream errors
        readStream.on("error", (streamErr) => {
          console.error("Stream error:", streamErr);
          if (!res.headersSent) {
            res.status(500).json({ error: "Error reading the file." });
          }
        });

        // Pipe the read stream to the response
        readStream.pipe(res);
      }
    } catch (error) {
      console.error("Error fetching file content:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  app.get("/", async (req: Request, res: Response, next: NextFunction) => {
    res.status(200);
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>novia</title>
      <script>
        async function sendUrl() {
          const inputField = document.getElementById('urlInput');
          const url = inputField.value;
          const encodedUrl = encodeURIComponent(url);
          const apiUrl = \`/add/\${encodedUrl}\`;
    
          try {
            const response = await fetch(apiUrl, { method: 'GET' });
            if (response.ok) {
              const result = await response.text();
              inputField.value = "";
            } else {
              alert('Request failed: ' + response.statusText);
            }
          } catch (error) {
            alert('Error: ' + error.message);
          }
        }
      </script>
    </head>
    <body>
      <h1>novia</h1>
      <a href='/videos'>GET /videos</a><br>
      GET /:hash (retreive a blob with a SHA256 hash)<br> 
      GET /add/:url (add a new video download, url need to be uri encoded)<br> 

      <h1>Fetch URL</h1>
      <input type="text" id="urlInput" placeholder="Enter a URL" />
      <button onclick="sendUrl()">Fetch</button>
    </body>
    </html>
  `;
  res.send(htmlContent);
   
  });

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Unhandled error:", err.stack);
    res.status(500).json({ error: "Something went wrong!" });
  });

  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}
