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
const dataDir = path.join(__dirname, 'data');
const databaseDir = path.join(__dirname, 'Database');
const knowledgeDir = path.join(__dirname, 'knowledge');
const platformConfigPath = path.join(dataDir, 'platform-config.json');
const notificationLogPath = path.join(dataDir, 'owner-notifications.log');
const organizationsPath = path.join(databaseDir, 'organizations.json');
const databaseDataPath = path.join(databaseDir, 'data.json');
const organizationNotificationLogPath = path.join(databaseDir, 'website-notifications.log');
const platformProfilePath = path.join(knowledgeDir, 'platform-profile.md');
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

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
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
  return String(value || 'organization')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 42) || 'organization';
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
  await ensureKnowledgeDir();

  const startUrl = normalizeUrl(config.platformUrl);
  const slug = platformStorageSlug(config.instituteName || new URL(startUrl).hostname);
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

  const textPath = path.join(knowledgeDir, `${slug}.txt`);
  const jsonPath = path.join(knowledgeDir, `${slug}.json`);
  const textContent = [
    `# ${config.instituteName}`,
    `Platform URL: ${config.platformUrl}`,
    `Collected at: ${collectedAt}`,
    '',
    config.platformSummary ? `Platform summary:\n${config.platformSummary}` : '',
    '',
    pages.map(pageToText).join('\n\n---\n\n')
  ].filter(Boolean).join('\n');

  await fs.writeFile(textPath, `${textContent.trim()}\n`);
  await fs.writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);

  return {
    textFile: path.relative(knowledgeDir, textPath).replace(/\\/g, '/'),
    jsonFile: path.relative(knowledgeDir, jsonPath).replace(/\\/g, '/'),
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
  const slug = platformStorageSlug(organization?.instituteName || organization?.clientId || 'platform');
  return {
    slug,
    jsonFile: `${slug}.json`,
    textFile: `${slug}.txt`,
    jsonPath: path.join(databaseDir, `${slug}.json`),
    textPath: path.join(databaseDir, `${slug}.txt`)
  };
}

async function ensureConversationLog(organization) {
  await ensureDatabaseDir();
  const paths = getConversationLogPaths(organization);

  try {
    await fs.access(paths.jsonPath);
  } catch (error) {
    const payload = {
      description: `AI chat conversations for ${organization.instituteName}.`,
      clientId: organization.clientId,
      instituteName: organization.instituteName,
      platformUrl: organization.platformUrl,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      conversations: []
    };
    await fs.writeFile(paths.jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  try {
    await fs.access(paths.textPath);
  } catch (error) {
    await fs.writeFile(paths.textPath, `AI chat conversations for ${organization.instituteName}\nPlatform: ${organization.platformUrl}\nClient ID: ${organization.clientId}\n\n`);
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

  const currentLog = await readJsonFile(paths.jsonPath, {
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

  const textEntry = [
    `Time: ${savedEntry.timestamp}`,
    `User: ${savedEntry.userMessage}`,
    `Assistant: ${savedEntry.assistantReply}`,
    savedEntry.sources.length ? `Sources: ${savedEntry.sources.map((source) => source.source).join(', ')}` : 'Sources: none',
    ''
  ].join('\n');

  await fs.writeFile(paths.jsonPath, `${JSON.stringify(currentLog, null, 2)}\n`);
  await fs.appendFile(paths.textPath, `${textEntry}\n`);

  return {
    jsonFile: paths.jsonFile,
    textFile: paths.textFile,
    updatedAt: savedEntry.timestamp
  };
}

async function loadPlatformConfig() {
  try {
    const content = await fs.readFile(platformConfigPath, 'utf8');
    platformConfig = JSON.parse(content);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to load platform config:', error?.message || error);
    }
    platformConfig = null;
  }
}

async function loadOrganizationRegistry() {
  await ensureDatabaseDir();

  try {
    const content = await fs.readFile(organizationsPath, 'utf8');
    const parsed = JSON.parse(content);
    organizationRegistry = Array.isArray(parsed.organizations) ? parsed.organizations : [];
    platformConfig = organizationRegistry[organizationRegistry.length - 1] || null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to load organization registry:', error?.message || error);
    }
    organizationRegistry = [];
    platformConfig = null;
  }
}

function buildPlatformProfile(config) {
  return `# Platform Profile

Institute: ${config.instituteName}
Organization type: ${config.organizationType || 'Not provided'}
Platform URL: ${config.platformUrl}
Owner email: ${config.ownerEmail}
Setup contact: ${config.contactName || 'Not provided'}
Service plan: ${config.servicePlan || 'AI WebApp Personalized Chat Assistant'}
Terms accepted: ${config.termsAccepted ? 'Yes' : 'No'}

## Platform Purpose
${config.platformSummary}

## Assistant Boundary
The assistant must answer only questions related to this platform, the institute, and its uploaded knowledge base. If a user asks about unrelated topics, the assistant must say it can only help with this platform.
`;
}

async function savePlatformConfig(config) {
  await ensureDataDir();
  await ensureKnowledgeDir();
  platformConfig = config;
  await fs.writeFile(platformConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  await fs.writeFile(platformProfilePath, buildPlatformProfile(config));
}

async function saveOrganizationRegistry() {
  await ensureDatabaseDir();
  const websites = organizationRegistry.map((organization) => ({
    clientId: organization.clientId,
    embedToken: organization.embedToken,
    instituteName: organization.instituteName,
    platformUrl: organization.platformUrl,
    ownerEmail: organization.ownerEmail,
    contactName: organization.contactName,
    organizationType: organization.organizationType,
    servicePlan: organization.servicePlan,
    platformSummary: organization.platformSummary,
    termsAccepted: organization.termsAccepted,
    permissions: organization.permissions,
    status: organization.status,
    updatedAt: organization.updatedAt,
    createdAt: organization.createdAt,
    integrationCode: organization.integrationCode,
    knowledge: organization.knowledge,
    conversationLog: organization.conversationLog || {
      jsonFile: getConversationLogPaths(organization).jsonFile,
      textFile: getConversationLogPaths(organization).textFile
    }
  }));

  const registryPayload = {
    description: 'Registered websites using the AI WebApp Personalized Chat Assistant and their integration codes.',
    updatedAt: new Date().toISOString(),
    organizations: websites
  };
  const dataPayload = {
    description: 'Data file listing all websites that use the AI WebApp Personalized Chat Assistant.',
    updatedAt: registryPayload.updatedAt,
    websites: websites.map((website) => ({
      instituteName: website.instituteName,
      websiteLink: website.platformUrl,
      clientId: website.clientId,
      status: website.status,
      knowledgeFile: website.knowledge?.textFile || null,
      conversationFile: website.conversationLog?.jsonFile || null,
      registeredAt: website.createdAt,
      updatedAt: website.updatedAt
    }))
  };

  await fs.writeFile(organizationsPath, `${JSON.stringify(registryPayload, null, 2)}\n`);
  await fs.writeFile(databaseDataPath, `${JSON.stringify(dataPayload, null, 2)}\n`);
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
  const conversationLog = await ensureConversationLog(organization);
  organization.conversationLog = {
    jsonFile: conversationLog.jsonFile,
    textFile: conversationLog.textFile
  };

  if (existingIndex >= 0) {
    organizationRegistry[existingIndex] = organization;
  } else {
    organizationRegistry.push(organization);
  }

  platformConfig = organization;
  await saveOrganizationRegistry();
  return organization;
}

async function renderAccessDirectory(res, title, baseRoute, directoryPath) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const fileLinks = files.length
      ? files.map((file) => {
          const href = `${baseRoute}/${encodeURIComponent(file)}`;
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

function buildOwnerNotification(config) {
  return [
    `Time: ${new Date().toISOString()}`,
    `To: ${config.ownerEmail}`,
    `Subject: Chat assistant setup request for ${config.instituteName}`,
    `Client ID: ${config.clientId || 'Not assigned'}`,
    `Platform: ${config.platformUrl}`,
    `Organization type: ${config.organizationType || 'Not provided'}`,
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
  await ensureDataDir();
  const message = buildOwnerNotification(config);
  let sent = false;

  try {
    sent = await sendOwnerEmail(config, message);
  } catch (error) {
    console.error('Owner email failed:', error?.message || error);
  }

  await fs.appendFile(notificationLogPath, `${message}\nEmail sent: ${sent ? 'yes' : 'no'}\n\n`);
  await ensureDatabaseDir();
  await fs.appendFile(organizationNotificationLogPath, `${message}\nEmail sent: ${sent ? 'yes' : 'no'}\n\n`);
  return sent;
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

async function readTextTail(filePath, maxLength = 8000) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.slice(-maxLength);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to read ${filePath}:`, error?.message || error);
    }
    return '';
  }
}

async function getKnowledgeInventory() {
  await ensureKnowledgeDir();
  const entries = await fs.readdir(knowledgeDir, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const filePath = path.join(knowledgeDir, entry.name);
      const stats = await fs.stat(filePath);
      return {
        name: entry.name,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        indexed: ragIndex.files.includes(entry.name)
      };
    }));

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildMonitorSnapshot() {
  const [dataJson, organizationsJson, knowledgeFiles, notificationLog] = await Promise.all([
    readJsonFile(databaseDataPath, { websites: [], updatedAt: null }),
    readJsonFile(organizationsPath, { organizations: [], updatedAt: null }),
    getKnowledgeInventory(),
    readTextTail(organizationNotificationLogPath)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    database: dataJson,
    organizations: organizationsJson.organizations || [],
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
      latestRegistration: organizationRegistry[organizationRegistry.length - 1] || null,
      notificationLog
    }
  };
}

function buildPrompt(message, context, organization = null) {
  const platformBlock = organization
    ? `Current client platform:
Institute: ${organization.instituteName}
Platform URL: ${organization.platformUrl}
Organization type: ${organization.organizationType || 'Not provided'}
Service plan: ${organization.servicePlan || 'AI WebApp Personalized Chat Assistant'}
Platform purpose: ${organization.platformSummary}

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
    return `I can help with ${organization.instituteName}. ${trimSentence(organization.platformSummary || 'Ask me about this platform, its products, services, or details from its registered website materials.', 360)}`;
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

app.get('/access/database/:file', (req, res) => {
  res.sendFile(path.join(databaseDir, path.basename(req.params.file)));
});

app.get('/access/knowledge/:file', (req, res) => {
  res.sendFile(path.join(knowledgeDir, path.basename(req.params.file)));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/redulix', express.static(path.join(__dirname, 'Redulix')));

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
      ? [organization.knowledge?.textFile, organization.knowledge?.jsonFile].filter(Boolean)
      : null;
    const matches = ragEnabled
      ? retrieveRelevantChunks(ragIndex, message, ragTopK, organizationSources ? { sources: organizationSources } : {})
      : [];
    const organizationContext = organization ? buildPlatformProfile(organization) : '';
    const ragContext = [organizationContext, formatContext(matches)].filter(Boolean).join('\n\n');

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
    await saveOrganizationRegistry();
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
        status: item.status,
        updatedAt: item.updatedAt,
        integrationCode: item.integrationCode
      })),
      notification: emailSent
        ? 'Owner notification email sent.'
        : 'Owner notification was recorded in data/owner-notifications.log. Configure SMTP settings to send real email.',
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