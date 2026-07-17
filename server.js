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
const assistantAssetDir = path.join(__dirname, 'public', 'assistant-assets');
const crawlPageLimit = Math.max(1, Number(process.env.CRAWL_PAGE_LIMIT) || 12);
const crawlTimeoutMs = Math.max(1500, Number(process.env.CRAWL_TIMEOUT_MS) || 10000);
const monitorPassword = process.env.MONITOR_PASSWORD || 'S26112007';
const monitorSessionSecret = process.env.MONITOR_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const monitorSessionMaxAgeMs = 1000 * 60 * 60 * 8;

const defaultHeaderIcons = [
  {
    name: 'Profile',
    icon: '/profile-image.png',
    href: '/profile.html',
    tooltip: 'View profile'
  },
  {
    name: 'Settings',
    icon: '/settings-image.png',
    href: '/settings.html',
    tooltip: 'Open settings'
  }
];

const defaultAgentActions = [
  {
    id: 'login',
    label: 'Log in',
    intent: 'navigation',
    description: 'Send users to the platform login page.',
    keywords: ['login', 'log in', 'sign in', 'signin', 'access account'],
    humanRequired: false,
    url: ''
  },
  {
    id: 'signup',
    label: 'Create account',
    intent: 'navigation',
    description: 'Send users to the account registration page.',
    keywords: ['sign up', 'signup', 'register', 'create account', 'open account'],
    humanRequired: false,
    url: ''
  },
  {
    id: 'account',
    label: 'My account',
    intent: 'navigation',
    description: 'Send users to their account or profile page.',
    keywords: ['my account', 'profile', 'account page', 'dashboard'],
    humanRequired: false,
    url: ''
  },
  {
    id: 'cart',
    label: 'Cart',
    intent: 'navigation',
    description: 'Send users to the cart or checkout page.',
    keywords: ['cart', 'basket', 'checkout', 'buy now', 'payment'],
    humanRequired: false,
    url: ''
  },
  {
    id: 'orders',
    label: 'Orders',
    intent: 'navigation',
    description: 'Send users to order history or order tracking.',
    keywords: ['order', 'orders', 'track order', 'shipment', 'delivery'],
    humanRequired: false,
    url: ''
  },
  {
    id: 'support',
    label: 'Support',
    intent: 'navigation',
    description: 'Send users to customer support or contact help.',
    keywords: ['support', 'help center', 'contact', 'customer service'],
    humanRequired: false,
    url: ''
  },
  {
    id: 'password-reset',
    label: 'Reset password',
    intent: 'guided',
    description: 'Guide users through password reset. The assistant must not change passwords itself.',
    keywords: ['password', 'reset password', 'forgot password', 'change password'],
    humanRequired: true,
    url: ''
  }
];

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

async function ensureAssistantAssetDir() {
  await fs.mkdir(assistantAssetDir, { recursive: true });
}

const userProfilesFile = path.join(databaseDir, 'User_Profiles.json');

async function ensureUserProfilesFile() {
  await ensureDatabaseDir();
  try {
    await fs.access(userProfilesFile);
  } catch (error) {
    await fs.writeFile(userProfilesFile, '[]', 'utf8');
  }
}

async function loadUserProfilesFile() {
  await ensureUserProfilesFile();
  const raw = await fs.readFile(userProfilesFile, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    return [];
  }
}

async function saveUserProfilesFile(profiles) {
  await ensureDatabaseDir();
  await fs.writeFile(userProfilesFile, JSON.stringify(profiles, null, 2), 'utf8');
}

function normalizeProfilePayload(payload) {
  const fullName = String(payload?.fullName || '').trim();
  const email = String(payload?.email || '').trim().toLowerCase();
  const mobileNumber = String(payload?.mobileNumber || '').trim();
  const plan = String(payload?.plan || '').trim();
  const errors = [];

  if (!fullName) errors.push('Full name is required.');
  if (!isEmail(email)) errors.push('A valid email address is required.');
  if (!/^[+]\d{7,15}$/.test(mobileNumber)) {
    errors.push('Mobile number must include a country code, for example +1234567890.');
  }

  return {
    fullName,
    email,
    mobileNumber,
    plan: ['Mini', 'Pro', 'Max'].includes(plan) ? plan : 'Mini',
    errors
  };
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

  const faqSection = Array.isArray(config.faqs) && config.faqs.length
    ? ['FAQs:', ...config.faqs.map((faq, index) => {
        const title = faq.question ? `${index + 1}. ${faq.question}` : `${index + 1}. FAQ`;
        const answer = faq.answer ? `Answer: ${faq.answer}` : 'Answer: (no answer provided)';
        return `${title}\n${answer}`;
      })].join('\n\n')
    : '';

  const textContent = [
    `# ${config.instituteName}`,
    `Platform URL: ${config.platformUrl}`,
    `Collected at: ${collectedAt}`,
    '',
    config.platformSummary ? `Platform summary:\n${config.platformSummary}` : '',
    faqSection ? `${faqSection}` : '',
    '',
    pages.map(pageToText).filter(Boolean).join('\n\n---\n\n')
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

function getAssistantImageExtension(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/avif') return 'avif';
  if (normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon') return 'ico';
  return null;
}

async function persistAssistantImage(value, clientId) {
  const image = String(value || '').trim();
  if (!image) return null;
  if (/^https?:\/\//i.test(image) || image.startsWith('/assistant-assets/')) return image;

  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(image);
  if (!match) return image.startsWith('data:') ? image : null;

  const extension = getAssistantImageExtension(match[1]);
  if (!extension) return image;

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return image;

  await ensureAssistantAssetDir();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const fileName = `${safeSlug(clientId)}-${hash}.${extension}`;
  await fs.writeFile(path.join(assistantAssetDir, fileName), buffer);

  return `/assistant-assets/${fileName}`;
}

function resolveAssistantImageUrl(req, value) {
  const image = String(value || '').trim();
  if (!image) return null;
  if (/^(?:https?:|data:)/i.test(image)) return image;
  if (image.startsWith('/')) return `${getPublicBaseUrl(req)}${image}`;
  return image;
}

function normalizePlan(value) {
  const plan = String(value || '').trim();
  return ['Mini', 'Pro', 'Max'].includes(plan) ? plan : 'Mini';
}

function normalizeAgentActions(actions, platformUrl = '') {
  const baseUrl = normalizeUrl(platformUrl);
  const baseOrigin = baseUrl ? new URL(baseUrl).origin : null;
  const submittedActions = Array.isArray(actions) ? actions : [];
  const submittedById = new Map(submittedActions.map((action) => [String(action?.id || '').trim(), action]));

  return defaultAgentActions.map((defaultAction) => {
    const submitted = submittedById.get(defaultAction.id) || {};
    const rawUrl = String(submitted.url || '').trim();
    let normalizedActionUrl = '';

    if (rawUrl) {
      try {
        normalizedActionUrl = new URL(rawUrl, baseOrigin || undefined).toString();
      } catch (error) {
        normalizedActionUrl = '';
      }
    }

    return {
      ...defaultAction,
      url: normalizedActionUrl,
      enabled: Boolean(normalizedActionUrl) || defaultAction.humanRequired
    };
  });
}

function getAvailableAgentActions(organization) {
  return normalizeAgentActions(organization?.agentActions, organization?.platformUrl)
    .filter((action) => action.enabled);
}

function actionKeywordMatches(message, action) {
  const normalizedMessage = String(message || '').toLowerCase();
  return action.keywords.some((keyword) => normalizedMessage.includes(keyword));
}

function findAgentAction(message, organization) {
  if (!organization) return null;

  const actions = getAvailableAgentActions(organization);
  const lowered = String(message || '').toLowerCase();
  const wantsNavigation = /\b(how|where|open|go|take|redirect|send|link|page|visit|find|access)\b/.test(lowered);
  const matchedAction = actions.find((action) => actionKeywordMatches(message, action));

  if (!matchedAction) return null;
  if (matchedAction.humanRequired) return matchedAction;
  if (!matchedAction.url) return null;

  return wantsNavigation ? matchedAction : null;
}

function buildActionReply(action, organization) {
  if (!action) return null;

  if (action.humanRequired) {
    const configuredResetUrl = action.url
      ? ` You can start from this page: ${action.url}`
      : '';
    return {
      reply: `For ${organization.instituteName}, I can guide you with ${action.label.toLowerCase()}, but I cannot perform that task for you because it requires your identity or a human confirmation.${configuredResetUrl} Use the platform's official ${action.label.toLowerCase()} option, follow the verification steps, and contact support if you cannot access your email or phone.`,
      action: null
    };
  }

  return {
    reply: `I can take you to the ${action.label.toLowerCase()} page for ${organization.instituteName}. Redirecting you now.`,
    action: {
      type: 'redirect',
      label: action.label,
      url: action.url
    }
  };
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

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildEmbedScript(req, organization) {
  const baseUrl = getPublicBaseUrl(req);
  const clientIdAttribute = organization.clientId ? ` data-client-id="${organization.clientId}"` : '';
  const embedTokenAttribute = organization.embedToken ? ` data-embed-token="${organization.embedToken}"` : '';
  const assistantName = organization.assistantName || '';
  const assistantImage = resolveAssistantImageUrl(req, organization.assistantImage);
  const assistantNameAttribute = assistantName ? ` data-assistant-name="${escapeAttribute(assistantName)}"` : '';
  const assistantImageAttribute = assistantImage ? ` data-assistant-image="${escapeAttribute(assistantImage)}"` : '';
  // Return a multi-line, indented snippet so integrators can paste it
  // directly into their HTML. Attributes are placed on separate lines
  // for readability and to avoid accidental truncation when copying.
  const scriptTag = [`<script src="${baseUrl}/embed.js"`,
    clientIdAttribute ? `  ${clientIdAttribute.trim()}` : '',
    embedTokenAttribute ? `  ${embedTokenAttribute.trim()}` : '',
    assistantNameAttribute ? `  ${assistantNameAttribute.trim()}` : '',
    assistantImageAttribute ? `  ${assistantImageAttribute.trim()}` : '',
    '  async defer></script>'
  ].filter(Boolean).join('\n');

  return ['<!-- Paste this as HTML before </body>, outside any existing <script> block. -->', scriptTag].join('\n');
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
          organization.agentActions = normalizeAgentActions(organization.agentActions, organization.platformUrl);
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
  organization.agentActions = normalizeAgentActions(organization.agentActions, organization.platformUrl);

  const storagePaths = await ensurePlatformFolders(organization);
  const conversationLog = await ensureConversationLog(organization);

  // Build full organization record before the single final write
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

  // Single atomic write — avoids partial state on disk and race conditions
  await fs.writeFile(storagePaths.basicInfoPath, `${JSON.stringify(organization, null, 2)}\n`);

  if (existingIndex >= 0) {
    organizationRegistry[existingIndex] = organization;
  } else {
    organizationRegistry.push(organization);
  }

  platformConfig = organization;
  return organization;
}

async function processPlatformSetupBackground(config, organization) {
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
      errors: [{ url: normalizeUrl(config.platformUrl), error: error?.message || 'Collection failed' }]
    };
  }

  const updatedOrganization = {
    ...organization,
    knowledge: collectedKnowledge,
    updatedAt: new Date().toISOString()
  };
  await saveOrganization(updatedOrganization);

  try {
    await notifyOwner(updatedOrganization);
  } catch (error) {
    console.error('Background owner notification failed:', error?.message || error);
  }

  try {
    const folderName = getPlatformStoragePaths(updatedOrganization).folderName;
    await refreshRagIndexForPlatform(folderName);
  } catch (error) {
    console.error('Background RAG index refresh failed:', error?.message || error);
  }
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

// Incrementally index only one platform folder and merge into the existing
// ragIndex — avoids a full rebuild (which grows with every registered platform).
async function refreshRagIndexForPlatform(platformFolderName) {
  try {
    const platformKnowledgeDir = path.join(knowledgeDir, platformFolderName);
    const partialIndex = await buildRagIndex({
      knowledgeDir: platformKnowledgeDir,
      chunkSize: process.env.RAG_CHUNK_SIZE,
      chunkOverlap: process.env.RAG_CHUNK_OVERLAP
    });

    // Re-prefix relative paths so they match full-index source paths used during retrieval
    const prefixedChunks = partialIndex.chunks.map((chunk) => ({
      ...chunk,
      id: `${platformFolderName}/${chunk.id}`,
      source: `${platformFolderName}/${chunk.source}`
    }));
    const prefixedFiles = partialIndex.files.map((f) => `${platformFolderName}/${f}`);

    // Drop stale chunks for this platform then add fresh ones
    const retained = ragIndex.chunks.filter(
      (chunk) => !chunk.source.startsWith(`${platformFolderName}/`)
    );
    const retainedFiles = ragIndex.files.filter(
      (f) => !f.startsWith(`${platformFolderName}/`)
    );
    const merged = [...retained, ...prefixedChunks];

    // Rebuild document-frequency map over the merged set
    const documentFrequency = new Map();
    for (const chunk of merged) {
      for (const token of chunk.termFrequency.keys()) {
        documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
      }
    }

    ragIndex = {
      knowledgeDir,
      files: [...retainedFiles, ...prefixedFiles],
      chunks: merged,
      documentFrequency,
      updatedAt: new Date().toISOString()
    };

    console.log(`RAG index updated for "${platformFolderName}": ${ragIndex.chunks.length} total chunks from ${ragIndex.files.length} files.`);
  } catch (error) {
    console.error(`Incremental RAG index failed for "${platformFolderName}", falling back to full rebuild:`, error?.message || error);
    await refreshRagIndex();
  }
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
  const agentActions = organization ? getAvailableAgentActions(organization) : [];
  const actionBlock = agentActions.length
    ? `Available safe platform tasks:
${agentActions.map((action) => {
  const behavior = action.humanRequired
    ? 'guide the user only; do not perform this task'
    : `redirect the user to ${action.url}`;
  return `- ${action.label}: ${behavior}. Trigger phrases: ${action.keywords.join(', ')}`;
}).join('\n')}

`
    : '';
  const platformBlock = organization
    ? `Current client platform:
Institute: ${organization.instituteName}
Platform URL: ${organization.platformUrl}
Organization type: ${organization.organizationType || 'Not provided'}
Plan: ${organization.plan || 'Mini'}
Service plan: ${organization.servicePlan || 'AI WebApp Personalized Chat Assistant'}

${actionBlock}
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

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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

app.get('/api/user-profiles', async (req, res) => {
  try {
    const profiles = await loadUserProfilesFile();
    const requestedEmail = String(req.query.email || '').trim().toLowerCase();
    const requestedId = String(req.query.id || '').trim();

    if (requestedEmail) {
      const profile = profiles.find((item) => (item.email || '').toLowerCase() === requestedEmail);
      return res.json({ profile: profile || null, profilesCount: profiles.length });
    }

    if (requestedId) {
      const profile = profiles.find((item) => item.id === requestedId);
      return res.json({ profile: profile || null, profilesCount: profiles.length });
    }

    return res.json({ profiles, profilesCount: profiles.length });
  } catch (error) {
    console.error('Failed to load user profiles:', error?.message || error);
    return res.status(500).json({ error: 'Unable to load user profiles.' });
  }
});

app.post('/api/user-profiles', async (req, res) => {
  try {
    const normalized = normalizeProfilePayload(req.body || {});
    if (normalized.errors.length) {
      return res.status(400).json({ error: 'Please provide valid profile data.', details: normalized.errors });
    }

    const profiles = await loadUserProfilesFile();
    const existingIndex = profiles.findIndex((item) => (item.email || '').toLowerCase() === normalized.email);
    const now = new Date().toISOString();
    const profile = {
      id: existingIndex >= 0 ? profiles[existingIndex].id : `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fullName: normalized.fullName,
      email: normalized.email,
      mobileNumber: normalized.mobileNumber,
      plan: normalized.plan,
      createdAt: existingIndex >= 0 ? profiles[existingIndex].createdAt : now,
      updatedAt: now
    };

    if (existingIndex >= 0) {
      profiles[existingIndex] = profile;
    } else {
      profiles.push(profile);
    }

    await saveUserProfilesFile(profiles);
    return res.status(201).json({ profile, profilesCount: profiles.length });
  } catch (error) {
    console.error('Failed to save user profile:', error?.message || error);
    return res.status(500).json({ error: 'Unable to save user profile.' });
  }
});

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

    const agentAction = findAgentAction(message, organization);
    if (agentAction) {
      const actionResponse = buildActionReply(agentAction, organization);
      let conversationLog = null;
      try {
        conversationLog = await recordPlatformConversation(organization, {
          userMessage: message,
          assistantReply: actionResponse.reply,
          sources: [],
          request: {
            clientId: clientId || null,
            siteUrl: siteUrl || null,
            action: actionResponse.action || { type: 'guided', label: agentAction.label }
          }
        });
      } catch (error) {
        console.error('Failed to record platform action conversation:', error?.message || error);
      }

      return res.json({
        reply: actionResponse.reply,
        sources: [],
        action: actionResponse.action,
        conversationLog,
        platform: {
          clientId: organization.clientId,
          instituteName: organization.instituteName,
          platformUrl: organization.platformUrl
        }
      });
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
          agentActions: getAvailableAgentActions(activePlatform),
          updatedAt: activePlatform.updatedAt,
          knowledge: activePlatform.knowledge,
          conversationLog: activePlatform.conversationLog,
          assistantName: activePlatform.assistantName || 'BLUENINE',
          assistantImage: resolveAssistantImageUrl(req, activePlatform.assistantImage),
          embedScript: `${getPublicBaseUrl(req)}/embed.js`,
          integrationCode: activePlatform.integrationCode || (organization ? buildEmbedScript(req, organization) : null),
          headerIcons: activePlatform.headerIcons || defaultHeaderIcons
        }
      : null
  });
});

app.get('/api/ui/header-icons', (req, res) => {
  const organization = getOrganizationFromRequest(req);
  const activePlatform = organization || platformConfig;
  res.json({
    enabled: true,
    icons: activePlatform?.headerIcons || defaultHeaderIcons
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
      termsAccepted,
      faqs,
      agentActions,
      assistantName,
      assistantImage
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

    const platformFaqs = Array.isArray(faqs)
      ? faqs.map((faq) => ({
          question: String(faq?.question || '').trim(),
          answer: String(faq?.answer || '').trim()
        })).filter((faq) => faq.question || faq.answer)
      : [];

    const clientId = createClientId(instituteName);
    const storedAssistantImage = await persistAssistantImage(assistantImage, clientId);

    const config = {
      clientId,
      embedToken: createEmbedToken(),
      instituteName: instituteName.trim(),
      platformUrl: normalizedUrl,
      ownerEmail: ownerEmail.trim(),
      contactName: (contactName || '').trim(),
      organizationType: (organizationType || '').trim(),
      plan: normalizePlan(plan),
      servicePlan: (servicePlan || 'AI WebApp Personalized Chat Assistant').trim(),
      platformSummary: platformSummary.trim(),
      assistantName: (assistantName || 'BLUENINE').trim(),
      assistantImage: storedAssistantImage,
      headerIcons: defaultHeaderIcons,
      faqs: platformFaqs,
      agentActions: normalizeAgentActions(agentActions, normalizedUrl),
      termsAccepted: Boolean(termsAccepted),
      permissions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    config.integrationCode = buildEmbedScript(req, config);
    const organization = await saveOrganization({
      ...config,
      knowledge: {
        folder: null,
        detailFile: null,
        textFile: null,
        pageCount: 0,
        collectedAt: null,
        errors: []
      }
    });
    organization.integrationCode = buildEmbedScript(req, organization);
    await writeOrganizationBasicInfo(organization);

    // Build the full response payload first, then send it in one go.
    // Do NOT call res.flushHeaders() before res.json() — on proxied hosts like
    // Render it opens a chunked transfer that can be cut off before the body
    // arrives, producing "Unexpected end of JSON input" on the client.
    const responsePayload = {
      status: 'ok',
      platform: {
        clientId: organization.clientId,
        instituteName: organization.instituteName,
        platformUrl: organization.platformUrl,
        ownerEmail: organization.ownerEmail,
        organizationType: organization.organizationType,
        plan: organization.plan || 'Mini',
        servicePlan: organization.servicePlan,
        agentActions: getAvailableAgentActions(organization),
        updatedAt: organization.updatedAt,
        integrationCode: organization.integrationCode,
        headerIcons: organization.headerIcons || defaultHeaderIcons,
        knowledge: organization.knowledge,
        conversationLog: organization.conversationLog,
        assistantName: organization.assistantName || 'BLUENINE',
        assistantImage: resolveAssistantImageUrl(req, organization.assistantImage)
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
      notification: 'Setup saved. Knowledge collection and index refresh are running in the background.',
      embedScript: `${getPublicBaseUrl(req)}/embed.js`,
      integrationCode: organization.integrationCode,
      installationInstructions: 'Copy this integration code and paste it before the closing </body> tag on the client website.',
      knowledge: organization.knowledge,
      fileCount: ragIndex.files.length,
      chunkCount: ragIndex.chunks.length
    };

    res.json(responsePayload);

    // Background work runs after the response is fully flushed
    setImmediate(() => {
      processPlatformSetupBackground(config, organization)
        .catch((error) => console.error('Background setup processing failed:', error?.message || error));
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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>LICONR AI Invoice</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,system-ui,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563eb,#9333ea);padding:36px 40px;text-align:center;">
            <p style="margin:0;font-size:2rem;font-weight:900;letter-spacing:.15em;color:#ffffff;text-transform:uppercase;">LICONR AI</p>
            <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:.95rem;">Subscription Invoice</p>
          </td>
        </tr>
        <!-- Invoice meta -->
        <tr>
          <td style="padding:32px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="color:#64748b;font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">Invoice ID</td>
                <td align="right" style="color:#1e293b;font-weight:700;font-size:.9rem;">${escapeHtml(payment.id || '')}</td>
              </tr>
              <tr><td colspan="2" style="padding:6px 0;border-bottom:1px solid #e2e8f0;"></td></tr>
              <tr><td style="padding-top:14px;color:#64748b;font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">Date</td>
                <td align="right" style="padding-top:14px;color:#1e293b;font-size:.9rem;">${new Date(payment.date).toLocaleString()}</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Recipient -->
        <tr>
          <td style="padding:28px 40px 0;">
            <p style="margin:0 0 12px;font-size:.82rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Bill To</p>
            <p style="margin:0;font-size:1.05rem;font-weight:700;color:#1e293b;">${escapeHtml(payment.name)}</p>
            <p style="margin:4px 0 0;color:#475569;font-size:.9rem;">${escapeHtml(payment.email)}</p>
          </td>
        </tr>
        <!-- Line item -->
        <tr>
          <td style="padding:28px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
              <tr style="background:#f8fafc;">
                <th align="left" style="padding:12px 18px;font-size:.78rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Description</th>
                <th align="right" style="padding:12px 18px;font-size:.78rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Amount</th>
              </tr>
              <tr>
                <td style="padding:16px 18px;color:#1e293b;font-size:.95rem;">LICONR AI — ${escapeHtml(payment.plan || 'Standard')} Plan<br/><span style="font-size:.82rem;color:#64748b;">Monthly subscription</span></td>
                <td align="right" style="padding:16px 18px;font-weight:700;font-size:1.05rem;color:#1e293b;">$${escapeHtml(payment.amount)} ${escapeHtml(payment.currency || 'USD')}</td>
              </tr>
              <tr style="background:#f8fafc;">
                <td style="padding:12px 18px;font-weight:700;color:#1e293b;">Total</td>
                <td align="right" style="padding:12px 18px;font-weight:800;font-size:1.1rem;color:#2563eb;">$${escapeHtml(payment.amount)} ${escapeHtml(payment.currency || 'USD')}</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Thank you note -->
        <tr>
          <td style="padding:28px 40px;">
            <div style="background:#eff6ff;border-radius:10px;padding:18px 20px;border-left:4px solid #2563eb;">
              <p style="margin:0;color:#1e40af;font-size:.92rem;line-height:1.6;">Thank you for your purchase! Your subscription is now active. If you have any questions, reply to this email and our team will be happy to help.</p>
            </div>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:.8rem;">© ${new Date().getFullYear()} LICONR AI · All Rights Reserved</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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

app.post('/create-paddle-payment', express.json(), async (req, res) => {
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

    const paddleApiKey = process.env.PADDLE_API_KEY || '';
    const paddlePriceId = process.env.PADDLE_PRICE_ID || '';
    const base = getPublicBaseUrl(req);

    // If Paddle credentials are configured, create a real Paddle checkout session
    if (paddleApiKey && paddlePriceId) {
      try {
        const paddleApiBase = process.env.PADDLE_SANDBOX === 'true'
          ? 'https://sandbox-api.paddle.com'
          : 'https://api.paddle.com';

        const successUrl = new URL(`${base}/complete-payment`);
        successUrl.searchParams.set('email', payment.email);
        if (returnUrl) successUrl.searchParams.set('returnUrl', returnUrl);

        const paddleRes = await fetch(`${paddleApiBase}/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${paddleApiKey}`
          },
          body: JSON.stringify({
            items: [{ price_id: paddlePriceId, quantity: 1 }],
            customer: { email: payment.email },
            custom_data: { name: payment.name, plan: payment.plan, invoice_id: payment.id },
            checkout: { url: successUrl.toString() }
          })
        });

        if (paddleRes.ok) {
          const paddleData = await paddleRes.json();
          const checkoutUrl = paddleData?.data?.checkout?.url;
          if (checkoutUrl) return res.json({ url: checkoutUrl, payment });
        } else {
          const errText = await paddleRes.text();
          console.error('Paddle API error:', errText);
        }
      } catch (paddleErr) {
        console.error('Paddle request failed:', paddleErr?.message || paddleErr);
      }
    }

    // Fallback: redirect straight to home (no live Paddle credentials set)
    const homeUrl = new URL(`${base}/home.html`);
    if (payment.plan && payment.plan !== 'Standard') homeUrl.searchParams.set('plan', payment.plan);
    res.json({ url: homeUrl.toString(), payment });
  } catch (err) {
    console.error('/create-paddle-payment error:', err?.message || err);
    res.status(500).json({ error: 'failed' });
  }
});

// Paddle webhook — verify signature and record completed payments
app.post('/webhooks/paddle', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const paddleWebhookSecret = process.env.PADDLE_WEBHOOK_SECRET || '';
    const signature = req.headers['paddle-signature'] || '';

    if (paddleWebhookSecret && signature) {
      // Paddle uses a ts=...;h1=... signature format
      const parts = Object.fromEntries(signature.split(';').map(p => p.split('=')));
      const ts = parts['ts'] || '';
      const h1 = parts['h1'] || '';
      const signed = `${ts}:${req.body.toString()}`;
      const expected = crypto.createHmac('sha256', paddleWebhookSecret).update(signed).digest('hex');
      if (expected !== h1) {
        console.warn('Paddle webhook signature mismatch');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    }

    const event = JSON.parse(req.body.toString());
    const eventType = event?.event_type || '';

    // Record payment on successful transaction completion
    if (eventType === 'transaction.completed') {
      const txn = event?.data || {};
      const customData = txn?.custom_data || {};
      const customerEmail = txn?.customer?.email || customData?.email || '';
      const payments = await loadPaymentsFile();
      const payment = {
        id: customData.invoice_id || `INV-${Date.now()}`,
        name: customData.name || customerEmail,
        email: String(customerEmail).toLowerCase(),
        amount: ((txn?.details?.totals?.total || 0) / 100).toFixed(2),
        currency: txn?.currency_code || 'USD',
        plan: customData.plan || 'Standard',
        date: new Date().toISOString(),
        paddleTransactionId: txn?.id || ''
      };
      const existingIndex = payments.findIndex(p => (p.email || '').toLowerCase() === payment.email);
      if (existingIndex >= 0) payments[existingIndex] = payment; else payments.push(payment);
      await savePaymentsFile(payments);
      try { await sendInvoiceEmail(payment); } catch (err) { console.error('Invoice email failed:', err?.message || err); }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('/webhooks/paddle error:', err?.message || err);
    res.status(500).json({ error: 'Webhook processing failed' });
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
