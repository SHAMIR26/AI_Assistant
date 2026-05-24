const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const emptyState = document.querySelector('[data-empty-state]');
const ragStatus = document.getElementById('rag-status');
const ragRefresh = document.getElementById('rag-refresh');
const platformForm = document.getElementById('platform-form');
const platformStatus = document.getElementById('platform-status');
const platformSummary = document.getElementById('platform-summary');
const setupDetails = document.getElementById('setup-details');
const embedCode = document.getElementById('embed-code');
const integrationCard = document.getElementById('integration-card');
const integrationCodeOutput = document.getElementById('integration-code-output');
const copyIntegrationCode = document.getElementById('copy-integration-code');
const integrationCopyStatus = document.getElementById('integration-copy-status');
const platformRegistry = document.getElementById('platform-registry');
const registryCount = document.getElementById('registry-count');

const urlParams = new URLSearchParams(window.location.search);
const embeddedClientId = urlParams.get('clientId') || '';
const embeddedToken = urlParams.get('embedToken') || '';
const embeddedSiteUrl = urlParams.get('siteUrl') || '';
const isEmbedded = urlParams.get('embed') === '1';
const lastSetupKey = 'redulix:last-platform-setup';

if (isEmbedded) {
  document.body.classList.add('is-embedded');
}

function formatSourceList(sources = []) {
  if (!sources.length) return '';

  const uniqueSources = [...new Set(sources.map((source) => source.source))];
  return `\n\nSources: ${uniqueSources.join(', ')}`;
}

function addMessage(role, text, sources = []) {
  emptyState?.classList.add('is-hidden');

  const bubble = document.createElement('div');
  bubble.className = `message ${role}`;

  const label = document.createElement('strong');
  label.textContent = role === 'user' ? 'You' : 'Assistant';

  const content = document.createElement('span');
  content.textContent = text;

  bubble.append(label, content);

  const sourceText = formatSourceList(sources);
  if (sourceText) {
    const sourceList = document.createElement('small');
    sourceList.className = 'message-sources';
    sourceList.textContent = sourceText.trim();
    bubble.appendChild(sourceList);
  }

  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function setLoading(isLoading) {
  chatInput.disabled = isLoading;
  chatForm.querySelector('button').disabled = isLoading;
}

async function loadRagStatus() {
  if (!ragStatus) return;

  try {
    const response = await fetch('/api/rag/status');
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load knowledge base status.');
    }

    ragStatus.textContent = data.enabled
      ? `${data.chunkCount} knowledge chunks`
      : 'Knowledge disabled';
  } catch (error) {
    ragStatus.textContent = 'Knowledge unavailable';
    console.error(error);
  }
}

function setPlatformFormDisabled(isDisabled) {
  platformForm.querySelectorAll('input, textarea, button').forEach((field) => {
    if (field === copyIntegrationCode || field === integrationCodeOutput) return;
    field.disabled = isDisabled;
  });
}

function showIntegrationCode(code, instituteName = 'the client') {
  if (!integrationCard || !integrationCodeOutput || !copyIntegrationCode || !integrationCopyStatus) return;

  const hasCode = Boolean(code);
  integrationCard.hidden = !hasCode;
  integrationCodeOutput.value = code || '';
  copyIntegrationCode.disabled = !hasCode;
  integrationCopyStatus.textContent = hasCode
    ? `Copy this code and paste it into ${instituteName}'s website files before </body>.`
    : 'Ready to copy after setup.';
}

function restoreLastSetupCode() {
  if (isEmbedded) return;

  try {
    const setup = JSON.parse(sessionStorage.getItem(lastSetupKey) || 'null');
    if (!setup?.integrationCode) return;

    showIntegrationCode(setup.integrationCode, setup.instituteName || 'the client');
    platformStatus.textContent = 'Ready to register another platform';
  } catch (error) {
    sessionStorage.removeItem(lastSetupKey);
  }
}

function renderPlatformRegistry(platforms = []) {
  if (!platformRegistry || !registryCount) return;

  registryCount.textContent = `${platforms.length} website${platforms.length === 1 ? '' : 's'}`;
  platformRegistry.innerHTML = '';

  if (!platforms.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No websites have been registered yet.';
    platformRegistry.appendChild(empty);
    return;
  }

  platforms.forEach((platform) => {
    const card = document.createElement('article');
    card.className = 'registry-card';

    const title = document.createElement('strong');
    title.textContent = platform.instituteName;

    const url = document.createElement('span');
    url.textContent = platform.platformUrl;

    const client = document.createElement('small');
    client.textContent = `Client code: ${platform.clientId}`;

    const code = document.createElement('code');
    code.textContent = platform.integrationCode || 'Integration code unavailable';

    card.append(title, url, client, code);
    platformRegistry.appendChild(card);
  });
}

function hydratePlatformStatus(data, options = {}) {
  if (Array.isArray(data.platforms)) {
    renderPlatformRegistry(data.platforms);
  }

  if (!isEmbedded && !options.showSavedPlatform) {
    platformStatus.textContent = 'Ready to register a platform';
    embedCode.textContent = 'Embed code appears after setup.';
    showIntegrationCode('');
    setupDetails.open = true;
    return;
  }

  if (!data.configured) {
    platformStatus.textContent = 'Not configured';
    embedCode.textContent = 'Embed code appears after setup.';
    showIntegrationCode('');
    return;
  }

  const platform = data.platform;
  const integrationCode = platform.integrationCode || `<script src="${platform.embedScript}" async defer></script>`;
  platformStatus.textContent = `${platform.instituteName} configured`;
  const knowledgeText = platform.knowledge?.pageCount
    ? ` Collected ${platform.knowledge.pageCount} page${platform.knowledge.pageCount === 1 ? '' : 's'} into ${platform.knowledge.textFile}.`
    : '';
  platformSummary.textContent = `Assistant is personalized for ${platform.instituteName} and answers only from platform materials.${knowledgeText}`;
  embedCode.textContent = integrationCode;
  showIntegrationCode(integrationCode, platform.instituteName);
  setupDetails.open = !isEmbedded && !data.configured;
}

copyIntegrationCode?.addEventListener('click', async () => {
  const code = integrationCodeOutput?.value || embedCode?.textContent || '';
  if (!code || code === 'Embed code appears after setup.') return;

  try {
    await navigator.clipboard.writeText(code);
    sessionStorage.removeItem(lastSetupKey);
    integrationCopyStatus.textContent = 'Copied. Paste it before </body> in the client website.';
    copyIntegrationCode.textContent = 'Copied';
    setTimeout(() => {
      copyIntegrationCode.textContent = 'Copy code';
    }, 1800);
  } catch (error) {
    integrationCodeOutput?.focus();
    integrationCodeOutput?.select();
    integrationCopyStatus.textContent = 'Select the code above and copy it manually.';
  }
});

async function loadPlatformStatus() {
  try {
    const statusParams = new URLSearchParams();
    if (embeddedClientId) statusParams.set('clientId', embeddedClientId);
    if (embeddedToken) statusParams.set('embedToken', embeddedToken);
    if (embeddedSiteUrl) statusParams.set('siteUrl', embeddedSiteUrl);
    const query = statusParams.toString() ? `?${statusParams.toString()}` : '';
    const response = await fetch(`/api/platform/status${query}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load platform status.');
    }

    hydratePlatformStatus(data);
    restoreLastSetupCode();
  } catch (error) {
    platformStatus.textContent = 'Setup unavailable';
    console.error(error);
  }
}

platformForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(platformForm);
  const permissions = {
    ownerApproval: formData.get('ownerApproval') === 'on',
    storePlatformInfo: formData.get('storePlatformInfo') === 'on'
  };

  const payload = {
    instituteName: formData.get('instituteName'),
    platformUrl: formData.get('platformUrl'),
    ownerEmail: formData.get('ownerEmail'),
    contactName: formData.get('contactName'),
    organizationType: formData.get('organizationType'),
    servicePlan: formData.get('servicePlan'),
    platformSummary: formData.get('platformSummary'),
    platformActivities: formData.get('platformActivities'),
    termsAccepted: formData.get('termsAccepted') === 'on',
    permissions
  };

  setPlatformFormDisabled(true);
  platformStatus.textContent = 'Saving setup...';

  try {
    const response = await fetch('/api/platform/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not save platform setup.');
    }

    hydratePlatformStatus({
      configured: true,
      platforms: data.platforms,
      platform: {
        ...data.platform,
        contactName: payload.contactName,
        organizationType: payload.organizationType,
        servicePlan: payload.servicePlan,
        permissions,
        embedScript: data.embedScript,
        integrationCode: data.integrationCode,
        knowledge: data.knowledge
      }
    }, { showSavedPlatform: true });
    platformForm.reset();
    platformStatus.textContent = 'Saved. Ready for next platform';
    if (ragStatus) ragStatus.textContent = `${data.chunkCount} knowledge chunks`;
    addMessage('bot', `Setup saved for ${data.platform.instituteName}. Here is the integration code to copy into the client's website files before </body>:\n\n${data.integrationCode}`);
    sessionStorage.setItem(lastSetupKey, JSON.stringify({
      instituteName: data.platform.instituteName,
      integrationCode: data.integrationCode
    }));
    setTimeout(() => {
      window.location.reload();
    }, 3500);
  } catch (error) {
    platformStatus.textContent = 'Setup failed';
    addMessage('bot', error.message || 'Could not save setup.');
    console.error(error);
  } finally {
    setPlatformFormDisabled(false);
  }
});

ragRefresh?.addEventListener('click', async () => {
  ragRefresh.disabled = true;
  ragStatus.textContent = 'Refreshing knowledge...';

  try {
    const response = await fetch('/api/rag/reindex', { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not refresh knowledge base.');
    }

    ragStatus.textContent = `${data.chunkCount} knowledge chunks`;
  } catch (error) {
    ragStatus.textContent = 'Refresh failed';
    console.error(error);
  } finally {
    ragRefresh.disabled = false;
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  addMessage('user', message);
  chatInput.value = '';
  setLoading(true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        clientId: embeddedClientId,
        embedToken: embeddedToken,
        siteUrl: embeddedSiteUrl
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Server error');
    }

    addMessage('bot', data.reply || 'No reply from server.', data.sources);
  } catch (error) {
    addMessage('bot', error.message || 'There was an error sending your message.');
    console.error(error);
  } finally {
    setLoading(false);
  }
});

loadPlatformStatus();
loadRagStatus();
