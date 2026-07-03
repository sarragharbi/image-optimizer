# Image Optimizer

Streaming image compression service. Upload an image of any size and get back
a resized (max 1920px on the longest side), WebP-compressed (quality 80)
version — without ever buffering the full upload in server memory.

## How it stays memory-safe for huge files

- **Upload**: the raw multipart body is parsed by `busboy` and piped directly
  to a temporary file on disk as it arrives. Express never buffers or
  size-limits the request body.
- **Processing**: `sharp` reads that temp file with `limitInputPixels: false`
  and `sequentialRead: true`, and `sharp.cache(false)` is set globally so
  decoded pixel data is never cached across requests.
- **Cleanup**: both the original upload and the compressed output are deleted
  from disk (`fs.unlink`) right after the response finishes, or immediately
  if the client disconnects or an error occurs.
- **Timeouts**: Node's default 5-minute request timeout is disabled
  (`server.requestTimeout = 0`) so slow, multi-gigabyte uploads aren't killed
  mid-transfer.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000

## Notes for production deployment

If you put this behind a reverse proxy (nginx, an ALB, etc.), that proxy has
its own request size and timeout limits (e.g. nginx's `client_max_body_size`,
default 1MB) which must be raised independently — Node's own limits being
disabled here doesn't affect the proxy in front of it.
