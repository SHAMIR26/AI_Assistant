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
const ragTopK = Number(process.env.RAG_TOP_K) || 4;
const ragEnabled = process.env.RAG_ENABLED !== 'false';
const dataDir = path.join(__dirname, 'data');
const databaseDir = path.join(__dirname, 'Database');
const platformConfigPath = path.join(dataDir, 'platform-config.json');
const notificationLogPath = path.join(dataDir, 'owner-notifications.log');
const organizationsPath = path.join(databaseDir, 'organizations.json');
const organizationNotificationLogPath = path.join(databaseDir, 'website-notifications.log');
const platformProfilePath = path.join(__dirname, 'knowledge', 'platform-profile.md');

let ragIndex = {
  knowledgeDir: path.join(__dirname, 'knowledge'),
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

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function ensureDatabaseDir() {
  await fs.mkdir(databaseDir, { recursive: true });
}

function safeSlug(value) {
  return String(value || 'organization')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'organization';
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

function getOrganizationFromRequest(req) {
  const clientId = req.body?.clientId || req.query?.clientId;
  const embedToken = req.body?.embedToken || req.query?.embedToken;
  const organization = clientId ? getOrganizationByClientId(clientId) : null;

  if (!organization) return null;
  if (embedToken && organization.embedToken && embedToken !== organization.embedToken) return null;

  return organization;
}

function buildEmbedScript(req, organization) {
  const baseUrl = getPublicBaseUrl(req);
  return `<script src="${baseUrl}/embed.js" data-client-id="${organization.clientId}" data-embed-token="${organization.embedToken}" async defer></script>`;
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
  const permissions = Object.entries(config.permissions)
    .filter(([, granted]) => granted)
    .map(([name]) => `- ${name}`)
    .join('\n');

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

## Granted Permissions
${permissions || '- No permissions granted'}

## Assistant Boundary
The assistant must answer only questions related to this platform, the institute, and its uploaded knowledge base. If a user asks about unrelated topics, the assistant must say it can only help with this platform.
`;
}

async function savePlatformConfig(config) {
  await ensureDataDir();
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
    integrationCode: organization.integrationCode
  }));

  await fs.writeFile(organizationsPath, `${JSON.stringify({
    description: 'Registered websites using the AI WebApp Personalized Chat Assistant and their integration codes.',
    updatedAt: new Date().toISOString(),
    organizations: websites
  }, null, 2)}\n`);
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

  if (existingIndex >= 0) {
    organizationRegistry[existingIndex] = organization;
  } else {
    organizationRegistry.push(organization);
  }

  platformConfig = organization;
  await saveOrganizationRegistry();
  return organization;
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
    `Terms accepted: ${config.termsAccepted ? 'yes' : 'no'}`,
    'Requested permissions:',
    ...Object.entries(config.permissions).map(([name, granted]) => `- ${name}: ${granted ? 'granted' : 'missing'}`)
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
    knowledgeDir: path.join(__dirname, 'knowledge'),
    chunkSize: process.env.RAG_CHUNK_SIZE,
    chunkOverlap: process.env.RAG_CHUNK_OVERLAP
  });

  console.log(`RAG index ready: ${ragIndex.chunks.length} chunks from ${ragIndex.files.length} files.`);
  return ragIndex;
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

app.use(express.json());
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
    const { message, clientId, embedToken } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const organization = getOrganizationFromRequest(req);
    if (clientId && !organization) {
      return res.status(403).json({ error: 'This assistant code is not registered or is no longer active.' });
    }

    const matches = !organization && ragEnabled ? retrieveRelevantChunks(ragIndex, message, ragTopK) : [];
    const organizationContext = organization ? buildPlatformProfile(organization) : '';
    const ragContext = [organizationContext, formatContext(matches)].filter(Boolean).join('\n\n');

    if (ragEnabled && !matches.length && !organization) {
      return res.json({
        reply: 'I can only help with this platform, and I could not find an answer in the uploaded platform materials.',
        sources: []
      });
    }

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: buildPrompt(message, ragContext, organization),
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
      return res.status(500).json({
        error: 'Ollama returned an unexpected response. Make sure Ollama is running and the model is installed.'
      });
    }

    if (!response.ok) {
      console.error('Ollama request failed:', data);
      return res.status(response.status).json({
        error: data.error || `Failed to generate a response with ${ollamaModel}.`
      });
    }

    const assistantMessage = data.response || 'Sorry, I could not generate a response.';

    res.json({
      reply: assistantMessage.trim(),
      sources: matches.map((match) => ({
        id: match.id,
        source: match.source,
        score: match.score
      })),
      platform: organization
        ? {
            clientId: organization.clientId,
            instituteName: organization.instituteName,
            platformUrl: organization.platformUrl
          }
        : null
    });
  } catch (error) {
    console.error('Ollama request failed:', error?.message || error);
    res.status(503).json({
      error: `Could not reach Ollama at ${ollamaUrl}. Start Ollama and run: ollama pull ${ollamaModel}`
    });
  }
});

app.get('/api/platform/status', (req, res) => {
  const organization = getOrganizationFromRequest(req);
  if (req.query?.clientId && !organization) {
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
          embedScript: `${getPublicBaseUrl(req)}/embed.js`,
          integrationCode: activePlatform.integrationCode || (organization ? buildEmbedScript(req, organization) : null)
        }
      : null
  });
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
      termsAccepted,
      permissions = {}
    } = req.body;

    const normalizedUrl = normalizeUrl(platformUrl);
    const requiredPermissions = [
      'ownerApproval',
      'storePlatformInfo'
    ];

    const missingPermissions = requiredPermissions.filter((permission) => !permissions[permission]);

    if (!instituteName || !platformSummary || !normalizedUrl || !isEmail(ownerEmail)) {
      return res.status(400).json({
        error: 'Institute name, valid platform URL, owner email, and platform summary are required.'
      });
    }

    if (!termsAccepted) {
      return res.status(400).json({
        error: 'You must agree to the REDULIX terms and confirm setup authority.'
      });
    }

    if (missingPermissions.length) {
      return res.status(400).json({
        error: `Missing required permissions: ${missingPermissions.join(', ')}`
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
      permissions: requiredPermissions.reduce((result, permission) => {
        result[permission] = Boolean(permissions[permission]);
        return result;
      }, {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const organization = await saveOrganization(config);
    organization.integrationCode = buildEmbedScript(req, organization);
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
        integrationCode: organization.integrationCode
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
