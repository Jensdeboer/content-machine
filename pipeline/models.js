'use strict';
// The only way any stage talks to a model.
//
//   callModel({ stage, prompt, schema, config, ... }) -> parsed JSON
//
// No stage shells out to a CLI or imports an SDK itself. Two backends:
//
//   cli   (default) `claude -p --output-format json --model <id>`, a subprocess
//         against the box's existing Max-plan login. No API key, no per-token
//         bill: adding a brand costs a folder, not money.
//   stub  MODELS_BACKEND=stub, fixtures from pipeline/fixtures/, so a whole run
//         is exercisable offline.
//
// Strict JSON is enforced here, not in the callers. The expected shape goes in
// the prompt; the response is parsed here; a parse failure is retried once with
// the parse error fed back. Twice failed throws ModelError, and the caller parks
// the deck as needs_attention. Half-parsed output is never returned.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

class ModelError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ModelError';
    Object.assign(this, detail);
  }
}

// ------------------------------------------------------------------ shapes ---
// The schema is passed to the model as the shape it must return. Kept as plain
// text so the prompt reads like an instruction rather than a JSON Schema dump.
function shapeInstruction(schema) {
  return [
    'Return JSON and nothing else. No prose before or after, no markdown fence.',
    'The JSON must match this shape exactly:',
    typeof schema === 'string' ? schema : JSON.stringify(schema, null, 2),
  ].join('\n');
}

// A model that has been told "JSON only" still occasionally wraps it. Pull the
// first balanced JSON value out of the text rather than failing the run on a
// fence, but never guess at malformed JSON.
function extractJson(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try { return JSON.parse(candidate); } catch (e) { /* fall through to scan */ }

  const start = candidate.search(/[{[]/);
  if (start < 0) throw new SyntaxError('no JSON value in the response');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new SyntaxError('unterminated JSON value in the response');
}

// --------------------------------------------------------------- cli backend ---
function runClaude({ modelId, prompt, timeoutMs, allowedTools, cwd }) {
  const args = ['-p', '--output-format', 'json', '--model', modelId];
  if (allowedTools && allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  else args.push('--strict-mcp-config'); // no tools, no MCP servers: a scan call should not browse

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: cwd || ROOT, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ModelError(`claude cli timed out after ${timeoutMs}ms`, { kind: 'timeout', stderr: stderr.slice(-400) }));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new ModelError(`claude cli could not start: ${e.message}`, { kind: 'spawn' }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) {
        return reject(new ModelError(`claude cli exited ${code}`, { kind: 'exit', code, stderr: stderr.slice(-400) }));
      }
      resolve(stdout);
    });

    child.stdin.end(prompt);
  });
}

// `--output-format json` wraps the answer in an envelope; the model's own text
// is the `result` field. Older/newer shapes are tolerated by falling back to the
// raw stdout.
function unwrapCliEnvelope(stdout) {
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      if (env.is_error) throw new ModelError(`claude cli reported an error: ${String(env.result || '').slice(0, 300)}`, { kind: 'cli-error' });
      if (typeof env.result === 'string') return env.result;
      if (Array.isArray(env.content)) {
        const text = env.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
        if (text) return text;
      }
    }
  } catch (e) {
    if (e instanceof ModelError) throw e;
  }
  return stdout;
}

// -------------------------------------------------------------- stub backend ---
function stubFor(stage, callIndex) {
  const file = path.join(FIXTURES, `${stage}.json`);
  if (!fs.existsSync(file)) {
    throw new ModelError(`MODELS_BACKEND=stub but no fixture for the "${stage}" stage (${file})`, { kind: 'fixture-missing' });
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A fixture may be a single response, or a list of responses for stages that
  // are called more than once in a run (scan chunks, per-idea verify/write).
  if (Array.isArray(data.responses)) return data.responses[Math.min(callIndex, data.responses.length - 1)];
  return data;
}

const stubCounters = new Map();

// ---------------------------------------------------------------- the entry ---
async function callModel({ stage, prompt, schema, config, backend, timeoutMs, allowedTools, log = () => {} }) {
  if (!stage) throw new ModelError('callModel needs a stage');
  if (!prompt) throw new ModelError(`callModel(${stage}) needs a prompt`);

  const chosen = backend || process.env.MODELS_BACKEND || 'cli';
  if (chosen === 'stub') {
    const n = stubCounters.get(stage) || 0;
    stubCounters.set(stage, n + 1);
    log(`models: stage=${stage} backend=stub call=${n + 1}`);
    return stubFor(stage, n);
  }

  const modelId = config.models.forStage(stage);
  if (!modelId) throw new ModelError(`config.md gives the "${stage}" stage no model; it is pure code`);
  const limit = timeoutMs || config.models.timeoutMs;

  const full = `${prompt}\n\n${shapeInstruction(schema)}`;
  const attempts = [];
  let text = null;

  // Attempt 1, then one retry on a transport failure, then one retry on a parse
  // failure with the parse error fed back. Never more: a stage that cannot
  // answer twice is a stage failure, and the deck parks as needs_attention.
  for (let transport = 0; transport < 2 && text === null; transport++) {
    try {
      log(`models: stage=${stage} backend=cli model=${modelId} attempt=${transport + 1}`);
      const stdout = await runClaude({ modelId, prompt: full, timeoutMs: limit, allowedTools, cwd: ROOT });
      text = unwrapCliEnvelope(stdout);
    } catch (e) {
      attempts.push(e.message);
      if (transport === 1) {
        throw new ModelError(`${stage}: the model could not be reached (${attempts.join(' | ')})`, { stage, kind: 'transport', attempts });
      }
    }
  }

  try {
    return extractJson(text);
  } catch (parseError) {
    log(`models: stage=${stage} first response did not parse (${parseError.message}); retrying once with the error fed back`);
    const repair = [
      full,
      '',
      'Your previous reply could not be parsed as JSON.',
      `The parse error was: ${parseError.message}`,
      'Here is what you replied, between the markers:',
      '<<<PREVIOUS', String(text).slice(0, 4000), 'PREVIOUS>>>',
      'Reply again with valid JSON matching the shape above, and nothing else.',
    ].join('\n');
    let retryText;
    try {
      retryText = unwrapCliEnvelope(await runClaude({ modelId, prompt: repair, timeoutMs: limit, allowedTools, cwd: ROOT }));
    } catch (e) {
      throw new ModelError(`${stage}: reply did not parse and the repair call failed (${e.message})`, { stage, kind: 'transport' });
    }
    try {
      return extractJson(retryText);
    } catch (second) {
      throw new ModelError(`${stage}: the model returned unparseable JSON twice (${parseError.message}; then ${second.message})`, {
        stage, kind: 'parse', first: String(text).slice(0, 500), second: String(retryText).slice(0, 500),
      });
    }
  }
}

module.exports = { callModel, ModelError, extractJson, shapeInstruction };
