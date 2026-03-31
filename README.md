# Verity — Autonomous Competitive Intelligence

Verity is a production-grade AI research agent that autonomously investigates any company and generates a structured strategic brief — powered by Claude's agentic tool use.

## What it does

Enter a company name. Verity's agent autonomously:
1. Scans their official website for positioning language
2. Searches for news and announcements from the last 90 days
3. Analyzes job postings to infer strategic investment priorities
4. Reads customer reviews for sentiment signals
5. Synthesizes everything into a structured brief with confidence scoring

## Technical architecture

- **ReAct agentic loop** — Claude reasons, acts (web search/fetch), observes results, and iterates up to 12 times before synthesizing
- **Server-Sent Events (SSE)** — real-time streaming of agent steps, reasoning, and results to the frontend
- **Streaming token-by-token Q&A** — follow-up questions stream live using `anthropic.messages.stream()`
- **Token & cost tracking** — accumulates input/output tokens across all iterations, computes estimated cost per analysis
- **Live agent reasoning** — Claude's thinking between tool calls streams to the UI in real time
- **Supabase persistence** — analyses cached with 7-day TTL, normalized company name matching, graceful in-memory fallback
- **Analysis delta** — when refreshing a stale analysis, computes and displays what changed vs. last time
- **Research focus modes** — tailor the brief for competitive threat, partnership evaluation, investment research, or sales intelligence
- **Shareable URLs** — every analysis gets a `/view/:id` permalink
- **PDF export** — print-optimized CSS for clean one-click export

## Stack

- **Backend:** Node.js, Express, Anthropic Claude API (`claude-sonnet-4-20250514`)
- **Agent tools:** `web_search_20250305`, `web_fetch_20250910`
- **Database:** Supabase (PostgreSQL)
- **Frontend:** Vanilla JS, SSE streaming, CSS animations

## Running locally

```bash
# Install dependencies
npm install

# Add environment variables
cp .env.example .env
# Fill in your ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

# Start the server
node --watch server.js
```

Open `http://localhost:3000`

## Environment variables

```
ANTHROPIC_API_KEY=your_anthropic_key
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```
