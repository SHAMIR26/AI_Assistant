const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const emptyState = document.querySelector('[data-empty-state]');
const platformForm = document.getElementById('platform-form');
const platformStatus = document.getElementById('platform-status');
const platformSummary = document.getElementById('platform-summary');
const setupDetails = document.getElementById('setup-details');
const embedCode = document.getElementById('embed-code');
const integrationCard = document.getElementById('integration-card');
const integrationCodeOutput = document.getElementById('integration-code-output');
const copyIntegrationCode = document.getElementById('copy-integration-code');
const integrationCopyStatus = document.getElementById('integration-copy-status');

const urlParams = new URLSearchParams(window.location.search);
const embeddedClientId = urlParams.get('clientId') || '';
const embeddedToken = urlParams.get('embedToken') || '';
const embeddedSiteUrl = urlParams.get('siteUrl') || '';
const isEmbedded = urlParams.get('embed') === '1';
let setupRefreshTimer = null;

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
    ? `Copy this code into ${instituteName}'s HTML before </body>, outside any existing <script>...</script> block.`
    : 'Ready to copy after setup.';
}

function hydratePlatformStatus(data, options = {}) {
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
  platformSummary.textContent = `Assistant is personalized for ${platform.instituteName} and answers only from platform materials.`;
  embedCode.textContent = integrationCode;
  showIntegrationCode(integrationCode, platform.instituteName);
  setupDetails.open = !isEmbedded && !data.configured;
}

copyIntegrationCode?.addEventListener('click', async () => {
  const code = integrationCodeOutput?.value || embedCode?.textContent || '';
  if (!code || code === 'Embed code appears after setup.') return;

  try {
    await navigator.clipboard.writeText(code);
    if (setupRefreshTimer) clearTimeout(setupRefreshTimer);
    integrationCopyStatus.textContent = 'Copied. Refreshing for the next platform...';
    copyIntegrationCode.textContent = 'Copied';
    setTimeout(() => {
      window.location.reload();
    }, 900);
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
    platformStatus.textContent = 'Saved. Refreshing for next platform';
    integrationCopyStatus.textContent = `Copy this code now and paste it as HTML outside any existing script block. This page will refresh for another platform registration in 15 seconds.`;
    addMessage('bot', `Setup saved for ${data.platform.instituteName}. Copy the integration code now and paste it as HTML outside any existing script block. The page will refresh for another platform registration in 15 seconds.`);
    setupRefreshTimer = setTimeout(() => {
      window.location.reload();
    }, 15000);
  } catch (error) {
    platformStatus.textContent = 'Setup failed';
    addMessage('bot', error.message || 'Could not save setup.');
    console.error(error);
  } finally {
    setPlatformFormDisabled(false);
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
