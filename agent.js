// agent.js — The ReAct agentic loop: the technical heart of Verity.
//
// Pattern: ReAct (Reason -> Act -> Observe -> Repeat)
// The agent reasons about what to do next, calls tools (web_search, web_fetch),
// observes results, and repeats until it has enough information to synthesize.

import Anthropic from '@anthropic-ai/sdk';
import {
  AGENT_SYSTEM_PROMPT,
  buildResearchPrompt,
  buildResearchWithPriorContextPrompt,
  buildFollowUpSystemPrompt
} from './prompts.js';

const anthropic = new Anthropic();

// Claude Sonnet pricing (per million tokens)
const COST_PER_M_INPUT        = 3.0;
const COST_PER_M_OUTPUT       = 15.0;
const COST_PER_M_CACHE_WRITE  = 3.75;  // 25% premium over input
const COST_PER_M_CACHE_READ   = 0.30;  // 90% discount vs input

const tools = [
  { type: "web_search_20250305", name: "web_search", max_uses: 15 },
  { type: "web_fetch_20250910",  name: "web_fetch" }
];

// System prompt as a cached array — the 700-token system block is encoded once
// per 5-minute TTL window instead of on every iteration of the loop.
const CACHED_SYSTEM = [
  {
    type: "text",
    text: AGENT_SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" }
  }
];

async function callWithRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err?.status === 429 || err?.error?.type === 'rate_limit_error';
      if (isRateLimit && attempt < maxRetries) {
        const waitSec = attempt * 15;
        console.log(`[agent] Rate limited. Waiting ${waitSec}s before retry ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw err;
      }
    }
  }
}

function extractJSON(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Failed to parse agent output as JSON');
  }
}

function computeCost(inputTokens, outputTokens, cacheWriteTokens = 0, cacheReadTokens = 0) {
  return parseFloat((
    (inputTokens     * COST_PER_M_INPUT       +
     outputTokens    * COST_PER_M_OUTPUT      +
     cacheWriteTokens * COST_PER_M_CACHE_WRITE +
     cacheReadTokens  * COST_PER_M_CACHE_READ) / 1_000_000
  ).toFixed(4));
}

// Mark the last message in the conversation with a cache breakpoint so the
// growing conversation history is cached between loop iterations.
function withCacheBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const copy = messages.map(m => ({ ...m }));
  const last = copy[copy.length - 1];
  if (Array.isArray(last.content) && last.content.length > 0) {
    const contentCopy = last.content.map(b => ({ ...b }));
    contentCopy[contentCopy.length - 1] = {
      ...contentCopy[contentCopy.length - 1],
      cache_control: { type: "ephemeral" }
    };
    copy[copy.length - 1] = { ...last, content: contentCopy };
  }
  return copy;
}

// Run the agentic research loop.
// options.focus        — research focus key (e.g. "competitive_threat")
// options.priorAnalysis — prior analysis JSON for stale-cache refreshes
// options.userContext  — optional reader context string for personalization
// options.deep        — run a second extended-thinking synthesis pass on SO WHAT
export async function runAgent(companyName, onStep, onComplete, options = {}) {
  const { focus = null, priorAnalysis = null, deep = false } = options;

  const messages = [];
  let iteration = 0;
  const MAX_ITERATIONS = 12;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;

  console.log(`[agent] Starting research for "${companyName}"` +
    `${focus ? ` (focus: ${focus})` : ''}` +
    `${priorAnalysis ? ' (with prior context)' : ''}`);

  // Use array content so withCacheBreakpoint can attach cache_control to this message
  const initialPrompt = priorAnalysis
    ? buildResearchWithPriorContextPrompt(companyName, priorAnalysis)
    : buildResearchPrompt(companyName, focus, options.userContext || null);

  messages.push({
    role: "user",
    content: [{ type: "text", text: initialPrompt, cache_control: { type: "ephemeral" } }]
  });

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`[agent] Iteration ${iteration}/${MAX_ITERATIONS}`);

    const response = await callWithRetry(() => anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: CACHED_SYSTEM,
      tools,
      messages: withCacheBreakpoint(messages)
    }));

    totalInputTokens       += response.usage?.input_tokens              || 0;
    totalOutputTokens      += response.usage?.output_tokens             || 0;
    totalCacheWriteTokens  += response.usage?.cache_creation_input_tokens || 0;
    totalCacheReadTokens   += response.usage?.cache_read_input_tokens    || 0;

    if (totalCacheReadTokens > 0 || totalCacheWriteTokens > 0) {
      console.log(`[agent] Cache: ${totalCacheWriteTokens} written, ${totalCacheReadTokens} read`);
    }

    messages.push({ role: "assistant", content: response.content });

    const textBlocks = response.content.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      const preview = textBlocks.map(b => b.text).join("").substring(0, 200);
      console.log(`[agent] Thinking: ${preview}...`);
    }

    if (response.stop_reason === "end_turn") {
      console.log(`[agent] Finished after ${iteration} iterations`);

      const finalText = response.content.filter(b => b.type === "text").map(b => b.text).join("");

      try {
        const parsed = extractJSON(finalText);
        parsed.analysis_date = parsed.analysis_date || new Date().toISOString().split('T')[0];

        // Extended thinking synthesis pass — improves strategic_so_what when deep=true
        if (deep && parsed.follow_up_context) {
          console.log(`[agent] Running extended thinking synthesis for "${companyName}"...`);
          try {
            const thinkingResponse = await callWithRetry(() => anthropic.messages.create({
              model: "claude-sonnet-4-20250514",
              max_tokens: 6000,
              thinking: { type: "enabled", budget_tokens: 5000 },
              messages: [{
                role: "user",
                content: `You are a strategic analyst. Based on this research about ${companyName}, write the most incisive 4-6 sentence strategic interpretation possible. Be specific, non-obvious, and actionable — focus on what this company is ACTUALLY doing, what they're moving toward, what they're leaving behind, and what that creates in the market.

Research:
${parsed.follow_up_context.substring(0, 8000)}

Existing interpretation (improve significantly on this):
${parsed.strategic_so_what}`
              }]
            }));

            const betterSoWhat = thinkingResponse.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('').trim();

            if (betterSoWhat) {
              parsed.strategic_so_what = betterSoWhat;
              parsed._deep_synthesis = true;
              totalInputTokens  += thinkingResponse.usage?.input_tokens  || 0;
              totalOutputTokens += thinkingResponse.usage?.output_tokens || 0;
              console.log(`[agent] Extended thinking synthesis complete`);
            }
          } catch (thinkErr) {
            console.warn(`[agent] Extended thinking failed (using original): ${thinkErr.message}`);
          }
        }

        const tokenStats = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheWriteTokens: totalCacheWriteTokens,
          cacheReadTokens: totalCacheReadTokens,
          estimatedCostUsd: computeCost(totalInputTokens, totalOutputTokens, totalCacheWriteTokens, totalCacheReadTokens)
        };
        onComplete(parsed, tokenStats);
        return parsed;
      } catch (e) {
        throw new Error(`Agent produced invalid output: ${e.message}`);
      }
    }

    if (response.stop_reason === "tool_use") {
      const reasoningBlocks = response.content.filter(b => b.type === "text");
      if (reasoningBlocks.length > 0) {
        const reasoning = reasoningBlocks.map(b => b.text).join("").trim();
        if (reasoning) onStep({ type: "reasoning", text: reasoning, iteration });
      }

      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        onStep({ type: "tool_call", tool: toolUse.name, input: toolUse.input, iteration });
        console.log(`[agent] Tool: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)})`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Tool executed successfully. Results are available in the conversation context."
        });

        onStep({ type: "tool_result", tool: toolUse.name, iteration });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  throw new Error(`Agent exceeded maximum iterations (${MAX_ITERATIONS})`);
}

// Synthesize a comparison matrix across 2-3 company analyses
export async function synthesizeComparison(results) {
  const summaries = results.map(r =>
    `${r.company}:\nExecutive summary: ${r.analysis.executive_summary}\nStrategic interpretation: ${r.analysis.strategic_so_what}\nTop signals: ${(r.analysis.key_signals || []).slice(0, 3).map(s => s.signal).join('; ')}\nSentiment: ${r.analysis.customer_sentiment?.net_interpretation || 'N/A'}`
  ).join('\n\n---\n\n');

  const response = await callWithRetry(() => anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are a strategic analyst comparing companies. Return ONLY a valid JSON object with this exact schema — no preamble:
{
  "winner_momentum": "the company with the most strategic momentum and a one-sentence explanation",
  "biggest_differentiator": "what fundamentally separates these companies from each other",
  "shared_risk": "the biggest risk all of them face",
  "market_map": "2-3 sentences on how they are positioned relative to each other in the market",
  "rows": [
    { "dimension": "Positioning angle", "values": { ${results.map(r => `"${r.company}": "..."`).join(', ')} } },
    { "dimension": "Biggest strength", "values": { ${results.map(r => `"${r.company}": "..."`).join(', ')} } },
    { "dimension": "Biggest risk", "values": { ${results.map(r => `"${r.company}": "..."`).join(', ')} } },
    { "dimension": "Strategic momentum", "values": { ${results.map(r => `"${r.company}": "high | medium | low"`).join(', ')} } }
  ]
}

Companies to compare:
${summaries}`
    }]
  }));

  return extractJSON(response.content[0].text);
}

// Streaming follow-up Q&A — the follow_up_context system prompt is cached
// so the large research blob is only encoded once per 5-minute TTL window.
export async function handleFollowUpStream(followUpContext, userQuestion, conversationHistory, onToken, onDone) {
  const cachedFollowUpSystem = [
    {
      type: "text",
      text: buildFollowUpSystemPrompt(followUpContext),
      cache_control: { type: "ephemeral" }
    }
  ];

  const messages = [
    ...conversationHistory,
    { role: "user", content: userQuestion }
  ];

  console.log(`[agent] Streaming follow-up: "${userQuestion.substring(0, 80)}"`);

  let fullText = '';

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: cachedFollowUpSystem,
    messages
  });

  stream.on('text', (text) => {
    fullText += text;
    onToken(text);
  });

  await stream.finalMessage();
  onDone(fullText);
}

// Non-streaming follow-up (kept for backwards compat with /api/followup)
export async function handleFollowUp(followUpContext, userQuestion, conversationHistory) {
  const cachedFollowUpSystem = [
    {
      type: "text",
      text: buildFollowUpSystemPrompt(followUpContext),
      cache_control: { type: "ephemeral" }
    }
  ];

  const messages = [
    ...conversationHistory,
    { role: "user", content: userQuestion }
  ];

  console.log(`[agent] Follow-up: "${userQuestion.substring(0, 80)}"`);

  const response = await callWithRetry(() => anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: cachedFollowUpSystem,
    messages
  }));

  return response.content[0].text;
}
