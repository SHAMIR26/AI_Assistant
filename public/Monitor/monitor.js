const lockPanel = document.getElementById('monitor-lock');
const dashboard = document.getElementById('monitor-dashboard');
const loginForm = document.getElementById('monitor-login-form');
const passwordInput = document.getElementById('monitor-password');
const loginStatus = document.getElementById('monitor-login-status');
const refreshButton = document.getElementById('monitor-refresh');
const logoutButton = document.getElementById('monitor-logout');
const updatedLabel = document.getElementById('monitor-updated');
const platformCount = document.getElementById('monitor-platform-count');
const activeCount = document.getElementById('monitor-active-count');
const fileCount = document.getElementById('monitor-file-count');
const chunkCount = document.getElementById('monitor-chunk-count');
const dataUpdated = document.getElementById('monitor-data-updated');
const ragUpdated = document.getElementById('monitor-rag-updated');
const websitesList = document.getElementById('monitor-websites');
const knowledgeList = document.getElementById('monitor-knowledge');
const logOutput = document.getElementById('monitor-log');

async function apiRequest(path, options = {}) {
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };

    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}.`);
    }

    return data;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Could not connect to the monitor API. Open this page from the running server, for example http://localhost:3000/monitor.');
    }
    throw error;
  }
}

function formatDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setAuthenticated(isAuthenticated) {
  lockPanel.hidden = isAuthenticated;
  dashboard.hidden = !isAuthenticated;
  if (!isAuthenticated) passwordInput.focus();
}

function renderEmpty(target, text) {
  target.innerHTML = '';
  const empty = document.createElement('p');
  empty.className = 'monitor-empty';
  empty.textContent = text;
  target.appendChild(empty);
}

function renderWebsites(websites = []) {
  if (!websites.length) {
    renderEmpty(websitesList, 'No client platforms are registered in Database/data.json yet.');
    return;
  }

  websitesList.innerHTML = '';
  websites.forEach((website) => {
    const item = document.createElement('article');
    item.className = 'monitor-list-item';

    const title = document.createElement('strong');
    title.textContent = website.instituteName || 'Unnamed platform';

    const link = document.createElement('a');
    link.href = website.websiteLink || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = website.websiteLink || 'No website link';

    const meta = document.createElement('span');
    meta.textContent = [
      website.status || 'unknown',
      website.clientId || 'no client id',
      website.knowledgeFile ? `knowledge: ${website.knowledgeFile}` : 'no knowledge file',
      website.conversationFile ? `conversations: ${website.conversationFile}` : 'no conversation file'
    ].join(' | ');

    item.append(title, link, meta);
    websitesList.appendChild(item);
  });
}

function renderKnowledge(files = []) {
  if (!files.length) {
    renderEmpty(knowledgeList, 'No files are currently stored in the knowledge folder.');
    return;
  }

  knowledgeList.innerHTML = '';
  files.forEach((file) => {
    const item = document.createElement('article');
    item.className = 'monitor-list-item';

    const title = document.createElement('strong');
    title.textContent = file.name;

    const meta = document.createElement('span');
    meta.textContent = `${formatSize(file.size)} | ${file.indexed ? 'indexed' : 'not indexed'} | updated ${formatDate(file.updatedAt)}`;

    item.append(title, meta);
    knowledgeList.appendChild(item);
  });
}

function renderSnapshot(snapshot) {
  const websites = snapshot.database?.websites || [];
  const knowledgeFiles = snapshot.knowledge?.files || [];

  updatedLabel.textContent = `Snapshot generated ${formatDate(snapshot.generatedAt)}`;
  platformCount.textContent = String(snapshot.behavior?.registeredCount ?? websites.length);
  activeCount.textContent = String(snapshot.behavior?.activeCount ?? 0);
  fileCount.textContent = String(knowledgeFiles.length);
  chunkCount.textContent = String(snapshot.knowledge?.chunkCount ?? 0);
  dataUpdated.textContent = `Data updated ${formatDate(snapshot.database?.updatedAt)}`;
  ragUpdated.textContent = `Index updated ${formatDate(snapshot.knowledge?.updatedAt)}`;
  logOutput.textContent = snapshot.behavior?.notificationLog?.trim() || 'No setup notifications have been recorded yet.';

  renderWebsites(websites);
  renderKnowledge(knowledgeFiles);
}

async function loadMonitorData() {
  refreshButton.disabled = true;
  loginStatus.textContent = '';

  try {
    const data = await apiRequest('/api/monitor/data');
    renderSnapshot(data);
    setAuthenticated(true);
  } catch (error) {
    setAuthenticated(false);
    loginStatus.textContent = error.message || 'Monitor is locked.';
  } finally {
    refreshButton.disabled = false;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginStatus.textContent = 'Checking password...';

  try {
    await apiRequest('/api/monitor/login', {
      method: 'POST',
      body: JSON.stringify({ password: passwordInput.value })
    });

    passwordInput.value = '';
    loginStatus.textContent = '';
    await loadMonitorData();
  } catch (error) {
    setAuthenticated(false);
    loginStatus.textContent = error.message || 'Incorrect monitor password.';
  }
});

refreshButton.addEventListener('click', loadMonitorData);

logoutButton.addEventListener('click', async () => {
  await apiRequest('/api/monitor/logout', { method: 'POST' }).catch(() => null);
  setAuthenticated(false);
});

apiRequest('/api/monitor/session')
  .then((data) => {
    if (data.authenticated) {
      return loadMonitorData();
    }
    setAuthenticated(false);
  })
  .catch((error) => {
    setAuthenticated(false);
    loginStatus.textContent = error.message;
  });
