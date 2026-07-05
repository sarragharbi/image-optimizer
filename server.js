'use strict';

/**
 * Image Optimizer — streaming upload straight to Cloudinary (Fixed for Image Transformations)
 */
require('dotenv').config();

const express = require('express');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const Busboy = require('busboy');

// ---------------------------------------------------------------------------
// Cloudinary configuration
// ---------------------------------------------------------------------------
// Credentials are read from the environment (never hardcoded) — see the
// README / run instructions for how to pass them when starting the server.
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error(
    'Missing Cloudinary configuration. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET environment variables before starting the server.'
  );
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_OUTPUT_DIMENSION = 1920; // longest side, in pixels
const OUTPUT_QUALITY = 80;
const CLOUDINARY_FOLDER = 'champions_optimizer';

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API Upload Route
// ---------------------------------------------------------------------------
app.post('/api/upload', (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    res.status(400).json({ error: 'Expected a multipart/form-data request containing an "image" field.' });
    return;
  }

  let busboy;
  try {
    busboy = Busboy({ headers: req.headers });
  } catch (err) {
    res.status(400).json({ error: 'Malformed multipart request.' });
    return;
  }

  let fileReceived = false;
  let invalidFileType = false;
  let responded = false;
  let clientAborted = false;
  let cloudinaryUploadStream = null;

  const finishWithError = (statusCode, message) => {
    if (responded) return;
    responded = true;
    if (!res.headersSent) {
      res.status(statusCode).json({ error: message });
    } else {
      res.end();
    }
  };

  req.on('aborted', () => {
    clientAborted = true;
    if (cloudinaryUploadStream) cloudinaryUploadStream.destroy();
    console.log('Client aborted the upload before it completed.');
  });

  busboy.on('file', (fieldname, fileStream, info) => {
    if (fieldname !== 'image') {
      fileStream.resume();
      return;
    }

    if (!info.mimeType || !info.mimeType.startsWith('image/')) {
      invalidFileType = true;
      fileStream.resume();
      return;
    }

    fileReceived = true;

    // Utilisation de upload_stream standard pour accepter les transformations d'images à la volée
    cloudinaryUploadStream = cloudinary.uploader.upload_stream(
      {
        folder: CLOUDINARY_FOLDER,
        resource_type: 'image',
        transformation: [
          { width: MAX_OUTPUT_DIMENSION, height: MAX_OUTPUT_DIMENSION, crop: 'limit' },
          { fetch_format: 'webp', quality: OUTPUT_QUALITY },
        ],
      },
      (err, result) => {
        if (clientAborted) return;

        if (err) {
          console.error('Cloudinary upload error details:', err);
          finishWithError(502, 'Error while uploading the image to Cloudinary.');
          return;
        }

        if (responded) return;
        responded = true;
        res.json({ success: true, url: result.secure_url });
      }
    );

    cloudinaryUploadStream.on('error', (err) => {
      console.error('Error while streaming the upload to Cloudinary:', err.message);
      finishWithError(502, 'Error while uploading the image to Cloudinary.');
    });

    fileStream.on('error', (err) => {
      console.error('Error while reading the incoming file stream:', err.message);
      if (cloudinaryUploadStream) cloudinaryUploadStream.destroy();
      finishWithError(500, 'Error while receiving the uploaded file.');
    });

    fileStream.pipe(cloudinaryUploadStream);
  });

  busboy.on('error', (err) => {
    console.error('Busboy parsing error:', err.message);
    if (cloudinaryUploadStream) cloudinaryUploadStream.destroy();
    finishWithError(500, 'Error while parsing the upload.');
  });

  busboy.on('finish', () => {
    if (clientAborted || responded) return;

    if (invalidFileType) {
      finishWithError(400, 'Unsupported file type. Please upload an image file.');
      return;
    }

    if (!fileReceived) {
      finishWithError(400, 'No image file was provided. Please attach a file under the "image" field.');
      return;
    }
  });

  req.pipe(busboy);
});

// ---------------------------------------------------------------------------
// Process-level safety nets
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server stays alive):', reason);
});

const server = app.listen(PORT, () => {
  console.log(`Image Optimizer server listening on http://localhost:${PORT}`);
});

server.requestTimeout = 0;

module.exports = app;