'use strict';

const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzoneText');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const compressBtn = document.getElementById('compressBtn');
const cancelBtn = document.getElementById('cancelBtn');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const statusMessage = document.getElementById('statusMessage');

let selectedFile = null;
let activeRequest = null;

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function resetStatus() {
  statusMessage.hidden = true;
  statusMessage.textContent = '';
  statusMessage.classList.remove('status-message--error', 'status-message--success');
}

function showStatus(message, type) {
  statusMessage.hidden = false;
  statusMessage.textContent = message;
  statusMessage.classList.toggle('status-message--error', type === 'error');
  statusMessage.classList.toggle('status-message--success', type === 'success');
}

function setSelectedFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showStatus('Please select an image file.', 'error');
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  fileInfo.hidden = false;
  dropzoneText.textContent = 'Click to choose a different image';
  compressBtn.disabled = false;
  resetStatus();
}

fileInput.addEventListener('change', (event) => {
  setSelectedFile(event.target.files[0]);
});

// Drag & drop support.
['dragenter', 'dragover'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('dropzone--active');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dropzone--active');
  });
});

dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

function setBusyUI(isBusy) {
  compressBtn.disabled = isBusy;
  fileInput.disabled = isBusy;
  cancelBtn.hidden = !isBusy;
  progressSection.hidden = !isBusy;
}

function extractFilenameFromHeader(header, fallback) {
  if (!header) return fallback;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match ? match[1] : fallback;
}

function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readBlobAsErrorMessage(blob) {
  try {
    const text = await blob.text();
    const parsed = JSON.parse(text);
    return parsed.error || 'Something went wrong while compressing the image.';
  } catch {
    return 'Something went wrong while compressing the image.';
  }
}

function compressImage() {
  if (!selectedFile) return;

  resetStatus();
  setBusyUI(true);
  progressFill.classList.remove('progress-bar__fill--indeterminate');
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Uploading… 0%';

  const formData = new FormData();
  formData.append('image', selectedFile);

  const xhr = new XMLHttpRequest();
  activeRequest = xhr;
  xhr.responseType = 'blob';

  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    progressFill.style.width = `${percent}%`;
    progressLabel.textContent = `Uploading… ${percent}% (${formatBytes(event.loaded)} / ${formatBytes(event.total)})`;
  });

  xhr.upload.addEventListener('load', () => {
    // The upload itself is done; the server is now running Sharp on the
    // file. We don't know how long that will take, so show an
    // indeterminate progress animation instead of a stalled 100% bar.
    progressFill.classList.add('progress-bar__fill--indeterminate');
    progressLabel.textContent = 'Processing image on the server… this can take a while for very large files.';
  });

  xhr.addEventListener('load', async () => {
    activeRequest = null;
    setBusyUI(false);

    if (xhr.status >= 200 && xhr.status < 300) {
      const contentDisposition = xhr.getResponseHeader('Content-Disposition');
      const filename = extractFilenameFromHeader(contentDisposition, 'compressed.webp');
      triggerBrowserDownload(xhr.response, filename);
      showStatus(`Done! "${filename}" has been downloaded (${formatBytes(xhr.response.size)}).`, 'success');
    } else {
      const message = await readBlobAsErrorMessage(xhr.response);
      showStatus(message, 'error');
    }
  });

  xhr.addEventListener('error', () => {
    activeRequest = null;
    setBusyUI(false);
    showStatus('Network error: the connection was lost during the upload.', 'error');
  });

  xhr.addEventListener('abort', () => {
    activeRequest = null;
    setBusyUI(false);
    showStatus('Upload cancelled.', 'error');
  });

  xhr.open('POST', '/api/compress');
  xhr.send(formData);
}

compressBtn.addEventListener('click', compressImage);

cancelBtn.addEventListener('click', () => {
  if (activeRequest) {
    activeRequest.abort();
  }
});
