const chatWindow = document.getElementById('chat-window');
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

// Render the registration result card in the display box
function showResultCard({ instituteName, chatLink, integrationCode }) {
  emptyState?.classList.add('is-hidden');

  // Clear any previous result
  const existing = chatWindow.querySelector('.result-card');
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.className = 'result-card';
  card.style.cssText = 'display:grid;gap:18px;padding:22px;';

  // Title
  const title = document.createElement('strong');
  title.style.cssText = 'color:var(--accent);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em;';
  title.textContent = `${instituteName} — Registration complete`;
  card.appendChild(title);

  // Chat link section
  const chatLinkSection = document.createElement('div');
  chatLinkSection.style.cssText = 'display:grid;gap:7px;';

  const chatLinkLabel = document.createElement('strong');
  chatLinkLabel.style.cssText = 'font-size:0.88rem;color:var(--text);';
  chatLinkLabel.textContent = 'Platform chat link';

  const chatLinkRow = document.createElement('div');
  chatLinkRow.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';

  const chatLinkAnchor = document.createElement('a');
  chatLinkAnchor.href = chatLink;
  chatLinkAnchor.target = '_blank';
  chatLinkAnchor.rel = 'noopener';
  chatLinkAnchor.textContent = chatLink;
  chatLinkAnchor.style.cssText = 'color:var(--accent);font-size:0.85rem;word-break:break-all;flex:1;';

  const copyChatBtn = document.createElement('button');
  copyChatBtn.type = 'button';
  copyChatBtn.textContent = 'Copy link';
  copyChatBtn.style.cssText = 'min-height:34px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface-soft);color:var(--text-muted);font:inherit;font-size:0.82rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;';
  copyChatBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(chatLink);
      copyChatBtn.textContent = 'Copied!';
      setTimeout(() => { copyChatBtn.textContent = 'Copy link'; }, 2000);
    } catch {
      copyChatBtn.textContent = 'Copy failed';
    }
  });

  chatLinkRow.append(chatLinkAnchor, copyChatBtn);
  chatLinkSection.append(chatLinkLabel, chatLinkRow);
  const chatLinkHint = document.createElement('small');
  chatLinkHint.style.cssText = 'color:var(--text-muted);font-size:0.8rem;';
  chatLinkHint.textContent = 'Share this link with your platform users so they can chat with the AI assistant.';
  chatLinkSection.appendChild(chatLinkHint);
  card.appendChild(chatLinkSection);

  // Divider
  const hr = document.createElement('hr');
  hr.style.cssText = 'border:none;border-top:1px solid var(--line);margin:0;';
  card.appendChild(hr);

  // Integration snippet section
  const snippetSection = document.createElement('div');
  snippetSection.style.cssText = 'display:grid;gap:7px;';

  const snippetLabel = document.createElement('strong');
  snippetLabel.style.cssText = 'font-size:0.88rem;color:var(--text);';
  snippetLabel.textContent = 'Website integration snippet';

  const snippetHint = document.createElement('small');
  snippetHint.style.cssText = 'color:var(--text-muted);font-size:0.8rem;';
  snippetHint.textContent = 'Paste this as HTML before the closing </body> tag, outside any existing script block.';

  const snippetBox = document.createElement('code');
  snippetBox.style.cssText = 'display:block;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:#0d0d0d;color:var(--text-muted);font-size:0.82rem;line-height:1.55;overflow-x:auto;white-space:pre;word-break:break-all;';
  snippetBox.textContent = integrationCode;

  const copySnippetBtn = document.createElement('button');
  copySnippetBtn.type = 'button';
  copySnippetBtn.textContent = 'Copy snippet';
  copySnippetBtn.style.cssText = 'justify-self:start;min-height:36px;padding:0 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-size:0.88rem;font-weight:800;cursor:pointer;';
  copySnippetBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(integrationCode);
      copySnippetBtn.textContent = 'Copied!';
      setTimeout(() => { copySnippetBtn.textContent = 'Copy snippet'; }, 2000);
    } catch {
      snippetBox.focus();
      snippetBox.select?.();
    }
  });

  snippetSection.append(snippetLabel, snippetHint, snippetBox, copySnippetBtn);
  card.appendChild(snippetSection);

  chatWindow.appendChild(card);
  chatWindow.scrollTop = chatWindow.scrollHeight;
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

  const payload = {
    instituteName: formData.get('instituteName'),
    platformUrl: formData.get('platformUrl'),
    ownerEmail: formData.get('ownerEmail'),
    contactName: formData.get('contactName'),
    organizationType: formData.get('organizationType'),
    servicePlan: formData.get('servicePlan'),
    platformSummary: formData.get('platformSummary'),
    platformActivities: formData.get('platformActivities'),
    termsAccepted: formData.get('termsAccepted') === 'on'
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
        embedScript: data.embedScript,
        integrationCode: data.integrationCode,
        knowledge: data.knowledge
      }
    }, { showSavedPlatform: true });
    platformForm.reset();

    const chatLink = `${window.location.origin}/ai_chat.html?clientId=${data.platform.clientId}`;
    platformStatus.textContent = 'Saved. Refreshing for next platform in 15 seconds';
    integrationCopyStatus.textContent = `Copy this code now and paste it as HTML outside any existing script block. This page will refresh for another platform registration in 15 seconds.`;

    // Show integration snippet and chat link in the result display box
    showResultCard({
      instituteName: data.platform.instituteName,
      chatLink,
      integrationCode: data.integrationCode || `<script src="${data.embedScript}" async defer></script>`
    });

    setupRefreshTimer = setTimeout(() => {
      window.location.reload();
    }, 15000);
  } catch (error) {
    platformStatus.textContent = 'Setup failed';
    // Show error in the result box
    emptyState?.classList.add('is-hidden');
    const existing = chatWindow.querySelector('.result-card');
    if (existing) existing.remove();
    const errCard = document.createElement('div');
    errCard.className = 'result-card message bot';
    errCard.style.cssText = 'align-self:flex-start;';
    errCard.innerHTML = `<strong style="color:var(--accent);font-size:0.78rem;text-transform:uppercase;">Error</strong><span>${error.message || 'Could not save setup.'}</span>`;
    chatWindow.appendChild(errCard);
    console.error(error);
  } finally {
    setPlatformFormDisabled(false);
  }
});

loadPlatformStatus();