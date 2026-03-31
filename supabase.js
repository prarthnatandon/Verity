// supabase.js — Supabase client and all database operations.
// The Supabase connection is server-authenticated, never exposed to the client.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[supabase] WARNING: SUPABASE_URL or SUPABASE_ANON_KEY not set. Database features disabled.');
}

const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

function daysSince(dateString) {
  const then = new Date(dateString);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

// Check cache for a recent analysis of this company
export async function checkCache(companyName) {
  if (!supabase) return null;

  const normalized = companyName.toLowerCase().trim();

  try {
    const { data, error } = await supabase
      .from('analyses')
      .select('*')
      .eq('company_name_normalized', normalized)
      .eq('is_stale', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;

    const age = daysSince(data.created_at);

    if (age < 7) {
      return { data: data.analysis_json, age, id: data.id };
    }

    // Stale but exists — return with stale flag for re-analysis with prior context
    return { data: data.analysis_json, age, id: data.id, stale: true };
  } catch (err) {
    console.error('[supabase] Cache check failed:', err.message);
    return null;
  }
}

// Save a completed analysis
export async function saveAnalysis(companyName, analysisJson) {
  if (!supabase) {
    console.log('[supabase] DB not configured — skipping save');
    return null;
  }

  const normalized = companyName.toLowerCase().trim();

  try {
    const { data, error } = await supabase
      .from('analyses')
      .insert({
        company_name: companyName,
        company_name_normalized: normalized,
        analysis_json: analysisJson,
        sources_count: analysisJson.sources_used?.length || 0,
        overall_confidence: analysisJson.overall_confidence || 'unknown'
      })
      .select()
      .single();

    if (error) {
      console.error('[supabase] Save failed:', error.message);
      return null;
    }

    console.log(`[supabase] Analysis saved for "${companyName}" (id: ${data.id})`);
    return data;
  } catch (err) {
    console.error('[supabase] Save failed:', err.message);
    return null;
  }
}

// Get analysis by ID
export async function getAnalysisById(id) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('analyses')
      .select('*')
      .eq('id', id)
      .single();

    if (error) return null;
    return data;
  } catch (err) {
    console.error('[supabase] Fetch by ID failed:', err.message);
    return null;
  }
}

// Get history of past analyses
export async function getHistory() {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('analyses')
      .select('id, company_name, overall_confidence, sources_count, created_at')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) return [];
    return data;
  } catch (err) {
    console.error('[supabase] History fetch failed:', err.message);
    return [];
  }
}

/*
  SQL to run in your Supabase SQL Editor:

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
*/
