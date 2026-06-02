// server.js — Express backend for Verity.
// Three critical purposes that a pure frontend cannot serve:
// 1. SECURITY: The Anthropic API key never touches the browser.
// 2. ARCHITECTURE: Multi-step agent reasoning happens server-side.
// 3. PERSISTENCE: Supabase connection is server-authenticated.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { runAgent, handleFollowUp, handleFollowUpStream, synthesizeComparison } from './agent.js';
import { checkCache, saveAnalysis, getAnalysisById, getHistory } from './supabase.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analyses. Please wait before running another.' }
});

const followupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many follow-up questions. Please wait a moment.' }
});

// ---------- HTML page routes (must be before express.static) ----------
// express.static would auto-serve index.html at / otherwise
app.get('/', (req, res) => {
  res.sendFile('landing.html', { root: './public' });
});

app.get('/app', (req, res) => {
  res.sendFile('index.html', { root: './public' });
});

app.get('/compare', (req, res) => {
  res.sendFile('compare.html', { root: './public' });
});

app.get('/view/:id', (req, res) => {
  res.sendFile('index.html', { root: './public' });
});

app.use(express.static('public', { index: false }));

// In-memory store for analyses when Supabase is not configured — capped at 100 entries (LRU)
const memoryStore = new Map();
const MEMORY_STORE_MAX = 100;
function memorySet(id, val) {
  if (memoryStore.size >= MEMORY_STORE_MAX) {
    memoryStore.delete(memoryStore.keys().next().value); // evict oldest
  }
  memoryStore.set(id, val);
}

// Compute what changed between an old and new analysis (for stale cache refreshes)
function computeDelta(oldAnalysis, newAnalysis) {
  const oldSignalSet = new Set((oldAnalysis.key_signals || []).map(s => s.signal));
  const newSignalSet = new Set((newAnalysis.key_signals || []).map(s => s.signal));

  const addedSignals = (newAnalysis.key_signals || []).filter(s => !oldSignalSet.has(s.signal));
  const removedSignalTexts = [...oldSignalSet].filter(s => !newSignalSet.has(s));

  const oldMoveSet = new Set((oldAnalysis.recent_moves || []).map(m => m.what));
  const newMoves = (newAnalysis.recent_moves || []).filter(m => !oldMoveSet.has(m.what));

  if (addedSignals.length === 0 && removedSignalTexts.length === 0 && newMoves.length === 0) {
    return null; // No meaningful delta
  }

  return { addedSignals, removedSignalTexts, newMoves };
}

// ---------- SSE streaming analysis endpoint ----------
// GET /api/analyze/stream?company=Notion&focus=competitive_threat
app.get('/api/analyze/stream', analyzeLimiter, async (req, res) => {
  const { company, focus, context: userContext, deep } = req.query;

  if (!company || company.trim().length === 0) {
    res.status(400).json({ error: 'Company name is required' });
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[server] Analysis requested for: "${company}"${focus ? ` [focus: ${focus}]` : ''}`);
  console.log(`${'='.repeat(60)}`);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    // Check cache first
    sendEvent('status', { message: 'Checking research cache...' });
    const cached = await checkCache(company);

    if (cached && !cached.stale) {
      console.log(`[server] Cache hit for "${company}" (${cached.age} days old)`);
      sendEvent('cache_hit', { age_days: cached.age });
      sendEvent('complete', { analysis: cached.data, analysisId: cached.id });
      res.end();
      return;
    }

    // Capture prior data for delta computation if this is a stale refresh
    const priorData = cached?.stale ? cached.data : null;

    // Run agent — track stats for the analysis stats bar
    sendEvent('status', { message: cached?.stale ? 'Refreshing stale analysis...' : 'Starting research...' });

    const startTime = Date.now();
    let toolCallCount = 0;

    const onStep = (step) => {
      if (step.type === 'tool_call') toolCallCount++;
      sendEvent('step', step);
    };

    const onComplete = async (analysis, tokenStats) => {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const sourcesCount = (analysis.sources_used || []).length;

      // Compute what changed if this was a stale refresh
      const delta = priorData ? computeDelta(priorData, analysis) : null;

      // Save to database
      const saved = await saveAnalysis(company, analysis);
      const analysisId = saved?.id || `mem_${Date.now()}`;

      // Also store in memory for follow-up if Supabase is down
      memorySet(analysisId, analysis);

      const totalTokens = tokenStats ? tokenStats.inputTokens + tokenStats.outputTokens : 0;
      const cacheHit = tokenStats?.cacheReadTokens > 0;
      console.log(`[server] Analysis complete for "${company}" (${durationSec}s, ${toolCallCount} calls, ${sourcesCount} sources, ${totalTokens} tokens${cacheHit ? `, ${tokenStats.cacheReadTokens} cache-read` : ''})`);

      sendEvent('complete', {
        analysis,
        analysisId,
        delta,
        stats: {
          durationSec,
          toolCallCount,
          sourcesCount,
          ...(tokenStats || {})
        }
      });
      res.end();
    };

    const agentOptions = {
      focus: focus || null,
      userContext: userContext || null,
      deep: deep === 'true'
    };
    if (cached?.stale) {
      await runAgent(company, onStep, onComplete, { ...agentOptions, priorAnalysis: cached.data });
    } else {
      await runAgent(company, onStep, onComplete, agentOptions);
    }
  } catch (err) {
    console.error(`[server] Analysis failed:`, err.message);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// ---------- Multi-company comparison endpoint ----------
// GET /api/compare?companies=Notion,Linear&focus=competitive_threat
app.get('/api/compare', analyzeLimiter, async (req, res) => {
  const companies = (req.query.companies || '')
    .split(',').map(c => c.trim()).filter(Boolean).slice(0, 3);

  if (companies.length < 2) {
    return res.status(400).json({ error: 'Provide at least 2 companies (comma-separated)' });
  }

  console.log(`[server] Compare requested: ${companies.join(' vs ')}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const focus = req.query.focus || null;
    sendEvent('status', { message: `Researching ${companies.join(', ')} in parallel...` });

    // Run all agents in parallel — each streams its steps tagged with company name
    const results = await Promise.all(companies.map(company =>
      new Promise((resolve, reject) => {
        runAgent(
          company,
          (step) => sendEvent('step', { company, ...step }),
          (analysis) => resolve({ company, analysis }),
          { focus }
        ).catch(reject);
      })
    ));

    sendEvent('status', { message: 'Synthesizing comparison matrix...' });
    const matrix = await synthesizeComparison(results);

    sendEvent('complete', {
      results: results.map(r => ({ company: r.company, analysis: r.analysis })),
      matrix
    });
    res.end();
  } catch (err) {
    console.error('[server] Compare failed:', err.message);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// ---------- Follow-up Q&A endpoint (standard, non-streaming) ----------
// POST /api/followup
app.post('/api/followup', followupLimiter, async (req, res) => {
  const { analysisId, question, history } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  console.log(`[server] Follow-up for analysis ${analysisId}: "${question.substring(0, 80)}"`);

  try {
    let analysis = null;

    if (analysisId && !analysisId.startsWith('mem_')) {
      const dbResult = await getAnalysisById(analysisId);
      if (dbResult) analysis = dbResult.analysis_json;
    }

    if (!analysis && memoryStore.has(analysisId)) {
      analysis = memoryStore.get(analysisId);
    }

    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found. Run a new analysis first.' });
    }

    const followUpContext = analysis.follow_up_context || JSON.stringify(analysis);
    const conversationHistory = history || [];

    const answer = await handleFollowUp(followUpContext, question, conversationHistory);
    res.json({ answer });
  } catch (err) {
    console.error(`[server] Follow-up failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Streaming follow-up Q&A endpoint ----------
// POST /api/followup/stream — returns SSE token stream
app.post('/api/followup/stream', followupLimiter, async (req, res) => {
  const { analysisId, question, history } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  console.log(`[server] Streaming follow-up for ${analysisId}: "${question.substring(0, 80)}"`);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    let analysis = null;

    if (analysisId && !analysisId.startsWith('mem_')) {
      const dbResult = await getAnalysisById(analysisId);
      if (dbResult) analysis = dbResult.analysis_json;
    }

    if (!analysis && memoryStore.has(analysisId)) {
      analysis = memoryStore.get(analysisId);
    }

    if (!analysis) {
      sendEvent('error', { message: 'Analysis not found. Run a new analysis first.' });
      res.end();
      return;
    }

    const followUpContext = analysis.follow_up_context || JSON.stringify(analysis);
    const conversationHistory = history || [];

    await handleFollowUpStream(
      followUpContext,
      question,
      conversationHistory,
      (token) => sendEvent('token', { text: token }),
      (fullText) => sendEvent('done', { answer: fullText })
    );

    res.end();
  } catch (err) {
    console.error(`[server] Streaming follow-up failed:`, err.message);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// ---------- History endpoint ----------
// GET /api/history
app.get('/api/history', async (req, res) => {
  const history = await getHistory();
  res.json(history);
});

// ---------- Single analysis retrieval ----------
// GET /api/analysis/:id
app.get('/api/analysis/:id', async (req, res) => {
  const { id } = req.params;

  let analysis = null;

  if (!id.startsWith('mem_')) {
    analysis = await getAnalysisById(id);
  }

  if (!analysis && memoryStore.has(id)) {
    analysis = { analysis_json: memoryStore.get(id) };
  }

  if (!analysis) {
    return res.status(404).json({ error: 'Analysis not found' });
  }

  res.json(analysis.analysis_json || analysis);
});

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    supabase: !!process.env.SUPABASE_URL,
    uptime: Math.floor(process.uptime())
  });
});


app.listen(PORT, () => {
  console.log(`\n[verity] Server running on http://localhost:${PORT}`);
  console.log(`[verity] Anthropic API key: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`[verity] Supabase: ${process.env.SUPABASE_URL ? 'configured' : 'not configured (using in-memory store)'}`);
  console.log();
});
