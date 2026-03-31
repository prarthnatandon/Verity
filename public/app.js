// app.js — Frontend JavaScript for Verity.

// ---- State ----
let currentAnalysisId = null;
let currentAnalysis = null;
let qaHistory = [];
let elapsedInterval = null;
let analysisStartTime = null;
let isAnalyzing = false;
let tipInterval = null;

// ---- DOM refs ----
const companyInput = document.getElementById('company-input');
const analyzeBtn = document.getElementById('analyze-btn');
const focusSelect = document.getElementById('focus-select');
const stepsPanel = document.getElementById('steps-panel');
const stepsList = document.getElementById('steps-list');
const statusArea = document.getElementById('status-area');
const statusText = document.getElementById('status-text');
const elapsedTime = document.getElementById('elapsed-time');
const cacheBadge = document.getElementById('cache-badge');
const errorArea = document.getElementById('error-area');
const brief = document.getElementById('brief');
const deltaSection = document.getElementById('delta-section');
const deltaContent = document.getElementById('delta-content');
const followupArea = document.getElementById('followup-area');
const qaHistoryEl = document.getElementById('qa-history');
const qaInput = document.getElementById('qa-input');
const qaBtn = document.getElementById('qa-btn');
const historyList = document.getElementById('history-list');
const copyBtn = document.getElementById('copy-btn');
const shareBtn = document.getElementById('share-btn');
const pdfBtn = document.getElementById('pdf-btn');
const emptyState = document.getElementById('empty-state');
const skeleton = document.getElementById('skeleton');
const statsBar = document.getElementById('stats-bar');
const phaseProgress = document.getElementById('phase-progress');
const phaseLabel = document.getElementById('phase-label');
const toastContainer = document.getElementById('toast-container');

// ---- Research phases ----
const PHASES = [
  { id: 'website',   label: 'Website scan',      keywords: ['official', 'website', 'homepage', 'about'] },
  { id: 'news',      label: 'News & activity',    keywords: ['news', 'announcement', 'launch', 'funding', 'partnership'] },
  { id: 'jobs',      label: 'Job postings',       keywords: ['jobs', 'hiring', 'careers', 'linkedin', 'greenhouse', 'lever'] },
  { id: 'sentiment', label: 'Customer sentiment', keywords: ['review', 'g2', 'trustpilot', 'reddit', 'complaints'] },
  { id: 'synthesis', label: 'Synthesis',          keywords: [] }
];

let phaseStates = {};
let pendingToolCallsByIteration = {};

function resetPhases() {
  phaseStates = {};
  PHASES.forEach(p => { phaseStates[p.id] = 'pending'; });
  pendingToolCallsByIteration = {};
}

function inferPhase(toolInput) {
  const text = JSON.stringify(toolInput).toLowerCase();
  for (const phase of PHASES) {
    if (phase.keywords.some(kw => text.includes(kw))) return phase.id;
  }
  return null;
}

// ---- Numbered steps panel with connecting line ----
function renderSteps() {
  stepsList.innerHTML = PHASES.map((phase, i) => {
    const state = phaseStates[phase.id];
    const num = i + 1;
    const numContent = state === 'done' ? '' : num; // checkmark via CSS ::before on done
    return `
      <div class="step-item">
        <div class="step-number ${state}">${state === 'done' ? '' : num}</div>
        <div class="step-content">
          <div class="step-label ${state}">${phase.label}</div>
          <div class="step-detail" id="step-detail-${phase.id}"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ---- Phase progress bar in main area ----
function updatePhaseProgress(activePhaseId) {
  const phaseOrder = PHASES.map(p => p.id);
  const activeIdx = phaseOrder.indexOf(activePhaseId);
  const segments = document.querySelectorAll('.phase-segment');
  const total = phaseOrder.length;

  let activePhaseName = '';
  segments.forEach((seg, idx) => {
    seg.classList.remove('active', 'done');
    if (idx < activeIdx) seg.classList.add('done');
    else if (idx === activeIdx) {
      seg.classList.add('active');
      activePhaseName = PHASES[idx].label;
    }
  });

  if (phaseLabel) {
    phaseLabel.textContent = `${activePhaseName} · ${activeIdx + 1} / ${total}`;
  }
}

function showPhaseProgress() {
  phaseProgress.classList.remove('hidden');
  // Initialize all segments
  document.querySelectorAll('.phase-segment').forEach(s => s.classList.remove('active', 'done'));
}

function hidePhaseProgress() {
  phaseProgress.classList.add('hidden');
}

// ---- Skeleton ----
function showSkeleton() {
  skeleton.classList.remove('hidden');
  document.querySelectorAll('.skel-section').forEach(s => s.classList.remove('active', 'done'));
}

function updateSkeleton(phaseId) {
  const phaseOrder = PHASES.map(p => p.id);
  const activeIdx = phaseOrder.indexOf(phaseId);
  document.querySelectorAll('.skel-section').forEach(s => {
    const idx = phaseOrder.indexOf(s.dataset.phase);
    s.classList.remove('active', 'done');
    if (idx < activeIdx) s.classList.add('done');
    else if (idx === activeIdx) s.classList.add('active');
  });
}

function hideSkeleton() {
  skeleton.classList.add('hidden');
}

// ---- Elapsed timer ----
function startTimer() {
  analysisStartTime = Date.now();
  elapsedInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - analysisStartTime) / 1000);
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    elapsedTime.textContent = mins > 0 ? `${mins}m ${remaining}s` : `${remaining}s`;
  }, 1000);
}

function stopTimer() {
  if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
}

// ---- Toast notification system ----
function showToast(message, icon = '✓') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  // Trigger slide-in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { toast.classList.add('visible'); });
  });

  // Auto-dismiss after 2.5s
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ---- Analyze button states ----
function setButtonAnalyzing() {
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<span class="btn-spinner"></span><span class="btn-label">Analyzing...</span>';
}

function setButtonIdle() {
  analyzeBtn.disabled = false;
  analyzeBtn.innerHTML = '<span class="btn-label">Analyze</span>';
}

// ---- Stats bar with count-up animation ----
function showStats(stats, analysis) {
  if (!stats) return;
  const confidence = analysis.overall_confidence || 'unknown';
  const confColor = confidence === 'high' ? 'green' : confidence === 'medium' ? 'amber' : 'blue';

  // Build token/cost stat if available
  let tokenPart = '';
  if (stats.inputTokens || stats.outputTokens) {
    const totalTokens = (stats.inputTokens || 0) + (stats.outputTokens || 0);
    const tokenDisplay = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : `${totalTokens}`;
    const costDisplay = stats.estimatedCostUsd !== undefined ? ` · ~$${stats.estimatedCostUsd}` : '';
    tokenPart = `
      <span class="stat-separator">/</span>
      <div class="stat-item"><span class="stat-dot amber"></span> <span class="count-up" data-target="${totalTokens}" data-suffix=" tokens${costDisplay}">${tokenDisplay} tokens${costDisplay}</span></div>
    `;
  }

  statsBar.classList.remove('hidden');
  statsBar.innerHTML = `
    <div class="stat-item"><span class="stat-dot violet"></span> <span class="count-up" data-target="${stats.durationSec}" data-suffix="s">0s</span></div>
    <span class="stat-separator">/</span>
    <div class="stat-item"><span class="stat-dot blue"></span> <span class="count-up" data-target="${stats.toolCallCount}" data-suffix=" tool calls">0 tool calls</span></div>
    <span class="stat-separator">/</span>
    <div class="stat-item"><span class="stat-dot green"></span> <span class="count-up" data-target="${stats.sourcesCount}" data-suffix=" sources">0 sources</span></div>
    ${tokenPart}
    <span class="stat-separator">/</span>
    <div class="stat-item"><span class="stat-dot ${confColor}"></span> ${capitalize(confidence)} confidence</div>
  `;

  // Count-up animation
  document.querySelectorAll('.count-up').forEach((el, i) => {
    const target = parseInt(el.dataset.target) || 0;
    const suffix = el.dataset.suffix || '';
    const duration = 800;
    const delay = i * 100;
    const start = Date.now() + delay;

    setTimeout(() => {
      const tick = () => {
        const elapsed = Date.now() - start;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(eased * target);
        el.textContent = current + suffix;
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
  });
}

// ---- Staggered reveal ----
function revealBriefSections() {
  document.querySelectorAll('.reveal-section').forEach((section, i) => {
    setTimeout(() => section.classList.add('revealed'), i * 120);
  });
}

function resetRevealSections() {
  document.querySelectorAll('.reveal-section').forEach(s => s.classList.remove('revealed'));
}

// ---- Input validation ----
function validateInput() {
  const val = companyInput.value.trim();
  if (!val) {
    companyInput.style.borderColor = '#fca5a5';
    setTimeout(() => { companyInput.style.borderColor = ''; }, 1500);
    return false;
  }
  return true;
}

// ---- Empty state rotating tips ----
const TIPS = [
  'Verity researches the live web — not a static database',
  'Use focus modes to tailor briefs for sales, investment, or competitive strategy',
  'Follow-up Q&A is grounded in retrieved research — no hallucination',
];
let tipIndex = 0;

function startTips() {
  const tipEl = document.getElementById('empty-tip');
  if (!tipEl) return;
  tipEl.style.opacity = '0';

  const showTip = () => {
    tipEl.style.opacity = '0';
    setTimeout(() => {
      tipEl.textContent = `— ${TIPS[tipIndex % TIPS.length]}`;
      tipEl.style.opacity = '1';
      tipIndex++;
    }, 300);
  };

  showTip();
  tipInterval = setInterval(showTip, 4000);
}

function stopTips() {
  if (tipInterval) { clearInterval(tipInterval); tipInterval = null; }
}

// ---- Analysis via SSE ----
function startAnalysis(company) {
  if (isAnalyzing) return;
  if (!validateInput()) return;

  isAnalyzing = true;
  stopTips();
  const focus = focusSelect ? focusSelect.value : '';

  // Reset UI
  brief.classList.add('hidden');
  deltaSection.classList.add('hidden');
  followupArea.classList.add('hidden');
  cacheBadge.classList.add('hidden');
  errorArea.classList.add('hidden');
  emptyState.classList.add('hidden');
  statsBar.classList.add('hidden');
  statusArea.classList.remove('hidden');
  stepsPanel.classList.remove('hidden');
  qaHistory = [];
  qaHistoryEl.innerHTML = '';
  currentAnalysisId = null;
  currentAnalysis = null;

  resetPhases();
  resetRevealSections();
  renderSteps();
  showSkeleton();
  showPhaseProgress();
  startTimer();
  setButtonAnalyzing();

  statusText.textContent = 'Starting research...';

  const url = `/api/analyze/stream?company=${encodeURIComponent(company)}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    const event = JSON.parse(e.data);

    switch (event.type) {
      case 'status':
        statusText.textContent = event.message;
        break;

      case 'cache_hit':
        statusText.textContent = 'Retrieved from cache';
        hideSkeleton();
        hidePhaseProgress();
        break;

      case 'step':
        handleStep(event);
        break;

      case 'complete':
        stopTimer();
        hideSkeleton();
        hidePhaseProgress();
        statusArea.classList.add('hidden');
        eventSource.close();
        setButtonIdle();
        isAnalyzing = false;

        currentAnalysis = event.analysis;
        currentAnalysisId = event.analysisId;

        // Mark all phases done with cascade animation
        PHASES.forEach((p, i) => {
          setTimeout(() => {
            phaseStates[p.id] = 'done';
            renderSteps();
          }, i * 60);
        });

        showStats(event.stats, event.analysis);

        if (event.age_days !== undefined) showCacheBadge(event.age_days);
        if (event.delta) renderDelta(event.delta);

        renderBrief(event.analysis);
        revealBriefSections();
        loadHistory();
        break;

      case 'error':
        stopTimer();
        hideSkeleton();
        hidePhaseProgress();
        statusArea.classList.add('hidden');
        errorArea.classList.remove('hidden');
        errorArea.textContent = `Analysis failed: ${event.message}`;
        eventSource.close();
        setButtonIdle();
        isAnalyzing = false;
        break;
    }
  };

  eventSource.onerror = () => {
    stopTimer();
    hideSkeleton();
    hidePhaseProgress();
    statusArea.classList.add('hidden');
    errorArea.classList.remove('hidden');
    errorArea.textContent = 'Connection lost. Please try again.';
    eventSource.close();
    setButtonIdle();
    isAnalyzing = false;
  };
}

function handleStep(step) {
  if (step.type === 'reasoning') {
    const reasoningEl = document.createElement('div');
    reasoningEl.className = 'step-reasoning';
    const shortText = step.text.substring(0, 120) + (step.text.length > 120 ? '…' : '');
    reasoningEl.textContent = shortText;
    reasoningEl.title = step.text; // full text on hover
    stepsList.appendChild(reasoningEl);
    stepsPanel.scrollTop = stepsPanel.scrollHeight;
    return;
  }

  if (step.type === 'tool_call') {
    const phase = inferPhase(step.input);
    if (phase) {
      let foundActive = false;
      for (const p of PHASES) {
        if (p.id === phase) {
          // Animate previous active → done
          if (phaseStates[p.id] === 'active') {
            triggerDoneAnimation(p.id);
          }
          phaseStates[p.id] = 'active';
          foundActive = true;
        } else if (!foundActive && phaseStates[p.id] === 'active') {
          triggerDoneAnimation(p.id);
          phaseStates[p.id] = 'done';
        }
      }
      renderSteps();
      updateSkeleton(phase);
      updatePhaseProgress(phase);

      const detail = document.getElementById(`step-detail-${phase}`);
      if (detail) {
        const query = step.input.query || step.input.url || '';
        detail.textContent = query.substring(0, 48) + (query.length > 48 ? '…' : '');
      }
    }

    // Parallel call tracking
    const iter = step.iteration;
    if (!pendingToolCallsByIteration[iter]) pendingToolCallsByIteration[iter] = [];
    pendingToolCallsByIteration[iter].push(step);

    const iterCalls = pendingToolCallsByIteration[iter];
    if (iterCalls.length > 1) {
      statusText.textContent = `Running ${iterCalls.length} searches in parallel…`;
    } else {
      const q = step.input.query || step.input.url || '';
      statusText.textContent = `${step.tool === 'web_search' ? 'Searching' : 'Fetching'}: ${q.substring(0, 60)}`;
    }
  }
}

function triggerDoneAnimation(phaseId) {
  const phaseOrder = PHASES.map(p => p.id);
  const idx = phaseOrder.indexOf(phaseId);
  const stepNumbers = stepsList.querySelectorAll('.step-number');
  if (stepNumbers[idx]) {
    stepNumbers[idx].classList.add('just-completed');
    setTimeout(() => stepNumbers[idx].classList.remove('just-completed'), 400);
  }
}

// ---- Delta: what changed ----
function renderDelta(delta) {
  if (!delta) return;
  const parts = [];

  if (delta.addedSignals?.length > 0) {
    parts.push(`
      <div class="delta-group">
        <div class="delta-group-label added">New signals</div>
        ${delta.addedSignals.map(s => `
          <div class="delta-row added">
            <span class="delta-indicator">+</span>
            <span class="delta-text">${escapeHtml(s.signal)}</span>
            <span class="signal-type ${s.type}">${s.type}</span>
          </div>
        `).join('')}
      </div>
    `);
  }

  if (delta.removedSignalTexts?.length > 0) {
    parts.push(`
      <div class="delta-group">
        <div class="delta-group-label removed">No longer detected</div>
        ${delta.removedSignalTexts.map(text => `
          <div class="delta-row removed">
            <span class="delta-indicator">−</span>
            <span class="delta-text">${escapeHtml(text)}</span>
          </div>
        `).join('')}
      </div>
    `);
  }

  if (delta.newMoves?.length > 0) {
    parts.push(`
      <div class="delta-group">
        <div class="delta-group-label added">New recent moves</div>
        ${delta.newMoves.map(m => `
          <div class="delta-row added">
            <span class="delta-indicator">+</span>
            <span class="delta-text">${escapeHtml(m.what)}</span>
            <span class="delta-when">${escapeHtml(m.when || '')}</span>
          </div>
        `).join('')}
      </div>
    `);
  }

  if (parts.length === 0) return;
  deltaContent.innerHTML = parts.join('');
  deltaSection.classList.remove('hidden');
}

function showCacheBadge(ageDays) {
  cacheBadge.classList.remove('hidden');
  cacheBadge.innerHTML = `
    <span>Cached · ${ageDays} day${ageDays !== 1 ? 's' : ''} ago</span>
    <span class="refresh-link" id="refresh-link">Refresh</span>
  `;
  document.getElementById('refresh-link').addEventListener('click', () => {
    cacheBadge.classList.add('hidden');
    startAnalysis(companyInput.value.trim());
  });
}

// ---- Render the structured brief ----
function renderBrief(analysis) {
  brief.classList.remove('hidden');
  followupArea.classList.remove('hidden');

  document.getElementById('exec-summary').textContent = analysis.executive_summary || '';
  document.getElementById('meta-industry').textContent = analysis.industry || '';
  document.getElementById('meta-funding').textContent = analysis.funding_stage || '';

  const confEl = document.getElementById('meta-confidence');
  confEl.textContent = `Confidence: ${analysis.overall_confidence || 'unknown'}`;
  confEl.title = analysis.overall_confidence_reason || '';

  // Key signals — with data-type for colored left border
  const signalsGrid = document.getElementById('signals-grid');
  signalsGrid.innerHTML = (analysis.key_signals || []).map(sig => `
    <div class="signal-card" data-type="${sig.type}">
      <div class="signal-top">
        <div class="signal-text">${escapeHtml(sig.signal)}</div>
        <div class="signal-badges">
          <span class="signal-type ${sig.type}">${sig.type}</span>
          <span class="confidence-badge ${sig.confidence}">
            <span class="conf-dot"></span>
            ${capitalize(sig.confidence)}
          </span>
        </div>
      </div>
      <div class="signal-reason">${escapeHtml(sig.confidence_reason || '')}</div>
      ${sig.source ? `<a href="${escapeHtml(sig.source)}" target="_blank" rel="noopener" class="signal-source">${truncateUrl(sig.source)}</a>` : ''}
    </div>
  `).join('');

  // Positioning
  const pos = analysis.positioning || {};
  document.getElementById('positioning').innerHTML = `
    <div class="pos-row">
      <div class="pos-label">How they describe themselves</div>
      <div class="pos-value">${escapeHtml(pos.how_they_describe_themselves || 'N/A')}</div>
    </div>
    <div class="pos-row">
      <div class="pos-label">Target customer</div>
      <div class="pos-value">${escapeHtml(pos.who_they_target || 'N/A')}</div>
    </div>
    <div class="pos-row">
      <div class="pos-label">Key claims</div>
      <ul class="claims-list">
        ${(pos.key_claims || []).map(c => `<li>${escapeHtml(c)}</li>`).join('')}
      </ul>
    </div>
    <div class="pos-row">
      <div class="pos-label">Pricing model</div>
      <div class="pos-value">${escapeHtml(pos.pricing_model || 'N/A')}</div>
    </div>
  `;

  // Recent moves
  document.getElementById('recent-moves').innerHTML = (analysis.recent_moves || []).map(m => `
    <div class="move-card">
      <div class="move-what">${escapeHtml(m.what)}</div>
      <div class="move-when">${escapeHtml(m.when || '')}</div>
      <div class="move-significance">${escapeHtml(m.significance || '')}</div>
      ${m.source ? `<div class="move-source"><a href="${escapeHtml(m.source)}" target="_blank" rel="noopener">${truncateUrl(m.source)}</a></div>` : ''}
    </div>
  `).join('') || '<p class="muted-text">No recent moves identified</p>';

  // Hiring
  const hiring = analysis.hiring_signals || {};
  document.getElementById('hiring').innerHTML = `
    <div class="hiring-areas">
      ${(hiring.growth_areas || []).map(a => `<span class="hiring-tag">${escapeHtml(a)}</span>`).join('')}
    </div>
    <div class="hiring-interp">${escapeHtml(hiring.interpretation || 'No hiring data available')}</div>
  `;

  // Sentiment
  const sent = analysis.customer_sentiment || {};
  document.getElementById('sentiment').innerHTML = `
    <div class="sentiment-grid">
      <div>
        <div class="sentiment-col-label love">What they love</div>
        <ul class="sentiment-list love">
          ${(sent.what_they_love || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
        </ul>
      </div>
      <div>
        <div class="sentiment-col-label pain">Pain points</div>
        <ul class="sentiment-list pain">
          ${(sent.what_they_complain_about || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
        </ul>
      </div>
    </div>
    <div class="sentiment-interpretation">${escapeHtml(sent.net_interpretation || 'N/A')}</div>
  `;

  document.getElementById('so-what').textContent = analysis.strategic_so_what || '';

  // Sources
  document.getElementById('sources').innerHTML = (analysis.sources_used || []).map(s => `
    <div class="source-item">
      <span class="source-type">${s.type || 'web'}</span>
      <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="source-url">${escapeHtml(s.url)}</a>
    </div>
  `).join('') || '<p class="muted-text">No sources recorded</p>';
}

// ---- Follow-up Q&A (streaming) ----
async function askFollowUp(question) {
  if (!question.trim() || !currentAnalysisId) return;

  qaHistoryEl.innerHTML += `<div class="qa-message user">${escapeHtml(question)}</div>`;
  qaInput.value = '';
  qaBtn.disabled = true;

  // Show thinking dots while waiting for first token
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'qa-thinking';
  thinkingEl.innerHTML = '<span></span><span></span><span></span>';
  qaHistoryEl.appendChild(thinkingEl);
  qaHistoryEl.scrollTop = qaHistoryEl.scrollHeight;

  let answerEl = null;
  let firstToken = true;

  try {
    const res = await fetch('/api/followup/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisId: currentAnalysisId, question, history: qaHistory })
    });

    if (!res.ok) {
      thinkingEl.remove();
      const err = await res.json();
      qaHistoryEl.innerHTML += `<div class="qa-message assistant" style="color:#dc2626">${escapeHtml(err.error || 'Failed to get answer.')}</div>`;
      qaBtn.disabled = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullAnswer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'token') {
            if (firstToken) {
              // Replace thinking dots with streaming answer
              thinkingEl.remove();
              answerEl = document.createElement('div');
              answerEl.className = 'qa-message assistant qa-streaming';
              qaHistoryEl.appendChild(answerEl);
              firstToken = false;
            }
            fullAnswer += event.text;
            answerEl.textContent = fullAnswer;
            qaHistoryEl.scrollTop = qaHistoryEl.scrollHeight;
          } else if (event.type === 'done') {
            if (answerEl) answerEl.className = 'qa-message assistant';
            qaHistory.push({ role: 'user', content: question });
            qaHistory.push({ role: 'assistant', content: event.answer });
          } else if (event.type === 'error') {
            thinkingEl.remove();
            qaHistoryEl.innerHTML += `<div class="qa-message assistant" style="color:#dc2626">${escapeHtml(event.message)}</div>`;
          }
        } catch { /* ignore parse errors */ }
      }
    }
  } catch {
    thinkingEl.remove();
    qaHistoryEl.innerHTML += `<div class="qa-message assistant" style="color:#dc2626">Failed to get answer. Please try again.</div>`;
  }

  qaBtn.disabled = false;
  qaHistoryEl.scrollTop = qaHistoryEl.scrollHeight;
}

// ---- History ----
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();

    if (data.length === 0) {
      historyList.innerHTML = '<p class="empty-history">No analyses yet</p>';
      return;
    }

    historyList.innerHTML = data.map(item => {
      const age = daysSince(item.created_at);
      const ageLabel = age === 0 ? 'today' : age === 1 ? '1d ago' : `${age}d ago`;
      const isStale = age >= 7;
      const conf = item.overall_confidence || 'unknown';
      return `
        <div class="history-item" data-id="${item.id}" data-name="${escapeHtml(item.company_name)}">
          <span class="history-name">${escapeHtml(item.company_name)}</span>
          <span class="history-right">
            <span class="history-conf-dot ${conf}"></span>
            <span class="history-age ${isStale ? 'history-stale' : 'history-fresh'}">${ageLabel}${isStale ? ' ↻' : ''}</span>
          </span>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => loadAnalysisById(el.dataset.id, el.dataset.name));
    });
  } catch { /* silent */ }
}

// ---- Load analysis by ID ----
async function loadAnalysisById(id, name) {
  try {
    const res = await fetch(`/api/analysis/${id}`);
    if (!res.ok) throw new Error('Not found');
    const analysis = await res.json();

    currentAnalysis = analysis;
    currentAnalysisId = id;
    qaHistory = [];
    qaHistoryEl.innerHTML = '';
    errorArea.classList.add('hidden');
    statusArea.classList.add('hidden');
    emptyState.classList.add('hidden');
    skeleton.classList.add('hidden');
    statsBar.classList.add('hidden');
    deltaSection.classList.add('hidden');
    hidePhaseProgress();

    if (name) companyInput.value = name;
    else if (analysis.company) companyInput.value = analysis.company;

    const age = daysSince(analysis.analysis_date || new Date().toISOString());
    showCacheBadge(age);

    resetRevealSections();
    renderBrief(analysis);

    resetPhases();
    PHASES.forEach(p => { phaseStates[p.id] = 'done'; });
    stepsPanel.classList.remove('hidden');
    renderSteps();
    revealBriefSections();
  } catch {
    errorArea.classList.remove('hidden');
    errorArea.textContent = 'Failed to load analysis.';
  }
}

// ---- Copy brief ----
function copyBrief() {
  if (!currentAnalysis) return;
  const a = currentAnalysis;
  const text = [
    `VERITY COMPETITIVE BRIEF: ${a.company}`,
    `Date: ${a.analysis_date}`,
    `Industry: ${a.industry} | Funding: ${a.funding_stage}`,
    `Confidence: ${a.overall_confidence}`,
    '', '--- EXECUTIVE SUMMARY ---', a.executive_summary,
    '', '--- KEY SIGNALS ---',
    ...(a.key_signals || []).map(s => `[${s.type.toUpperCase()}] [${s.confidence}] ${s.signal}`),
    '', '--- POSITIONING ---',
    `Self-description: ${a.positioning?.how_they_describe_themselves}`,
    `Target: ${a.positioning?.who_they_target}`,
    `Pricing: ${a.positioning?.pricing_model}`,
    '', '--- RECENT MOVES ---',
    ...(a.recent_moves || []).map(m => `${m.when}: ${m.what} — ${m.significance}`),
    '', '--- HIRING SIGNALS ---',
    `Areas: ${(a.hiring_signals?.growth_areas || []).join(', ')}`,
    a.hiring_signals?.interpretation,
    '', '--- CUSTOMER SENTIMENT ---',
    `Love: ${(a.customer_sentiment?.what_they_love || []).join('; ')}`,
    `Complaints: ${(a.customer_sentiment?.what_they_complain_about || []).join('; ')}`,
    a.customer_sentiment?.net_interpretation,
    '', '--- STRATEGIC "SO WHAT" ---', a.strategic_so_what,
    '', '--- SOURCES ---',
    ...(a.sources_used || []).map(s => s.url)
  ].join('\n');

  navigator.clipboard.writeText(text).then(() => showToast('Brief copied to clipboard'));
}

// ---- Share link ----
function copyShareLink() {
  if (!currentAnalysisId) return;
  const url = `${window.location.origin}/view/${currentAnalysisId}`;
  navigator.clipboard.writeText(url).then(() => showToast('Share link copied'));
}

// ---- Export PDF ----
function exportPdf() {
  if (!currentAnalysis) return;
  showToast('Opening print dialog…', '↓');
  setTimeout(() => window.print(), 300);
}

// ---- Utilities ----
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function truncateUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 30 ? u.pathname.substring(0, 30) + '…' : u.pathname);
  } catch {
    return url.substring(0, 50);
  }
}

function daysSince(dateStr) {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

// ---- Event listeners ----
analyzeBtn.addEventListener('click', () => {
  const company = companyInput.value.trim();
  if (company) startAnalysis(company);
});

companyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const company = companyInput.value.trim();
    if (company) startAnalysis(company);
  }
});

qaBtn.addEventListener('click', () => askFollowUp(qaInput.value));
qaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') askFollowUp(qaInput.value); });

copyBtn.addEventListener('click', copyBrief);
shareBtn.addEventListener('click', copyShareLink);
pdfBtn.addEventListener('click', exportPdf);

// ---- Example company chips ----
document.querySelectorAll('.chip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const company = btn.dataset.company;
    companyInput.value = company;
    startAnalysis(company);
  });
});

// ---- Mobile command bar ----
const mobileInput = document.querySelector('.mobile-company-input');
const mobileBtn = document.querySelector('.mobile-analyze-btn');
if (mobileInput && mobileBtn) {
  mobileBtn.addEventListener('click', () => {
    const val = mobileInput.value.trim();
    if (val) { companyInput.value = val; startAnalysis(val); }
  });
  mobileInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = mobileInput.value.trim();
      if (val) { companyInput.value = val; startAnalysis(val); }
    }
  });
}

// ---- Keyboard shortcuts ----
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    companyInput.focus();
    companyInput.select();
  }
  if (e.key === 'Escape') companyInput.blur();
});

// ---- Init ----
const viewMatch = window.location.pathname.match(/^\/view\/(.+)$/);
if (viewMatch) {
  loadAnalysisById(viewMatch[1]);
} else {
  startTips();
}

loadHistory();
