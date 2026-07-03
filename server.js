'use strict';

/**
 * Image Optimizer — streaming upload & compression server.
 *
 * Design constraints this file satisfies:
 *   - No upper bound on the size of an uploaded image (1 GB, 5 GB, ...).
 *   - The raw upload is never buffered in memory: Busboy streams the
 *     multipart body straight to a disk file as bytes arrive.
 *   - Sharp/libvips is configured for very large / high-pixel-count images
 *     and never caches decoded images in RAM.
 *   - Both the original upload and the compressed output are deleted from
 *     disk as soon as the response has been sent (or as soon as anything
 *     goes wrong), so disk usage never accumulates.
 *   - A client disconnecting mid-upload (common with multi-GB transfers)
 *     is handled gracefully and never crashes the process.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const Busboy = require('busboy');
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Sharp global configuration for massive files
// ---------------------------------------------------------------------------
// Disable Sharp's internal operation cache. Without this, Sharp keeps
// decoded pixel data / intermediate results around in memory, which slowly
// leaks RAM when the server processes many large images over its lifetime.
sharp.cache(false);

// Cap the number of threads libvips uses per operation so a single huge
// image can't monopolize every CPU core on the box (tune per deployment).
sharp.concurrency(4);

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'tmp', 'uploads');
const COMPRESSED_DIR = path.join(__dirname, 'tmp', 'compressed');

const MAX_OUTPUT_DIMENSION = 1920; // longest side, in pixels
const WEBP_QUALITY = 80;

// Make sure the working directories exist before the server accepts traffic.
for (const dir of [UPLOAD_DIR, COMPRESSED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
// Intentionally NOT using express.json()/express.urlencoded() on this app:
// those parsers buffer the whole body in memory and impose a default size
// limit (100kb). The upload route below reads the raw request stream itself
// via Busboy, so Express is never asked to parse or size-limit the body.
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Deletes a file if it exists, swallowing (and logging) any error so that
 * cleanup never throws inside an already-running error handler.
 */
async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to delete temporary file "${filePath}":`, err.message);
    }
  }
}

app.post('/api/compress', (req, res) => {
  // Reject early if the client isn't actually sending multipart form data.
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    res.status(400).json({ error: 'Expected a multipart/form-data request containing an "image" field.' });
    return;
  }

  const uploadId = crypto.randomUUID();
  const rawFilePath = path.join(UPLOAD_DIR, `${uploadId}.raw`);
  const compressedFilePath = path.join(COMPRESSED_DIR, `${uploadId}.webp`);

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      // No `limits.fileSize` is set on purpose: we never want Busboy to
      // reject a file based on size. The only real ceiling is available
      // disk space on the server.
    });
  } catch (err) {
    res.status(400).json({ error: 'Malformed multipart request.' });
    return;
  }

  let fileReceived = false;
  let invalidFileType = false;
  let originalFilename = 'image';
  let responded = false;
  let writeStream = null;
  let clientAborted = false;

  const finishWithError = (statusCode, message) => {
    if (responded) return;
    responded = true;
    if (!res.headersSent) {
      res.status(statusCode).json({ error: message });
    } else {
      res.end();
    }
  };

  const cleanupTempFiles = () => {
    safeUnlink(rawFilePath);
    safeUnlink(compressedFilePath);
  };

  // The client hung up before we could finish reading/processing the
  // upload. This is expected behaviour for very large transfers on flaky
  // connections — it must never crash the process, just abandon the work.
  req.on('aborted', () => {
    clientAborted = true;
    if (writeStream) writeStream.destroy();
    cleanupTempFiles();
  });

  busboy.on('file', (fieldname, fileStream, info) => {
    if (fieldname !== 'image') {
      // Not the field we expect: drain and ignore it without buffering.
      fileStream.resume();
      return;
    }

    if (!info.mimeType || !info.mimeType.startsWith('image/')) {
      // Drain this part without saving it, but keep reading the rest of the
      // multipart stream so the client's upload can complete normally and
      // we can report a clean error once Busboy reaches 'finish'.
      invalidFileType = true;
      fileStream.resume();
      return;
    }

    fileReceived = true;
    originalFilename = info.filename || 'image';

    writeStream = fs.createWriteStream(rawFilePath);

    fileStream.on('error', (err) => {
      console.error('Error while reading the incoming file stream:', err.message);
      writeStream.destroy();
      finishWithError(500, 'Error while receiving the uploaded file.');
    });

    writeStream.on('error', (err) => {
      console.error('Error while writing the upload to disk:', err.message);
      fileStream.unpipe(writeStream);
      finishWithError(500, 'Error while saving the uploaded file on the server.');
    });

    // Streams the incoming bytes straight to disk as they arrive — at no
    // point is the full file held in memory.
    fileStream.pipe(writeStream);
  });

  busboy.on('error', (err) => {
    console.error('Busboy parsing error:', err.message);
    if (writeStream) writeStream.destroy();
    cleanupTempFiles();
    finishWithError(500, 'Error while parsing the upload.');
  });

  busboy.on('finish', async () => {
    if (clientAborted || responded) return;

    if (invalidFileType) {
      finishWithError(400, 'Unsupported file type. Please upload an image file.');
      return;
    }

    if (!fileReceived) {
      finishWithError(400, 'No image file was provided. Please attach a file under the "image" field.');
      return;
    }

    // Wait for the disk write to fully flush before handing the file to
    // Sharp, otherwise we might try to read a partially-written file.
    const waitForWriteToFinish = () =>
      new Promise((resolve, reject) => {
        if (writeStream.writableFinished) {
          resolve();
          return;
        }
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

    try {
      await waitForWriteToFinish();
    } catch (err) {
      cleanupTempFiles();
      finishWithError(500, 'Error while saving the uploaded file on the server.');
      return;
    }

    if (clientAborted) return;

    try {
      await compressImage(rawFilePath, compressedFilePath);
    } catch (err) {
      console.error('Sharp processing error:', err.message);
      cleanupTempFiles();
      finishWithError(422, 'The uploaded file could not be processed as an image. It may be corrupted or in an unsupported format.');
      return;
    }

    if (clientAborted || responded) {
      cleanupTempFiles();
      return;
    }

    const downloadName = `${path.parse(originalFilename).name || 'image'}-compressed.webp`;

    responded = true;
    res.download(compressedFilePath, downloadName, (err) => {
      if (err) {
        // Most common cause: the client aborted the download partway
        // through. Nothing more to do here besides logging and cleanup.
        console.error('Error while sending the compressed file:', err.message);
      }
      cleanupTempFiles();
    });
  });

  req.pipe(busboy);
});

/**
 * Resizes and compresses an image on disk, streaming the work through
 * libvips without loading the full decoded bitmap into the Node.js heap.
 */
function compressImage(inputPath, outputPath) {
  return sharp(inputPath, {
    // Removes Sharp's default ~268 megapixel safety ceiling so extremely
    // large images (huge scans, panoramas, etc.) are not rejected.
    limitInputPixels: false,
    // Decodes the image sequentially (top to bottom) instead of loading
    // the whole thing at once, which significantly reduces peak memory
    // usage for very large source images.
    sequentialRead: true,
  })
    .rotate() // auto-orient using EXIF data before resizing
    .resize({
      width: MAX_OUTPUT_DIMENSION,
      height: MAX_OUTPUT_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toFile(outputPath);
}

// ---------------------------------------------------------------------------
// Process-level safety nets
// ---------------------------------------------------------------------------
// A single malformed request or an unexpected library error must never take
// the whole server down while other uploads are in flight.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server stays alive):', reason);
});

const server = app.listen(PORT, () => {
  console.log(`Image Optimizer server listening on http://localhost:${PORT}`);
});

// Node's HTTP server aborts a request that takes longer than
// `requestTimeout` (5 minutes by default) to be fully received, which would
// kill legitimate multi-gigabyte uploads on slow connections. Disable that
// ceiling here. `headersTimeout` is left at its default since only the
// request body is expected to be large, not the headers.
// If this app sits behind a reverse proxy (nginx, etc.), remember to raise
// its timeouts and body-size limits too — they are outside Node's control.
server.requestTimeout = 0; // no maximum time to receive the full request

module.exports = app;
