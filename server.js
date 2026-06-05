const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { buildRagIndex, formatContext, retrieveRelevantChunks } = require('./rag');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';
const openAiApiKey = process.env.OPENAI_API_KEY || '';
const openAiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const configuredAiProvider = (process.env.AI_PROVIDER || '').toLowerCase();
const ragTopK = Number(process.env.RAG_TOP_K) || 4;
const ragEnabled = process.env.RAG_ENABLED !== 'false';
const defaultPlanLimits = {
  Mini: 100,
  Pro: 1000,
  Max: 5000
};
const databaseDir = path.join(__dirname, 'Database');
const knowledgeDir = path.join(__dirname, 'knowledge');
const crawlPageLimit = Math.max(1, Number(process.env.CRAWL_PAGE_LIMIT) || 12);
const crawlTimeoutMs = Math.max(1500, Number(process.env.CRAWL_TIMEOUT_MS) || 10000);
const monitorPassword = process.env.MONITOR_PASSWORD || 'S26112007';
const monitorSessionSecret = process.env.MONITOR_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const monitorSessionMaxAgeMs = 1000 * 60 * 60 * 8;

let ragIndex = {
  knowledgeDir,
  files: [],
  chunks: [],
  documentFrequency: new Map(),
  updatedAt: null
};

let platformConfig = null;
let organizationRegistry = [];

app.set('trust proxy', true);

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch (error) {
    return null;
  }
}

function getPublicBaseUrl(req) {
  const configuredUrl = normalizeUrl(process.env.PUBLIC_BASE_URL);
  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return cookies;
      cookies[decodeURIComponent(part.slice(0, separatorIndex))] = decodeURIComponent(part.slice(separatorIndex + 1));
      return cookies;
    }, {});
}

function signMonitorPayload(payload) {
  return crypto
    .createHmac('sha256', monitorSessionSecret)
    .update(payload)
    .digest('base64url');
}

function createMonitorToken() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + monitorSessionMaxAgeMs
  })).toString('base64url');
  return `${payload}.${signMonitorPayload(payload)}`;
}

function verifyMonitorToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return false;

  const expectedSignature = signMonitorPayload(payload);
  if (
    expectedSignature.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature))
  ) {
    return false;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(session.exp) > Date.now();
  } catch (error) {
    return false;
  }
}

function requireMonitorSession(req, res, next) {
  const cookies = parseCookies(req);
  if (!verifyMonitorToken(cookies.monitor_session)) {
    return res.status(401).json({ error: 'Monitor password is required.' });
  }
  next();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function ensureDatabaseDir() {
  await fs.mkdir(databaseDir, { recursive: true });
}

async function ensureKnowledgeDir() {
  await fs.mkdir(knowledgeDir, { recursive: true });
}

function safeSlug(value) {
  return String(value || 'organization')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'organization';
}

function platformStorageSlug(value) {
  const words = String(value || 'organization')
    .match(/[a-z0-9]+/gi);

  if (!words?.length) return 'Organization';

  return words
    .map((word) => {
      const normalized = word.toLowerCase();
      return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
    })
    .join('')
    .slice(0, 42) || 'Organization';
}

function getPlatformStoragePaths(platformNameOrOrganization) {
  const name = typeof platformNameOrOrganization === 'string'
    ? platformNameOrOrganization
    : platformNameOrOrganization?.instituteName || platformNameOrOrganization?.clientId || 'platform';
  const folderName = platformStorageSlug(name);
  const databasePlatformDir = path.join(databaseDir, folderName);
  const knowledgePlatformDir = path.join(knowledgeDir, folderName);

  return {
    folderName,
    databasePlatformDir,
    knowledgePlatformDir,
    basicInfoFile: 'basic_info.json',
    conversationFile: 'conversation.json',
    detailFile: 'detail.txt',
    basicInfoPath: path.join(databasePlatformDir, 'basic_info.json'),
    databaseConversationPath: path.join(databasePlatformDir, 'conversation.json'),
    knowledgeConversationPath: path.join(knowledgePlatformDir, 'conversation.json'),
    databaseDetailPath: path.join(databasePlatformDir, 'detail.txt'),
    knowledgeDetailPath: path.join(knowledgePlatformDir, 'detail.txt')
  };
}

async function ensurePlatformFolders(platformNameOrOrganization) {
  await ensureDatabaseDir();
  await ensureKnowledgeDir();

  const paths = getPlatformStoragePaths(platformNameOrOrganization);
  await Promise.all([
    fs.mkdir(paths.databasePlatformDir, { recursive: true }),
    fs.mkdir(paths.knowledgePlatformDir, { recursive: true })
  ]);

  return paths;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTagContent(html, tagName) {
  const matches = [];
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let match;

  while ((match = regex.exec(html)) !== null) {
    const text = stripHtml(match[1]);
    if (text) matches.push(text);
  }

  return matches;
}

function extractMetaContent(html, name) {
  const regex = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  return stripHtml(regex.exec(html)?.[1] || '');
}

function extractJsonLd(html) {
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const text = match[1].trim();
    if (!text) continue;
    try {
      blocks.push(JSON.parse(text));
    } catch (error) {
      blocks.push(text.slice(0, 4000));
    }
  }

  return blocks;
}

function extractSameOriginLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    try {
      const link = new URL(match[1], base);
      link.hash = '';
      if (link.origin === base.origin && ['http:', 'https:'].includes(link.protocol)) {
        links.push(link.toString());
      }
    } catch (error) {
      // Ignore malformed links found in client HTML.
    }
  }

  return links;
}

function pageToText(page) {
  return [
    `URL: ${page.url}`,
    page.title ? `Title: ${page.title}` : '',
    page.description ? `Description: ${page.description}` : '',
    page.headings?.length ? `Headings:\n${page.headings.map((heading) => `- ${heading}`).join('\n')}` : '',
    page.structuredData?.length ? `Structured data:\n${JSON.stringify(page.structuredData, null, 2)}` : '',
    page.text ? `Content:\n${page.text}` : ''
  ].filter(Boolean).join('\n\n');
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), crawlTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LICONR-AI-Assistant-Setup/1.0',
        Accept: 'text/html,application/xhtml+xml'
      }
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.toLowerCase().includes('text/html')) {
      return null;
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function collectWebsiteKnowledge(config) {
  const startUrl = normalizeUrl(config.platformUrl);
  const paths = await ensurePlatformFolders(config.instituteName || new URL(startUrl).hostname);
  const queued = [startUrl];
  const visited = new Set();
  const pages = [];

  while (queued.length && pages.length < crawlPageLimit) {
    const url = queued.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const html = await fetchHtml(url);
      if (!html) continue;

      const title = extractTagContent(html, 'title')[0] || '';
      const description = extractMetaContent(html, 'description') || extractMetaContent(html, 'og:description');
      const headings = ['h1', 'h2', 'h3']
        .flatMap((tagName) => extractTagContent(html, tagName))
        .slice(0, 40);
      const bodyText = stripHtml(html).slice(0, 18000);
      const jsonLd = extractJsonLd(html);

      pages.push({
        url,
        title,
        description,
        headings,
        text: bodyText,
        structuredData: jsonLd
      });

      for (const link of extractSameOriginLinks(html, url)) {
        if (visited.size + queued.length >= crawlPageLimit * 3) break;
        if (!visited.has(link) && !queued.includes(link)) queued.push(link);
      }
    } catch (error) {
      pages.push({
        url,
        error: error.name === 'AbortError' ? 'Fetch timed out' : (error.message || 'Fetch failed')
      });
    }
  }

  const collectedAt = new Date().toISOString();
  const record = {
    clientId: config.clientId,
    instituteName: config.instituteName,
    platformUrl: config.platformUrl,
    collectedAt,
    pageLimit: crawlPageLimit,
    pageCount: pages.length,
    pages
  };

  const textContent = [
    `# ${config.instituteName}`,
    `Platform URL: ${config.platformUrl}`,
    `Collected at: ${collectedAt}`,
    '',
    config.platformSummary ? `Platform summary:\n${config.platformSummary}` : '',
    '',
    pages.map(pageToText).join('\n\n---\n\n')
  ].filter(Boolean).join('\n');

  await Promise.all([
    fs.writeFile(paths.databaseDetailPath, `${textContent.trim()}\n`),
    fs.writeFile(paths.knowledgeDetailPath, `${textContent.trim()}\n`)
  ]);

  return {
    folder: paths.folderName,
    detailFile: `${paths.folderName}/${paths.detailFile}`,
    textFile: `${paths.folderName}/${paths.detailFile}`,
    jsonFile: null,
    pageCount: pages.length,
    collectedAt,
    errors: pages.filter((page) => page.error).map((page) => ({ url: page.url, error: page.error }))
  };
}

function createClientId(instituteName) {
  return `${safeSlug(instituteName)}-${crypto.randomBytes(4).toString('hex')}`;
}

function createEmbedToken() {
  return crypto.randomBytes(16).toString('hex');
}

function normalizePlan(value) {
  const plan = String(value || '').trim();
  return ['Mini', 'Pro', 'Max'].includes(plan) ? plan : 'Mini';
}

function getPlanLimit(plan) {
  const normalizedPlan = normalizePlan(plan);
  const configuredLimit = Number(process.env[`PLAN_LIMIT_${normalizedPlan.toUpperCase()}`]);
  if (Number.isFinite(configuredLimit) && configuredLimit >= 0) {
    return configuredLimit;
  }
  return defaultPlanLimits[normalizedPlan];
}

function getCurrentUsagePeriod(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStart = new Date(Date.UTC(year, month, 1));
  const periodEnd = new Date(Date.UTC(year, month + 1, 1));

  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    startedAt: periodStart.toISOString(),
    endsAt: periodEnd.toISOString()
  };
}

function normalizeUsage(organization, now = new Date()) {
  const plan = normalizePlan(organization?.plan);
  const limit = getPlanLimit(plan);
  const period = getCurrentUsagePeriod(now);
  const existingUsage = organization?.usage || {};
  const existingPeriod = existingUsage.periodKey === period.key ? existingUsage : {};

  return {
    plan,
    period: 'monthly',
    periodKey: period.key,
    periodStartedAt: period.startedAt,
    periodEndsAt: period.endsAt,
    messagesUsed: Math.max(0, Number(existingPeriod.messagesUsed) || 0),
    messagesLimit: limit,
    messagesRemaining: Math.max(0, limit - (Number(existingPeriod.messagesUsed) || 0)),
    updatedAt: existingPeriod.updatedAt || null
  };
}

function getUsageLimitResult(organization) {
  const usage = normalizeUsage(organization);
  return {
    usage,
    allowed: usage.messagesUsed < usage.messagesLimit
  };
}

async function writeOrganizationBasicInfo(organization) {
  const paths = await ensurePlatformFolders(organization);
  await fs.writeFile(paths.basicInfoPath, `${JSON.stringify(organization, null, 2)}\n`);
}

async function incrementPlatformUsage(organization) {
  if (!organization) return null;

  const usage = normalizeUsage(organization);
  const updatedUsage = {
    ...usage,
    messagesUsed: usage.messagesUsed + 1,
    messagesRemaining: Math.max(0, usage.messagesLimit - usage.messagesUsed - 1),
    updatedAt: new Date().toISOString()
  };

  organization.plan = normalizePlan(organization.plan);
  organization.usage = updatedUsage;
  organization.updatedAt = updatedUsage.updatedAt;

  const existingIndex = organizationRegistry.findIndex((item) => item.clientId === organization.clientId);
  if (existingIndex >= 0) {
    organizationRegistry[existingIndex] = organization;
  }

  await writeOrganizationBasicInfo(organization);
  return updatedUsage;
}

function getOrganizationByClientId(clientId) {
  return organizationRegistry.find((organization) => organization.clientId === clientId) || null;
}

function normalizeComparableOrigin(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  return url.origin.toLowerCase();
}

function getOrganizationBySiteUrl(siteUrl) {
  const origin = normalizeComparableOrigin(siteUrl);
  if (!origin) return null;

  return organizationRegistry.find((organization) => {
    return normalizeComparableOrigin(organization.platformUrl) === origin;
  }) || null;
}

function getOrganizationFromRequest(req) {
  const clientId = req.body?.clientId || req.query?.clientId;
  const embedToken = req.body?.embedToken || req.query?.embedToken;
  const siteUrl = req.body?.siteUrl || req.query?.siteUrl;
  const organization = clientId ? getOrganizationByClientId(clientId) : getOrganizationBySiteUrl(siteUrl);

  if (!organization) return null;
  if (embedToken && organization.embedToken && embedToken !== organization.embedToken) return null;

  return organization;
}

function buildEmbedScript(req, organization) {
  const baseUrl = getPublicBaseUrl(req);
  const clientIdAttribute = organization.clientId ? ` data-client-id="${organization.clientId}"` : '';
  const embedTokenAttribute = organization.embedToken ? ` data-embed-token="${organization.embedToken}"` : '';
  return [
    '<!-- Paste this as HTML before </body>, outside any existing <script> block. -->',
    `<script src="${baseUrl}/embed.js"${clientIdAttribute}${embedTokenAttribute} async defer></script>`
  ].join('\n');
}

function getConversationLogPaths(organization) {
  const paths = getPlatformStoragePaths(organization);
  return {
    slug: paths.folderName,
    folder: paths.folderName,
    jsonFile: `${paths.folderName}/${paths.conversationFile}`,
    textFile: `${paths.folderName}/${paths.conversationFile}`,
    databaseJsonPath: paths.databaseConversationPath,
    knowledgeJsonPath: paths.knowledgeConversationPath,
    jsonPath: paths.databaseConversationPath
  };
}

async function ensureConversationLog(organization) {
  await ensurePlatformFolders(organization);
  const paths = getConversationLogPaths(organization);
  const payload = {
    description: `AI chat conversations for ${organization.instituteName}.`,
    clientId: organization.clientId,
    instituteName: organization.instituteName,
    platformUrl: organization.platformUrl,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    conversations: []
  };

  for (const filePath of [paths.databaseJsonPath, paths.knowledgeJsonPath]) {
    try {
      await fs.access(filePath);
    } catch (error) {
      await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    }
  }

  return paths;
}

async function recordPlatformConversation(organization, entry) {
  if (!organization) return null;

  const paths = await ensureConversationLog(organization);
  const savedEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    clientId: organization.clientId,
    instituteName: organization.instituteName,
    platformUrl: organization.platformUrl,
    userMessage: entry.userMessage,
    assistantReply: entry.assistantReply,
    sources: entry.sources || [],
    request: entry.request || {}
  };

  const currentLog = await readJsonFile(paths.databaseJsonPath, {
    description: `AI chat conversations for ${organization.instituteName}.`,
    clientId: organization.clientId,
    instituteName: organization.instituteName,
    platformUrl: organization.platformUrl,
    createdAt: savedEntry.timestamp,
    conversations: []
  });
  currentLog.updatedAt = savedEntry.timestamp;
  currentLog.conversations = Array.isArray(currentLog.conversations) ? currentLog.conversations : [];
  currentLog.conversations.push(savedEntry);

  const content = `${JSON.stringify(currentLog, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(paths.databaseJsonPath, content),
    fs.writeFile(paths.knowledgeJsonPath, content)
  ]);

  return {
    jsonFile: paths.jsonFile,
    textFile: paths.textFile,
    updatedAt: savedEntry.timestamp
  };
}

async function loadOrganizationRegistry() {
  await ensureDatabaseDir();

  try {
    const entries = await fs.readdir(databaseDir, { withFileTypes: true });
    const organizations = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const basicInfoPath = path.join(databaseDir, entry.name, 'basic_info.json');
      try {
        const content = await fs.readFile(basicInfoPath, 'utf8');
        const organization = JSON.parse(content);
        if (organization?.clientId && organization?.platformUrl) {
          organization.plan = normalizePlan(organization.plan);
          organization.usage = normalizeUsage(organization);
          organizations.push(organization);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`Failed to load ${basicInfoPath}:`, error?.message || error);
        }
      }
    }

    organizationRegistry = organizations.sort((a, b) => {
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
    platformConfig = organizationRegistry[organizationRegistry.length - 1] || null;
  } catch (error) {
    console.error('Failed to load organization registry:', error?.message || error);
    organizationRegistry = [];
    platformConfig = null;
  }
}

async function saveOrganization(config) {
  const existingIndex = organizationRegistry.findIndex((organization) => organization.platformUrl === config.platformUrl);
  const previous = existingIndex >= 0 ? organizationRegistry[existingIndex] : null;
  const organization = {
    ...previous,
    ...config,
    clientId: previous?.clientId || config.clientId,
    embedToken: previous?.embedToken || config.embedToken,
    status: 'active',
    createdAt: previous?.createdAt || config.createdAt || new Date().toISOString(),
    updatedAt: config.updatedAt || new Date().toISOString()
  };
  organization.plan = normalizePlan(organization.plan);
  organization.usage = normalizeUsage(organization);
  const storagePaths = await ensurePlatformFolders(organization);
  await fs.writeFile(storagePaths.basicInfoPath, `${JSON.stringify(organization, null, 2)}\n`);

  const conversationLog = await ensureConversationLog(organization);
  organization.conversationLog = {
    jsonFile: conversationLog.jsonFile,
    textFile: conversationLog.textFile
  };
  organization.knowledge = {
    ...(organization.knowledge || {}),
    folder: storagePaths.folderName,
    conversationFile: `${storagePaths.folderName}/${storagePaths.conversationFile}`,
    detailFile: `${storagePaths.folderName}/${storagePaths.detailFile}`,
    textFile: `${storagePaths.folderName}/${storagePaths.detailFile}`
  };
  organization.usage = normalizeUsage(organization);
  await fs.writeFile(storagePaths.basicInfoPath, `${JSON.stringify(organization, null, 2)}\n`);

  if (existingIndex >= 0) {
    organizationRegistry[existingIndex] = organization;
  } else {
    organizationRegistry.push(organization);
  }

  platformConfig = organization;
  return organization;
}

async function collectAccessFiles(directoryPath, rootPath = directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectAccessFiles(fullPath, rootPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootPath, fullPath).replace(/\\/g, '/'));
    }
  }

  return files;
}

async function renderAccessDirectory(res, title, baseRoute, directoryPath) {
  try {
    const files = (await collectAccessFiles(directoryPath))
      .sort((a, b) => a.localeCompare(b));

    const fileLinks = files.length
      ? files.map((file) => {
          const href = `${baseRoute}/${file.split('/').map(encodeURIComponent).join('/')}`;
          return `<a class="access-card" href="${href}"><strong>${escapeHtml(file)}</strong><span>Open file</span></a>`;
        }).join('\n')
      : '<p class="integration-copy-status">No files found.</p>';

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="app-shell">
    <section class="chat-panel access-panel" aria-label="${escapeHtml(title)}">
      <header class="chat-header">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <a class="header-link" href="/access.html">Back to access</a>
        </div>
      </header>
      <section class="access-grid">
        ${fileLinks}
      </section>
    </section>
  </main>
</body>
</html>`);
  } catch (error) {
    res.status(500).type('html').send('Could not load files.');
  }
}

function sendAccessFile(res, rootDir, requestedPath) {
  const normalizedPath = path.normalize(requestedPath || '').replace(/^(\.\.(\\|\/|$))+/, '');
  const filePath = path.resolve(rootDir, normalizedPath);
  const resolvedRoot = path.resolve(rootDir);

  if (filePath !== resolvedRoot && filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return res.sendFile(filePath);
  }

  return res.status(404).send('File not found.');
}

function buildOwnerNotification(config) {
  return [
    `Time: ${new Date().toISOString()}`,
    `To: ${config.ownerEmail}`,
    `Subject: Chat assistant setup request for ${config.instituteName}`,
    `Client ID: ${config.clientId || 'Not assigned'}`,
    `Platform: ${config.platformUrl}`,
    `Organization type: ${config.organizationType || 'Not provided'}`,
    `Plan: ${config.plan || 'Mini'}`,
    `Service plan: ${config.servicePlan || 'Not provided'}`,
    `Contact: ${config.contactName || 'Not provided'}`,
    `Integration code: ${config.integrationCode || 'Not generated yet'}`,
    `Terms accepted: ${config.termsAccepted ? 'yes' : 'no'}`
  ].join('\n');
}

async function sendOwnerEmail(config, notificationText) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: config.ownerEmail,
    subject: `Chat assistant setup request for ${config.instituteName}`,
    text: `${notificationText}\n\nPaste the integration code before the closing </body> tag on the client website.`
  });

  return true;
}

async function notifyOwner(config) {
  const message = buildOwnerNotification(config);

  try {
    return await sendOwnerEmail(config, message);
  } catch (error) {
    console.error('Owner email failed:', error?.message || error);
    return false;
  }
}

async function refreshRagIndex() {
  ragIndex = await buildRagIndex({
    knowledgeDir,
    chunkSize: process.env.RAG_CHUNK_SIZE,
    chunkOverlap: process.env.RAG_CHUNK_OVERLAP
  });

  console.log(`RAG index ready: ${ragIndex.chunks.length} chunks from ${ragIndex.files.length} files.`);
  return ragIndex;
}

async function readJsonFile(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to read ${filePath}:`, error?.message || error);
    }
    return fallback;
  }
}

async function getKnowledgeInventory() {
  await ensureKnowledgeDir();
  const knowledgeFiles = await collectAccessFiles(knowledgeDir);
  const files = await Promise.all(knowledgeFiles
    .map(async (name) => {
      const filePath = path.join(knowledgeDir, name);
      const stats = await fs.stat(filePath);
      return {
        name,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        indexed: ragIndex.files.includes(name)
      };
    }));

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildMonitorSnapshot() {
  const knowledgeFiles = await getKnowledgeInventory();

  return {
    generatedAt: new Date().toISOString(),
    database: {
      directory: 'Database',
      platformFolders: organizationRegistry.map((organization) => ({
        folder: getPlatformStoragePaths(organization).folderName,
        basicInfoFile: `${getPlatformStoragePaths(organization).folderName}/basic_info.json`,
        conversationFile: organization.conversationLog?.jsonFile || `${getPlatformStoragePaths(organization).folderName}/conversation.json`,
        detailFile: `${getPlatformStoragePaths(organization).folderName}/detail.txt`
      }))
    },
    organizations: organizationRegistry,
    knowledge: {
      directory: 'knowledge',
      files: knowledgeFiles,
      indexedFileCount: ragIndex.files.length,
      chunkCount: ragIndex.chunks.length,
      updatedAt: ragIndex.updatedAt
    },
    behavior: {
      registeredCount: organizationRegistry.length,
      activeCount: organizationRegistry.filter((organization) => organization.status === 'active').length,
      latestRegistration: organizationRegistry[organizationRegistry.length - 1] || null
    }
  };
}

function buildPrompt(message, context, organization = null) {
  const platformBlock = organization
    ? `Current client platform:
Institute: ${organization.instituteName}
Platform URL: ${organization.platformUrl}
Organization type: ${organization.organizationType || 'Not provided'}
Plan: ${organization.plan || 'Mini'}
Service plan: ${organization.servicePlan || 'AI WebApp Personalized Chat Assistant'}

`
    : '';
  const contextBlock = context
    ? `Answer using only the platform and knowledge base context below. Do not use outside knowledge. If the context does not contain the answer, say that you can only help with this platform and could not find the answer in the uploaded platform materials.\n\nPlatform and knowledge base context:\n${context}\n\n`
    : 'No relevant knowledge base context was found for this question.\n\n';

  return `You are a platform-grounded assistant for an institute. Keep answers brief and helpful. Refuse unrelated questions. When a client platform is provided, answer only for that client and never describe another organization.
${platformBlock}
${contextBlock}User: ${message}
Assistant:`;
}

function getAiProvider() {
  if (configuredAiProvider) return configuredAiProvider;
  if (openAiApiKey) return 'openai';
  if (process.env.OLLAMA_URL || process.env.NODE_ENV !== 'production') return 'ollama';
  return 'knowledge';
}

async function generateWithOllama(prompt) {
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 300
      }
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    console.error('Ollama returned a non-JSON response:', text.slice(0, 800));
    throw new Error('Ollama returned an unexpected response.');
  }

  if (!response.ok) {
    console.error('Ollama request failed:', data);
    throw new Error(data.error || `Failed to generate a response with ${ollamaModel}.`);
  }

  return (data.response || '').trim();
}

async function generateWithOpenAi(prompt) {
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input: prompt,
      temperature: 0.4,
      max_output_tokens: 450
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('OpenAI request failed:', data);
    throw new Error(data?.error?.message || `Failed to generate a response with ${openAiModel}.`);
  }

  const directText = data?.output_text;
  const nestedText = data?.output
    ?.flatMap((item) => item.content || [])
    ?.filter((content) => content.type === 'output_text' || content.text)
    ?.map((content) => content.text)
    ?.join('\n');

  return String(directText || nestedText || '').trim();
}

function trimSentence(value, maxLength = 520) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;

  const clipped = text.slice(0, maxLength);
  const sentenceEnd = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'));
  return `${clipped.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maxLength).trim()}...`;
}

function generateKnowledgeReply(message, matches, organization = null) {
  if (matches.length) {
    const snippets = matches
      .slice(0, 2)
      .map((match) => trimSentence(match.text, 420))
      .filter(Boolean);

    if (snippets.length) {
      const intro = organization
        ? `For ${organization.instituteName}, I found this in the platform materials:`
        : 'I found this in the platform materials:';
      return `${intro}\n\n${snippets.map((snippet) => `- ${snippet}`).join('\n')}`;
    }
  }

  if (organization) {
    return `I can help with ${organization.instituteName}, but I could not find an answer in that platform's knowledge materials.`;
  }

  return 'I can only help with this platform, and I could not find an answer in the uploaded platform materials.';
}

async function generateAssistantReply(prompt, fallbackReply) {
  const provider = getAiProvider();

  try {
    if (provider === 'openai') return await generateWithOpenAi(prompt);
    if (provider === 'ollama') return await generateWithOllama(prompt);
    return fallbackReply;
  } catch (error) {
    console.error(`${provider} generation failed:`, error?.message || error);
    return fallbackReply;
  }
}

app.use(express.json());

app.get(['/monitor', '/monitor/', '/monitor.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Monitor', 'monitor.html'));
});

app.get(['/access', '/access/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'access.html'));
});

app.get('/access/database', (req, res) => {
  renderAccessDirectory(res, 'Database', '/access/database', databaseDir);
});

app.get('/access/knowledge', (req, res) => {
  renderAccessDirectory(res, 'Knowledge', '/access/knowledge', knowledgeDir);
});

app.get('/access/database/*', (req, res) => {
  sendAccessFile(res, databaseDir, req.params[0]);
});

app.get('/access/knowledge/*', (req, res) => {
  sendAccessFile(res, knowledgeDir, req.params[0]);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/redulix', express.static(path.join(__dirname, 'Redulix')));

app.get('/home.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/', (req, res) => {
  res.send('AI Chat Backend is Running!');
});

app.get('/redulix', (req, res) => {
  res.sendFile(path.join(__dirname, 'Redulix', 'home.html'));
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, clientId, embedToken, siteUrl } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const organization = getOrganizationFromRequest(req);
    if ((clientId || siteUrl) && !organization) {
      return res.status(403).json({ error: 'This assistant code is not registered or is no longer active.' });
    }

    const organizationSources = organization
      ? [
          organization.knowledge?.detailFile,
          organization.knowledge?.textFile,
          organization.knowledge?.conversationFile,
          organization.knowledge?.jsonFile
        ].filter(Boolean)
      : null;
    const matches = ragEnabled
      ? retrieveRelevantChunks(ragIndex, message, ragTopK, organizationSources ? { sources: organizationSources } : {})
      : [];
    const ragContext = formatContext(matches);

    if (ragEnabled && !matches.length && !organization) {
      return res.json({
        reply: 'I can only help with this platform, and I could not find an answer in the uploaded platform materials.',
        sources: []
      });
    }

    const fallbackReply = generateKnowledgeReply(message, matches, organization);
    const assistantMessage = await generateAssistantReply(
      buildPrompt(message, ragContext, organization),
      fallbackReply
    );
    const reply = assistantMessage || fallbackReply;
    const sources = matches.map((match) => ({
      id: match.id,
      source: match.source,
      score: match.score
    }));

    let conversationLog = null;
    try {
      conversationLog = await recordPlatformConversation(organization, {
        userMessage: message,
        assistantReply: reply,
        sources,
        request: {
          clientId: clientId || null,
          siteUrl: siteUrl || null
        }
      });
    } catch (error) {
      console.error('Failed to record platform conversation:', error?.message || error);
    }

    res.json({
      reply,
      sources,
      conversationLog,
      platform: organization
        ? {
            clientId: organization.clientId,
            instituteName: organization.instituteName,
            platformUrl: organization.platformUrl
          }
        : null
    });
  } catch (error) {
    console.error('Chat request failed:', error?.message || error);
    res.status(503).json({
      error: 'The assistant is temporarily unavailable. Please try again shortly.'
    });
  }
});

app.get('/api/platform/status', (req, res) => {
  const organization = getOrganizationFromRequest(req);
  if ((req.query?.clientId || req.query?.siteUrl) && !organization) {
    return res.status(403).json({ error: 'This assistant code is not registered or is no longer active.' });
  }
  const activePlatform = organization || platformConfig;
  res.json({
    configured: Boolean(activePlatform),
    registeredCount: organizationRegistry.length,
    platforms: organizationRegistry.map((item) => ({
      clientId: item.clientId,
      instituteName: item.instituteName,
      platformUrl: item.platformUrl,
      ownerEmail: item.ownerEmail,
      plan: item.plan || 'Mini',
      status: item.status,
      updatedAt: item.updatedAt,
      integrationCode: item.integrationCode
    })),
    platform: activePlatform
      ? {
          clientId: activePlatform.clientId,
          instituteName: activePlatform.instituteName,
          platformUrl: activePlatform.platformUrl,
          ownerEmail: activePlatform.ownerEmail,
          contactName: activePlatform.contactName,
          organizationType: activePlatform.organizationType,
          plan: activePlatform.plan || 'Mini',
          servicePlan: activePlatform.servicePlan,
          termsAccepted: activePlatform.termsAccepted,
          permissions: activePlatform.permissions,
          updatedAt: activePlatform.updatedAt,
          knowledge: activePlatform.knowledge,
          conversationLog: activePlatform.conversationLog,
          embedScript: `${getPublicBaseUrl(req)}/embed.js`,
          integrationCode: activePlatform.integrationCode || (organization ? buildEmbedScript(req, organization) : null)
        }
      : null
  });
});

app.get('/ai_chat.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ai_chat.html'));
});

app.post('/api/platform/setup', async (req, res) => {
  try {
    const {
      instituteName,
      platformUrl,
      ownerEmail,
      contactName,
      organizationType,
      plan,
      servicePlan,
      platformSummary,
      termsAccepted
    } = req.body;

    const normalizedUrl = normalizeUrl(platformUrl);

    if (!instituteName || !platformSummary || !normalizedUrl || !isEmail(ownerEmail)) {
      return res.status(400).json({
        error: 'Institute name, valid platform URL, owner email, and platform summary are required.'
      });
    }

    if (!termsAccepted) {
      return res.status(400).json({
        error: 'You must agree to the LICONR terms and confirm setup authority.'
      });
    }

    const config = {
      clientId: createClientId(instituteName),
      embedToken: createEmbedToken(),
      instituteName: instituteName.trim(),
      platformUrl: normalizedUrl,
      ownerEmail: ownerEmail.trim(),
      contactName: (contactName || '').trim(),
      organizationType: (organizationType || '').trim(),
      plan: normalizePlan(plan),
      servicePlan: (servicePlan || 'AI WebApp Personalized Chat Assistant').trim(),
      platformSummary: platformSummary.trim(),
      termsAccepted: Boolean(termsAccepted),
      permissions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    config.integrationCode = buildEmbedScript(req, config);
    let collectedKnowledge = null;
    try {
      collectedKnowledge = await collectWebsiteKnowledge(config);
    } catch (error) {
      console.error('Website knowledge collection failed:', error?.message || error);
      collectedKnowledge = {
        textFile: null,
        jsonFile: null,
        pageCount: 0,
        collectedAt: new Date().toISOString(),
        errors: [{ url: normalizedUrl, error: error.message || 'Collection failed' }]
      };
    }

    const organization = await saveOrganization({
      ...config,
      knowledge: collectedKnowledge
    });
    organization.integrationCode = config.integrationCode;
    const emailSent = await notifyOwner(organization);
    const index = await refreshRagIndex();

    res.json({
      status: 'ok',
      platform: {
        clientId: organization.clientId,
        instituteName: organization.instituteName,
        platformUrl: organization.platformUrl,
        ownerEmail: organization.ownerEmail,
        organizationType: organization.organizationType,
        plan: organization.plan || 'Mini',
        servicePlan: organization.servicePlan,
        updatedAt: organization.updatedAt,
        integrationCode: organization.integrationCode,
        knowledge: organization.knowledge,
        conversationLog: organization.conversationLog
      },
      platforms: organizationRegistry.map((item) => ({
        clientId: item.clientId,
        instituteName: item.instituteName,
        platformUrl: item.platformUrl,
        ownerEmail: item.ownerEmail,
        plan: item.plan || 'Mini',
        status: item.status,
        updatedAt: item.updatedAt,
        integrationCode: item.integrationCode
      })),
      notification: emailSent
        ? 'Owner notification email sent.'
        : 'Configure SMTP settings to send owner notification emails.',
      embedScript: `${getPublicBaseUrl(req)}/embed.js`,
      integrationCode: organization.integrationCode,
      installationInstructions: 'Copy this integration code and paste it before the closing </body> tag on the client website.',
      knowledge: organization.knowledge,
      fileCount: index.files.length,
      chunkCount: index.chunks.length
    });
  } catch (error) {
    console.error('Failed to save platform setup:', error?.message || error);
    res.status(500).json({ error: 'Failed to save platform setup.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/rag/status', (req, res) => {
  res.json({
    enabled: ragEnabled,
    files: ragIndex.files,
    fileCount: ragIndex.files.length,
    chunkCount: ragIndex.chunks.length,
    updatedAt: ragIndex.updatedAt
  });
});

app.post('/api/rag/reindex', async (req, res) => {
  try {
    const index = await refreshRagIndex();
    res.json({
      status: 'ok',
      fileCount: index.files.length,
      chunkCount: index.chunks.length,
      updatedAt: index.updatedAt
    });
  } catch (error) {
    console.error('Failed to rebuild RAG index:', error?.message || error);
    res.status(500).json({ error: 'Failed to rebuild the RAG index.' });
  }
});

app.get('/api/monitor/session', (req, res) => {
  res.json({ authenticated: verifyMonitorToken(parseCookies(req).monitor_session) });
});

app.post('/api/monitor/login', (req, res) => {
  const password = String(req.body?.password || '');
  const passwordMatches = password.length === monitorPassword.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(monitorPassword));

  if (!passwordMatches) {
    return res.status(401).json({ error: 'Incorrect monitor password.' });
  }

  res.cookie('monitor_session', createMonitorToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: monitorSessionMaxAgeMs
  });
  res.json({ status: 'ok' });
});

app.post('/api/monitor/logout', (req, res) => {
  res.clearCookie('monitor_session');
  res.json({ status: 'ok' });
});

app.get('/api/monitor/data', requireMonitorSession, async (req, res) => {
  try {
    res.json(await buildMonitorSnapshot());
  } catch (error) {
    console.error('Failed to build monitor data:', error?.message || error);
    res.status(500).json({ error: 'Failed to load monitor data.' });
  }
});

// --- Simple payments endpoints (lightweight server-side storage + mock checkout) ---
const paymentsFile = path.join(__dirname, 'payments.json');

async function loadPaymentsFile() {
  try {
    const raw = await fs.readFile(paymentsFile, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    return [];
  }
}

async function savePaymentsFile(payments) {
  try {
    await fs.writeFile(paymentsFile, JSON.stringify(payments, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save payments file:', err?.message || err);
  }
}

// Send an invoice email to the payer (if SMTP is configured)
async function sendInvoiceEmail(payment) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP not configured; skipping invoice email.');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const html = `
    <h1>LICONR AI Subscription Invoice</h1>
    <p><strong>Name:</strong> ${escapeHtml(payment.name)}</p>
    <p><strong>Email:</strong> ${escapeHtml(payment.email)}</p>
    <p><strong>Plan:</strong> ${escapeHtml(payment.plan || 'Standard')}</p>
    <p><strong>Amount:</strong> $${escapeHtml(payment.amount)}</p>
    <p><strong>Date:</strong> ${new Date(payment.date).toLocaleString()}</p>
    <p>Thank you for your purchase.</p>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: payment.email,
    cc: process.env.SMTP_FROM || process.env.SMTP_USER,
    subject: `LICONR AI Invoice — ${payment.id || ''}`,
    text: `LICONR AI Invoice\n\nName: ${payment.name}\nEmail: ${payment.email}\nPlan: ${payment.plan || 'Standard'}\nAmount: $${payment.amount}\nDate: ${new Date(payment.date).toLocaleString()}`,
    html
  });

  return true;
}

app.post('/create-payoneer-payment', express.json(), async (req, res) => {
  try {
    const { amount, currency, name, email, plan, returnUrl } = req.body || {};
    if (!name || !email || !amount) return res.status(400).json({ error: 'Missing fields' });

    const payments = await loadPaymentsFile();
    const payment = {
      id: `INV-${Date.now()}`,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      amount: parseFloat(String(amount)).toFixed(2),
      currency: String(currency || 'USD'),
      plan: String(plan || 'Standard'),
      date: new Date().toISOString()
    };

    const existingIndex = payments.findIndex(p => (p.email || '').toLowerCase() === payment.email);
    if (existingIndex >= 0) payments[existingIndex] = payment; else payments.push(payment);
    await savePaymentsFile(payments);

    // Attempt to send invoice email (non-blocking failure will be logged)
    try { await sendInvoiceEmail(payment); } catch (err) { console.error('Invoice email failed:', err?.message || err); }

    const base = getPublicBaseUrl(req);
    // Suspend the external Payoneer checkout during testing and redirect directly to home.
    const checkoutUrl = `${base}/home.html`;

    res.json({ url: checkoutUrl, payment });
  } catch (err) {
    console.error('/create-payoneer-payment error:', err?.message || err);
    res.status(500).json({ error: 'failed' });
  }
});

// Mock checkout endpoint: simulates external gateway and redirects back to the returnUrl
app.get('/complete-payment', async (req, res) => {
  try {
    const { email, returnUrl } = req.query || {};
    const decodedReturn = typeof returnUrl === 'string' ? returnUrl : (getPublicBaseUrl(req) + '/accounts.html');

    // Optionally append query params so the client knows payment completed
    const sep = decodedReturn.includes('?') ? '&' : '?';
    const redirectTo = `${decodedReturn}${sep}paid=1&email=${encodeURIComponent(email || '')}`;
    res.redirect(302, redirectTo);
  } catch (err) {
    console.error('/complete-payment error:', err?.message || err);
    res.status(500).send('Checkout failed');
  }
});

loadOrganizationRegistry()
  .then(refreshRagIndex)
  .catch((error) => {
    console.error('RAG index failed to initialize:', error?.message || error);
  });

const server = app.listen(port, () => {
  console.log(`Chatbot server running at http://localhost:${port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Use a different PORT in your .env or stop the process using that port.`);
    process.exit(1);
  }
  throw error;
});
