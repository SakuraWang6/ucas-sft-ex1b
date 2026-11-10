const byId = (id) => document.getElementById(id);
const tokenKey = 'sft-token';
const token = readToken();
const openFromTerminal = '请打开终端显示的完整链接以访问传输台。';
const defaultLimits = { filesLimit: 16, maxBytes: 8 * 1024 * 1024 };
const fileInput = byId('upload-input');
const nameInput = byId('upload-name');
const dropZone = byId('drop-zone');
const connectionButton = byId('connection-action');
const refreshButton = byId('refresh-files');
const chooseButton = byId('choose-files');
const activityLog = byId('activity-log');
const filesBody = byId('files-body');

let session = null;
let hasConnected = false;
let files = [];
let fileError = '';
let connectionError = '';
let busy = 'startup';
let revision = 0;
let polling = false;

class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function readToken() {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fragment === null) return sessionStorage.getItem(tokenKey);
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[a-f0-9]{64}$/.test(fragment)) return null;
  sessionStorage.setItem(tokenKey, fragment);
  return fragment;
}

async function request(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options,
    cache: 'no-store',
    headers: { ...options.headers, 'X-SFT-Token': token },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new BridgeError(body.error || `本机桥接请求失败（HTTP ${response.status}）`, response.status);
  }
  return response;
}

async function json(path, options) {
  return (await request(path, options)).json();
}

const translatedErrors = new Map([
  ['File already exists', '远端已存在同名文件。请为上传文件指定其他名称。'],
  ['Storage is full', '当前账号的文件数量已达上限。'],
  ['File is unavailable', '远端文件无法读取。请刷新列表。'],
  ['Invalid file name', '远端名称格式无效。'],
  ['Failed to fetch', '无法访问本机桥接服务。'],
]);

function errorText(error) {
  return translatedErrors.get(error.message) || error.message;
}

function showNotice(message, kind = 'success') {
  const notice = byId('notice');
  notice.dataset.kind = kind;
  notice.textContent = message;
  notice.hidden = !message;
}

function updateText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const scale = bytes >= 1024 ** 2 ? 1024 ** 2 : 1024;
  const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(bytes / scale);
  return `${number} ${scale === 1024 ? 'KiB' : 'MiB'}`;
}

function validName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    && !name.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

function create(tag, className = '', text = '') {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function renderFiles() {
  const rows = files.map(({ name, bytes }) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const label = create('div', 'file-name');
    label.append(icon('file'), create('span', '', name));
    nameCell.append(label);
    const sizeCell = create('td', 'file-size', formatBytes(bytes));
    sizeCell.title = `${bytes} 字节`;
    const actionCell = document.createElement('td');
    const button = create('button', 'download-button');
    button.type = 'button';
    button.setAttribute('aria-label', `下载 ${name}`);
    button.append(icon('download'), '下载');
    button.addEventListener('click', () => void download(name, bytes));
    actionCell.append(button);
    row.append(nameCell, sizeCell, actionCell);
    return row;
  });
  filesBody.replaceChildren(...rows);
}

function render() {
  const connected = session?.connected === true;
  if (connected) hasConnected = true;
  const limits = session ?? defaultLimits;
  const waiting = busy === 'startup' || busy === 'connect';
  const badge = byId('connection-badge');
  badge.dataset.state = waiting ? 'pending' : connected ? 'online' : 'offline';
  const pendingLabel = busy === 'startup' ? '读取会话' : '正在连接';
  updateText(badge, !token ? '未授权' : waiting ? pendingLabel
    : connected ? '已连接' : connectionError ? '桥接不可用' : '已断开');
  byId('session-user').textContent = session?.user || '—';
  byId('session-protocol').textContent = connected ? session.protocol : '—';
  byId('session-peer').textContent = session?.peer || '—';
  const openLabel = hasConnected ? '重新连接' : '连接';
  connectionButton.textContent = busy === 'disconnect' ? '正在断开' : connected ? '断开连接' : openLabel;
  connectionButton.disabled = Boolean(busy) || !token;

  const canTransfer = connected && !busy;
  refreshButton.disabled = !canTransfer;
  chooseButton.disabled = !canTransfer;
  fileInput.disabled = !canTransfer;
  nameInput.disabled = !canTransfer;
  filesBody.querySelectorAll('button').forEach((button) => { button.disabled = !canTransfer; });
  byId('upload-limit').textContent = `单文件 ≤ ${formatBytes(limits.maxBytes)}`;

  const loadingFiles = busy === 'startup' || busy === 'refresh' || busy === 'connect';
  const showTable = connected && !loadingFiles && !fileError && files.length > 0;
  byId('files-table').hidden = !showTable;
  const fileState = byId('file-state');
  fileState.hidden = showTable;
  fileState.dataset.error = String(Boolean(fileError));
  byId('file-state-text').textContent = loadingFiles ? '正在读取远端目录…'
    : !connected ? '连接后查看当前账号的文件。'
      : fileError || '远端目录为空。上传文件后可在此下载。';
  updateText(byId('file-summary'), connected && !loadingFiles && !fileError
    ? `${files.length} / ${limits.filesLimit} 个文件 · ${session.user} 的专属目录`
    : `账号目录最多存放 ${limits.filesLimit} 个文件`);
}

async function refreshStatus() {
  try {
    session = await json('status');
    connectionError = '';
  } catch (error) {
    connectionError = errorText(error);
    session = null;
    throw error;
  }
}

async function refreshFiles() {
  fileError = '';
  if (session?.connected) {
    try {
      files = (await json('files')).files;
    } catch (error) {
      fileError = errorText(error);
      throw error;
    }
  } else {
    files = [];
  }
  renderFiles();
}

async function operate(kind, run) {
  if (busy) return;
  busy = kind;
  revision += 1;
  showNotice('');
  render();
  try {
    await run();
  } catch (error) {
    showNotice(errorText(error), 'error');
    if (error.status === 503) await refreshStatus().catch(() => {});
  } finally {
    busy = '';
    render();
  }
}

function logTransfer(type, name, bytes) {
  const item = create('li', 'activity-row');
  const main = create('div', 'activity-main');
  main.append(create('strong', '', name), create('span', '', formatBytes(bytes)));
  const detail = create('p', 'activity-digest');
  detail.hidden = true;
  main.append(detail);
  const result = create('span', 'activity-status', '处理中');
  item.append(create('span', 'activity-type', type), main, result);
  activityLog.prepend(item);
  if (activityLog.children.length > 20) activityLog.lastElementChild.remove();
  byId('activity-empty').hidden = true;
  return (state, message) => {
    result.textContent = state === 'error' ? '失败' : '已校验';
    result.dataset.kind = state;
    detail.hidden = false;
    detail.className = state === 'error' ? 'activity-error' : 'activity-digest';
    detail.textContent = message;
  };
}

async function sha256(data) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器无法在此页面计算 SHA-256。');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function verifiedDigest(hash, resumedAt) {
  return `SHA-256  ${hash}${resumedAt > 0 ? ` · 从 ${formatBytes(resumedAt)} 续传` : ''}`;
}

function upload(selectedFiles) {
  if (busy || !session?.connected || !selectedFiles.length) return;
  const override = nameInput.value.trim();
  if (override && selectedFiles.length !== 1) {
    showNotice('指定远端名称时，请只选择一个文件。', 'error');
    return;
  }
  const queue = byId('queue-status');
  void operate('upload', async () => {
    queue.hidden = false;
    let succeeded = 0;
    try {
      for (const [index, file] of selectedFiles.entries()) {
        const name = override || file.name;
        queue.textContent = `正在顺序处理 ${index + 1} / ${selectedFiles.length}`;
        const finish = logTransfer('上传', name, file.size);
        try {
          if (!validName(name)) throw new Error('请指定合法的远端名称后重试。');
          if (file.size > session.maxBytes) throw new Error(`文件超过 ${formatBytes(session.maxBytes)} 上限。`);
          const hash = await sha256(await file.arrayBuffer());
          const result = await json(`upload-resume?name=${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          });
          if (result.name !== name || result.bytes !== file.size || result.sha256 !== hash) {
            throw new Error('上传回执与本地文件校验值不一致。');
          }
          finish('success', verifiedDigest(hash, result.resumedAt));
          succeeded += 1;
        } catch (error) {
          finish('error', errorText(error));
          if (error.status === 503) throw error;
        }
      }
      if (override && succeeded === 1) nameInput.value = '';
      await refreshFiles();
    } finally {
      queue.textContent = `已完成 ${succeeded} / ${selectedFiles.length} 个文件。详细结果见传输记录。`;
    }
  });
}

async function download(name, size) {
  await operate('download', async () => {
    const finish = logTransfer('下载', name, size);
    try {
      const response = await request(`download-resume?name=${encodeURIComponent(name)}`);
      const bytes = await response.arrayBuffer();
      const hash = await sha256(bytes);
      if (hash !== response.headers.get('X-SFT-SHA256') || bytes.byteLength !== size) {
        throw new Error('下载文件的大小或 SHA-256 校验失败。');
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      finish('success', verifiedDigest(hash, Number(response.headers.get('X-SFT-Resumed-Bytes'))));
    } catch (error) {
      finish('error', errorText(error));
      throw error;
    }
  });
}

connectionButton.addEventListener('click', () => {
  const action = session?.connected ? 'disconnect' : 'connect';
  void operate(action, async () => {
    await json(action, { method: 'POST' });
    await refreshStatus();
    await refreshFiles();
  });
});

refreshButton.addEventListener('click', () => {
  void operate('refresh', async () => {
    await refreshStatus();
    await refreshFiles();
  });
});

chooseButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const selected = Array.from(fileInput.files);
  fileInput.value = '';
  upload(selected);
});

function isFileDrag(event) {
  return event.dataTransfer?.types.includes('Files');
}

dropZone.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  const enabled = !chooseButton.disabled;
  event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
  dropZone.dataset.dragging = String(enabled);
});
dropZone.addEventListener('dragleave', (event) => {
  if (!(event.relatedTarget instanceof Node) || !dropZone.contains(event.relatedTarget)) {
    dropZone.dataset.dragging = 'false';
  }
});
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.dataset.dragging = 'false';
  upload(Array.from(event.dataTransfer?.files ?? []));
});
for (const name of ['dragover', 'drop']) {
  document.addEventListener(name, (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });
}

async function initialize() {
  try {
    if (!token) {
      showNotice(openFromTerminal, 'error');
      return;
    }
    await refreshStatus();
    await refreshFiles();
  } catch (error) {
    showNotice(errorText(error), 'error');
  } finally {
    busy = '';
    render();
  }
}

await initialize();

setInterval(async () => {
  if (!token || busy || polling || document.hidden) return;
  const started = revision;
  polling = true;
  try {
    const status = await json('status');
    if (revision !== started) return;
    const wasConnected = session?.connected;
    session = status;
    connectionError = '';
    if (status.connected && !wasConnected) {
      void operate('refresh', refreshFiles);
    } else {
      render();
    }
  } catch (error) {
    if (revision !== started) return;
    session = null;
    connectionError = errorText(error);
    showNotice(connectionError, 'error');
    render();
  } finally {
    polling = false;
  }
}, 8000);
