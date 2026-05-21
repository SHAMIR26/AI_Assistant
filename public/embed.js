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

  function getScriptOrigin() {
    if (embedScriptElement && embedScriptElement.src) {
      return new URL(embedScriptElement.src, window.location.href).origin;
    }

    return window.location.origin;
  }

  function injectWidget() {
    if (!document.body || document.getElementById(WIDGET_ID)) return;

    const origin = getScriptOrigin();
    const host = document.createElement('div');
    host.id = WIDGET_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '20px';
    host.style.zIndex = '2147483647';

    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .launcher {
        width: 56px;
        height: 56px;
        border: 0;
        border-radius: 999px;
        padding: 0;
        background: #147c72;
        color: #ffffff;
        font: 700 26px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
        cursor: pointer;
      }

      .launcher:hover {
        background: #0b5f58;
      }

      .frame {
        position: fixed;
        right: 20px;
        bottom: 76px;
        width: min(420px, calc(100vw - 40px));
        height: min(680px, calc(100vh - 110px));
        border: 1px solid rgba(31, 42, 42, 0.16);
        border-radius: 8px;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
        background: #ffffff;
        display: none;
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
    frame.title = 'Platform chat assistant';
    const params = new URLSearchParams({ embed: '1' });
    if (clientId) params.set('clientId', clientId);
    if (embedToken) params.set('embedToken', embedToken);
    if (siteUrl) params.set('siteUrl', siteUrl);
    frame.src = `${origin}/?${params.toString()}`;
    frame.loading = 'lazy';
    frame.allow = 'clipboard-write';

    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.textContent = '🌍';
    launcher.title = 'Open AI assistant';
    launcher.setAttribute('aria-label', 'Open AI assistant');
    launcher.setAttribute('aria-expanded', 'false');

    launcher.addEventListener('click', function () {
      const isOpen = frame.classList.toggle('is-open');
      launcher.textContent = isOpen ? '×' : '🌍';
      launcher.title = isOpen ? 'Close AI assistant' : 'Open AI assistant';
      launcher.setAttribute('aria-label', launcher.title);
      launcher.setAttribute('aria-expanded', String(isOpen));
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
