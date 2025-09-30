import { parseGIF, decompressFrames } from './vendor/gifuct/index.js';
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.js';

const screenshotInput = document.querySelector('#screenshotInput');
const screenshotInfo = document.querySelector('#screenshotInfo');
const deviceSelect = document.querySelector('#deviceSelect');
const colorSelect = document.querySelector('#colorSelect');
const orientationSelect = document.querySelector('#orientationSelect');
const resetBtn = document.querySelector('#resetBtn');
const composeBtn = document.querySelector('#composeBtn');
const downloadBtn = document.querySelector('#downloadBtn');
const copyBtn = document.querySelector('#copyBtn');
const downloadScaledBtn = document.querySelector('#downloadScaledBtn');
const copyScaledBtn = document.querySelector('#copyScaledBtn');
const statusMessage = document.querySelector('#statusMessage');
const previewCanvas = document.querySelector('#previewCanvas');
const outputImage = document.querySelector('#outputImage');
const outputVideo = document.querySelector('#outputVideo');

let dataMap = {};
let bezelMetadata = null;
let selectedBezel = null;
let screenshotImage = null;
let screenshotGifFrames = null;
let screenshotVideo = null;
let screenshotVideoUrl = null;
let screenshotDimensions = null;
let screenshotType = 'image';
let composedOutputUrl = null;
let composedOutputType = null;
let composedObjectUrl = null;
const bezelCache = new Map();
const maskCache = new Map();

init();

async function init() {
  setStatus('載入外框資料中…');
  try {
    const response = await fetch('metadata.json');
    if (!response.ok) throw new Error('無法讀取 metadata.json');
    bezelMetadata = await response.json();
    dataMap = buildDataMap(bezelMetadata);
    populateDeviceSelect();
    composeBtn.disabled = true;
    setDownloadState(false);
    screenshotInfo.textContent = '可選擇檔案，或直接貼上圖片。';
    setStatus('請上傳或貼上 App 截圖或影片並選擇外框。');
  } catch (error) {
    console.error(error);
    setStatus('載入失敗：' + error.message);
  }
}

function buildDataMap(meta) {
  const devices = {};
  Object.entries(meta).forEach(([path, info]) => {
    const segments = path.split('/');
    if (segments.length < 3) return;
    const device = segments[1];
    const filename = segments[2].replace('.png', '');
    const parts = filename.split(' - ');
    if (parts.length < 3) return;
    const orientation = parts.pop();
    const color = parts.pop();
    const deviceName = parts.join(' - ');
    if (!devices[deviceName]) devices[deviceName] = {};
    if (!devices[deviceName][color]) devices[deviceName][color] = {};
    devices[deviceName][color][orientation] = {
      path,
      meta: info,
      device: deviceName,
      color,
      orientation,
    };
  });
  return devices;
}

function populateDeviceSelect() {
  const devices = Object.keys(dataMap).sort();
  deviceSelect.innerHTML = '';
  devices.forEach((device) => {
    const option = document.createElement('option');
    option.value = device;
    option.textContent = device;
    deviceSelect.append(option);
  });
  if (devices.length > 0) {
    deviceSelect.value = devices[0];
    populateColorSelect();
  }
}

function populateColorSelect() {
  const device = deviceSelect.value;
  const colors = device ? Object.keys(dataMap[device]).sort() : [];
  colorSelect.innerHTML = '';
  colors.forEach((color) => {
    const option = document.createElement('option');
    option.value = color;
    option.textContent = color;
    colorSelect.append(option);
  });
  if (colors.length > 0) {
    colorSelect.value = colors[0];
    populateOrientationSelect();
  }
}

function populateOrientationSelect() {
  const device = deviceSelect.value;
  const color = colorSelect.value;
  const orientations = device && color ? Object.keys(dataMap[device][color]).sort((a, b) => {
    if (a === b) return 0;
    if (a === 'Portrait') return -1;
    if (b === 'Portrait') return 1;
    return a.localeCompare(b);
  }) : [];
  orientationSelect.innerHTML = '';
  orientations.forEach((orientation) => {
    const option = document.createElement('option');
    option.value = orientation;
    option.textContent = orientation === 'Portrait' ? '直向 (Portrait)' : '橫向 (Landscape)';
    orientationSelect.append(option);
  });
  if (orientations.length > 0) {
    orientationSelect.value = orientations[0];
    updateSelectedBezel();
  }
}

function updateSelectedBezel() {
  const device = deviceSelect.value;
  const color = colorSelect.value;
  const orientation = orientationSelect.value;
  if (!device || !color || !orientation) {
    selectedBezel = null;
    composeBtn.disabled = true;
    return;
  }
  selectedBezel = dataMap[device]?.[color]?.[orientation] ?? null;
  refreshComposeState();
}

screenshotInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    clearScreenshot();
    return;
  }
  await processScreenshotFile(file, { source: 'upload' });
  event.target.value = '';
});

window.addEventListener('paste', async (event) => {
  if (!event.clipboardData) return;

  const activeElement = document.activeElement;
  if (shouldIgnorePasteTarget(activeElement)) return;

  try {
    const file = await extractImageFromClipboard(event.clipboardData);
    if (!file) return;

    event.preventDefault();
    await processScreenshotFile(file, { source: 'paste' });
    screenshotInput.value = '';
  } catch (error) {
    console.error(error);
    setStatus('貼上圖片時發生錯誤：' + error.message);
  }
});

deviceSelect.addEventListener('change', () => {
  populateColorSelect();
});

colorSelect.addEventListener('change', () => {
  populateOrientationSelect();
});

orientationSelect.addEventListener('change', () => {
  updateSelectedBezel();
});

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    handleReset();
  });
}

composeBtn.addEventListener('click', () => {
  compose();
});

downloadBtn.addEventListener('click', (event) => {
  if (downloadBtn.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
  }
});

copyBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (copyBtn.getAttribute('aria-disabled') === 'true') {
    return;
  }
  await copyComposedImage();
});

downloadScaledBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (downloadScaledBtn.getAttribute('aria-disabled') === 'true') {
    return;
  }
  await downloadScaledVersion();
});

copyScaledBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (copyScaledBtn.getAttribute('aria-disabled') === 'true') {
    return;
  }
  await copyScaledVersion();
});

function refreshComposeState({ screenshotOrientation } = {}) {
  const bezelReady = Boolean(selectedBezel);
  const screenshotReady = isScreenshotReady();
  composeBtn.disabled = !(bezelReady && screenshotReady);
  setDownloadState(Boolean(composedOutputUrl));
  if (!bezelReady || !screenshotReady) {
    setStatus('請確認截圖與外框皆已選擇。');
    return;
  }
  const bezelOrientation = selectedBezel.orientation;
  let message = `已選擇：${selectedBezel.device} · ${selectedBezel.color} · ${bezelOrientation}.`;
  if (screenshotOrientation && screenshotOrientation !== bezelOrientation) {
    message += ' 注意：截圖方向與外框不同，將自動置中填滿。';
  }
  setStatus(message);
}

function setDownloadState(enabled) {
  if (enabled) {
    downloadBtn.setAttribute('aria-disabled', 'false');
    copyBtn.setAttribute('aria-disabled', 'false');
    downloadScaledBtn.setAttribute('aria-disabled', 'false');
    copyScaledBtn.setAttribute('aria-disabled', 'false');
  } else {
    downloadBtn.setAttribute('aria-disabled', 'true');
    downloadBtn.removeAttribute('href');
    copyBtn.setAttribute('aria-disabled', 'true');
    downloadScaledBtn.setAttribute('aria-disabled', 'true');
    downloadScaledBtn.removeAttribute('href');
    copyScaledBtn.setAttribute('aria-disabled', 'true');
  }
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function handleReset() {
  clearScreenshot();
  setStatus('已重設，請上傳或貼上 App 截圖或影片並選擇外框。');
}

function resetComposedOutput() {
  if (composedObjectUrl) {
    URL.revokeObjectURL(composedObjectUrl);
    composedObjectUrl = null;
  }
  composedOutputUrl = null;
  composedOutputType = null;
  outputImage.removeAttribute('src');
  outputImage.hidden = false;
  if (outputVideo) {
    outputVideo.pause();
    outputVideo.removeAttribute('src');
    outputVideo.load();
    outputVideo.hidden = true;
  }
}

function setComposedOutput(url, type, { isObjectUrl = false } = {}) {
  if (composedObjectUrl && composedObjectUrl !== url) {
    URL.revokeObjectURL(composedObjectUrl);
  }
  composedOutputUrl = url;
  composedOutputType = type;
  composedObjectUrl = isObjectUrl ? url : null;
  if (type && type.startsWith('video')) {
    if (!outputVideo) return;
    outputImage.hidden = true;
    outputVideo.hidden = false;
    outputVideo.src = url;
    outputVideo.load();
    outputVideo.muted = true;
    outputVideo.play().catch(() => {});
  } else {
    outputImage.hidden = false;
    outputImage.src = url;
    if (outputVideo) {
      outputVideo.hidden = true;
      outputVideo.pause();
    }
  }
}

function clearScreenshot() {
  screenshotImage = null;
  screenshotGifFrames = null;
  if (screenshotVideo) {
    screenshotVideo.pause();
    screenshotVideo.src = '';
    screenshotVideo.load();
    screenshotVideo = null;
  }
  if (screenshotVideoUrl) {
    URL.revokeObjectURL(screenshotVideoUrl);
    screenshotVideoUrl = null;
  }
  screenshotDimensions = null;
  screenshotType = 'image';
  if (previewCanvas) {
    const ctx = previewCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }
  if (screenshotInput) {
    screenshotInput.value = '';
  }
  resetComposedOutput();
  setDownloadState(false);
  screenshotInfo.textContent = '可選擇檔案，或直接貼上圖片。';
  refreshComposeState();
}

async function processScreenshotFile(file, { source = 'upload' } = {}) {
  if (!file) return;
  try {
    resetComposedOutput();
    if (screenshotVideo) {
      screenshotVideo.pause();
      screenshotVideo.src = '';
      screenshotVideo.load();
      screenshotVideo = null;
    }
    if (screenshotVideoUrl) {
      URL.revokeObjectURL(screenshotVideoUrl);
      screenshotVideoUrl = null;
    }
    let width;
    let height;
    let orientation;
    let infoLabel = '';
    if (file.type === 'image/gif' || file.name?.toLowerCase().endsWith('.gif')) {
      const gifData = await loadGifFromFile(file);
      screenshotType = 'gif';
      screenshotGifFrames = gifData.frames;
      screenshotDimensions = { width: gifData.width, height: gifData.height };
      width = gifData.width;
      height = gifData.height;
      orientation = getOrientation(width, height);
      infoLabel = `GIF · 幀數：${gifData.frames.length}`;
      screenshotImage = null;
    } else if (file.type.startsWith('video/') || file.name?.toLowerCase().match(/\.(mp4|mov)$/)) {
      const videoData = await loadVideoFromFile(file);
      screenshotType = 'video';
      screenshotVideo = videoData.video;
      screenshotVideoUrl = videoData.url;
      screenshotGifFrames = null;
      screenshotImage = null;
      width = videoData.width;
      height = videoData.height;
      orientation = getOrientation(width, height);
      const durationSeconds = Number.isFinite(videoData.duration) ? videoData.duration : 0;
      infoLabel = `影片 · 時長：${durationSeconds.toFixed(1)} 秒`;
    } else {
      const { image, width: imgWidth, height: imgHeight } = await loadImageFromFile(file);
      screenshotType = 'image';
      screenshotImage = image;
      screenshotGifFrames = null;
      width = imgWidth;
      height = imgHeight;
      orientation = getOrientation(width, height);
    }
    screenshotDimensions = { width, height };
    setDownloadState(false);
    const sourceLabel = source === 'paste' ? '剪貼簿' : '檔案';
    const typeLabel = infoLabel ? `${infoLabel} · ` : '';
    screenshotInfo.textContent = `${sourceLabel} · ${typeLabel}尺寸：${width} × ${height}，方向：${orientation === 'Portrait' ? '直向' : '橫向'}`;
    autoSelectBezelForScreenshot(width, height);
    refreshComposeState({ screenshotOrientation: orientation });
  } catch (error) {
    console.error(error);
    setStatus('載入截圖失敗：' + error.message);
  }
}

async function extractImageFromClipboard(clipboardData) {
  if (!clipboardData) return null;
  const items = clipboardData.items ? Array.from(clipboardData.items) : [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  const files = clipboardData.files ? Array.from(clipboardData.files) : [];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      return file;
    }
  }

  const stringItems = items.filter((item) => item.kind === 'string');
  for (const item of stringItems) {
    const content = await getItemString(item);
    const candidate = await convertStringContentToFile(content, item.type);
    if (candidate) return candidate;
  }

  const htmlData = safeGetClipboardData(clipboardData, 'text/html');
  const htmlCandidate = await convertStringContentToFile(htmlData, 'text/html');
  if (htmlCandidate) return htmlCandidate;

  const uriList = safeGetClipboardData(clipboardData, 'text/uri-list');
  const uriCandidate = await convertStringContentToFile(uriList, 'text/uri-list');
  if (uriCandidate) return uriCandidate;

  const plainText = safeGetClipboardData(clipboardData, 'text/plain');
  const textCandidate = await convertStringContentToFile(plainText, 'text/plain');
  if (textCandidate) return textCandidate;

  return null;
}

function shouldIgnorePasteTarget(activeElement) {
  if (!activeElement) return false;
  if (activeElement.isContentEditable) return true;
  if (activeElement.tagName === 'INPUT') {
    const type = activeElement.getAttribute('type');
    return type && type !== 'file';
  }
  if (activeElement.tagName === 'TEXTAREA') return true;
  return false;
}

function isScreenshotReady() {
  if (screenshotType === 'gif') {
    return Array.isArray(screenshotGifFrames) && screenshotGifFrames.length > 0;
  }
  if (screenshotType === 'video') {
    return Boolean(screenshotVideo);
  }
  return Boolean(screenshotImage);
}

function safeGetClipboardData(clipboardData, type) {
  if (!clipboardData || !clipboardData.getData) return '';
  try {
    return clipboardData.getData(type) || '';
  } catch (error) {
    return '';
  }
}

function getItemString(item) {
  return new Promise((resolve) => {
    if (!item || item.kind !== 'string' || !item.getAsString) {
      resolve('');
      return;
    }
    item.getAsString((value) => {
      resolve(value || '');
    });
  });
}

async function convertStringContentToFile(content, typeHint) {
  if (!content) return null;
  const trimmed = content.trim();
  const firstLine = trimmed.split(/\r?\n/)[0].trim();

  if (firstLine.startsWith('data:image/')) {
    const file = dataUrlToFile(firstLine);
    if (file) return file;
  }

  if (typeHint === 'text/html' || /<img/i.test(trimmed)) {
    const src = extractImageSrcFromHtml(trimmed);
    if (src) {
      if (src.startsWith('data:image/')) {
        const file = dataUrlToFile(src);
        if (file) return file;
      }
      if (/^https?:\/\//i.test(src)) {
        const fetched = await fetchImageAsFile(src);
        if (fetched) return fetched;
      }
    }
  }

  if (/^https?:\/\//i.test(firstLine)) {
    const fetched = await fetchImageAsFile(firstLine);
    if (fetched) return fetched;
  }

  return null;
}

function extractImageSrcFromHtml(html) {
  try {
    const container = document.createElement('div');
    container.innerHTML = html;
    const img = container.querySelector('img');
    return img?.src || '';
  } catch (error) {
    return '';
  }
}

function dataUrlToFile(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2].replace(/\s+/g, '');
  try {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      buffer[i] = binary.charCodeAt(i);
    }
    const extension = guessExtensionFromMime(mime);
    const filename = `pasted-image.${extension}`;
    return createFileFromParts([buffer], filename, { type: mime });
  } catch (error) {
    console.error('Failed to decode data URL', error);
    return null;
  }
}

async function fetchImageAsFile(url) {
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const mime = blob.type || 'application/octet-stream';
    const extension = guessExtensionFromMime(mime);
    const filename = `pasted-image.${extension}`;
    return createFileFromParts([blob], filename, { type: mime });
  } catch (error) {
    console.warn('Failed to fetch image from clipboard URL', error);
    return null;
  }
}

function guessExtensionFromMime(mime) {
  if (!mime) return 'png';
  const parts = mime.split('/');
  let subtype = parts[1] || 'png';
  if (subtype.includes('+')) {
    subtype = subtype.split('+')[0];
  }
  if (subtype === 'jpeg') return 'jpg';
  return subtype;
}

function createFileFromParts(parts, filename, options) {
  if (typeof File === 'function') {
    try {
      return new File(parts, filename, options);
    } catch (error) {
      // Fall through to Blob fallback.
    }
  }
  const blob = new Blob(parts, options);
  try {
    return Object.defineProperty(blob, 'name', { value: filename, configurable: true });
  } catch (error) {
    blob.name = filename;
    return blob;
  }
}

function autoSelectBezelForScreenshot(width, height) {
  const match = findBestBezelMatch(width, height);
  if (!match) return false;

  let deviceChanged = false;
  if (deviceSelect.value !== match.device) {
    deviceSelect.value = match.device;
    populateColorSelect();
    deviceChanged = true;
  }

  const previousColor = colorSelect.value;
  const colorOptionFound = setSelectValue(colorSelect, match.color);
  const colorChanged = colorOptionFound && colorSelect.value !== previousColor;

  if (deviceChanged || colorChanged) {
    populateOrientationSelect();
  }

  setSelectValue(orientationSelect, match.orientation);
  updateSelectedBezel();
  return true;
}

function setSelectValue(select, value) {
  const option = Array.from(select.options).find((opt) => opt.value === value);
  if (option) {
    select.value = value;
    return true;
  }
  return false;
}

function findBestBezelMatch(width, height) {
  if (!dataMap || !Object.keys(dataMap).length) return null;
  const targetOrientation = getOrientation(width, height);
  const aspect = width / height;
  const candidates = [];

  Object.entries(dataMap).forEach(([deviceName, colors]) => {
    Object.entries(colors).forEach(([colorName, orientations]) => {
      Object.entries(orientations).forEach(([orientationName, info]) => {
        const { screen } = info.meta;
        const screenWidth = screen.width;
        const screenHeight = screen.height;
        if (!screenWidth || !screenHeight) return;
        const screenAspect = screenWidth / screenHeight;
        const widthDiff = Math.abs(screenWidth - width) / screenWidth;
        const heightDiff = Math.abs(screenHeight - height) / screenHeight;
        const aspectDiff = Math.abs(screenAspect - aspect);
        const areaDiff = Math.abs(screenWidth * screenHeight - width * height) / (screenWidth * screenHeight);
        const score = aspectDiff * 2 + widthDiff + heightDiff + areaDiff;
        candidates.push({
          device: deviceName,
          color: colorName,
          orientation: orientationName,
          score,
          orientationMatch: orientationName === targetOrientation,
        });
      });
    });
  });

  if (!candidates.length) return null;
  let pool = candidates.filter((candidate) => candidate.orientationMatch);
  if (!pool.length) pool = candidates;

  let best = null;
  const epsilon = 1e-6;
  pool.forEach((candidate) => {
    if (!best || candidate.score < best.score - epsilon || (Math.abs(candidate.score - best.score) <= epsilon && isBetterTie(candidate, best))) {
      best = candidate;
    }
  });
  return best;
}

function isBetterTie(candidate, currentBest) {
  if (candidate.device === deviceSelect.value && currentBest.device !== deviceSelect.value) return true;
  if (candidate.color === colorSelect.value && currentBest.color !== colorSelect.value) return true;
  if (candidate.orientation === orientationSelect.value && currentBest.orientation !== orientationSelect.value) return true;
  return false;
}

const MIN_GIF_DELAY = 20;

async function loadGifFromFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const parsed = parseGIF(arrayBuffer);
  const frames = decompressFrames(parsed, true);
  if (!frames.length) {
    throw new Error('GIF 未包含任何幀影像');
  }

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  const gifCanvas = document.createElement('canvas');
  gifCanvas.width = width;
  gifCanvas.height = height;
  const gifCtx = gifCanvas.getContext('2d');

  const composedFrames = [];
  let previousFrame = null;
  let restoreImageData = null;

  frames.forEach((frame) => {
    if (previousFrame) {
      if (previousFrame.disposalType === 2) {
        const dims = previousFrame.dims;
        gifCtx.clearRect(dims.left, dims.top, dims.width, dims.height);
      } else if (previousFrame.disposalType === 3 && restoreImageData) {
        gifCtx.putImageData(restoreImageData, 0, 0);
      }
    }

    if (frame.disposalType === 3) {
      restoreImageData = gifCtx.getImageData(0, 0, width, height);
    } else {
      restoreImageData = null;
    }

    const frameWidth = frame.dims.width;
    const frameHeight = frame.dims.height;
    if (frameWidth === 0 || frameHeight === 0) {
      previousFrame = frame;
      return;
    }

    tempCanvas.width = frameWidth;
    tempCanvas.height = frameHeight;
    const frameImageData = tempCtx.createImageData(frameWidth, frameHeight);
    frameImageData.data.set(frame.patch);
    tempCtx.putImageData(frameImageData, 0, 0);
    gifCtx.drawImage(tempCanvas, frame.dims.left, frame.dims.top);

    const composedImage = gifCtx.getImageData(0, 0, width, height);
    composedFrames.push({
      imageData: composedImage,
      delay: Math.max(frame.delay || 100, MIN_GIF_DELAY),
    });

    previousFrame = frame;
  });

  if (!composedFrames.length) {
    throw new Error('無法解析 GIF 幀資料');
  }

  return {
    width,
    height,
    frames: composedFrames,
  };
}

async function loadVideoFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      if (!video.videoWidth || !video.videoHeight) {
        reject(new Error('無法取得影片尺寸'));
        URL.revokeObjectURL(url);
        return;
      }
      resolve({
        video,
        url,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration || 0,
      });
    };
    const onError = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error('影片讀取失敗'));
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        resolve({ image, width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => reject(new Error('圖片讀取失敗'));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error('檔案讀取失敗'));
    reader.readAsDataURL(file);
  });
}

function loadImage(path) {
  if (!bezelCache.has(path)) {
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('無法載入外框圖檔'));
      img.src = path;
    });
    bezelCache.set(path, promise);
  }
  return bezelCache.get(path);
}

function getOrientation(width, height) {
  if (width === height) return 'Portrait';
  return width > height ? 'Landscape' : 'Portrait';
}

function buildSafeFileName(device, color, orientation) {
  return `${device} ${color} ${orientation}`.replace(/\s+/g, '-');
}

async function getMask(path, bezel, meta) {
  if (!maskCache.has(path)) {
    const { width, height, screen } = meta;
    const bezelCanvas = document.createElement('canvas');
    bezelCanvas.width = width;
    bezelCanvas.height = height;
    const bezelCtx = bezelCanvas.getContext('2d');
    bezelCtx.drawImage(bezel, 0, 0);

    const imageData = bezelCtx.getImageData(screen.x, screen.y, screen.width, screen.height);
    const { data } = imageData;
    const screenWidth = imageData.width;
    const screenHeight = imageData.height;
    const totalPixels = screenWidth * screenHeight;
    const visited = new Uint8Array(totalPixels);
    const queue = new Uint32Array(totalPixels);
    const alphaThreshold = 254;

    let startX = Math.floor(screenWidth / 2);
    let startY = Math.floor(screenHeight / 2);
    let startIdx = startY * screenWidth + startX;
    let startAlpha = data[startIdx * 4 + 3];
    if (startAlpha > alphaThreshold) {
      let found = false;
      for (let y = 0; y < screenHeight && !found; y += 1) {
        for (let x = 0; x < screenWidth; x += 1) {
          const idx = y * screenWidth + x;
          const alpha = data[idx * 4 + 3];
          if (alpha <= alphaThreshold) {
            startX = x;
            startY = y;
            startIdx = idx;
            startAlpha = alpha;
            found = true;
            break;
          }
        }
      }
      if (!found) {
        throw new Error('無法建立遮罩：找不到透明螢幕區域');
      }
    }

    // Flood fill the transparent display interior so we ignore detached transparent corners.
    let head = 0;
    let tail = 0;
    queue[tail++] = startIdx;
    visited[startIdx] = 1;

    while (head < tail) {
      const current = queue[head++];
      const x = current % screenWidth;
      const y = (current / screenWidth) | 0;

      if (x + 1 < screenWidth) {
        const rightIdx = current + 1;
        if (!visited[rightIdx] && data[rightIdx * 4 + 3] <= alphaThreshold) {
          visited[rightIdx] = 1;
          queue[tail++] = rightIdx;
        }
      }
      if (x > 0) {
        const leftIdx = current - 1;
        if (!visited[leftIdx] && data[leftIdx * 4 + 3] <= alphaThreshold) {
          visited[leftIdx] = 1;
          queue[tail++] = leftIdx;
        }
      }
      if (y + 1 < screenHeight) {
        const bottomIdx = current + screenWidth;
        if (!visited[bottomIdx] && data[bottomIdx * 4 + 3] <= alphaThreshold) {
          visited[bottomIdx] = 1;
          queue[tail++] = bottomIdx;
        }
      }
      if (y > 0) {
        const topIdx = current - screenWidth;
        if (!visited[topIdx] && data[topIdx * 4 + 3] <= alphaThreshold) {
          visited[topIdx] = 1;
          queue[tail++] = topIdx;
        }
      }
    }

    for (let i = 0; i < totalPixels; i += 1) {
      const base = i * 4;
      if (visited[i]) {
        const alpha = data[base + 3];
        const maskAlpha = 255 - alpha;
        data[base] = 255;
        data[base + 1] = 255;
        data[base + 2] = 255;
        data[base + 3] = maskAlpha;
      } else {
        data[base] = 0;
        data[base + 1] = 0;
        data[base + 2] = 0;
        data[base + 3] = 0;
      }
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    maskCanvas.getContext('2d').putImageData(imageData, screen.x, screen.y);
    maskCache.set(path, maskCanvas);
  }
  return maskCache.get(path);
}

async function compose() {
  if (!selectedBezel || !isScreenshotReady()) return;
  composeBtn.disabled = true;
  try {
    setStatus('合成中…');
    let result;
    if (screenshotType === 'gif') {
      result = await composeGif();
    } else if (screenshotType === 'video') {
      result = await composeVideo();
    } else {
      result = await composeStatic();
    }
    setStatus(result.statusMessage);
  } catch (error) {
    console.error(error);
    setStatus('合成失敗：' + error.message);
  } finally {
    refreshComposeState();
  }
}

async function composeStatic() {
  const { path, meta, device, color, orientation } = selectedBezel;
  const bezel = await loadImage(path);
  const mask = await getMask(path, bezel, meta);
  const ctx = previewCanvas.getContext('2d');
  previewCanvas.width = meta.width;
  previewCanvas.height = meta.height;
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

  const screen = meta.screen;
  const shotWidth = screenshotDimensions.width;
  const shotHeight = screenshotDimensions.height;
  const scale = Math.max(screen.width / shotWidth, screen.height / shotHeight);
  const targetWidth = shotWidth * scale;
  const targetHeight = shotHeight * scale;
  const offsetX = screen.x + (screen.width - targetWidth) / 2;
  const offsetY = screen.y + (screen.height - targetHeight) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(screen.x, screen.y, screen.width, screen.height);
  ctx.clip();
  ctx.drawImage(screenshotImage, offsetX, offsetY, targetWidth, targetHeight);
  ctx.restore();

  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(bezel, 0, 0);

  const dataUrl = previewCanvas.toDataURL('image/png');
  setComposedOutput(dataUrl, 'image/png');
  const safeName = buildSafeFileName(device, color, orientation);
  updateDownloadLink(safeName, 'png');
  return { statusMessage: '合成完成' };
}

async function composeGif() {
  if (!Array.isArray(screenshotGifFrames) || !screenshotGifFrames.length) {
    throw new Error('GIF 幀資料不足');
  }
  const { path, meta, device, color, orientation } = selectedBezel;
  const bezel = await loadImage(path);
  const mask = await getMask(path, bezel, meta);
  const ctx = previewCanvas.getContext('2d');
  previewCanvas.width = meta.width;
  previewCanvas.height = meta.height;
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

  const screen = meta.screen;
  const shotWidth = screenshotDimensions.width;
  const shotHeight = screenshotDimensions.height;
  const scale = Math.max(screen.width / shotWidth, screen.height / shotHeight);
  const targetWidth = shotWidth * scale;
  const targetHeight = shotHeight * scale;
  const offsetX = screen.x + (screen.width - targetWidth) / 2;
  const offsetY = screen.y + (screen.height - targetHeight) / 2;

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = shotWidth;
  frameCanvas.height = shotHeight;
  const frameCtx = frameCanvas.getContext('2d');

  const composedFrames = [];

  screenshotGifFrames.forEach((frame) => {
    frameCtx.putImageData(frame.imageData, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(screen.x, screen.y, screen.width, screen.height);
    ctx.clip();
    ctx.drawImage(frameCanvas, offsetX, offsetY, targetWidth, targetHeight);
    ctx.restore();

    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(bezel, 0, 0);

    const composedFrame = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
    composedFrames.push({ imageData: composedFrame, delay: frame.delay });
  });

  if (!composedFrames.length) {
    throw new Error('GIF 幀無法合成');
  }

  // Build palette from up to the first 5 frames to reduce flicker.
  const sampleFrameSize = composedFrames[0].imageData.data.length;
  const sampleCount = Math.min(composedFrames.length, 5);
  const sampleData = new Uint8Array(sampleFrameSize * sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    sampleData.set(composedFrames[i].imageData.data, i * sampleFrameSize);
  }

  const palette = quantize(sampleData, 256, {
    format: 'rgba4444',
    oneBitAlpha: true,
    clearAlpha: true,
    clearAlphaThreshold: 0,
  });
  const transparentIndex = palette.findIndex((color) => color.length > 3 && color[3] === 0);

  const encoder = GIFEncoder();
  composedFrames.forEach((frame, index) => {
    const indexed = applyPalette(frame.imageData.data, palette, 'rgba4444');
    const frameOptions = {
      delay: frame.delay,
    };
    if (index === 0) {
      frameOptions.palette = palette;
      frameOptions.repeat = 0;
    }
    if (transparentIndex >= 0) {
      frameOptions.transparent = true;
      frameOptions.transparentIndex = transparentIndex;
    }
    encoder.writeFrame(indexed, previewCanvas.width, previewCanvas.height, frameOptions);
  });
  encoder.finish();

  const bytes = encoder.bytes();
  const blob = new Blob([bytes], { type: 'image/gif' });
  const blobUrl = URL.createObjectURL(blob);
  setComposedOutput(blobUrl, 'image/gif', { isObjectUrl: true });

  ctx.putImageData(composedFrames[0].imageData, 0, 0);

  const safeName = buildSafeFileName(device, color, orientation);
  updateDownloadLink(safeName, 'gif');
  return { statusMessage: 'GIF 合成完成，可下載。' };
}

async function composeVideo() {
  if (!screenshotVideo || !screenshotVideoUrl) {
    throw new Error('影片尚未準備完成');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('瀏覽器不支援 MediaRecorder 影片輸出');
  }
  const capture = previewCanvas.captureStream
    ? previewCanvas.captureStream(30)
    : previewCanvas.mozCaptureStream
      ? previewCanvas.mozCaptureStream(30)
      : null;
  if (!capture) {
    throw new Error('瀏覽器不支援畫面擷取');
  }
  const mimeType = getSupportedRecorderMimeType();
  if (!mimeType) {
    throw new Error('此瀏覽器不支援 MP4 影片錄製');
  }

  const { path, meta, device, color, orientation } = selectedBezel;
  const bezel = await loadImage(path);
  const mask = await getMask(path, bezel, meta);
  const ctx = previewCanvas.getContext('2d');
  previewCanvas.width = meta.width;
  previewCanvas.height = meta.height;
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

  const screen = meta.screen;
  const shotWidth = screenshotDimensions.width;
  const shotHeight = screenshotDimensions.height;
  const scale = Math.max(screen.width / shotWidth, screen.height / shotHeight);
  const targetWidth = shotWidth * scale;
  const targetHeight = shotHeight * scale;
  const offsetX = screen.x + (screen.width - targetWidth) / 2;
  const offsetY = screen.y + (screen.height - targetHeight) / 2;

  const chunks = [];
  let recorder;
  const audioStreams = [];
  try {
    recorder = new MediaRecorder(capture, { mimeType });
  } catch (error) {
    throw new Error('無法啟動影片錄製');
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) {
      chunks.push(event.data);
    }
  };

  return new Promise((resolve, reject) => {
    let rafId = null;
    let resolved = false;
    const safeName = buildSafeFileName(device, color, orientation);

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const fail = (error) => {
      if (resolved) return;
      resolved = true;
      reject(error instanceof Error ? error : new Error(error || '影片處理失敗'));
    };

    const video = document.createElement('video');
    video.src = screenshotVideoUrl;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.muted = false;
    video.volume = 1;
    video.preload = 'auto';

    const renderFrame = () => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

      ctx.save();
      ctx.beginPath();
      ctx.rect(screen.x, screen.y, screen.width, screen.height);
      ctx.clip();
      ctx.drawImage(video, offsetX, offsetY, targetWidth, targetHeight);
      ctx.restore();

      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(bezel, 0, 0);

      if (!video.paused && !video.ended) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    const stopRecording = () => {
      video.removeEventListener('ended', stopRecording);
      video.removeEventListener('error', onVideoError);
      if (rafId) cancelAnimationFrame(rafId);
      if (recorder.state === 'recording') {
        recorder.stop();
      }
      capture.getTracks().forEach((track) => track.stop());
      audioStreams.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      video.pause();
      video.src = '';
      video.load();
    };

    const onVideoError = () => {
      stopRecording();
      fail(new Error('影片播放失敗'));
    };

    recorder.onerror = () => {
      stopRecording();
      fail(new Error('錄製過程發生錯誤'));
    };

    recorder.onstop = () => {
      if (resolved) {
        return;
      }
      if (rafId) cancelAnimationFrame(rafId);
      const blob = new Blob(chunks, { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      setComposedOutput(blobUrl, mimeType, { isObjectUrl: true });
      updateDownloadLink(safeName, mimeTypeToExtension(mimeType));
      finish({ statusMessage: '影片合成完成' });
    };

    const attachAudioTracks = () => {
      const audioStream = video.captureStream?.() ?? video.mozCaptureStream?.();
      if (!audioStream) return;
      const tracks = audioStream.getAudioTracks();
      if (!tracks.length) return;
      audioStreams.push(audioStream);
      tracks.forEach((track) => capture.addTrack(track));
    };

    const startPlayback = async () => {
      video.currentTime = 0;
      try {
        await video.play();
      } catch (error) {
        capture.getTracks().forEach((track) => track.stop());
        fail(new Error('影片播放失敗'));
        return;
      }

      attachAudioTracks();

      try {
        recorder.start();
      } catch (error) {
        capture.getTracks().forEach((track) => track.stop());
        audioStreams.forEach((stream) => {
          stream.getTracks().forEach((track) => track.stop());
        });
        video.pause();
        fail(new Error('無法開始錄製影片'));
        return;
      }

      renderFrame();
    };

    video.addEventListener('ended', stopRecording, { once: true });
    video.addEventListener('error', onVideoError, { once: true });

    if (video.readyState >= 2) {
      startPlayback().catch(() => {});
    } else {
      const onLoaded = () => {
        startPlayback().catch(() => {});
      };
      video.addEventListener('loadeddata', onLoaded, { once: true });
    }
  });
}

function updateDownloadLink(safeName, extension) {
  if (!composedOutputUrl) return;
  downloadBtn.href = composedOutputUrl;
  downloadBtn.download = `screenshot-${safeName}.${extension}`;
  setDownloadState(true);
}

function getSupportedRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const mp4Candidates = [
    'video/mp4;codecs=avc1.64001F,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
  ];
  for (const type of mp4Candidates) {
    if (MediaRecorder.isTypeSupported?.(type)) {
      return type;
    }
  }
  return '';
}

function mimeTypeToExtension(mime) {
  if (!mime) return 'mp4';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogv';
  return 'mp4';
}

async function downloadScaledVersion() {
  if (!composedOutputUrl || !composedOutputType) {
    setStatus('請先完成合成再下載縮小圖');
    return;
  }

  try {
    setStatus('產生縮小圖中…');

    if (composedOutputType.startsWith('video')) {
      setStatus('影片暫不支援縮小功能');
      return;
    }

    const scale = 0.5;
    let scaledUrl;
    let extension;
    let safeName;

    if (composedOutputType === 'image/gif') {
      // For GIF, scale using canvas
      const originalCanvas = previewCanvas;
      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = Math.floor(originalCanvas.width * scale);
      scaledCanvas.height = Math.floor(originalCanvas.height * scale);
      const scaledCtx = scaledCanvas.getContext('2d');

      // For GIF, we need to re-encode all frames at 50% size
      if (!Array.isArray(screenshotGifFrames) || !screenshotGifFrames.length) {
        setStatus('GIF 幀資料不足');
        return;
      }

      const { path, meta, device, color, orientation } = selectedBezel;
      const bezel = await loadImage(path);
      const mask = await getMask(path, bezel, meta);

      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = meta.width;
      fullCanvas.height = meta.height;
      const fullCtx = fullCanvas.getContext('2d');

      const screen = meta.screen;
      const shotWidth = screenshotDimensions.width;
      const shotHeight = screenshotDimensions.height;
      const fullScale = Math.max(screen.width / shotWidth, screen.height / shotHeight);
      const targetWidth = shotWidth * fullScale;
      const targetHeight = shotHeight * fullScale;
      const offsetX = screen.x + (screen.width - targetWidth) / 2;
      const offsetY = screen.y + (screen.height - targetHeight) / 2;

      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = shotWidth;
      frameCanvas.height = shotHeight;
      const frameCtx = frameCanvas.getContext('2d');

      const composedFrames = [];

      screenshotGifFrames.forEach((frame) => {
        frameCtx.putImageData(frame.imageData, 0, 0);
        fullCtx.globalCompositeOperation = 'source-over';
        fullCtx.clearRect(0, 0, fullCanvas.width, fullCanvas.height);

        fullCtx.save();
        fullCtx.beginPath();
        fullCtx.rect(screen.x, screen.y, screen.width, screen.height);
        fullCtx.clip();
        fullCtx.drawImage(frameCanvas, offsetX, offsetY, targetWidth, targetHeight);
        fullCtx.restore();

        fullCtx.globalCompositeOperation = 'destination-in';
        fullCtx.drawImage(mask, 0, 0);
        fullCtx.globalCompositeOperation = 'source-over';
        fullCtx.drawImage(bezel, 0, 0);

        // Scale down the frame
        scaledCtx.clearRect(0, 0, scaledCanvas.width, scaledCanvas.height);
        scaledCtx.drawImage(fullCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);

        const scaledFrame = scaledCtx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);
        composedFrames.push({ imageData: scaledFrame, delay: frame.delay });
      });

      // Build palette and encode GIF
      const sampleFrameSize = composedFrames[0].imageData.data.length;
      const sampleCount = Math.min(composedFrames.length, 5);
      const sampleData = new Uint8Array(sampleFrameSize * sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        sampleData.set(composedFrames[i].imageData.data, i * sampleFrameSize);
      }

      const palette = quantize(sampleData, 256, {
        format: 'rgba4444',
        oneBitAlpha: true,
        clearAlpha: true,
        clearAlphaThreshold: 0,
      });
      const transparentIndex = palette.findIndex((color) => color.length > 3 && color[3] === 0);

      const encoder = GIFEncoder();
      composedFrames.forEach((frame, index) => {
        const indexed = applyPalette(frame.imageData.data, palette, 'rgba4444');
        const frameOptions = {
          delay: frame.delay,
        };
        if (index === 0) {
          frameOptions.palette = palette;
          frameOptions.repeat = 0;
        }
        if (transparentIndex >= 0) {
          frameOptions.transparent = true;
          frameOptions.transparentIndex = transparentIndex;
        }
        encoder.writeFrame(indexed, scaledCanvas.width, scaledCanvas.height, frameOptions);
      });
      encoder.finish();

      const bytes = encoder.bytes();
      const blob = new Blob([bytes], { type: 'image/gif' });
      scaledUrl = URL.createObjectURL(blob);
      extension = 'gif';
      safeName = buildSafeFileName(device, color, orientation);
    } else {
      // For static images (PNG, JPG)
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = composedOutputUrl;
      });

      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = Math.floor(img.width * scale);
      scaledCanvas.height = Math.floor(img.height * scale);
      const scaledCtx = scaledCanvas.getContext('2d');
      scaledCtx.drawImage(img, 0, 0, scaledCanvas.width, scaledCanvas.height);

      scaledUrl = scaledCanvas.toDataURL('image/png');
      extension = 'png';
      const { device, color, orientation } = selectedBezel;
      safeName = buildSafeFileName(device, color, orientation);
    }

    // Trigger download
    const link = document.createElement('a');
    link.href = scaledUrl;
    link.download = `screenshot-${safeName}-50%.${extension}`;
    link.click();

    // Clean up blob URL if created
    if (scaledUrl.startsWith('blob:')) {
      setTimeout(() => URL.revokeObjectURL(scaledUrl), 1000);
    }

    setStatus('縮小圖已下載');
  } catch (error) {
    console.error(error);
    setStatus('產生縮小圖失敗：' + error.message);
  }
}

async function copyComposedImage() {
  if (!composedOutputUrl || !composedOutputType) {
    setStatus('請先完成合成再複製圖片');
    return;
  }

  try {
    setStatus('正在複製到剪貼簿…');

    if (composedOutputType.startsWith('video')) {
      setStatus('影片暫不支援複製功能');
      return;
    }

    // Safari requires ClipboardItem to be created synchronously with a Promise
    if (composedOutputType === 'image/gif') {
      // For GIF
      const item = new ClipboardItem({
        'image/gif': fetch(composedOutputUrl).then(r => r.blob())
      });
      await navigator.clipboard.write([item]);
    } else {
      // For static images - use PNG format
      const item = new ClipboardItem({
        'image/png': new Promise((resolve, reject) => {
          previewCanvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('無法轉換圖片'));
          }, 'image/png');
        })
      });
      await navigator.clipboard.write([item]);
    }

    setStatus('已複製到剪貼簿');
  } catch (error) {
    console.error(error);
    if (error.name === 'NotAllowedError') {
      setStatus('複製失敗：瀏覽器未授予權限。請使用下載功能。');
    } else {
      setStatus('複製失敗：' + error.message + '。請使用下載功能。');
    }
  }
}

async function copyScaledVersion() {
  if (!composedOutputUrl || !composedOutputType) {
    setStatus('請先完成合成再複製縮小圖');
    return;
  }

  try {
    setStatus('產生縮小圖並複製中…');

    if (composedOutputType.startsWith('video')) {
      setStatus('影片暫不支援縮小功能');
      return;
    }

    const scale = 0.5;
    let blob;

    if (composedOutputType === 'image/gif') {
      // For GIF, scale using canvas
      if (!Array.isArray(screenshotGifFrames) || !screenshotGifFrames.length) {
        setStatus('GIF 幀資料不足');
        return;
      }

      const { path, meta, device, color, orientation } = selectedBezel;
      const bezel = await loadImage(path);
      const mask = await getMask(path, bezel, meta);

      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = Math.floor(meta.width * scale);
      scaledCanvas.height = Math.floor(meta.height * scale);
      const scaledCtx = scaledCanvas.getContext('2d');

      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = meta.width;
      fullCanvas.height = meta.height;
      const fullCtx = fullCanvas.getContext('2d');

      const screen = meta.screen;
      const shotWidth = screenshotDimensions.width;
      const shotHeight = screenshotDimensions.height;
      const fullScale = Math.max(screen.width / shotWidth, screen.height / shotHeight);
      const targetWidth = shotWidth * fullScale;
      const targetHeight = shotHeight * fullScale;
      const offsetX = screen.x + (screen.width - targetWidth) / 2;
      const offsetY = screen.y + (screen.height - targetHeight) / 2;

      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = shotWidth;
      frameCanvas.height = shotHeight;
      const frameCtx = frameCanvas.getContext('2d');

      const composedFrames = [];

      screenshotGifFrames.forEach((frame) => {
        frameCtx.putImageData(frame.imageData, 0, 0);
        fullCtx.globalCompositeOperation = 'source-over';
        fullCtx.clearRect(0, 0, fullCanvas.width, fullCanvas.height);

        fullCtx.save();
        fullCtx.beginPath();
        fullCtx.rect(screen.x, screen.y, screen.width, screen.height);
        fullCtx.clip();
        fullCtx.drawImage(frameCanvas, offsetX, offsetY, targetWidth, targetHeight);
        fullCtx.restore();

        fullCtx.globalCompositeOperation = 'destination-in';
        fullCtx.drawImage(mask, 0, 0);
        fullCtx.globalCompositeOperation = 'source-over';
        fullCtx.drawImage(bezel, 0, 0);

        // Scale down the frame
        scaledCtx.clearRect(0, 0, scaledCanvas.width, scaledCanvas.height);
        scaledCtx.drawImage(fullCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);

        const scaledFrame = scaledCtx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);
        composedFrames.push({ imageData: scaledFrame, delay: frame.delay });
      });

      // Build palette and encode GIF
      const sampleFrameSize = composedFrames[0].imageData.data.length;
      const sampleCount = Math.min(composedFrames.length, 5);
      const sampleData = new Uint8Array(sampleFrameSize * sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        sampleData.set(composedFrames[i].imageData.data, i * sampleFrameSize);
      }

      const palette = quantize(sampleData, 256, {
        format: 'rgba4444',
        oneBitAlpha: true,
        clearAlpha: true,
        clearAlphaThreshold: 0,
      });
      const transparentIndex = palette.findIndex((color) => color.length > 3 && color[3] === 0);

      const encoder = GIFEncoder();
      composedFrames.forEach((frame, index) => {
        const indexed = applyPalette(frame.imageData.data, palette, 'rgba4444');
        const frameOptions = {
          delay: frame.delay,
        };
        if (index === 0) {
          frameOptions.palette = palette;
          frameOptions.repeat = 0;
        }
        if (transparentIndex >= 0) {
          frameOptions.transparent = true;
          frameOptions.transparentIndex = transparentIndex;
        }
        encoder.writeFrame(indexed, scaledCanvas.width, scaledCanvas.height, frameOptions);
      });
      encoder.finish();

      const bytes = encoder.bytes();
      blob = new Blob([bytes], { type: 'image/gif' });

      // Copy GIF to clipboard
      const item = new ClipboardItem({
        'image/gif': Promise.resolve(blob)
      });
      await navigator.clipboard.write([item]);
    } else {
      // For static images (PNG, JPG)
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = composedOutputUrl;
      });

      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = Math.floor(img.width * scale);
      scaledCanvas.height = Math.floor(img.height * scale);
      const scaledCtx = scaledCanvas.getContext('2d');
      scaledCtx.drawImage(img, 0, 0, scaledCanvas.width, scaledCanvas.height);

      // Copy scaled image to clipboard - Safari compatible
      const item = new ClipboardItem({
        'image/png': new Promise((resolve, reject) => {
          scaledCanvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('無法轉換圖片'));
          }, 'image/png');
        })
      });
      await navigator.clipboard.write([item]);
    }

    setStatus('縮小圖已複製到剪貼簿');
  } catch (error) {
    console.error(error);
    if (error.name === 'NotAllowedError') {
      setStatus('複製失敗：瀏覽器未授予權限。請使用下載功能。');
    } else {
      setStatus('複製縮小圖失敗：' + error.message + '。請使用下載功能。');
    }
  }
}
