const chatWindow = document.getElementById('chat-window');
const emptyState = document.querySelector('[data-empty-state]');
const platformForm = document.getElementById('platform-form');
// The following elements are optional — they exist only on some pages
const platformStatus = document.getElementById('platform-status') || null;
const platformSummary = document.getElementById('platform-summary') || null;
const setupDetails = document.querySelector('.setup-details') || null;
const embedCode = document.getElementById('embed-code') || null;
const integrationCard = document.getElementById('integration-card');
const integrationCodeOutput = document.getElementById('integration-code-output');
const copyIntegrationCode = document.getElementById('copy-integration-code');
const integrationCopyStatus = document.getElementById('integration-copy-status');

const urlParams = new URLSearchParams(window.location.search);
const embeddedClientId = urlParams.get('clientId') || '';
const embeddedToken = urlParams.get('embedToken') || '';
const embeddedSiteUrl = urlParams.get('siteUrl') || '';
const isEmbedded = urlParams.get('embed') === '1';
const selectedPlan = urlParams.get('plan') || '';
const faqList = document.getElementById('faq-list');
const formError = document.getElementById('form-error');
const addFaqButton = document.getElementById('add-faq-button');
let faqIndex = 1;
let setupRefreshTimer = null;
let platformSetupAbortController = null;

function showFormError(message) {
  if (!formError) {
    alert(message);
    return;
  }
  formError.textContent = message;
  formError.style.display = 'block';
  formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearFormError() {
  if (!formError) return;
  formError.textContent = '';
  formError.style.display = 'none';
}

function refreshFaqLabels() {
  const items = Array.from(faqList?.querySelectorAll('.faq-item') || []);
  items.forEach((item, index) => {
    const questionLabel = item.querySelector('.faq-question-label');
    if (questionLabel) {
      questionLabel.firstChild.textContent = `${index + 1}. FAQ question`;
    }
  });
}

function attachFaqRemoveHandler(item) {
  const removeButton = item.querySelector('.faq-remove-button');
  if (!removeButton) return;

  removeButton.addEventListener('click', () => {
    item.remove();
    refreshFaqLabels();
  });
}

function createFaqItem() {
  faqIndex += 1;
  const item = document.createElement('div');
  item.className = 'faq-item';
  item.innerHTML = `
    <label class="faq-question-label">
      ${faqIndex}. FAQ question
      <input type="text" name="faqQuestion[]" placeholder="What should the assistant answer?" />
    </label>
    <label>
      Answer
      <textarea name="faqAnswer[]" rows="3" placeholder="Provide the answer the assistant should use."></textarea>
    </label>
    <button type="button" class="faq-remove-button">Remove</button>
  `;

  attachFaqRemoveHandler(item);
  faqList?.appendChild(item);
}

if (isEmbedded) {
  document.body.classList.add('is-embedded');
}

// If a plan was passed via URL, fix it and disable the select
if (selectedPlan) {
  const planSelect = document.getElementById('plan');
  if (planSelect) {
    planSelect.value = selectedPlan;
    planSelect.disabled = true;
    // Add visual styling to indicate it's locked
    planSelect.style.opacity = '0.7';
    planSelect.style.cursor = 'not-allowed';
    planSelect.style.background = 'rgba(255,255,255,0.02)';
  }
}

Array.from(faqList?.querySelectorAll('.faq-item') || []).forEach((item, index) => {
  faqIndex = Math.max(faqIndex, index + 1);
  attachFaqRemoveHandler(item);
});

addFaqButton?.addEventListener('click', createFaqItem);

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
  platformForm.querySelectorAll('input, select, textarea, button').forEach((field) => {
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
    if (platformStatus) platformStatus.textContent = 'Ready to register a platform';
    if (embedCode) embedCode.textContent = 'Embed code appears after setup.';
    showIntegrationCode('');
    if (setupDetails) setupDetails.open = true;
    return;
  }

  if (!data.configured) {
    if (platformStatus) platformStatus.textContent = 'Not configured';
    if (embedCode) embedCode.textContent = 'Embed code appears after setup.';
    showIntegrationCode('');
    return;
  }

  const platform = data.platform;
  const integrationCode = platform.integrationCode || `<script src="${platform.embedScript}" async defer></script>`;
  if (platformStatus) platformStatus.textContent = `${platform.instituteName} configured`;
  if (platformSummary) platformSummary.textContent = `Assistant is personalized for ${platform.instituteName} and answers only from platform materials.`;
  if (embedCode) embedCode.textContent = integrationCode;
  showIntegrationCode(integrationCode, platform.instituteName);
  if (setupDetails) setupDetails.open = !isEmbedded && !data.configured;
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

  // Prevent duplicate submissions while a request is in progress
  if (platformSetupAbortController) {
    console.warn('Setup request already in progress. Please wait.');
    return;
  }

  clearFormError();
  const formData = new FormData(platformForm);

  const faqQuestions = formData.getAll('faqQuestion[]').map((value) => String(value || '').trim());
  const faqAnswers = formData.getAll('faqAnswer[]').map((value) => String(value || '').trim());
  const faqItems = faqQuestions.map((question, index) => ({
    question,
    answer: faqAnswers[index] || ''
  }));
  const validFaqs = faqItems.filter((faq) => faq.question && faq.answer);
  const incompleteFaqCount = faqItems.filter((faq) => (faq.question && !faq.answer) || (!faq.question && faq.answer)).length;

  const requiredFields = ['instituteName', 'platformUrl', 'ownerEmail', 'contactName', 'organizationType', 'platformSummary'];
  const missingField = requiredFields.find((name) => !String(formData.get(name) || '').trim());
  if (missingField) {
    showFormError('Please complete every required field before continuing.');
    return;
  }

  if (incompleteFaqCount > 0) {
    showFormError('Please complete every FAQ with both a question and an answer.');
    return;
  }

  if (validFaqs.length < 3) {
    showFormError('Please provide at least 3 complete FAQs with answers.');
    return;
  }

  const faqs = validFaqs;
  // Read optional assistant fields (name + image). If an image is provided,
  // convert it to a data URL so the server can persist it as part of the
  // platform configuration (no multipart upload required).
  let assistantImageDataUrl = null;
  try {
    const assistantFile = formData.get('assistantImage');
    if (assistantFile && assistantFile.size) {
      assistantImageDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(assistantFile);
      });
    }
  } catch (err) {
    console.warn('Could not read assistant image:', err);
    assistantImageDataUrl = null;
  }

  const assistantName = String(formData.get('assistantName') || '').trim() || 'BLUENINE';

  const payload = {
    instituteName: formData.get('instituteName'),
    platformUrl: formData.get('platformUrl'),
    ownerEmail: formData.get('ownerEmail'),
    contactName: formData.get('contactName'),
    organizationType: formData.get('organizationType'),
    plan: formData.get('plan'),
    servicePlan: formData.get('servicePlan'),
    platformSummary: formData.get('platformSummary'),
    termsAccepted: formData.get('termsAccepted') === 'on',
    faqs,
    assistantName,
    assistantImage: assistantImageDataUrl
  };

  // Setup abort controller for this request.
  // 120 s gives plenty of headroom — the server responds immediately after
  // saving; background crawling does not block the HTTP response.
  platformSetupAbortController = new AbortController();
  const timeoutId = setTimeout(() => platformSetupAbortController.abort(), 120000);

  // Update UI to show loading state
  setPlatformFormDisabled(true);
  const submitBtn = document.getElementById('submit-btn-text');
  const submitSpinner = document.getElementById('submit-btn-spinner');
  const originalBtnText = submitBtn?.textContent || 'Save setup';
  if (submitBtn) submitBtn.textContent = 'Saving...';
  if (submitSpinner) submitSpinner.hidden = false;
  if (platformStatus) platformStatus.textContent = 'Saving setup…';

  try {
    const response = await fetch('/api/platform/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: platformSetupAbortController.signal
    });

    // Safe-parse: a proxy or server error may return an empty body or HTML,
    // which would cause JSON.parse to throw "Unexpected end of JSON input".
    let data;
    const rawText = await response.text();
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(
        response.ok
          ? 'Server returned an unreadable response. Please try again.'
          : `Server error ${response.status}: ${rawText.slice(0, 120) || 'No response body.'}`
      );
    }

    if (!response.ok) {
      throw new Error(data?.error || `Server error ${response.status}.`);
    }

    hydratePlatformStatus({
      configured: true,
      platforms: data.platforms,
      platform: {
        ...data.platform,
        contactName: payload.contactName,
        organizationType: payload.organizationType,
        plan: payload.plan,
        servicePlan: payload.servicePlan,
        embedScript: data.embedScript,
        integrationCode: data.integrationCode,
        knowledge: data.knowledge
      }
    }, { showSavedPlatform: true });
    platformForm.reset();

    const chatLink = `${window.location.origin}/ai_chat.html?clientId=${data.platform.clientId}`;
    if (platformStatus) platformStatus.textContent = 'Saved. Refreshing for next platform in 15 seconds';
    if (integrationCopyStatus) integrationCopyStatus.textContent = 'Copy this code now and paste it as HTML outside any existing script block. This page will refresh for another platform registration in 15 seconds.';

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
    if (platformStatus) platformStatus.textContent = 'Setup failed';
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
    // Clear timeout and abort controller
    clearTimeout(timeoutId);
    platformSetupAbortController = null;

    // Restore UI state
    setPlatformFormDisabled(false);
    const submitBtn = document.getElementById('submit-btn-text');
    const submitSpinner = document.getElementById('submit-btn-spinner');
    if (submitBtn) submitBtn.textContent = 'Save setup';
    if (submitSpinner) submitSpinner.hidden = true;
  }
});

loadPlatformStatus();