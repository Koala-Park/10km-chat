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
const retentionNote = document.getElementById('retention-note');
const attachmentsEl = document.getElementById('attachments');
const defaultPlaceholder = messageInput.placeholder;
const defaultHint = uploadStatus.textContent;
const allMessages = new Map();
// 이미지 요소는 다시 그릴 때마다 새로 만들면 높이가 0으로 돌아가 화면이 튀므로 메시지별로 재사용한다.
const imageNodes = new Map();
let stickToBottom = true;
let busy = false;
let sharedFiles = null;
// 보내기 전에 입력창 위에 올려 둔 첨부 파일. 이미지는 blob 주소로 미리 보여 준다.
let pending = [];

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

function imagePreview(message) {
  let link = imageNodes.get(message.id);
  if (link) return link;
  link = document.createElement('a');
  link.className = 'image-preview';
  link.href = `/api/files/${encodeURIComponent(message.id)}/image`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = '원본 크기로 보기';
  const image = document.createElement('img');
  image.src = link.href;
  image.alt = message.filename;
  image.loading = 'lazy';
  image.decoding = 'async';
  // 이미지가 늦게 로드되며 높이가 생겨도 맨 아래를 보고 있었다면 계속 맨 아래에 둔다.
  image.addEventListener('load', () => { if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight; });
  image.addEventListener('error', () => link.classList.add('broken'));
  link.append(image);
  imageNodes.set(message.id, link);
  return link;
}

// 같은 사람이 한 번에 올린 파일(같은 batch)이 연달아 있으면 메시지 하나로 묶는다.
function groupMessages(sorted) {
  const groups = [];
  for (const message of sorted) {
    const last = groups.at(-1)?.at(-1);
    const sameBatch = message.batch && last?.batch === message.batch && last.name === message.name
      && new Date(last.createdAt).toDateString() === new Date(message.createdAt).toDateString();
    if (sameBatch) groups.at(-1).push(message);
    else groups.push([message]);
  }
  return groups;
}

function appendFiles(body, files) {
  const images = files.filter(file => file.imageType);
  if (images.length === 1) {
    imageNodes.get(images[0].id)?.classList.remove('tile');
    body.append(imagePreview(images[0]), fileLink(images[0]));
  } else if (images.length > 1) {
    const grid = document.createElement('div');
    grid.className = 'image-grid';
    grid.style.setProperty('--columns', images.length === 2 || images.length === 4 ? 2 : 3);
    for (const image of images) {
      const tile = imagePreview(image);
      tile.classList.add('tile');
      grid.append(tile);
    }
    const caption = document.createElement('p');
    caption.className = 'image-grid-caption';
    caption.textContent = `이미지 ${images.length}장 · ${formatSize(images.reduce((total, image) => total + image.size, 0))} · 눌러서 원본 보기`;
    body.append(grid, caption);
  }
  for (const file of files) if (!file.imageType) body.append(fileLink(file));
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
  for (const group of groupMessages(sorted)) {
    const [message] = group;
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
    // 파일과 함께 보낸 글은 같은 묶음이라 한 메시지 안에서 글을 먼저, 파일을 아래에 보여 준다.
    for (const item of group) {
      if (item.type !== 'text') continue;
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = item.text;
      body.append(text);
    }
    const files = group.filter(item => item.type === 'file');
    if (files.length) appendFiles(body, files);
    row.append(avatar, body);
    messagesInner.append(row);
  }

  for (const id of imageNodes.keys()) if (!allMessages.has(id)) imageNodes.delete(id);
  renderFiles();
  if (nearBottom || sorted.length <= 1) {
    stickToBottom = true;
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }
}

messagesEl.addEventListener('scroll', () => {
  stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 110;
});

function formatDays(days) {
  return Number.isInteger(days) ? `${days}일` : `${Math.round(days * 24)}시간`;
}

function renderRetention(retention) {
  const { messageDays = 0, fileDays = 0 } = retention || {};
  const fileLimit = messageDays && fileDays ? Math.min(messageDays, fileDays) : messageDays || fileDays;
  let note = '';
  if (messageDays && fileLimit < messageDays) note = `대화는 ${formatDays(messageDays)}, 파일은 ${formatDays(fileLimit)} 뒤 자동 삭제`;
  else if (messageDays) note = `${formatDays(messageDays)} 지난 대화와 파일은 자동 삭제`;
  else if (fileDays) note = `파일은 ${formatDays(fileDays)} 뒤 자동 삭제`;
  retentionNote.textContent = note;
  retentionNote.hidden = !note;
}

function removeMessages(ids) {
  for (const id of ids) allMessages.delete(id);
  if (sharedFiles) sharedFiles = sharedFiles.filter(file => !ids.includes(file.id));
  render();
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
function uploadFile(file, batch, onProgress) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ name: nameInput.value, filename: file.name });
    if (batch) params.set('batch', batch);
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
    // 끊긴 동안 정리된 메시지가 남지 않도록 서버가 준 목록으로 통째로 바꾼다.
    allMessages.clear();
    data.messages.forEach(message => allMessages.set(message.id, message));
    renderRetention(data.retention);
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
  events.addEventListener('removed', event => {
    try { removeMessages(JSON.parse(event.data).ids); }
    catch { /* Ignore malformed event and recover on reconnect. */ }
  });
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
  renderAttachments();
}

function addMessage(message) {
  allMessages.set(message.id, message);
  if (sharedFiles && message.type === 'file' && !sharedFiles.some(item => item.id === message.id)) sharedFiles.push(message);
  render();
}

// crypto.randomUUID는 HTTPS에서만 쓸 수 있어 사내망 http 주소에서도 되는 getRandomValues로 만든다.
function newBatchId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function renderAttachments() {
  attachmentsEl.replaceChildren();
  attachmentsEl.hidden = !pending.length;
  messageInput.placeholder = pending.length ? '메시지를 덧붙이거나 Enter로 바로 보내기' : defaultPlaceholder;
  for (const item of pending) {
    const chip = document.createElement('div');
    chip.className = item.url ? 'attachment image' : 'attachment';
    chip.title = `${item.file.name} · ${formatSize(item.file.size)}`;
    if (item.url) {
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = item.file.name;
      // HEIC처럼 브라우저가 못 그리는 이미지는 파일 아이콘으로 대신한다.
      image.addEventListener('error', () => { chip.classList.remove('image'); image.replaceWith(iconFile()); });
      chip.append(image);
    } else {
      const info = document.createElement('span');
      info.className = 'file-info';
      const name = document.createElement('strong');
      name.textContent = item.file.name;
      const size = document.createElement('small');
      size.textContent = formatSize(item.file.size);
      info.append(name, size);
      chip.append(iconFile(), info);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.disabled = busy;
    remove.setAttribute('aria-label', `${item.file.name} 첨부 빼기`);
    remove.addEventListener('click', () => { removeAttachment(item); messageInput.focus(); });
    chip.append(remove);
    attachmentsEl.append(chip);
  }
}

function addAttachments(files) {
  const added = Array.from(files || []);
  if (!added.length) return;
  clearError();
  const empty = added.filter(file => !file.size);
  for (const file of added) {
    if (file.size) pending.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
  }
  if (empty.length) showError(`${empty.map(file => file.name).join(', ')}: 빈 파일은 올릴 수 없습니다.`);
  renderAttachments();
  messageInput.focus();
}

function removeAttachment(item) {
  if (item.url) URL.revokeObjectURL(item.url);
  pending = pending.filter(entry => entry !== item);
  renderAttachments();
}

// 슬랙처럼 첨부를 먼저 올리고 글을 같은 묶음으로 보낸다. 올리지 못한 파일이 있으면 글은 보내지 않고 남겨 둔다.
composer.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const text = messageInput.value.trim();
  const queued = pending.slice();
  if (!text && !queued.length) return;
  setBusy(true);
  clearError();
  const batch = queued.length > 1 || (queued.length && text) ? newBatchId() : null;
  const failed = [];
  try {
    for (const [index, item] of queued.entries()) {
      const label = `파일 ${index + 1}/${queued.length} 업로드 중…`;
      uploadStatus.textContent = label;
      try {
        const result = await uploadFile(item.file, batch, ratio => { uploadStatus.textContent = `${label} ${Math.floor(ratio * 100)}%`; });
        addMessage(result.message);
        removeAttachment(item);
      } catch (error) { failed.push(`${item.file.name}: ${error.message || '업로드에 실패했습니다.'}`); }
    }
    if (failed.length) throw new Error(`${failed.join(' ')} 올리지 못한 파일은 입력창 위에 남겨 두었어요.`);
    if (text) {
      const data = await request('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameInput.value, text, batch }) });
      addMessage(data.message);
      messageInput.value = '';
      messageInput.style.height = '';
    }
  } catch (error) { showError(error.message || '메시지를 보내지 못했습니다.'); }
  finally {
    setBusy(false);
    uploadStatus.textContent = defaultHint;
    messageInput.focus();
  }
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

// 클립보드 이미지는 브라우저마다 image.png 같은 이름으로 들어오므로 보낸 시각을 붙여 구분한다.
function pastedFile(file, index) {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const extension = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\W.*$/, '');
  const pad = value => String(value).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return new File([file], `붙여넣은 이미지 ${stamp}${index ? ` (${index + 1})` : ''}.${extension}`, { type: file.type });
}

// 스크린샷처럼 클립보드에 파일만 있으면 첨부로 올려 둔다. 글자도 함께 있으면(엑셀 셀 복사 등) 평소처럼 글자를 붙여 넣는다.
document.addEventListener('paste', event => {
  const data = event.clipboardData;
  if (!data?.files.length || data.types.includes('text/plain')) return;
  event.preventDefault();
  addAttachments(Array.from(data.files, pastedFile));
});

attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addAttachments(fileInput.files);
  fileInput.value = '';
});

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
  addAttachments(event.dataTransfer.files);
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
