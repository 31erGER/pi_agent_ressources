#!/usr/bin/env node
/**
 * test-web.mjs — TDD harness for the web-tools pi extension.
 *
 * Loads /home/julian/.pi/agent/extensions/web.ts (native TS import, Node 23+),
 * mocks the pi extension API, and verifies the tool contract:
 *
 *   - every execute() returns { content: [{type:'text', text}], details }
 *     (a bare string crashes pi's getTextOutput — see crashes.json)
 *   - failures return isError: true, never throw
 *   - search actually uses the given query, honors max_results, has a config block
 *   - fetch goes DIRECTLY to the requested URL (no proxy/URL rewriting),
 *     converts HTML to plain text locally, decodes entities, truncates with a
 *     notice, and signals non-2xx / network / invalid-scheme errors
 *
 * The fetch suite runs against a recording stub of globalThis.fetch (hermetic:
 * no third party, no external network). The search suite talks to the local
 * SearXNG container (http://localhost:8080); two search tests stub the network
 * to simulate SearXNG being down / erroring.
 *
 * Usage:  node test-web.mjs [core|search|fetch]     (default: all)
 * Exit:   0 = all pass, 1 = any failure, 2 = watchdog timeout
 */
import { readFileSync } from 'node:fs';

const EXT_PATH = '/home/julian/.pi/agent/extensions/web.ts';
const EXT_SRC = () => readFileSync(EXT_PATH, 'utf8');
const SIG = () => new AbortController().signal;

// ---------------- tiny test runner ----------------
const tests = [];
const test = (suite, name, fn) => tests.push({ suite, name, fn });
let failures = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Result-shape contract: must be the pi result object, never a bare string. */
function assertResult(res, label) {
  assert(
    res !== null && typeof res === 'object' && !Array.isArray(res),
    `${label}: result must be a result object, got ${typeof res}${typeof res === 'string' ? ' (BARE STRING — crashes pi)' : ''}`,
  );
  assert(Array.isArray(res.content) && res.content.length > 0, `${label}: result.content must be a non-empty array`);
  assert(res.content[0].type === 'text' && typeof res.content[0].text === 'string', `${label}: result.content[0] must be {type:'text', text:string}`);
  return res;
}
const textOf = (res) => res.content[0].text;

// ---------------- recording fetch stub ----------------
/**
 * Replace globalThis.fetch for the duration of fn.
 * routes: [{ match: RegExp, body: string|Response, status?, headers?, reject? }]
 * Returns fn's result; the stub records every requested URL in `requested`.
 */
async function withFetchStub(routes, fn) {
  const real = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    requested.push(u);
    const route = routes.find((r) => r.match.test(u));
    if (!route) throw new TypeError(`fetch stub: no route for ${u}`);
    if (route.reject) throw route.reject;
    if (typeof route.body === 'string') {
      return new Response(route.body, { status: route.status ?? 200, headers: route.headers ?? { 'content-type': 'text/plain' } });
    }
    return route.body;
  };
  try {
    return await fn(requested);
  } finally {
    globalThis.fetch = real;
  }
}

// ---------------- fixtures ----------------
const HTML_DOC = `<!DOCTYPE html>
<html><head><title>Doc</title>
<style>body { color: red; }</style>
<script>var evil = "nope";</script>
</head><body>
<nav>menu junk</nav>
<main><h1>Heading</h1><p>Body &amp; text here.</p></main>
<footer>foot junk</footer>
</body></html>`;

const BIG_DOC = '<html><body><p>' + 'lorem ipsum dolor sit '.repeat(3000) + '</p></body></html>'; // ~64 KB
const PATTERN = '0123456789'.repeat(4500); // 45 000 plain-text chars (no whitespace) → exact slice boundaries
const JSON_DOC = '{"hello":"world","nums":[1,2,3]}';

const loadExtension = async () => {
  const mod = await import(`file://${EXT_PATH}?t=${Date.now()}`);
  const tools = {};
  const pi = { registerTool: (t) => { tools[t.name] = t; } };
  mod.default(pi);
  return tools;
};

// ---------------- core ----------------
test('core', 'C1: registers exactly the tools search + fetch', async () => {
  const tools = await loadExtension();
  assert(Object.keys(tools).length > 0, 'extension default export must register tools');
  assert('search' in tools && 'fetch' in tools, `expected tools search+fetch, got ${Object.keys(tools)}`);
  for (const name of ['search', 'fetch']) {
    const t = tools[name];
    assert(typeof t.description === 'string' && t.description.length > 0, `${name}: missing description`);
    assert(t.parameters && typeof t.parameters === 'object', `${name}: missing parameters schema`);
    assert(typeof t.execute === 'function', `${name}: missing execute`);
  }
});

test('core', 'C2: human-readable config block at top of file', async () => {
  const src = EXT_SRC();
  const lines = src.split('\n');
  for (const name of ['SEARXNG_BASE_URL', 'SEARCH_MAX_RESULTS', 'SEARCH_SNIPPET_CHARS', 'FETCH_TIMEOUT_MS', 'FETCH_MAX_CHARS']) {
    assert(src.includes(name), `config constant ${name} missing from web.ts`);
    const firstLine = lines.findIndex((l) => l.includes(name));
    assert(firstLine >= 0 && firstLine <= 25, `config constant ${name} must be in the top block (found at line ${firstLine + 1})`);
  }
});

// ---------------- search ----------------
test('search', 'S1: live SearXNG search returns a proper result', async () => {
  const { search } = await loadExtension();
  const res = assertResult(await search.execute('s1', { query: 'pi coding agent' }, SIG()), 'S1');
  assert(!res.isError, `S1: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(textOf(res).trim().length > 0, 'S1: result text empty');
  assert(res.details && res.details.count >= 1, `S1: details.count missing/0 (details=${JSON.stringify(res.details)})`);
});

test('search', 'S2: the query is actually used (not ignored/undefined)', async () => {
  const { search } = await loadExtension();
  const res = assertResult(await search.execute('s2', { query: 'quantum chromodynamics' }, SIG()), 'S2');
  assert(!res.isError, `S2: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(/chromodynamics/i.test(textOf(res)), 'S2: results do not mention the queried term — query parameter is being dropped');
});

test('search', 'S3: max_results is honored (asking for 3 yields 3)', async () => {
  const { search } = await loadExtension();
  const res = assertResult(await search.execute('s3', { query: 'test', max_results: 3 }, SIG()), 'S3');
  assert(!res.isError, `S3: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(res.details && res.details.count === 3, `S3: expected details.count 3, got ${res.details && res.details.count}`);
});

// NOTE: live SearXNG returns junk (30 hits!) for gibberish queries, so the
// empty-set contract is tested deterministically via a stubbed SearXNG response.
test('search', 'S4: empty result set is a clean result, not an error', async () => {
  const { search } = await loadExtension();
  let res;
  await withFetchStub(
    [{ match: /localhost:8080|127\.0\.0\.1:8080/, body: JSON.stringify({ query: 'x', results: [] }) }],
    async () => { res = await search.execute('s4', { query: 'xk9q2z no-hit-unique-88173 plugh' }, SIG()); },
  );
  res = assertResult(res, 'S4');
  assert(!res.isError, 'S4: empty results must not be an error');
  assert(res.details && res.details.count === 0, `S4: expected details.count 0, got ${res.details && res.details.count}`);
});

test('search', 'S4b: malformed SearXNG response → isError, no throw', async () => {
  const { search } = await loadExtension();
  let res;
  await withFetchStub(
    [{ match: /localhost:8080|127\.0\.0\.1:8080/, body: 'not json at all', status: 200 }],
    async () => { res = await search.execute('s4b', { query: 'anything' }, SIG()); },
  );
  res = assertResult(res, 'S4b');
  assert(res.isError === true, `S4b: expected isError true, got ${res.isError}`);
});

test('search', 'S5: SearXNG unreachable → isError, no throw', async () => {
  const { search } = await loadExtension();
  let res;
  await withFetchStub(
    [{ match: /localhost:8080|127\.0\.0\.1:8080/, reject: new TypeError('fetch failed: ECONNREFUSED') }],
    async () => { res = await search.execute('s5', { query: 'anything' }, SIG()); },
  );
  res = assertResult(res, 'S5');
  assert(res.isError === true, `S5: expected isError true, got ${res.isError}`);
});

test('search', 'S6: SearXNG HTTP 500 → isError, no throw', async () => {
  const { search } = await loadExtension();
  let res;
  await withFetchStub(
    [{ match: /localhost:8080|127\.0\.0\.1:8080/, body: 'internal error', status: 500 }],
    async () => { res = await search.execute('s6', { query: 'anything' }, SIG()); },
  );
  res = assertResult(res, 'S6');
  assert(res.isError === true, `S6: expected isError true, got ${res.isError} (text: ${textOf(res).slice(0, 80)})`);
});

const SX_OK = JSON.stringify({ query: 'x', results: [{ title: 'T1', url: 'https://example.com/1', content: 'snippet one' }] });
const sxStub = (extra = []) => [{ match: /localhost:8080|127\.0\.0\.1:8080/, body: SX_OK }, ...extra];

test('search', 'S7: freshness=week → time_range=week in request URL + details echo', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s7', { query: 'anything', freshness: 'week' }, SIG());
    return req;
  });
  res = assertResult(res, 'S7');
  assert(!res.isError, `S7: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && requested[0].includes('time_range=week'), `S7: request URL must contain time_range=week (requested: ${JSON.stringify(requested)})`);
  assert(res.details.time_range === 'week', `S7: details.time_range must be 'week' (details=${JSON.stringify(res.details)})`);
});

test('search', 'S8: freshness omitted → no time_range param, details echo absent', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s8', { query: 'anything' }, SIG());
    return req;
  });
  res = assertResult(res, 'S8');
  assert(!res.isError, `S8: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && !requested[0].includes('time_range'), `S8: request URL must NOT contain time_range (requested: ${JSON.stringify(requested)})`);
  assert(!res.details.time_range, `S8: details.time_range must be absent/null (details=${JSON.stringify(res.details)})`);
});

test('search', 'S9: freshness with invalid value → isError, no throw', async () => {
  const { search } = await loadExtension();
  let res;
  await withFetchStub(sxStub(), async () => {
    res = await search.execute('s9', { query: 'anything', freshness: 'yesterday' }, SIG());
  });
  res = assertResult(res, 'S9');
  assert(res.isError === true, `S9: expected isError true for invalid freshness, got ${res.isError}`);
});

test('search', 'S10: category=it → categories=it in request URL + details echo', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s10', { query: 'anything', category: 'it' }, SIG());
    return req;
  });
  res = assertResult(res, 'S10');
  assert(!res.isError, `S10: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && requested[0].includes('categories=it'), `S10: request URL must contain categories=it (requested: ${JSON.stringify(requested)})`);
  assert(res.details.categories === 'it', `S10: details.categories must be 'it' (details=${JSON.stringify(res.details)})`);
});

test('search', 'S11: category with unknown value → isError, no throw', async () => {
  const { search } = await loadExtension();
  let res;
  await withFetchStub(sxStub(), async () => {
    res = await search.execute('s11', { query: 'anything', category: 'astrology' }, SIG());
  });
  res = assertResult(res, 'S11');
  assert(res.isError === true, `S11: expected isError true for unknown category, got ${res.isError}`);
});

test('search', 'S12: category omitted → no categories param, details echo absent', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s12', { query: 'anything' }, SIG());
    return req;
  });
  res = assertResult(res, 'S12');
  assert(!res.isError, `S12: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && !requested[0].includes('categories'), `S12: request URL must NOT contain categories (requested: ${JSON.stringify(requested)})`);
  assert(!res.details.categories, `S12: details.categories must be absent/null (details=${JSON.stringify(res.details)})`);
});

test('search', 'S13: language=de → language=de in request URL + details echo', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s13', { query: 'anything', language: 'de' }, SIG());
    return req;
  });
  res = assertResult(res, 'S13');
  assert(!res.isError, `S13: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && requested[0].includes('language=de'), `S13: request URL must contain language=de (requested: ${JSON.stringify(requested)})`);
  assert(res.details.language === 'de', `S13: details.language must be 'de' (details=${JSON.stringify(res.details)})`);
});

test('search', 'S14: language omitted or empty string → no language param, details echo absent', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s14a', { query: 'anything' }, SIG());
    await search.execute('s14b', { query: 'anything', language: '   ' }, SIG());
    return req;
  });
  res = assertResult(res, 'S14');
  assert(!res.isError, `S14: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 2 && !requested[0].includes('language') && !requested[1].includes('language'), `S14: request URLs must NOT contain language (requested: ${JSON.stringify(requested)})`);
  assert(!res.details.language, `S14: details.language must be absent/null (details=${JSON.stringify(res.details)})`);
});

test('search', 'S15: page=2 → pageno=2 in request URL + details echo', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s15', { query: 'anything', page: 2 }, SIG());
    return req;
  });
  res = assertResult(res, 'S15');
  assert(!res.isError, `S15: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && requested[0].includes('pageno=2'), `S15: request URL must contain pageno=2 (requested: ${JSON.stringify(requested)})`);
  assert(res.details.pageno === 2, `S15: details.pageno must be 2 (details=${JSON.stringify(res.details)})`);
});

test('search', 'S16: page=1 or omitted → identical request to today (no pageno)', async () => {
  const { search } = await loadExtension();
  let res;
  const requested = await withFetchStub(sxStub(), async (req) => {
    res = await search.execute('s16a', { query: 'anything', page: 1 }, SIG());
    await search.execute('s16b', { query: 'anything' }, SIG());
    return req;
  });
  res = assertResult(res, 'S16');
  assert(!res.isError, `S16: unexpected error: ${textOf(res).slice(0, 120)}`);
  const expected = 'http://localhost:8080/search?q=anything&format=json';
  assert(requested.length === 2 && requested[0] === expected && requested[1] === expected, `S16: page 1/omitted must keep the request identical to today (requested: ${JSON.stringify(requested)})`);
  assert(!res.details.pageno, `S16: details.pageno must be absent/null (details=${JSON.stringify(res.details)})`);
});

test('search', 'S17: page out of range (0 or 11) → isError, no throw', async () => {
  const { search } = await loadExtension();
  const r0 = assertResult(await search.execute('s17a', { query: 'anything', page: 0 }, SIG()), 'S17a');
  assert(r0.isError === true, `S17a: expected isError true for page 0, got ${r0.isError}`);
  const r11 = assertResult(await search.execute('s17b', { query: 'anything', page: 11 }, SIG()), 'S17b');
  assert(r11.isError === true, `S17b: expected isError true for page 11, got ${r11.isError}`);
});

test('core', 'C3b: search promptGuidelines document the new knobs (freshness/category/language/page)', async () => {
  const { search } = await loadExtension();
  const g = (search.promptGuidelines ?? []).join(' ');
  for (const kw of ['freshness', 'category', 'language', 'page']) {
    assert(g.toLowerCase().includes(kw), `search promptGuidelines do not mention '${kw}' (guidelines: ${JSON.stringify(g)})`);
  }
});

// ---------------- fetch ----------------
const PAGE_URL = 'http://127.0.0.1:9/';

const fetchRoutes = (extra = []) => [
  { match: /\/html$/, body: HTML_DOC, headers: { 'content-type': 'text/html; charset=utf-8' } },
  { match: /\/big$/, body: BIG_DOC, headers: { 'content-type': 'text/html; charset=utf-8' } },
  { match: /\/plain$/, body: 'hello plain world', headers: { 'content-type': 'text/plain' } },
  { match: /\/pattern$/, body: PATTERN, headers: { 'content-type': 'text/plain' } },
  { match: /\/json$/, body: JSON_DOC, headers: { 'content-type': 'application/json' } },
  { match: /\/octet$/, body: '{"a":1}', headers: { 'content-type': 'application/octet-stream' } },
  ...extra,
];

test('fetch', 'F1: no third-party proxy in the source (no "jina")', async () => {
  assert(!/jina/i.test(EXT_SRC()), 'web.ts still contains a reference to "jina" (third-party proxy)');
});

test('fetch', 'F2: direct fetch — requested URL is used unchanged', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  const requested = await withFetchStub(fetchRoutes(), async (req) => {
    res = await tool.execute('f2', { url: `${PAGE_URL}plain` }, SIG());
    return req;
  });
  res = assertResult(res, 'F2');
  assert(!res.isError, `F2: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(requested.length === 1 && requested[0] === `${PAGE_URL}plain`, `F2: fetch was not made directly to the URL (requested: ${JSON.stringify(requested)})`);
  assert(textOf(res).includes('hello plain world'), 'F2: plain-text body not passed through');
});

test('fetch', 'F3: HTML converted to plain text (tags/scripts/styles removed, entities decoded)', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f3', { url: `${PAGE_URL}html` }, SIG());
  });
  res = assertResult(res, 'F3');
  assert(!res.isError, `F3: unexpected error: ${textOf(res).slice(0, 120)}`);
  const text = textOf(res);
  assert(text.includes('Heading'), 'F3: heading text missing');
  assert(text.includes('Body & text here.'), 'F3: entities not decoded (expected "Body & text here.")');
  assert(!text.includes('<'), 'F3: HTML tags remain in output');
  assert(!/evil|color:\s*red/i.test(text), 'F3: script/style content leaked into output');
});

test('fetch', 'F4: truncation at max_chars with notice + details', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f4', { url: `${PAGE_URL}big`, max_chars: 1000 }, SIG());
  });
  res = assertResult(res, 'F4');
  assert(!res.isError, `F4: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(res.details && res.details.truncated === true, `F4: details.truncated must be true (details=${JSON.stringify(res.details)})`);
  assert(textOf(res).length <= 1200, `F4: output ${textOf(res).length} chars exceeds max_chars 1000 + notice tolerance`);
  assert(/\[truncated\]|truncated/i.test(textOf(res)), 'F4: no truncation notice in output');
});

test('fetch', 'F9: offset absent → first window (default max 20000), range details, has_more=true', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f9', { url: `${PAGE_URL}pattern`, max_chars: 20000 }, SIG());
  });
  res = assertResult(res, 'F9');
  assert(!res.isError, `F9: unexpected error: ${textOf(res).slice(0, 120)}`);
  const d = res.details;
  assert(d.total_chars === 45000, `F9: details.total_chars must be 45000 (got ${d.total_chars})`);
  assert(d.returned_start === 0 && d.returned_end === 20000, `F9: range must be 0..20000 (got ${d.returned_start}..${d.returned_end})`);
  assert(d.has_more === true, `F9: details.has_more must be true (details=${JSON.stringify(d)})`);
  assert(textOf(res).startsWith(PATTERN.slice(0, 20000)), 'F9: first 20000 chars are not the beginning of the page');
  assert(/showing chars 0\u201320000 of 45000/i.test(textOf(res)), 'F9: range notice [showing chars X–Y of Z] missing');
});

test('fetch', 'F10: offset=20000 → exactly the next 20000 chars, has_more=true', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f10', { url: `${PAGE_URL}pattern`, offset: 20000, max_chars: 20000 }, SIG());
  });
  res = assertResult(res, 'F10');
  assert(!res.isError, `F10: unexpected error: ${textOf(res).slice(0, 120)}`);
  const d = res.details;
  assert(d.returned_start === 20000 && d.returned_end === 40000, `F10: range must be 20000..40000 (got ${d.returned_start}..${d.returned_end})`);
  assert(d.has_more === true, `F10: details.has_more must be true (details=${JSON.stringify(d)})`);
  assert(textOf(res).startsWith(PATTERN.slice(20000, 40000)), 'F10: window is not exactly chars 20000..40000');
});

test('fetch', 'F11: offset=40000 → final 5000 chars, has_more=false, no next-chunk hint', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f11', { url: `${PAGE_URL}pattern`, offset: 40000, max_chars: 20000 }, SIG());
  });
  res = assertResult(res, 'F11');
  assert(!res.isError, `F11: unexpected error: ${textOf(res).slice(0, 120)}`);
  const d = res.details;
  assert(d.total_chars === 45000, `F11: details.total_chars must be 45000 (got ${d.total_chars})`);
  assert(d.returned_start === 40000 && d.returned_end === 45000, `F11: range must be 40000..45000 (got ${d.returned_start}..${d.returned_end})`);
  assert(d.has_more === false, `F11: details.has_more must be false (details=${JSON.stringify(d)})`);
  const t11 = textOf(res);
  assert(t11.startsWith(PATTERN.slice(40000)), 'F11: final 5000 chars wrong');
  assert(!/offset=\d+/.test(t11.slice(5000)), 'F11: no further offset hint expected for the last chunk');
  assert(/end of page/i.test(t11), 'F11: end-of-page marker expected in the notice');
});

test('fetch', 'F12: offset beyond end → friendly notice, no error, no throw', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f12', { url: `${PAGE_URL}pattern`, offset: 999999 }, SIG());
  });
  res = assertResult(res, 'F12');
  assert(!res.isError, 'F12: beyond-end offset must not be an error');
  assert(/beyond end of page/i.test(textOf(res)), 'F12: beyond-end notice missing');
  assert(/45000/.test(textOf(res)), 'F12: notice should mention the total page size (45000)');
  assert(res.details.total_chars === 45000 && res.details.has_more === false, `F12: details wrong (details=${JSON.stringify(res.details)})`);
});

test('fetch', 'F5: invalid scheme rejected before any network call', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  const requested = await withFetchStub(fetchRoutes(), async (req) => {
    res = await tool.execute('f5', { url: 'ftp://example.com/file' }, SIG());
    return req;
  });
  res = assertResult(res, 'F5');
  assert(res.isError === true, `F5: expected isError true, got ${res.isError}`);
  assert(requested.length === 0, `F5: invalid scheme must not reach the network (requested: ${JSON.stringify(requested)})`);
});

test('fetch', 'F6: HTTP 404 → isError, no throw', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes([{ match: /\/missing$/, body: 'not found', status: 404 }]), async () => {
    res = await tool.execute('f6', { url: `${PAGE_URL}missing` }, SIG());
  });
  res = assertResult(res, 'F6');
  assert(res.isError === true, `F6: expected isError true, got ${res.isError}`);
});

test('fetch', 'F7: network failure → isError, no throw', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub([{ match: /.*/, reject: new TypeError('fetch failed: ECONNREFUSED') }], async () => {
    res = await tool.execute('f7', { url: `${PAGE_URL}plain` }, SIG());
  });
  res = assertResult(res, 'F7');
  assert(res.isError === true, `F7: expected isError true, got ${res.isError}`);
});

test('fetch', 'F13: raw=true on HTML → markup survives verbatim (no conversion)', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f13', { url: `${PAGE_URL}html`, raw: true }, SIG());
  });
  res = assertResult(res, 'F13');
  assert(!res.isError, `F13: unexpected error: ${textOf(res).slice(0, 120)}`);
  assert(textOf(res).includes('<h1>Heading</h1>'), 'F13: raw mode must keep the HTML markup verbatim');
});

test('fetch', 'F14: raw=true on JSON → parseable JSON body', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f14', { url: `${PAGE_URL}json`, raw: true }, SIG());
  });
  res = assertResult(res, 'F14');
  assert(!res.isError, `F14: unexpected error: ${textOf(res).slice(0, 120)}`);
  const parsed = JSON.parse(textOf(res));
  assert(parsed.hello === 'world' && Array.isArray(parsed.nums), 'F14: raw JSON body must round-trip through JSON.parse');
});

test('fetch', 'F14b: raw=true bypasses the binary content-type gate (body returned unmodified)', async () => {
  const { fetch: tool } = await loadExtension();
  let res;
  await withFetchStub(fetchRoutes(), async () => {
    res = await tool.execute('f14b', { url: `${PAGE_URL}octet`, raw: true }, SIG());
  });
  res = assertResult(res, 'F14b');
  assert(!res.isError, `F14b: raw=true must not reject binary content types (got: ${textOf(res).slice(0, 120)})`);
  assert(JSON.parse(textOf(res)).a === 1, 'F14b: raw body must be returned unmodified');
});

test('core', 'C3c: search promptGuidelines include retry-on-empty guidance (fewer filters)', async () => {
  const { search } = await loadExtension();
  const g = (search.promptGuidelines ?? []).join(' ');
  assert(/no results/i.test(g) && /fewer filters|one filter/i.test(g), `search promptGuidelines should advise retrying with fewer filters on empty results (guidelines: ${JSON.stringify(g)})`);
});

test('core', 'C3a: fetch promptGuidelines document the new knobs (offset/raw)', async () => {
  const { fetch: tool } = await loadExtension();
  const g = (tool.promptGuidelines ?? []).join(' ');
  for (const kw of ['offset', 'raw']) {
    assert(g.toLowerCase().includes(kw), `fetch promptGuidelines do not mention '${kw}' (guidelines: ${JSON.stringify(g)})`);
  }
});

test('fetch', 'F8: timeout path exists and is configurable (FETCH_TIMEOUT_MS in source, signal used)', async () => {
  const src = EXT_SRC();
  assert(src.includes('FETCH_TIMEOUT_MS'), 'F8: FETCH_TIMEOUT_MS config constant not referenced');
  assert(/AbortSignal|signal/i.test(src), 'F8: no timeout/cancellation mechanism found in source');
});

// ---------------- run ----------------
const only = process.argv[2];
const selected = tests.filter((t) => !only || t.suite === only);
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: harness exceeded 90s — ${failures} failures so far`);
  process.exit(2);
}, 90_000);
watchdog.unref();

console.log(`web-tools harness — ${selected.length} tests${only ? ` (suite: ${only})` : ''}\n`);
for (const t of selected) {
  try {
    await t.fn();
    console.log(`PASS  [${t.suite}] ${t.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  [${t.suite}] ${t.name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 3).join('\n      ')}`);
  }
}
console.log(`\n${selected.length - failures}/${selected.length} passed`);
process.exit(failures === 0 ? 0 : 1);
