// agent.js — The ReAct agentic loop: the technical heart of Verity.
//
// Pattern: ReAct (Reason -> Act -> Observe -> Repeat)
// The agent is NOT a single API call. It is a loop where Claude reasons about
// what to do next, calls tools (web_search, web_fetch), observes results,
// and repeats until it has enough information to synthesize a structured brief.

import Anthropic from '@anthropic-ai/sdk';
import {
  AGENT_SYSTEM_PROMPT,
  buildResearchPrompt,
  buildResearchWithPriorContextPrompt
} from './prompts.js';

const anthropic = new Anthropic();

// Claude Sonnet pricing (per million tokens)
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// Tool definitions for the Anthropic API — these are server-side tools
// that Claude can request. We execute them here, not in the browser.
const tools = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 15
  },
  {
    type: "web_fetch_20250910",
    name: "web_fetch"
  }
];

// Retry wrapper for API calls — handles 429 rate limit errors with backoff
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

// Extract JSON from text that might be wrapped in markdown code fences
function extractJSON(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    // Try to find JSON object in the text
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error(`Failed to parse agent output as JSON: ${e.message}`);
  }
}

// Compute estimated cost from token counts
function computeCost(inputTokens, outputTokens) {
  return parseFloat(((inputTokens * COST_PER_M_INPUT + outputTokens * COST_PER_M_OUTPUT) / 1_000_000).toFixed(4));
}

// Run the agentic research loop for a company
// focus: optional string key for research focus (e.g. "competitive_threat")
// onStep: callback for each tool call/result/reasoning (for SSE streaming to frontend)
// onComplete: callback with the final structured analysis and token stats
export async function runAgent(companyName, onStep, onComplete, focus = null) {
  const messages = [];
  let iteration = 0;
  const MAX_ITERATIONS = 12;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  console.log(`[agent] Starting research for "${companyName}"${focus ? ` (focus: ${focus})` : ''}`);

  // Initial user message kicks off the research agenda
  messages.push({
    role: "user",
    content: buildResearchPrompt(companyName, focus)
  });

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`[agent] Iteration ${iteration}/${MAX_ITERATIONS}`);

    const response = await callWithRetry(() => anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: AGENT_SYSTEM_PROMPT,
      tools: tools,
      messages: messages
    }));

    // Accumulate token usage across all iterations
    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    // Add assistant response to message history
    messages.push({ role: "assistant", content: response.content });

    // Log what the agent is thinking
    const textBlocks = response.content.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      const thinking = textBlocks.map(b => b.text).join("").substring(0, 200);
      console.log(`[agent] Thinking: ${thinking}...`);
    }

    // Check stop reason — "end_turn" means the agent decided it's done
    if (response.stop_reason === "end_turn") {
      console.log(`[agent] Agent finished after ${iteration} iterations`);

      const finalText = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");

      try {
        const parsed = extractJSON(finalText);
        parsed.analysis_date = parsed.analysis_date || new Date().toISOString().split('T')[0];
        const tokenStats = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          estimatedCostUsd: computeCost(totalInputTokens, totalOutputTokens)
        };
        onComplete(parsed, tokenStats);
        return parsed;
      } catch (e) {
        console.error(`[agent] Failed to parse final output:`, e.message);
        throw new Error(`Agent produced invalid output: ${e.message}`);
      }
    }

    // "tool_use" means the agent wants to call tools — execute them
    if (response.stop_reason === "tool_use") {
      // Emit any reasoning text the agent produced before calling tools
      const reasoningBlocks = response.content.filter(b => b.type === "text");
      if (reasoningBlocks.length > 0) {
        const reasoning = reasoningBlocks.map(b => b.text).join("").trim();
        if (reasoning) {
          onStep({ type: "reasoning", text: reasoning, iteration });
        }
      }

      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const toolInput = toolUse.input;
        const toolName = toolUse.name;

        // Emit step event to frontend via SSE
        onStep({
          type: "tool_call",
          tool: toolName,
          input: toolInput,
          iteration
        });

        console.log(`[agent] Tool call: ${toolName}(${JSON.stringify(toolInput).substring(0, 100)})`);

        // Tool results are handled by the Anthropic API internally for
        // server-side web_search and web_fetch. We pass them back as
        // tool_result blocks so the conversation continues.
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Tool executed successfully. Results are available in the conversation context."
        });

        onStep({
          type: "tool_result",
          tool: toolName,
          iteration
        });
      }

      // Add tool results to conversation so the agent can observe them
      messages.push({ role: "user", content: toolResults });
    }
  }

  throw new Error(`Agent exceeded maximum iterations (${MAX_ITERATIONS})`);
}

// Run agent with prior analysis context (for stale cache refreshes)
export async function runAgentWithPriorContext(companyName, priorAnalysis, onStep, onComplete) {
  const messages = [];
  let iteration = 0;
  const MAX_ITERATIONS = 12;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  console.log(`[agent] Starting research for "${companyName}" (with prior context)`);

  messages.push({
    role: "user",
    content: buildResearchWithPriorContextPrompt(companyName, priorAnalysis)
  });

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`[agent] Iteration ${iteration}/${MAX_ITERATIONS} (with prior)`);

    const response = await callWithRetry(() => anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: AGENT_SYSTEM_PROMPT,
      tools: tools,
      messages: messages
    }));

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      console.log(`[agent] Agent finished after ${iteration} iterations`);

      const finalText = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");

      try {
        const parsed = extractJSON(finalText);
        parsed.analysis_date = parsed.analysis_date || new Date().toISOString().split('T')[0];
        const tokenStats = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          estimatedCostUsd: computeCost(totalInputTokens, totalOutputTokens)
        };
        onComplete(parsed, tokenStats);
        return parsed;
      } catch (e) {
        throw new Error(`Agent produced invalid output: ${e.message}`);
      }
    }

    if (response.stop_reason === "tool_use") {
      // Emit reasoning text
      const reasoningBlocks = response.content.filter(b => b.type === "text");
      if (reasoningBlocks.length > 0) {
        const reasoning = reasoningBlocks.map(b => b.text).join("").trim();
        if (reasoning) {
          onStep({ type: "reasoning", text: reasoning, iteration });
        }
      }

      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        onStep({
          type: "tool_call",
          tool: toolUse.name,
          input: toolUse.input,
          iteration
        });

        console.log(`[agent] Tool call: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)})`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Tool executed successfully. Results are available in the conversation context."
        });

        onStep({
          type: "tool_result",
          tool: toolUse.name,
          iteration
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  throw new Error(`Agent exceeded maximum iterations (${MAX_ITERATIONS})`);
}

// Handle follow-up Q&A — no web searches, only reasons over retrieved research
export async function handleFollowUp(followUpContext, userQuestion, conversationHistory) {
  const { buildFollowUpSystemPrompt } = await import('./prompts.js');

  const messages = [
    ...conversationHistory,
    { role: "user", content: userQuestion }
  ];

  console.log(`[agent] Follow-up question: "${userQuestion.substring(0, 80)}..."`);

  const response = await callWithRetry(() => anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: buildFollowUpSystemPrompt(followUpContext),
    messages: messages
  }));

  return response.content[0].text;
}

// Streaming follow-up Q&A — streams tokens in real-time via callbacks
export async function handleFollowUpStream(followUpContext, userQuestion, conversationHistory, onToken, onDone) {
  const { buildFollowUpSystemPrompt } = await import('./prompts.js');

  const messages = [
    ...conversationHistory,
    { role: "user", content: userQuestion }
  ];

  console.log(`[agent] Streaming follow-up: "${userQuestion.substring(0, 80)}"`);

  let fullText = '';

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: buildFollowUpSystemPrompt(followUpContext),
    messages: messages
  });

  stream.on('text', (text) => {
    fullText += text;
    onToken(text);
  });

  await stream.finalMessage();
  onDone(fullText);
}
