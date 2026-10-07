const messagesEl = document.getElementById('messages');
const messagesInner = document.getElementById('messages-inner');
const messageInput = document.getElementById('message-input');
const nameInput = document.getElementById('name-input');
const composer = document.getElementById('composer');
const fileInput = document.getElementById('file-input');
const errorBanner = document.getElementById('error-banner');
const connection = document.getElementById('connection');
const connectionText = document.getElementById('connection-text');
const drawer = document.getElementById('files-drawer');
const backdrop = document.getElementById('drawer-backdrop');
const fileList = document.getElementById('file-list');
const sendButton = document.getElementById('send-button');
const attachButton = document.getElementById('attach-button');
const uploadStatus = document.getElementById('upload-status');
const dropOverlay = document.getElementById('drop-overlay');
const allMessages = new Map();
let busy = false;
let sharedFiles = null;

nameInput.value = localStorage.getItem('moa-name') || '';
nameInput.addEventListener('input', () => localStorage.setItem('moa-name', nameInput.value.trim()));

function formatTime(date) {
  return new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

function formatDay(date) {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(date));
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function iconFile() {
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2.5h6l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1Z"/><path d="M13 2.5v4h4M9 13h6M9 17h4"/></svg>';
  return icon;
}

function fileLink(message, compact = false) {
  const link = document.createElement('a');
  link.className = compact ? 'file-link compact' : 'file-link';
  link.href = `/api/files/${encodeURIComponent(message.id)}`;
  link.append(iconFile());
  const info = document.createElement('span');
  info.className = 'file-info';
  const name = document.createElement('strong');
  name.textContent = message.filename;
  const sub = document.createElement('small');
  sub.textContent = compact ? `${message.name} · ${formatSize(message.size)}` : `${formatSize(message.size)} · 다운로드`;
  info.append(name, sub);
  link.append(info);
  return link;
}

function render() {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 110;
  const sorted = [...allMessages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  messagesInner.replaceChildren();

  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="empty-symbol" aria-hidden="true"><span>✳</span></div><h2>첫 대화를 시작해 보세요</h2><p>메시지를 보내거나 파일을 올리면 이곳에 모두 함께 볼 수 있어요.</p>';
    messagesInner.append(empty);
  }

  let lastDay = '';
  for (const message of sorted) {
    const day = new Date(message.createdAt).toDateString();
    if (day !== lastDay) {
      const separator = document.createElement('div');
      separator.className = 'day-separator';
      separator.textContent = formatDay(message.createdAt);
      messagesInner.append(separator);
      lastDay = day;
    }
    const row = document.createElement('article');
    row.className = 'message';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = message.name.slice(0, 1).toUpperCase();
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = message.name;
    const time = document.createElement('time');
    time.dateTime = message.createdAt;
    time.textContent = formatTime(message.createdAt);
    meta.append(author, time);
    body.append(meta);
    if (message.type === 'file') body.append(fileLink(message));
    else {
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = message.text;
      body.append(text);
    }
    row.append(avatar, body);
    messagesInner.append(row);
  }

  renderFiles();
  if (nearBottom || sorted.length <= 1) requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
}

function renderFiles() {
  fileList.replaceChildren();
  const files = (sharedFiles || [...allMessages.values()].filter(message => message.type === 'file')).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'file-list-empty';
    empty.textContent = '아직 공유된 파일이 없어요.';
    fileList.append(empty);
  } else files.forEach(message => fileList.append(fileLink(message, true)));
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function clearError() { errorBanner.hidden = true; }

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '잠시 후 다시 시도해 주세요.');
  return data;
}

// 큰 파일은 오래 걸리므로 fetch 대신 XHR로 올려 진행률을 보여 준다.
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ name: nameInput.value, filename: file.name });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files?${params}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', event => { if (event.lengthComputable) onProgress(event.loaded / event.total); });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || '업로드에 실패했습니다.'));
    });
    xhr.addEventListener('error', () => reject(new Error('연결이 끊겨 업로드하지 못했습니다.')));
    xhr.send(file);
  });
}

async function loadMessages() {
  try {
    const data = await request('/api/messages');
    data.messages.forEach(message => allMessages.set(message.id, message));
    render();
    clearError();
  } catch (error) { showError('대화를 불러오지 못했습니다. 연결을 확인한 뒤 새로고침해 주세요.'); }
}

function connect() {
  const events = new EventSource('/api/events');
  events.onopen = () => {
    connection.classList.add('online');
    connectionText.textContent = '실시간 연결됨';
    loadMessages();
  };
  events.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      allMessages.set(message.id, message);
      if (sharedFiles && message.type === 'file' && !sharedFiles.some(file => file.id === message.id)) sharedFiles.push(message);
      render();
    } catch { /* Ignore malformed event and recover on reconnect. */ }
  };
  events.onerror = () => {
    connection.classList.remove('online');
    connectionText.textContent = '재연결 중';
  };
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  fileInput.disabled = value;
  attachButton.disabled = value;
  sendButton.classList.toggle('busy', value);
}

composer.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const text = messageInput.value.trim();
  if (!text) return;
  setBusy(true);
  clearError();
  try {
    const data = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameInput.value, text }) });
    allMessages.set(data.message.id, data.message);
    messageInput.value = '';
    messageInput.style.height = '';
    render();
  } catch (error) { showError(error.message || '메시지를 보내지 못했습니다.'); }
  finally { setBusy(false); messageInput.focus(); }
});

messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
});

async function uploadFiles(files) {
  const queued = Array.from(files || []);
  if (!queued.length || busy) return;
  setBusy(true);
  clearError();
  const errors = [];
  try {
    for (const [index, file] of queued.entries()) {
      const label = `파일 ${index + 1}/${queued.length} 업로드 중…`;
      uploadStatus.textContent = label;
      if (!file.size) {
        errors.push(`${file.name}: 빈 파일은 올릴 수 없습니다.`);
        continue;
      }
      try {
        const result = await uploadFile(file, ratio => { uploadStatus.textContent = `${label} ${Math.floor(ratio * 100)}%`; });
        allMessages.set(result.message.id, result.message);
        if (sharedFiles && !sharedFiles.some(item => item.id === result.message.id)) sharedFiles.push(result.message);
        render();
      } catch (error) { errors.push(`${file.name}: ${error.message || '업로드에 실패했습니다.'}`); }
    }
  } finally {
    setBusy(false);
    fileInput.value = '';
    uploadStatus.textContent = 'Enter 전송 · Shift + Enter 줄바꿈';
    if (errors.length) showError(errors.join(' '));
  }
}

attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => uploadFiles(fileInput.files));

let dragDepth = 0;
function isFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
function hideDropOverlay() { dragDepth = 0; dropOverlay.hidden = true; }
document.addEventListener('dragenter', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
});
document.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  dropOverlay.hidden = false;
});
document.addEventListener('dragleave', event => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth || !event.relatedTarget) hideDropOverlay();
});
document.addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  hideDropOverlay();
  uploadFiles(event.dataTransfer.files);
});
document.addEventListener('dragend', hideDropOverlay);
window.addEventListener('blur', hideDropOverlay);

async function setDrawer(open) {
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  backdrop.hidden = !open;
  if (open) {
    document.getElementById('drawer-close').focus();
    try {
      sharedFiles = (await request('/api/files')).files;
      renderFiles();
    } catch { showError('공유 파일 목록을 불러오지 못했습니다.'); }
  }
  else document.getElementById('files-button').focus();
}
document.getElementById('files-button').addEventListener('click', () => setDrawer(true));
document.getElementById('drawer-close').addEventListener('click', () => setDrawer(false));
backdrop.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && drawer.classList.contains('open')) setDrawer(false); });

render();
connect();
