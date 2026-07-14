(function () {
  const WIDGET_ID = 'platform-ai-chat-assistant-widget';
  const currentScript = document.currentScript;

  function findEmbedScript() {
    if (currentScript && currentScript.src) return currentScript;
    const scripts = Array.from(document.scripts);
    return scripts.reverse().find((script) => script.src && /\/embed\.js(?:[?#].*)?$/.test(script.src));
  }

  const embedScriptElement = findEmbedScript();
  const clientId = embedScriptElement?.dataset?.clientId || '';
  const embedToken = embedScriptElement?.dataset?.embedToken || '';
  const siteUrl = window.location.origin;

  function looksLikeLeakedScript(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    const hasScriptSyntax = /(?:window|document)\.(?:addEventListener|querySelectorAll|getElementById)|setTimeout|=>/.test(normalized);
    const hasUrbanWearScript = /feather\.replace|Scroll Header Effect|Add to Cart Logic|\.add-cart|scrollTop/.test(normalized);

    return hasScriptSyntax && hasUrbanWearScript;
  }

  function removeLeakedScriptText() {
    if (!document.body) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const leakedNodes = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (looksLikeLeakedScript(node.textContent)) {
        leakedNodes.push(node);
      }
    }

    leakedNodes.forEach((node) => {
      const parent = node.parentElement;
      node.remove();

      if (
        parent &&
        parent !== document.body &&
        !parent.children.length &&
        !parent.textContent.trim()
      ) {
        parent.remove();
      }
    });
  }

  function getScriptBaseUrl() {
    if (embedScriptElement && embedScriptElement.src) {
      const scriptUrl = new URL(embedScriptElement.src, window.location.href);
      scriptUrl.pathname = scriptUrl.pathname.replace(/\/embed\.js$/, '/');
      scriptUrl.search = '';
      scriptUrl.hash = '';
      return scriptUrl.toString().replace(/\/$/, '');
    }

    return window.location.origin;
  }

  function injectWidget() {
    if (!document.body) {
      window.requestAnimationFrame(injectWidget);
      return;
    }

    if (document.getElementById(WIDGET_ID)) return;

    removeLeakedScriptText();

    const baseUrl = getScriptBaseUrl();
    const host = document.createElement('div');
    host.id = WIDGET_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '20px';
    host.style.width = '64px';
    host.style.height = '64px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: 64px;
        height: 64px;
        z-index: 2147483647;
        pointer-events: none;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .launcher {
        width: 64px;
        height: 64px;
        pointer-events: auto;
        border: 0;
        border-radius: 999px;
        padding: 0;
        background: transparent;
        box-shadow: 0 8px 28px rgba(0, 60, 180, 0.45), 0 2px 8px rgba(0,0,0,0.5);
        cursor: pointer;
        transition: transform 0.18s ease, box-shadow 0.18s ease;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .launcher:hover {
        transform: scale(1.08);
        box-shadow: 0 12px 40px rgba(0, 80, 220, 0.65), 0 4px 12px rgba(0,0,0,0.6);
      }

      .launcher-logo {
        width: 64px;
        height: 64px;
        border-radius: 999px;
        object-fit: cover;
        display: block;
        pointer-events: none;
      }

      .launcher-logo.is-hidden {
        display: none;
      }

      .launcher-close {
        display: none;
        width: 64px;
        height: 64px;
        align-items: center;
        justify-content: center;
        font: 700 22px/1 system-ui, sans-serif;
        color: #fff;
        background: radial-gradient(circle at 40% 35%, #1a2a4a 0%, #060c1a 70%);
        border-radius: 999px;
        border: 2px solid #1a50cc;
      }

      .launcher.is-open .launcher-logo { display: none; }
      .launcher.is-open .launcher-close { display: flex; }

      .frame {
        position: fixed;
        right: 20px;
        bottom: 84px;
        width: min(420px, calc(100vw - 40px));
        height: min(680px, calc(100vh - 120px));
        border: 1px solid rgba(31, 42, 42, 0.16);
        border-radius: 8px;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
        background: #ffffff;
        display: none;
        pointer-events: auto;
      }

      .frame.is-open {
        display: block;
      }

      @media (max-width: 480px) {
        :host {
          right: 14px;
          bottom: 14px;
        }

        .frame {
          right: 10px;
          bottom: 70px;
          width: calc(100vw - 20px);
          height: calc(100vh - 86px);
        }
      }
    `;

    const frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.title = 'LICONR AI Chat Assistant';
    const params = new URLSearchParams({ embed: '1' });
    if (clientId) params.set('clientId', clientId);
    if (embedToken) params.set('embedToken', embedToken);
    if (siteUrl) params.set('siteUrl', siteUrl);
    frame.src = `${baseUrl}/ai_chat.html?${params.toString()}`;
    frame.loading = 'lazy';
    frame.allow = 'clipboard-write';

    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.title = 'Open AI assistant';
    launcher.setAttribute('aria-label', 'Open AI assistant');
    launcher.setAttribute('aria-expanded', 'false');

    const logoImg = document.createElement('img');
    logoImg.className = 'launcher-logo';
    logoImg.src = `${baseUrl}/liconr-logo.png`;
    logoImg.alt = 'LICONR AI';
    logoImg.draggable = false;

    const closeSpan = document.createElement('span');
    closeSpan.className = 'launcher-close';
    closeSpan.setAttribute('aria-hidden', 'true');
    closeSpan.textContent = '✕';

    launcher.append(logoImg, closeSpan);

    // Try to fetch platform details (assistant name / image) and update the
    // launcher appearance if the platform has provided them. Non-blocking.
    (async function tryLoadPlatformAppearance() {
      try {
        if (!clientId) return;
        const params = new URLSearchParams({ clientId });
        if (embedToken) params.set('embedToken', embedToken);
        if (siteUrl) params.set('siteUrl', siteUrl);
        const res = await fetch(`${baseUrl}/api/platform/status?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        const platform = data?.platform;
        if (!platform) return;
        const name = platform.assistantName || platform.instituteName || 'AI Assistant';
        const image = platform.assistantImage || null;
        if (image) {
          logoImg.src = image;
        } else {
          logoImg.src = `${baseUrl}/liconr-logo.png`;
        }
        logoImg.alt = name;
        launcher.title = `Open ${name} assistant`;
        frame.title = `${name} — AI Assistant`;
        // Send appearance info to the iframe so the chat UI can use the
        // same assistant name and image immediately (avoids timing issues).
        try {
          const origin = new URL(baseUrl).origin;
          frame.addEventListener('load', () => {
            try {
              frame.contentWindow.postMessage({
                type: 'platformAppearance',
                assistantName: name,
                assistantImage: image,
                instituteName: platform.instituteName || ''
              }, origin);
            } catch (e) {
              // ignore
            }
          }, { once: true });
        } catch (e) {
          // ignore any URL parsing/postMessage errors
        }
      } catch (err) {
        // ignore errors silently
      }
    })();

    launcher.addEventListener('click', function () {
      const isOpen = frame.classList.toggle('is-open');
      launcher.classList.toggle('is-open', isOpen);
      launcher.title = isOpen ? 'Close AI assistant' : 'Open AI assistant';
      launcher.setAttribute('aria-label', launcher.title);
      launcher.setAttribute('aria-expanded', String(isOpen));
    });

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow) return;

      const data = event.data || {};
      if (data.type !== 'platformAssistantAction') return;
      if (data.action?.type !== 'redirect' || !data.action.url) return;

      try {
        const targetUrl = new URL(data.action.url, window.location.href);
        if (!['http:', 'https:'].includes(targetUrl.protocol)) return;
        window.location.assign(targetUrl.toString());
      } catch (error) {
        // Ignore invalid action URLs.
      }
    });

    root.append(style, frame, launcher);
    document.body.appendChild(host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectWidget, { once: true });
  } else {
    injectWidget();
  }
})();
