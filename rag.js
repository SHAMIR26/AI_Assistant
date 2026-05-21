const fs = require('fs/promises');
const path = require('path');
const PDFParse = require('pdf-parse');

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf']);
const DEFAULT_CHUNK_SIZE = 900;
const DEFAULT_CHUNK_OVERLAP = 160;

function tokenize(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function chunkText(text, size = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP) {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return [];

  const chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    const targetEnd = Math.min(start + size, cleaned.length);
    let end = targetEnd;

    if (targetEnd < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf('\n\n', targetEnd);
      const sentenceBreak = cleaned.lastIndexOf('.', targetEnd);
      const softBreak = Math.max(paragraphBreak, sentenceBreak);

      if (softBreak > start + Math.floor(size * 0.55)) {
        end = softBreak + 1;
      }
    }

    chunks.push(cleaned.slice(start, end).trim());
    if (end >= cleaned.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks.filter(Boolean);
}

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readKnowledgeFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.pdf') {
    const buffer = await fs.readFile(filePath);
    try {
      const data = await PDFParse(buffer);
      return data.text || '';
    } catch (error) {
      console.error(`Failed to parse PDF ${filePath}:`, error?.message || error);
      return '';
    }
  }

  return fs.readFile(filePath, 'utf8');
}

function createChunkRecord({ filePath, knowledgeDir, chunk, index }) {
  const relativePath = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');
  const tokens = tokenize(`${relativePath} ${chunk}`);
  const termFrequency = new Map();

  for (const token of tokens) {
    termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
  }

  return {
    id: `${relativePath}#${index + 1}`,
    source: relativePath,
    text: chunk,
    tokenCount: tokens.length,
    termFrequency
  };
}

async function buildRagIndex(options = {}) {
  const knowledgeDir = options.knowledgeDir || path.join(__dirname, 'knowledge');
  const chunkSize = Number(options.chunkSize) || DEFAULT_CHUNK_SIZE;
  const chunkOverlap = Number(options.chunkOverlap) || DEFAULT_CHUNK_OVERLAP;

  await fs.mkdir(knowledgeDir, { recursive: true });

  const files = await collectFiles(knowledgeDir);
  const chunks = [];

  for (const filePath of files) {
    const content = await readKnowledgeFile(filePath);
    const fileChunks = chunkText(content, chunkSize, chunkOverlap);

    fileChunks.forEach((chunk, index) => {
      chunks.push(createChunkRecord({ filePath, knowledgeDir, chunk, index }));
    });
  }

  const documentFrequency = new Map();
  for (const chunk of chunks) {
    for (const token of chunk.termFrequency.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  return {
    knowledgeDir,
    files: files.map((filePath) => path.relative(knowledgeDir, filePath).replace(/\\/g, '/')),
    chunks,
    documentFrequency,
    updatedAt: new Date().toISOString()
  };
}

function retrieveRelevantChunks(index, query, limit = 4, options = {}) {
  if (!index?.chunks?.length) return [];

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const queryTermFrequency = new Map();
  for (const token of queryTokens) {
    queryTermFrequency.set(token, (queryTermFrequency.get(token) || 0) + 1);
  }

  const allowedSources = Array.isArray(options.sources)
    ? new Set(options.sources.map((source) => String(source).replace(/\\/g, '/')))
    : null;
  const chunks = allowedSources
    ? index.chunks.filter((chunk) => allowedSources.has(chunk.source))
    : index.chunks;

  const scored = chunks.map((chunk) => {
    let score = 0;

    for (const [token, queryCount] of queryTermFrequency.entries()) {
      const chunkCount = chunk.termFrequency.get(token) || 0;
      if (!chunkCount) continue;

      const containingChunks = index.documentFrequency.get(token) || 0;
      const idf = Math.log((index.chunks.length + 1) / (containingChunks + 1)) + 1;
      score += queryCount * chunkCount * idf;
    }

    return { ...chunk, score };
  });

  return scored
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((chunk) => ({
      id: chunk.id,
      source: chunk.source,
      text: chunk.text,
      score: Number(chunk.score.toFixed(3))
    }));
}

function formatContext(chunks) {
  if (!chunks.length) return '';

  return chunks
    .map((chunk, index) => `[Source ${index + 1}: ${chunk.source}]\n${chunk.text}`)
    .join('\n\n---\n\n');
}

module.exports = {
  buildRagIndex,
  formatContext,
  retrieveRelevantChunks
};
