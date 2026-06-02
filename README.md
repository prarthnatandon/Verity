# Verity — Autonomous Competitive Intelligence

Verity is a production-grade AI research agent that autonomously investigates any company and generates a structured strategic brief — powered by Claude's agentic tool use, prompt caching, and extended thinking.

Enter a company name. In under 90 seconds, Verity's agent has scanned their website, read the last 90 days of news, analyzed job postings, scraped customer reviews, and synthesized everything into a structured brief with confidence scoring, source citations, and a strategic interpretation.

---

## What it produces

Every analysis outputs a structured brief with:

- **Strategic Interpretation** — a 4-6 sentence "so what" that interprets what the company is actually doing, not just what it says
- **Key Signals** — categorized as `move`, `risk`, `opportunity`, or `threat`, each with a confidence rating and source citation
- **Recent Moves** — product launches, funding, partnerships, and strategic pivots from the last 90 days
- **Positioning** — how they describe themselves, who they target, their pricing model, and key claims
- **Hiring Signals** — growth areas inferred from open roles, interpreted strategically
- **Customer Sentiment** — what customers love and complain about, with a visual sentiment score
- **Follow-up Q&A** — ask anything; answers are grounded exclusively in retrieved research

---

## Technical architecture

### Agent loop

Verity uses a **ReAct (Reason → Act → Observe → Repeat)** agentic loop. Claude doesn't run as a single API call — it's a stateful multi-turn conversation where the model decides what to search, fetches pages, reasons about what it found, and decides what to do next. The loop runs up to 12 iterations before synthesizing.

```
User prompt
    ↓
[Iteration 1] Claude reasons → calls web_search → observes results
[Iteration 2] Claude reasons → calls web_fetch(company homepage) → observes
[Iteration 3] Claude reasons → calls web_search(recent news) → observes
...up to 12 iterations...
[Final]       Claude synthesizes → outputs structured JSON brief
```

### Prompt caching

Every API call in the loop uses `cache_control: { type: "ephemeral" }` on both the system prompt and the growing conversation history. This means the 700-token system prompt is encoded once per 5-minute window instead of on every iteration — reducing cost by 50–65% after the first run. Follow-up Q&A caches the entire research context blob (5k–10k tokens) for the duration of the conversation.

```js
const CACHED_SYSTEM = [
  { type: "text", text: AGENT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
];
```

### Extended thinking synthesis

When "Deep synthesis" is enabled, a second dedicated API call runs after the research loop with `thinking: { type: "enabled", budget_tokens: 5000 }`. This gives Claude a private reasoning scratchpad to produce a more incisive strategic interpretation before writing the final output — tool use and extended thinking can't be combined in a single call, so this requires a separate pass.

### Streaming

Real-time feedback is delivered via **Server-Sent Events (SSE)**. The frontend opens a persistent connection and receives events as they happen: tool calls, reasoning text, phase transitions, and the final result. Follow-up Q&A uses `anthropic.messages.stream()` for token-by-token streaming.

### Confidence scoring

Every signal is graded `high`, `medium`, or `low` with a plain-English explanation — not a black box. The grading rules are enforced in the system prompt: high = 3+ sources or direct company statement, medium = 1-2 sources or inference, low = single weak signal.

---

## Features

| Feature | Description |
|---|---|
| **Research focus modes** | Tailor any brief: competitive threat, partnership evaluation, investment research, or sales intelligence |
| **Your context** | Tell Verity who you are ("I run a competing B2B startup") and the SO WHAT adapts to your vantage point |
| **Deep synthesis** | Extended thinking pass for a more incisive strategic interpretation |
| **Signal filters** | Filter key signals by type (threat / risk / opportunity / move) or confidence level |
| **Multi-company comparison** | Research 2–3 companies in parallel and get a side-by-side matrix with a Claude-generated strategic summary |
| **Inline Ask** | Hover any signal card and click "→ Ask about this" to pre-fill the follow-up Q&A |
| **Analysis delta** | When refreshing a stale analysis, highlights exactly what changed vs. last time |
| **Shareable URLs** | Every analysis gets a `/view/:id` permalink |
| **Copy for Slack** | One-click copy formatted as Slack markdown with bold headers, blockquotes, and emoji confidence indicators |
| **PDF export** | Print-optimized CSS for clean one-click export |
| **Supabase persistence** | Analyses cached with 7-day TTL, normalized company name matching, graceful in-memory fallback |
| **Rate limiting** | 5 analyses / hour + 30 follow-ups / hour per IP |

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM), Express |
| AI | Anthropic Claude (`claude-sonnet-4-20250514`) |
| Agent tools | `web_search_20250305`, `web_fetch_20250910` |
| Streaming | Server-Sent Events (SSE), `anthropic.messages.stream()` |
| Caching | Anthropic prompt caching (`cache_control: ephemeral`) |
| Database | Supabase (PostgreSQL) |
| Frontend | Vanilla JS, CSS animations — no build step |

---

## Running locally

```bash
# 1. Clone and install
git clone https://github.com/prarthnatandon/Verity.git
cd Verity
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and fill in your keys (see below)

# 3. Start the dev server
node --watch server.js
```

Open `http://localhost:3000`

### Environment variables

```bash
ANTHROPIC_API_KEY=your_anthropic_key      # Required — get from console.anthropic.com
SUPABASE_URL=your_supabase_url            # Optional — analyses fall back to in-memory store
SUPABASE_ANON_KEY=your_supabase_anon_key  # Optional
```

Supabase is optional. Without it, analyses are stored in memory and lost on server restart.

### Supabase setup (optional)

Run this in your Supabase SQL editor:

```sql
CREATE TABLE analyses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name text NOT NULL,
  company_name_normalized text NOT NULL,
  analysis_json jsonb NOT NULL,
  sources_count integer,
  overall_confidence text,
  created_at timestamptz DEFAULT now(),
  is_stale boolean DEFAULT false
);

CREATE INDEX ON analyses (company_name_normalized);
CREATE INDEX ON analyses (created_at DESC);
```

---

## Project structure

```
Verity/
├── server.js          # Express app — routes, SSE endpoints, rate limiting
├── agent.js           # ReAct loop, prompt caching, extended thinking, comparison synthesis
├── prompts.js         # All system prompts and prompt builders (separated for iteration)
├── supabase.js        # Database client and all query functions
└── public/
    ├── index.html     # Main app shell
    ├── app.js         # Frontend logic — SSE handling, rendering, Q&A, filters
    ├── style.css      # Design system — violet/light, Geist font, animations
    ├── compare.html   # Multi-company comparison page
    ├── landing.html   # Marketing landing page
    └── landing.css    # Landing page styles
```

---

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/analyze/stream` | GET | SSE stream — runs the research agent. Params: `company`, `focus`, `context`, `deep` |
| `/api/compare` | GET | SSE stream — parallel agents for 2-3 companies. Param: `companies` (comma-separated) |
| `/api/followup/stream` | POST | SSE stream — token-by-token Q&A on retrieved research |
| `/api/analysis/:id` | GET | Retrieve a stored analysis by ID |
| `/api/history` | GET | List recent analyses |
| `/api/health` | GET | Health check — confirms API key and DB connectivity |
