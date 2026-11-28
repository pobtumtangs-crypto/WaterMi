import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createApp, SENSOR_UNITS, normalizeSensors, plantFacts } from '../server.js';
import { createSupabaseFactory } from '../supabase.js';

const IMAGE = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64')}`;
const history = [{ role: 'user', text: 'Why are my leaves yellow?' }];

async function start(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'watermi-'));
  const app = createApp({ dataDir, mockDelayMs: 1, ...options });
  const server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : body && JSON.stringify(body),
    });
    const raw = await res.text();
    const isJson = res.headers.get('content-type')?.includes('json');
    return { status: res.status, headers: res.headers, body: isJson ? JSON.parse(raw) : raw };
  };
  return { call, base, dataDir, photos: () => readdirSync(join(dataDir, 'photos')) };
}

const events = (sse) =>
  sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

// A stand-in for Google: records each request and returns a canned response.
function fakeGemini(respond) {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return respond();
  };
  return { fake, calls };
}
const reply = (value) => ({ candidates: [{ content: { parts: [{ text: value }] } }] });

test('config reports key and mode without exposing the key', async (t) => {
  const { call } = await start(t, { apiKey: 'secret-key' });
  const res = await call('GET', '/api/config');
  assert.deepEqual(res.body, {
    hasKey: true, mock: false,
    analysisModel: 'gemini-3.8-flash', chatModel: 'gemini-3.5-flash-lite',
  });
});

test('login protects the dashboard and isolates plant data between sessions', async (t) => {
  const { call } = await start(t, { mock: true, localAuth: true });
  assert.match((await call('GET', '/')).body, /Sign in with Email/);
  assert.match((await call('GET', '/index.html')).body, /Sign in with Email/);
  assert.equal((await call('GET', '/api/plants')).status, 401);

  const credentials = { email: 'grower@example.com', password: 'testing-123' };
  const login = await call('POST', '/api/auth/login', credentials);
  assert.equal(login.status, 200);
  const signedIn = { cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.match((await call('GET', '/', undefined, signedIn)).body, /<title>WaterMI<\/title>/);
  assert.equal((await call('POST', '/api/plants', { name: 'Basil' }, signedIn)).status, 201);
  assert.equal((await call('GET', '/api/plants', undefined, signedIn)).body.length, 1);

  const second = await call('POST', '/api/auth/register', { ...credentials, email: 'other@example.com' });
  assert.equal(second.status, 201);
  assert.equal(second.body.needsConfirmation, false);
  const otherUser = { cookie: second.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual((await call('GET', '/api/plants', undefined, otherUser)).body, []);

  assert.equal((await call('POST', '/api/auth/logout', undefined, signedIn)).status, 200);
  assert.equal((await call('GET', '/api/plants', undefined, signedIn)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { ...credentials, password: 'wrong-password' })).status, 401);
});

test('Supabase email login and sign-up establish secure sessions with user-scoped queries', async (t) => {
  const origin = 'https://watermi.example.com';
  const provider = 'https://project.supabase.co';
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'grower@example.com' };
  let challenge;
  const authClient = createSupabaseFactory(provider, 'public-key', async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.pathname === '/rest/v1/plants') {
      assert.equal(headers.get('authorization'), 'Bearer example-access-token');
      assert.equal(url.searchParams.get('user_id'), `eq.${user.id}`);
      return Response.json([]);
    }
    const body = JSON.parse(init.body);
    if (url.pathname === '/auth/v1/signup') {
      const redirect = new URL(url.searchParams.get('redirect_to'));
      assert.equal(redirect.origin + redirect.pathname, origin + '/auth/callback');
      assert.equal(body.email, user.email);
      assert.equal(body.password, 'testing-123');
      assert.equal(body.code_challenge_method, 's256');
      challenge = body.code_challenge;
      assert.ok(challenge);
      return Response.json(user);
    }
    assert.equal(url.pathname, '/auth/v1/token');
    if (url.searchParams.get('grant_type') === 'password') {
      assert.equal(body.password, 'testing-123');
    } else {
      assert.equal(url.searchParams.get('grant_type'), 'pkce');
      assert.equal(body.auth_code, 'example-confirmation-code');
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge);
    }
    return Response.json({
      user,
      token_type: 'bearer',
      access_token: 'example-access-token',
      refresh_token: 'example-refresh-token',
      expires_in: 3600,
    });
  });
  const { call } = await start(t, { authClient, secureCookies: true, publicOrigin: origin });
  const headers = { origin, 'x-forwarded-proto': 'https' };
  const loginPage = await call('GET', '/', undefined, headers);
  const registerPage = await call('GET', '/register', undefined, headers);
  assert.match(loginPage.body, /id="login-form"/);
  assert.match(registerPage.body, /id="register-form"/);
  assert.doesNotMatch(loginPage.body, /Continue with Google/);
  assert.doesNotMatch(registerPage.body, /Sign up with Google/);
  assert.equal((await call('POST', '/api/auth/google', undefined, headers)).status, 404);

  const credentials = { email: user.email, password: 'testing-123' };
  const login = await call('POST', '/api/auth/login', credentials, headers);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const signedIn = { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual((await call('GET', '/api/plants', undefined, signedIn)).body, []);

  const callback = await call('GET', '/auth/callback', undefined, headers);
  assert.match(callback.body, /src="\/auth-callback.js"/);
  const registration = await call('POST', '/api/auth/register', credentials, headers);
  assert.equal(registration.status, 201);
  assert.deepEqual(registration.body, { needsConfirmation: true });

  const code = { code: 'example-confirmation-code' };
  assert.equal((await call('POST', '/api/auth/callback', code, headers)).status, 400);
  const pending = { ...headers, cookie: registration.headers.get('set-cookie').split(';')[0] };
  const completed = await call('POST', '/api/auth/callback', code, pending);
  assert.equal(completed.status, 200);
  const confirmed = { ...headers, cookie: completed.headers.get('set-cookie').split(';')[0] };
  assert.notEqual(confirmed.cookie, pending.cookie);
  assert.deepEqual((await call('GET', '/api/plants', undefined, confirmed)).body, []);
});

test('Supabase mode persists sessions across restarts, supports Bearer JWTs, skips local db.json, and handles OTP/implicit callbacks', async (t) => {
  const origin = 'https://watermi.example.com';
  const provider = 'https://project.supabase.co';
  const user = { id: '22222222-2222-4222-8222-222222222222', email: 'farmer@example.com' };
  const secret = 'test-render-session-secret-0123456789';
  let revoked = 0;

  const makeAuthClient = () => createSupabaseFactory(provider, 'public-key', async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.pathname === '/rest/v1/plants') {
      assert.equal(headers.get('authorization'), 'Bearer jwt-access-token');
      assert.equal(url.searchParams.get('user_id'), `eq.${user.id}`);
      return Response.json([]);
    }
    if (url.pathname === '/auth/v1/user') {
      assert.equal(headers.get('authorization'), 'Bearer jwt-access-token');
      return Response.json(user);
    }
    if (url.pathname === '/auth/v1/logout') {
      revoked += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/auth/v1/verify' || url.pathname === '/auth/v1/token') {
      return Response.json({
        user,
        token_type: 'bearer',
        access_token: 'jwt-access-token',
        refresh_token: 'jwt-refresh-token',
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected Supabase call: ${url.pathname}`);
  });

  // Instance 1: even with a broken db.json path, Supabase mode never opens local disk storage.
  const first = await start(t, { authClient: makeAuthClient(), sessionSecret: secret, secureCookies: true, publicOrigin: origin });
  writeFileSync(join(first.dataDir, 'db.json'), '{broken');
  const headers = { origin, 'x-forwarded-proto': 'https' };
  const login = await first.call('POST', '/api/auth/login', { email: user.email, password: 'testing-123' }, headers);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // Instance 2 (simulates Render restart/spin-down with the same SESSION_SECRET): session cookie still works!
  const second = await start(t, { authClient: makeAuthClient(), sessionSecret: secret, secureCookies: true, publicOrigin: origin });
  assert.deepEqual((await second.call('GET', '/api/plants', undefined, { ...headers, cookie })).body, []);

  // Bearer Supabase JWT works without a cookie.
  assert.deepEqual((await second.call('GET', '/api/plants', undefined, { authorization: 'Bearer jwt-access-token' })).body, []);

  // OTP email confirmation & implicit hash callbacks establish a session.
  const otp = await second.call('POST', '/api/auth/callback', { tokenHash: 'hash-123', type: 'signup' }, headers);
  assert.equal(otp.status, 200);
  const implicit = await second.call('POST', '/api/auth/callback', { accessToken: 'jwt-access-token', refreshToken: 'jwt-refresh-token' }, headers);
  assert.equal(implicit.status, 200);

  // Logout revokes the token in Supabase and blocks cookie replay.
  assert.equal((await second.call('POST', '/api/auth/logout', undefined, { ...headers, cookie })).status, 200);
  assert.equal(revoked, 1);
  assert.equal((await second.call('GET', '/api/plants', undefined, { ...headers, cookie })).status, 401);
});

test('plant create, update, watering and validation', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/plants', { name: '  ' })).status, 400);
  assert.equal((await call('POST', '/api/plants', { name: 'a', waterEveryDays: 0 })).status, 400);

  const plant = (await call('POST', '/api/plants', { name: 'Rice', species: 'Jasmine' })).body;
  assert.equal(plant.waterEveryDays, 3);
  assert.deepEqual(plant.checkups, []);

  await new Promise((done) => setTimeout(done, 5));
  const updated = (await call('PATCH', `/api/plants/${plant.id}`, { location: 'North', watered: true, id: 'x' })).body;
  assert.equal(updated.id, plant.id);
  assert.equal(updated.location, 'North');
  assert.ok(updated.lastWatered > plant.lastWatered);

  const rejected = await call('PATCH', `/api/plants/${plant.id}`, { location: 'South', waterEveryDays: 'soon' });
  assert.equal(rejected.status, 400);
  assert.equal((await call('GET', '/api/plants')).body[0].location, 'North');
  assert.equal((await call('PATCH', '/api/plants/nope', {})).status, 404);
});

test('checkups save photos; deleting a checkup or plant removes them', async (t) => {
  const { call, photos } = await start(t);
  const plant = (await call('POST', '/api/plants', { name: 'Tomato' })).body;
  const url = `/api/plants/${plant.id}/checkups`;

  assert.equal((await call('POST', url, { image: 'data:image/jpeg;base64,aGVsbG8=', report: { health_score: 50 } })).status, 400);
  assert.equal((await call('POST', url, { image: IMAGE, report: {} })).status, 400);
  assert.equal(photos().length, 0);

  await call('POST', url, { image: IMAGE, report: { health_score: 140 }, note: 'first' });
  const saved = (await call('POST', url, { image: IMAGE, report: { health_score: 40 } })).body;
  assert.equal(saved.checkups.length, 2);
  assert.equal(saved.checkups[0].health_score, 100);
  assert.equal(saved.checkups[1].status, 'critical');
  assert.equal((await call('GET', `/photos/${saved.checkups[0].photo}`)).status, 200);

  const after = (await call('DELETE', `${url}/${saved.checkups[0].id}`)).body;
  assert.equal(after.checkups.length, 1);
  assert.deepEqual(photos(), [after.checkups[0].photo]);

  await call('DELETE', `/api/plants/${plant.id}`);
  assert.deepEqual(photos(), []);
  assert.deepEqual((await call('GET', '/api/plants')).body, []);
});

test('saved data survives a restart, and a broken database is not overwritten', async (t) => {
  const { call, dataDir } = await start(t);
  await call('POST', '/api/plants', { name: 'Mango' });
  createApp({ dataDir });
  writeFileSync(join(dataDir, 'db.json'), '{broken');
  assert.throws(() => createApp({ dataDir }), /Cannot read/);
});

test('bad JSON and unknown API routes return {error, code}', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/plants', '{oops')).body.code, 'bad_request');
  assert.equal((await call('GET', '/api/nope')).body.code, 'not_found');
});

test('demo mode analyzes and streams a chat reply without a key', async (t) => {
  const { call } = await start(t, { mock: true });
  const report = (await call('POST', '/api/analyze', { image: IMAGE })).body;
  assert.equal(report.is_plant, true);
  assert.equal(typeof report.health_score, 'number');

  const stream = events((await call('POST', '/api/chat', { history })).body);
  assert.ok(stream.filter((e) => e.t).length > 5);
  assert.deepEqual(stream.at(-1), { done: true });
});

test('missing key and bad chat history are rejected', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/analyze', { image: IMAGE })).body.code, 'no_key');
  assert.equal((await call('POST', '/api/chat', { history })).body.code, 'no_key');
  assert.equal((await call('POST', '/api/chat', { history: [] })).status, 400);
});

test('analysis sends the image to the analysis model and cleans up the report', async (t) => {
  const { fake, calls } = fakeGemini(() =>
    Response.json(reply(JSON.stringify({ health_score: 71.6, status: 'weird', actions: ['a'] }))));
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const res = await call('POST', '/api/analyze', { image: IMAGE, note: 'spots' }, { 'accept-language': 'th-TH,th;q=0.9' });

  assert.equal(res.body.health_score, 72);
  assert.equal(res.body.status, 'needs_attention');
  assert.deepEqual(res.body.problems, []);
  assert.match(calls[0].url, /gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].headers['x-goog-api-key'], 'k');
  const parts = calls[0].body.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/jpeg');
  assert.match(parts[1].text, /th-TH/);
});

test('an unreadable AI reply becomes ai_error', async (t) => {
  const { fake } = fakeGemini(() => Response.json(reply('not json')));
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  assert.equal((await call('POST', '/api/analyze', { image: IMAGE })).body.code, 'ai_error');
});

for (const [upstream, detail, status, code] of [
  [429, 'RESOURCE_EXHAUSTED', 429, 'quota'],
  [400, 'API key not valid', 401, 'bad_key'],
  [404, 'model not found', 502, 'bad_model'],
  [500, 'boom', 502, 'ai_error'],
  [503, 'high demand', 503, 'busy'],
]) {
  test(`Google ${upstream} becomes ${code} for analysis and chat`, async (t) => {
    const { fake } = fakeGemini(() => new Response(detail, { status: upstream }));
    const { call } = await start(t, { apiKey: 'k', fetch: fake });
    for (const res of [
      await call('POST', '/api/analyze', { image: IMAGE }),
      await call('POST', '/api/chat', { history }),
    ]) {
      assert.equal(res.status, status);
      assert.equal(res.body.code, code);
    }
  });
}

test('chat streams chunks and includes the plant, latest checkup and photo', async (t) => {
  const sse = [reply('Hello '), reply('สวัสดี')].map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join('');
  const bytes = Buffer.from(sse);
  // Split mid-line and mid-character, as a network might.
  const { fake, calls } = fakeGemini(() => new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7));
      c.close();
    },
  })));
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const plant = (await call('POST', '/api/plants', { name: 'Basil plot' })).body;
  await call('POST', `/api/plants/${plant.id}/checkups`, { image: IMAGE, report: { health_score: 55, summary: 'wilting' } });

  const res = await call('POST', '/api/chat', {
    plantId: plant.id,
    history: [{ role: 'model', text: 'hi' }, ...history],
  });
  assert.deepEqual(events(res.body), [{ t: 'Hello ' }, { t: 'สวัสดี' }, { done: true }]);
  assert.match(calls[0].url, /gemini-3\.5-flash-lite:streamGenerateContent\?alt=sse$/);
  assert.match(calls[0].body.systemInstruction.parts[0].text, /Basil plot.*wilting/s);
  assert.equal(calls[0].body.contents[0].role, 'user');
  assert.ok(calls[0].body.contents[0].parts.some((p) => p.inlineData));
});

test('an error during the stream is sent as an SSE error event', async (t) => {
  const body = `data: ${JSON.stringify(reply('Part'))}\n\ndata: ${JSON.stringify({ error: { code: 429, message: 'x' } })}\n\n`;
  const { fake } = fakeGemini(() => new Response(body));
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const stream = events((await call('POST', '/api/chat', { history })).body);
  assert.equal(stream[0].t, 'Part');
  assert.equal(stream.at(-1).code, 'quota');
});

test('a busy error partway through a chat reply names the model', async (t) => {
  const body = `data: ${JSON.stringify(reply('Part'))}\n\ndata: ${JSON.stringify({ error: { code: 503, message: 'x' } })}\n\n`;
  const { fake } = fakeGemini(() => new Response(body));
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const stream = events((await call('POST', '/api/chat', { history })).body);
  assert.match(stream.at(-1).error, /gemini-3\.5-flash-lite/);
});

// Answers each Gemini call with the status listed for it; 200 returns a usable report.
function byStatus(...statuses) {
  let n = 0;
  return fakeGemini(() => {
    const status = statuses[n++];
    return status === 200
      ? Response.json(reply(JSON.stringify({ health_score: 80, backup_model: 'made up by the AI' })))
      : new Response('x', { status });
  });
}
const modelsOf = (calls) => calls.map((c) => c.url.match(/models\/([^:]+):/)[1]);

test('a busy analysis model falls back to the backup and the report says so', async (t) => {
  const { fake, calls } = byStatus(503, 200);
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const res = await call('POST', '/api/analyze', { image: IMAGE });
  assert.equal(res.status, 200);
  assert.equal(res.body.backup_model, 'gemini-3.5-flash-lite');
  assert.deepEqual(modelsOf(calls), ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);

  const plant = (await call('POST', '/api/plants', { name: 'Chili' })).body;
  const saved = (await call('POST', `/api/plants/${plant.id}/checkups`, { image: IMAGE, report: res.body })).body;
  assert.equal(saved.checkups[0].report.backup_model, 'gemini-3.5-flash-lite');
});

test('the backup is not used or mentioned when the main model works', async (t) => {
  const { fake, calls } = byStatus(200);
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const res = await call('POST', '/api/analyze', { image: IMAGE });
  assert.equal('backup_model' in res.body, false);
  assert.equal(calls.length, 1);
});

for (const [name, statuses, options, status, code, count] of [
  ['both models busy gives busy', [503, 503], { analysisFallbackModel: 'gemini-3.5-flash-lite' }, 503, 'busy', 2],
  ['all three default models busy gives busy', [503, 503, 503], {}, 503, 'busy', 3],
  ['every model at its limit gives quota', [429, 429, 429], {}, 429, 'quota', 3],
  ['a mix of busy and limited models gives busy', [429, 503, 429], {}, 503, 'busy', 3],
  ['with backups off, a limit gives quota', [429], { analysisFallbackModel: '' }, 429, 'quota', 1],
  ['a broken backup reports its own error', [503, 404], {}, 502, 'bad_model', 2],
  ['an empty backup setting turns it off', [503], { analysisFallbackModel: '' }, 503, 'busy', 1],
  ['a backup equal to the main model is skipped', [503], { analysisFallbackModel: 'gemini-3.8-flash' }, 503, 'busy', 1],
]) {
  test(name, async (t) => {
    const { fake, calls } = byStatus(...statuses);
    const { call } = await start(t, { apiKey: 'k', fetch: fake, ...options });
    const res = await call('POST', '/api/analyze', { image: IMAGE });
    assert.equal(res.status, status);
    assert.equal(res.body.code, code);
    assert.equal(calls.length, count);
  });
}

// ---------- Pl@ntNet ----------

const PN_SPECIES = {
  results: [
    { score: 0.82, species: { scientificNameWithoutAuthor: 'Solanum lycopersicum', commonNames: ['Tomato', 'Love apple', 'x', 'y'] } },
    { score: 0.02, species: { scientificNameWithoutAuthor: 'Nelumbo nucifera', commonNames: ['Lotus'] } },
  ],
};
const PN_DISEASES = {
  results: [
    { name: 'ALTESO', score: 0.41, description: 'Alternaria solani - Early blight' },
    { name: '1PENIG', score: 0.07, description: 'Penicillium' },
  ],
};

// One fake for both services. `species` and `disease` are functions returning a Response.
function services({
  species = () => Response.json(PN_SPECIES),
  disease = () => Response.json(PN_DISEASES),
  report = { health_score: 60, plantnet: { plants: [{ name: 'invented by the AI', score: 1 }] } },
} = {}) {
  const calls = { plantnet: [], gemini: [] };
  const fake = async (url, init) => {
    if (url.includes('plantnet.org')) {
      calls.plantnet.push({ url, init });
      return url.includes('/diseases/') ? disease() : species();
    }
    calls.gemini.push(JSON.parse(init.body));
    return Response.json(reply(JSON.stringify(report)));
  };
  return { fake, calls };
}
const analyze = async (t, setup, image = IMAGE, options = {}) => {
  const { fake, calls } = services(setup);
  const app = await start(t, { apiKey: 'k', plantnetKey: 'pn secret', fetch: fake, ...options });
  const res = await app.call('POST', '/api/analyze', { image });
  const context = calls.gemini[0]?.contents[0].parts[1].text ?? '';
  return { ...app, res, calls, context };
};

test('Pl@ntNet gets the photo; strong matches go to Gemini and into the report', async (t) => {
  const { res, calls, context, call } = await analyze(t);
  assert.equal(calls.plantnet.length, 2);
  const urls = calls.plantnet.map((c) => new URL(c.url)).sort((a, b) => a.pathname.localeCompare(b.pathname));
  assert.deepEqual(urls.map((u) => u.pathname), ['/v2/diseases/identify', '/v2/identify/all']);
  assert.equal(urls[0].searchParams.get('api-key'), 'pn secret');
  assert.equal(urls[0].searchParams.has('no-reject'), false);
  for (const { init } of calls.plantnet) {
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('organs'), 'auto');
    assert.equal(init.body.get('images').type, 'image/jpeg');
  }
  assert.match(context, /Solanum lycopersicum.*Early blight/s);
  assert.doesNotMatch(context, /Nelumbo|Penicillium|pn secret/);
  assert.deepEqual(res.body.plantnet, {
    plants: [{ name: 'Solanum lycopersicum', common_names: ['Tomato', 'Love apple', 'x'], score: 0.82 }],
    diseases: [{ name: 'Alternaria solani - Early blight', score: 0.41 }],
  });

  const plant = (await call('POST', '/api/plants', { name: 'T' })).body;
  const saved = (await call('POST', `/api/plants/${plant.id}/checkups`, { image: IMAGE, report: res.body })).body;
  assert.deepEqual(saved.checkups[0].report.plantnet, res.body.plantnet);
});

for (const [name, fail] of [
  ['not a plant (404)', () => new Response('{}', { status: 404 })],
  ['daily limit (429)', () => new Response('{}', { status: 429 })],
  ['bad key (401)', () => new Response('{}', { status: 401 })],
  ['network failure', () => { throw new Error('offline'); }],
  ['unreadable reply', () => new Response('<html>')],
  ['unexpected shape', () => Response.json({ results: [null, { score: 'high' }] })],
]) {
  test(`analysis continues without Pl@ntNet: ${name}`, async (t) => {
    const { res, context } = await analyze(t, { species: fail, disease: fail });
    assert.equal(res.status, 200);
    assert.equal(res.body.health_score, 60);
    assert.equal('plantnet' in res.body, false);
    assert.doesNotMatch(context, /Pl@ntNet/);
  });
}

test('one failing Pl@ntNet check does not discard the other', async (t) => {
  const { res } = await analyze(t, { disease: () => new Response('{}', { status: 429 }) });
  assert.equal(res.body.plantnet.plants.length, 1);
  assert.deepEqual(res.body.plantnet.diseases, []);
});

test('suggestions are not attached when the AI says it is not a plant', async (t) => {
  const { res } = await analyze(t, { report: { is_plant: false, health_score: 0 } });
  assert.equal('plantnet' in res.body, false);
});

test('Pl@ntNet is not called without a key, for WebP, or in demo mode', async (t) => {
  const webp = `data:image/webp;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}`;
  assert.equal((await analyze(t, {}, IMAGE, { plantnetKey: '' })).calls.plantnet.length, 0);
  assert.equal((await analyze(t, {}, webp)).calls.plantnet.length, 0);
  assert.equal((await analyze(t, {}, IMAGE, { mock: true })).calls.plantnet.length, 0);
});

test('a Pl@ntNet failure never logs the key', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  await analyze(t, {
    species: () => { throw new Error('failed: https://my-api.plantnet.org/v2/identify/all?api-key=pn%20secret'); },
    disease: () => new Response('Bad token pn secret', { status: 401 }),
  });
  const text = logged.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(text, /Pl@ntNet/);
  assert.doesNotMatch(text, /secret/);
});

test('the second backup is tried when the first is busy too', async (t) => {
  const { fake, calls } = byStatus(503, 503, 200);
  const { call } = await start(t, { apiKey: 'k', fetch: fake });
  const res = await call('POST', '/api/analyze', { image: IMAGE });
  assert.equal(res.body.backup_model, 'gemini-3.1-flash-lite');
  assert.deepEqual(modelsOf(calls), ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
});

test('the backup list ignores spaces, blanks, repeats and the main model', async (t) => {
  const { fake, calls } = byStatus(503, 503, 503);
  const { call } = await start(t, {
    apiKey: 'k', fetch: fake, analysisFallbackModel: ' model-a, gemini-3.8-flash,,model-a , model-b ',
  });
  const res = await call('POST', '/api/analyze', { image: IMAGE });
  assert.deepEqual(modelsOf(calls), ['gemini-3.8-flash', 'model-a', 'model-b']);
  assert.match(res.body.error, /All the analysis models are busy/);
});

// ---------- Groq, the last backup ----------

const groqReply = (value) => Response.json({ choices: [{ message: { content: value } }] });

// Every Gemini model answers `geminiStatus`; Groq answers with `groq()`.
async function withGroq(t, { geminiStatus = 503, groq = () => groqReply('{"health_score":55,"summary":"from groq"}'), ...options } = {}) {
  const calls = { gemini: 0, groq: [] };
  const fake = async (url, init) => {
    if (url.includes('api.groq.com')) {
      calls.groq.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return groq();
    }
    calls.gemini += 1;
    return new Response('x', { status: geminiStatus });
  };
  const app = await start(t, { apiKey: 'k', groqKey: 'groq secret', fetch: fake, ...options });
  const res = await app.call('POST', '/api/analyze', { image: IMAGE, note: 'brown spots' });
  return { ...app, res, calls };
}

test('Groq makes the report when every Gemini model is busy', async (t) => {
  const { res, calls, call } = await withGroq(t);
  assert.equal(res.status, 200);
  assert.equal(res.body.summary, 'from groq');
  assert.equal(res.body.backup_model, 'qwen/qwen3.8-27b');
  assert.equal(calls.gemini, 3);
  assert.equal(calls.groq.length, 1);

  const [{ url, headers, body }] = calls.groq;
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(headers.authorization, 'Bearer groq secret');
  assert.equal(body.reasoning_effort, 'none');
  assert.ok(body.max_completion_tokens <= 3000);
  assert.match(body.messages[0].content, /agronomist/);
  assert.match(body.messages[1].content[0].text, /brown spots/);
  assert.equal(body.messages[1].content[1].image_url.url, IMAGE);

  // Groq's strict mode needs lower-case types, every field required and no extras.
  const { strict, schema } = body.response_format.json_schema;
  assert.equal(strict, true);
  for (const node of [schema, schema.properties.problems.items]) {
    assert.equal(node.type, 'object');
    assert.equal(node.additionalProperties, false);
    assert.deepEqual(node.required.sort(), Object.keys(node.properties).sort());
  }
  assert.equal(schema.properties.actions.items.type, 'string');
  assert.deepEqual(schema.properties.status.enum, ['healthy', 'needs_attention', 'critical']);

  const plant = (await call('POST', '/api/plants', { name: 'G' })).body;
  const saved = (await call('POST', `/api/plants/${plant.id}/checkups`, { image: IMAGE, report: res.body })).body;
  assert.equal(saved.checkups[0].report.backup_model, 'qwen/qwen3.8-27b');
});

test('Groq is still used when Gemini backups are turned off', async (t) => {
  const { res, calls } = await withGroq(t, { analysisFallbackModel: '' });
  assert.equal(res.status, 200);
  assert.equal(calls.gemini, 1);
});

for (const [geminiStatus, code] of [[401, 'bad_key'], [404, 'bad_model'], [500, 'ai_error']]) {
  test(`Groq is not used for a Gemini ${code} error`, async (t) => {
    const { res, calls } = await withGroq(t, { geminiStatus });
    assert.equal(res.body.code, code);
    assert.equal(calls.groq.length, 0);
  });
}

test('without a Groq key, busy Gemini models give the same busy error as before', async (t) => {
  const { res, calls } = await withGroq(t, { groqKey: '' });
  assert.equal(res.body.code, 'busy');
  assert.equal(calls.groq.length, 0);
});

for (const [name, groq, message] of [
  ['limit reached', () => new Response('x', { status: 429 }), /Groq backup has reached its limit/],
  ['rejected key', () => new Response('x', { status: 401 }), /GROQ_API_KEY/],
  ['server error', () => new Response('x', { status: 503 }), /Groq backup also failed/],
  ['network failure', () => { throw new Error('offline'); }, /Groq backup also failed/],
]) {
  test(`Groq ${name} gives a clear busy error`, async (t) => {
    const { res } = await withGroq(t, { groq });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'busy');
    assert.match(res.body.error, message);
  });
}

test('an unreadable Groq reply becomes ai_error', async (t) => {
  for (const groq of [() => groqReply('not json'), () => Response.json({}), () => new Response('<html>')]) {
    const { res } = await withGroq(t, { groq });
    assert.equal(res.body.code, 'ai_error');
  }
});

test('a Groq failure never logs the key', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  await withGroq(t, { groq: () => new Response('bad key groq secret', { status: 401 }) });
  const text = logged.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(text, /Groq/);
  assert.doesNotMatch(text, /groq secret/);
});

for (const [name, note, device, expected] of [
  ['a Thai note on an English device', 'ใบเหลือง', 'en-US', /in Thai\.$/],
  ['a Thai note mixed with English', 'tomato ใบเหลือง', 'en-US', /in Thai\.$/],
  ['no note on a Thai device', '', 'th-TH', /in Thai\.$/],
  ['no note on another device', '', 'fr-FR', /language with the code "fr-FR"\.$/],
  ['an English note on a Thai device', 'yellow leaves', 'th-TH', /same language as the grower's note\.$/],
]) {
  test(`the request ends with a language instruction: ${name}`, async (t) => {
    const { fake, calls } = fakeGemini(() => Response.json(reply('{"health_score":1}')));
    const { call } = await start(t, { apiKey: 'k', fetch: fake });
    await call('POST', '/api/analyze', { image: IMAGE, note }, { 'accept-language': device });
    assert.match(calls[0].body.contents[0].parts[1].text, expected);
  });
}

for (const [name, statuses, used, models] of [
  ['the next model when the main one is at its limit', [429, 200], 'gemini-3.5-flash-lite', 2],
  ['the last backup past a mix of limits and busy models', [429, 503, 200], 'gemini-3.1-flash-lite', 3],
]) {
  test(`analysis uses ${name}`, async (t) => {
    const { fake, calls } = byStatus(...statuses);
    const { call } = await start(t, { apiKey: 'k', fetch: fake });
    const res = await call('POST', '/api/analyze', { image: IMAGE });
    assert.equal(res.status, 200);
    assert.equal(res.body.backup_model, used);
    assert.equal(calls.length, models);
  });
}

test('Groq makes the report when every Gemini model is at its limit', async (t) => {
  const { res, calls } = await withGroq(t, { geminiStatus: 429 });
  assert.equal(res.status, 200);
  assert.equal(res.body.backup_model, 'qwen/qwen3.8-27b');
  assert.equal(calls.gemini, 3);
});

test('limits everywhere, Groq included, give quota', async (t) => {
  const { res } = await withGroq(t, { geminiStatus: 429, groq: () => new Response('x', { status: 429 }) });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'quota');
});

test('a Groq fault after Gemini limits says what went wrong', async (t) => {
  const { res } = await withGroq(t, { geminiStatus: 429, groq: () => new Response('x', { status: 401 }) });
  assert.equal(res.body.code, 'busy');
  assert.match(res.body.error, /GROQ_API_KEY/);
});

const sseReply = () => new Response(`data: ${JSON.stringify(reply('ok'))}\n\n`);
const chatChain = (...statuses) => {
  let n = 0;
  return fakeGemini(() => {
    const status = statuses[n++];
    return status === 200 ? sseReply() : new Response('x', { status });
  });
};

for (const [name, first] of [['busy', 503], ['at its limit', 429]]) {
  test(`chat switches to the backup when the main model is ${name}`, async (t) => {
    const { fake, calls } = chatChain(first, 200);
    const { call } = await start(t, { apiKey: 'k', fetch: fake });
    const res = await call('POST', '/api/chat', { history });
    assert.deepEqual(events(res.body), [{ t: 'ok' }, { done: true }]);
    assert.deepEqual(modelsOf(calls), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    assert.deepEqual(calls[1].body, calls[0].body);
  });
}

for (const [name, statuses, options, code, count] of [
  ['both at their limit', [429, 429], {}, 'quota', 2],
  ['one busy, one at its limit', [503, 429], {}, 'busy', 2],
  ['a rejected key stops at once', [401], {}, 'bad_key', 1],
  ['backup turned off', [429], { chatFallbackModel: '' }, 'quota', 1],
]) {
  test(`chat errors: ${name}`, async (t) => {
    const { fake, calls } = chatChain(...statuses);
    const { call } = await start(t, { apiKey: 'k', groqKey: 'g', fetch: fake, ...options });
    assert.equal((await call('POST', '/api/chat', { history })).body.code, code);
    assert.equal(calls.length, count);
    assert.ok(calls.every((c) => c.url.includes('generativelanguage')));
  });
}

// ---------- sensors, WaterMI branding & #dlg-plant UI ----------

test('SENSOR_UNITS and normalizeSensors handle defaults, partial updates, and edge values', () => {
  assert.deepEqual(SENSOR_UNITS, {
    humidity: '%',
    temperature: '°C',
    soilMoisture: '%',
    light: 'lux',
  });

  const defaults = normalizeSensors(undefined);
  assert.deepEqual(defaults, {
    humidity: { connected: false, value: null, unit: '%' },
    temperature: { connected: false, value: null, unit: '°C' },
    soilMoisture: { connected: false, value: null, unit: '%' },
    light: { connected: false, value: null, unit: 'lux' },
  });
  assert.deepEqual(normalizeSensors(null), defaults);

  const initial = normalizeSensors({
    humidity: { connected: true, value: 0, unit: ' %RH ' },
    temperature: { connected: 1, value: '23.5' },
    soilMoisture: { connected: false, value: '' },
    light: { connected: true, value: NaN },
    extraIgnored: { connected: true, value: 99 },
  });
  assert.deepEqual(initial, {
    humidity: { connected: true, value: 0, unit: '%RH' },
    temperature: { connected: true, value: 23.5, unit: '°C' },
    soilMoisture: { connected: false, value: null, unit: '%' },
    light: { connected: true, value: null, unit: 'lux' },
  });
  assert.equal('extraIgnored' in initial, false);

  const nonFinite = normalizeSensors({
    humidity: { value: Infinity },
    temperature: { value: -Infinity },
    light: { value: 'bright' },
  });
  assert.equal(nonFinite.humidity.value, null);
  assert.equal(nonFinite.temperature.value, null);
  assert.equal(nonFinite.light.value, null);

  const merged = normalizeSensors(
    {
      humidity: { value: 64 },
      temperature: { connected: false, value: null, unit: '' },
    },
    initial,
  );
  assert.deepEqual(merged, {
    humidity: { connected: true, value: 64, unit: '%RH' },
    temperature: { connected: false, value: null, unit: '°C' },
    soilMoisture: { connected: false, value: null, unit: '%' },
    light: { connected: true, value: null, unit: 'lux' },
  });
});

test('POST /api/plants initializes default sensors and accepts initial sensors', async (t) => {
  const { call } = await start(t);

  const plain = (await call('POST', '/api/plants', { name: 'Fern' })).body;
  assert.deepEqual(plain.sensors, {
    humidity: { connected: false, value: null, unit: '%' },
    temperature: { connected: false, value: null, unit: '°C' },
    soilMoisture: { connected: false, value: null, unit: '%' },
    light: { connected: false, value: null, unit: 'lux' },
  });

  const withInitial = (await call('POST', '/api/plants', {
    name: 'Orchid',
    sensors: {
      humidity: { connected: true, value: 68 },
      light: { connected: true, value: 0 },
    },
  })).body;
  assert.deepEqual(withInitial.sensors, {
    humidity: { connected: true, value: 68, unit: '%' },
    temperature: { connected: false, value: null, unit: '°C' },
    soilMoisture: { connected: false, value: null, unit: '%' },
    light: { connected: true, value: 0, unit: 'lux' },
  });

  const listed = (await call('GET', '/api/plants')).body;
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[1].sensors, withInitial.sensors);
});

test('PATCH /api/plants/:id supports partial sensor updates, status toggles, and rejects invalid sensors', async (t) => {
  const { call } = await start(t);
  const plant = (await call('POST', '/api/plants', {
    name: 'Mint',
    sensors: {
      humidity: { connected: true, value: 55 },
      temperature: { connected: true, value: 24.5 },
    },
  })).body;

  const p1 = (await call('PATCH', `/api/plants/${plant.id}`, {
    sensors: {
      humidity: { connected: false },
      light: { connected: true, value: 850 },
      soilMoisture: { connected: true, value: 0 },
    },
  })).body;
  assert.deepEqual(p1.sensors, {
    humidity: { connected: false, value: 55, unit: '%' },
    temperature: { connected: true, value: 24.5, unit: '°C' },
    soilMoisture: { connected: true, value: 0, unit: '%' },
    light: { connected: true, value: 850, unit: 'lux' },
  });

  const p2 = (await call('PATCH', `/api/plants/${plant.id}`, {
    sensors: {
      humidity: { connected: true, value: 61 },
      soilMoisture: { value: '' },
    },
  })).body;
  assert.equal(p2.sensors.humidity.connected, true);
  assert.equal(p2.sensors.humidity.value, 61);
  assert.equal(p2.sensors.soilMoisture.value, null);
  assert.equal(p2.sensors.light.value, 850);

  for (const invalid of [null, [], 'humidity', 42, true]) {
    const bad = await call('PATCH', `/api/plants/${plant.id}`, { sensors: invalid });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'bad_request');
    assert.match(bad.body.error, /sensors must be an object/);
  }
  const persisted = (await call('GET', '/api/plants')).body[0];
  assert.deepEqual(persisted.sensors, p2.sensors);
});

test('legacy db.json plants lacking sensors are normalized on read and unrelated patches without mutating db.json on read', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'watermi-legacy-'));
  const legacyDb = {
    plants: [{
      id: 'legacy-1',
      name: 'Legacy Aloe',
      species: 'Aloe vera',
      location: 'Porch',
      notes: '',
      waterEveryDays: 7,
      lastWatered: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      checkups: [],
    }],
  };
  const dbPath = join(dataDir, 'db.json');
  writeFileSync(dbPath, JSON.stringify(legacyDb, null, 2));
  const rawBefore = readFileSync(dbPath, 'utf8');

  const app = createApp({ dataDir, mockDelayMs: 1 });
  const server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };

  const listed = (await req('GET', '/api/plants')).body;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].sensors, normalizeSensors(undefined));
  assert.equal(readFileSync(dbPath, 'utf8'), rawBefore);

  const watered = (await req('PATCH', '/api/plants/legacy-1', { watered: true })).body;
  assert.deepEqual(watered.sensors, normalizeSensors(undefined));

  const checked = (await req('POST', '/api/plants/legacy-1/checkups', {
    image: IMAGE,
    report: { health_score: 80 },
  })).body;
  assert.deepEqual(checked.sensors, normalizeSensors(undefined));

  const afterDel = (await req('DELETE', `/api/plants/legacy-1/checkups/${checked.checkups[0].id}`)).body;
  assert.deepEqual(afterDel.sensors, normalizeSensors(undefined));
});

test('plantFacts includes connected non-null sensors with lux spacing and omits disconnected or null sensors', async (t) => {
  const parsed = JSON.parse(plantFacts({
    name: 'Pepper',
    species: 'Capsicum',
    location: 'Bed 1',
    notes: '',
    waterEveryDays: 2,
    lastWatered: '2026-01-01T00:00:00.000Z',
    sensors: {
      humidity: { connected: true, value: 62, unit: '%' },
      temperature: { connected: false, value: 25, unit: '°C' },
      soilMoisture: { connected: true, value: null, unit: '%' },
      light: { connected: true, value: 0, unit: 'lux' },
    },
    checkups: [],
  }));
  assert.deepEqual(parsed.sensors, { humidity: '62%', light: '0 lux' });

  const noQualifying = JSON.parse(plantFacts({
    name: 'Cactus',
    species: '',
    location: '',
    notes: '',
    waterEveryDays: 14,
    lastWatered: '2026-01-01T00:00:00.000Z',
    sensors: {
      humidity: { connected: false, value: 40, unit: '%' },
      temperature: { connected: true, value: null, unit: '°C' },
    },
    checkups: [],
  }));
  assert.equal('sensors' in noQualifying, false);

  const analyzeMock = fakeGemini(() => Response.json(reply(JSON.stringify({ health_score: 85 }))));
  const analyzeApp = await start(t, { apiKey: 'k', fetch: analyzeMock.fake });
  const p1 = (await analyzeApp.call('POST', '/api/plants', {
    name: 'Basil',
    sensors: {
      humidity: { connected: true, value: 62 },
      temperature: { connected: false, value: 24 },
      soilMoisture: { connected: true, value: null },
      light: { connected: true, value: 850 },
    },
  })).body;
  const p2 = (await analyzeApp.call('POST', '/api/plants', { name: 'Dormant Fern' })).body;

  await analyzeApp.call('POST', '/api/analyze', { image: IMAGE, plantId: p1.id });
  const a1Text = analyzeMock.calls[0].body.contents[0].parts[1].text;
  const a1Facts = JSON.parse(a1Text.match(/Plant record and previous checkup: (\{.*\})/)[1]);
  assert.deepEqual(a1Facts.sensors, { humidity: '62%', light: '850 lux' });

  await analyzeApp.call('POST', '/api/analyze', { image: IMAGE, plantId: p2.id });
  const a2Text = analyzeMock.calls[1].body.contents[0].parts[1].text;
  const a2Facts = JSON.parse(a2Text.match(/Plant record and previous checkup: (\{.*\})/)[1]);
  assert.equal('sensors' in a2Facts, false);

  const chatMock = fakeGemini(() => sseReply());
  const chatApp = await start(t, { apiKey: 'k', fetch: chatMock.fake });
  const cp1 = (await chatApp.call('POST', '/api/plants', {
    name: 'Basil',
    sensors: {
      humidity: { connected: true, value: 62 },
      temperature: { connected: false, value: 24 },
      soilMoisture: { connected: true, value: null },
      light: { connected: true, value: 850 },
    },
  })).body;
  const cp2 = (await chatApp.call('POST', '/api/plants', { name: 'Dormant Fern' })).body;

  await chatApp.call('POST', '/api/chat', { plantId: cp1.id, history });
  const c1Sys = chatMock.calls[0].body.systemInstruction.parts[0].text;
  const c1Facts = JSON.parse(c1Sys.split('\nThe user is asking about this saved plant:\n')[1]);
  assert.deepEqual(c1Facts.sensors, { humidity: '62%', light: '850 lux' });

  await chatApp.call('POST', '/api/chat', { plantId: cp2.id, history });
  const c2Sys = chatMock.calls[1].body.systemInstruction.parts[0].text;
  const c2Facts = JSON.parse(c2Sys.split('\nThe user is asking about this saved plant:\n')[1]);
  assert.equal('sensors' in c2Facts, false);
});

test('served UI files use WaterMI branding with zero legacy branding occurrences', async (t) => {
  const { call } = await start(t);

  const html = await call('GET', '/');
  assert.equal(html.status, 200);
  assert.match(html.body, /<title>WaterMI<\/title>/);
  assert.match(html.body, /class="brand"[\s\S]*?<span>WaterMI<\/span>/);
  assert.doesNotMatch(html.body, /leafwise/i);

  const appJs = await call('GET', '/app.js');
  assert.equal(appJs.status, 200);
  assert.match(appJs.body, /Cannot reach the WaterMI server\. Check that it is running\./);
  assert.match(appJs.body, /watermi\.chat\./);
  assert.doesNotMatch(appJs.body, /leafwise/i);

  const css = await call('GET', '/style.css');
  assert.equal(css.status, 200);
  assert.ok(css.body.length > 0);
  assert.doesNotMatch(css.body, /leafwise/i);
});

function createDom(html) {
  const VOID = new Set(['meta', 'link', 'input', 'img', 'br', 'hr']);
  const camelize = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  class FakeEl {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.attributes = {};
      this.dataset = {};
      this._classes = new Set();
      this.children = [];
      this.parentNode = null;
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.value = '';
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this.offsetHeight = 0;
      this._innerHTML = '';
      this.style = { setProperty() {} };
      this._listeners = {};
    }
    get className() {
      return [...this._classes].join(' ');
    }
    set className(val) {
      this._classes = new Set(String(val).split(/\s+/).filter(Boolean));
      this.attributes.class = this.className;
    }
    classList = {
      add: (...names) => {
        for (const n of names) if (n) this._classes.add(n);
        this.attributes.class = this.className;
      },
      remove: (...names) => {
        for (const n of names) this._classes.delete(n);
        this.attributes.class = this.className;
      },
      toggle: (name, force) => {
        const on = force !== undefined ? Boolean(force) : !this._classes.has(name);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        this.attributes.class = this.className;
        return on;
      },
      contains: (name) => this._classes.has(name),
    };
    get textContent() {
      return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    set textContent(v) {
      this.children = [String(v)];
    }
    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(v) {
      this._innerHTML = String(v);
    }
    setAttribute(k, v) {
      const val = String(v);
      this.attributes[k] = val;
      if (k === 'id') this.id = val;
      else if (k === 'class') this.className = val;
      else if (k === 'hidden') this.hidden = true;
      else if (k === 'disabled') this.disabled = true;
      else if (k === 'value') this.value = val;
      else if (k === 'open') this.open = true;
      else if (k.startsWith('data-')) this.dataset[camelize(k.slice(5))] = val;
    }
    getAttribute(k) {
      return k in this.attributes ? this.attributes[k] : null;
    }
    removeAttribute(k) {
      delete this.attributes[k];
      if (k === 'hidden') this.hidden = false;
      else if (k === 'disabled') this.disabled = false;
      else if (k === 'open') this.open = false;
    }
    append(...nodes) {
      for (const n of nodes.flat()) {
        if (n === null || n === undefined || n === false) continue;
        if (typeof n === 'string' || typeof n === 'number') {
          this.children.push(String(n));
        } else {
          n.parentNode = this;
          this.children.push(n);
        }
      }
    }
    replaceChildren(...nodes) {
      for (const c of this.children) if (c && typeof c === 'object') c.parentNode = null;
      this.children = [];
      this.append(...nodes);
    }
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    }
    dispatchEvent(ev) {
      const e = ev || { type: '' };
      e.target ??= this;
      e.currentTarget = this;
      e.preventDefault ??= () => {};
      for (const fn of this._listeners[e.type] ?? []) fn(e);
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this, currentTarget: this, preventDefault() {} });
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    reset() {}
    closest(sel) {
      let cur = this;
      while (cur && cur instanceof FakeEl) {
        if (sel === 'dialog' && cur.tagName === 'DIALOG') return cur;
        if (sel === 'button[data-view]' && cur.tagName === 'BUTTON' && cur.dataset.view !== undefined) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
  }

  const root = new FakeEl('html');
  const body = new FakeEl('body');
  root.append(body);
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z0-9-]+)([^>]*?)(\/?)>/g;
  for (const m of html.matchAll(tagRe)) {
    const [, closing, tagRaw, attrsRaw, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (tag === '!doctype' || tag === 'html' || tag === 'head') continue;
    if (tag === 'body') {
      if (!closing) stack.push(body);
      else if (stack.at(-1) === body) stack.pop();
      continue;
    }
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el = new FakeEl(tag);
    for (const am of attrsRaw.matchAll(/([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g)) {
      el.setAttribute(am[1], am[2] ?? '');
    }
    stack.at(-1).append(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }

  const walk = (node, pred, out = []) => {
    for (const c of node.children) {
      if (c instanceof FakeEl) {
        if (pred(c)) out.push(c);
        walk(c, pred, out);
      }
    }
    return out;
  };
  const matches = (el, sel) => {
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    if (sel === 'dialog[open]') return el.tagName === 'DIALOG' && el.open;
    if (sel === '[data-close]') return 'close' in el.dataset;
    return el.tagName === sel.toUpperCase();
  };
  const queryAll = (base, sel) => {
    const parts = sel.trim().split(/\s+/);
    if (parts.length === 1) return walk(base, (el) => matches(el, parts[0]));
    return walk(base, (el) => matches(el, parts[0])).flatMap((p) => walk(p, (c) => matches(c, parts[1])));
  };
  const document = {
    documentElement: root,
    body,
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (_, tag) => new FakeEl(tag),
    querySelector: (sel) => queryAll(root, sel)[0] ?? null,
    querySelectorAll: (sel) => queryAll(root, sel),
  };
  return { document, walk };
}

test('#dlg-plant renders all 4 sensors with statuses, formatting, and defined CSS classes', async (t) => {
  const { call, base } = await start(t, { mock: true });

  await call('POST', '/api/plants', {
    name: 'Sensor Basil',
    species: 'Ocimum basilicum',
    location: 'Greenhouse',
    sensors: {
      humidity: { connected: true, value: 62 },
      temperature: { connected: false, value: 24 },
      soilMoisture: { connected: true, value: 0 },
      light: { connected: true, value: 850 },
    },
  });
  await call('POST', '/api/plants', { name: 'Offline Fern' });

  const html = (await call('GET', '/')).body;
  const appJs = (await call('GET', '/app.js')).body;
  const css = (await call('GET', '/style.css')).body;

  const { document, walk } = createDom(html);
  const windowObj = { addEventListener() {}, scrollTo() {} };
  const sandbox = {
    document,
    window: windowObj,
    history: { replaceState() {} },
    location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    ResizeObserver: class { observe() {} },
    Event: class { constructor(type) { this.type = type; } },
    fetch: (url, init) => globalThis.fetch(url.startsWith('/') ? base + url : url, init),
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    URL,
    TextDecoder,
  };
  vm.runInNewContext(appJs, sandbox);

  let cards = [];
  for (let i = 0; i < 100; i++) {
    cards = document.querySelectorAll('.plant-card');
    if (cards.length === 2) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(cards.length, 2);

  // Open mixed-sensor plant ("Sensor Basil")
  cards.find((c) => c.textContent.includes('Sensor Basil')).click();
  const dialog = document.querySelector('#dlg-plant');
  const detail = document.querySelector('#plant-detail');
  assert.equal(dialog.open, true);

  const detailLeft = walk(detail, (el) => el.classList.contains('detail-left'))[0];
  const detailRight = walk(detail, (el) => el.classList.contains('detail-right'))[0];
  const sensorsCard = walk(detail, (el) => el.classList.contains('sensors-card'))[0];
  assert.ok(detailLeft);
  assert.ok(detailRight);
  assert.ok(walk(detailLeft, (el) => el.classList.contains('detail-photo')).length === 1);
  assert.ok(sensorsCard);
  const cardIndex = detailRight.children.indexOf(sensorsCard);
  assert.ok(cardIndex >= 0);
  assert.match(detailRight.children[cardIndex + 1].textContent, /Health over time/);

  const items = walk(sensorsCard, (el) => el.classList.contains('sensor-item'));
  assert.deepEqual(items.map((el) => el.dataset.sensor), ['humidity', 'temperature', 'soilMoisture', 'light']);

  const byKey = Object.fromEntries(items.map((el) => [el.dataset.sensor, {
    label: walk(el, (c) => c.classList.contains('sensor-label'))[0]?.textContent,
    status: walk(el, (c) => c.classList.contains('sensor-status'))[0]?.textContent,
    statusClasses: walk(el, (c) => c.classList.contains('sensor-status'))[0]?.className,
    value: walk(el, (c) => c.classList.contains('sensor-value'))[0]?.textContent,
    valueNode: walk(el, (c) => c.classList.contains('sensor-value'))[0],
  }]));

  assert.equal(byKey.humidity.label, 'Humidity');
  assert.equal(byKey.humidity.status, 'Connected');
  assert.match(byKey.humidity.statusClasses, /\bconnected\b/);
  assert.equal(byKey.humidity.value, '62%');

  assert.equal(byKey.temperature.label, 'Temperature');
  assert.equal(byKey.temperature.status, 'Not connected');
  assert.match(byKey.temperature.statusClasses, /\bdisconnected\b/);
  assert.equal(byKey.temperature.value, '—');
  assert.equal(byKey.temperature.valueNode.getAttribute('aria-label'), 'No reading');
  assert.doesNotMatch(items[1].textContent, /24°C/);

  assert.equal(byKey.soilMoisture.label, 'Soil moisture');
  assert.equal(byKey.soilMoisture.status, 'Connected');
  assert.equal(byKey.soilMoisture.value, '0%');

  assert.equal(byKey.light.label, 'Light');
  assert.equal(byKey.light.status, 'Connected');
  assert.equal(byKey.light.value, '850 lux');

  const fullText = detail.textContent;
  assert.doesNotMatch(fullText, /NaN|undefined|null%|null°C|null lux/);

  // Verify all CSS class tokens used inside #plant-detail exist in served style.css
  const strippedCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssClasses = new Set();
  for (const m of strippedCss.matchAll(/([^{}@]+)\{/g)) {
    for (const cm of m[1].matchAll(/\.([a-zA-Z0-9_-]+)/g)) cssClasses.add(cm[1]);
  }
  const usedClasses = new Set(walk(sensorsCard, () => true).flatMap((el) => el.className.split(/\s+/).filter(Boolean)));
  for (const cls of usedClasses) {
    assert.ok(cssClasses.has(cls), `Missing CSS selector for class .${cls} in style.css`);
  }

  // Close and open all-disconnected plant ("Offline Fern")
  walk(detail, (el) => el.classList.contains('close'))[0].click();
  assert.equal(dialog.open, false);

  document.querySelectorAll('.plant-card').find((c) => c.textContent.includes('Offline Fern')).click();
  assert.equal(dialog.open, true);
  const offlineStatuses = walk(detail, (el) => el.classList.contains('sensor-status')).map((el) => el.textContent);
  assert.deepEqual(offlineStatuses, ['Not connected', 'Not connected', 'Not connected', 'Not connected']);
  const offlineValues = walk(detail, (el) => el.classList.contains('sensor-value')).map((el) => el.textContent);
  assert.deepEqual(offlineValues, ['—', '—', '—', '—']);
});

test('setup view and Blynk sketch are served with every configurable setting', async (t) => {
  const { call } = await start(t);

  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /id="view-setup"/);
  assert.match(page.body, /id="s-download"/);

  const sketch = await call('GET', '/arduino/watermi_blynk/watermi_blynk.ino');
  assert.equal(sketch.status, 200);
  for (const name of ['BLYNK_TEMPLATE_ID', 'BLYNK_TEMPLATE_NAME', 'BLYNK_AUTH_TOKEN']) {
    assert.match(sketch.body, new RegExp(`#define ${name}\\s+"[^"]*"`), `${name} missing from Blynk sketch`);
  }
  for (const name of ['WIFI_SSID', 'WIFI_PASSWORD']) {
    assert.match(sketch.body, new RegExp(`const char\\* ${name}\\s*=\\s*"[^"]*";`), `${name} missing from Blynk sketch`);
  }
  assert.match(sketch.body, /#include <DHT\.h>/);
  assert.match(sketch.body, /const bool LIGHT_SENSOR_ENABLED = true;/);
  assert.match(sketch.body, /#define VPIN_TEMPERATURE V0/);
  assert.match(sketch.body, /#define VPIN_HUMIDITY\s+V1/);
  assert.match(sketch.body, /#define VPIN_LIGHT\s+V2/);
  assert.match(sketch.body, /#define VPIN_SOIL\s+V3/);
  assert.match(sketch.body, /lightRaw = constrain\(lightRaw, 0, 4095\);/);
  assert.match(sketch.body, /Blynk\.config\(BLYNK_AUTH_TOKEN\);/);
});

test('setup sketch download injects user template ID, auth token, Wi-Fi, and GPIO pins including lightPin', async (t) => {
  const { call, base } = await start(t, { mock: true });
  const html = (await call('GET', '/')).body;
  const appJs = (await call('GET', '/app.js')).body;
  const { document } = createDom(html);
  const downloaded = [];
  const sandbox = {
    document,
    window: { addEventListener() {}, scrollTo() {} },
    history: { replaceState() {} },
    location: { hash: '#setup' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    ResizeObserver: class { observe() {} },
    Event: class { constructor(type) { this.type = type; } },
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    fetch: (url, init) => globalThis.fetch(url.startsWith('/') ? base + url : url, init),
    confirm: () => true,
    setTimeout,
    clearTimeout,
    console,
    URL: {
      createObjectURL: (blob) => { downloaded.push(blob.text); return 'blob:sketch'; },
      revokeObjectURL: () => {},
    },
    TextDecoder,
  };
  vm.runInNewContext(appJs, sandbox);

  const dhtSel = document.querySelector('#s-dhtpin');
  const soilSel = document.querySelector('#s-soilpin');
  const lightSel = document.querySelector('#s-lightpin');
  const downloadBtn = document.querySelector('#s-download');
  for (let i = 0; i < 100 && dhtSel.children.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  document.querySelector('#s-blynk-template').value = 'TMPL_USER_123';
  document.querySelector('#s-blynk-auth').value = 'AUTH_USER_456';
  document.querySelector('#s-ssid').value = 'GrowerNet';
  document.querySelector('#s-pass').value = 'supersecret';
  dhtSel.value = '14';
  soilSel.value = '32';
  lightSel.value = '33';
  for (const id of ['#s-blynk-template', '#s-blynk-auth', '#s-ssid', '#s-pass', '#s-dhtpin', '#s-soilpin', '#s-lightpin']) {
    document.querySelector(id).dispatchEvent({ type: 'input' });
  }
  for (let i = 0; i < 100 && downloadBtn.disabled; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(downloadBtn.disabled, false);

  downloadBtn.click();
  const out = downloaded.at(-1);
  assert.match(out, /#define BLYNK_TEMPLATE_ID "TMPL_USER_123"/);
  assert.match(out, /#define BLYNK_AUTH_TOKEN "AUTH_USER_456"/);
  assert.match(out, /const char\* WIFI_SSID\s*=\s*"GrowerNet";/);
  assert.match(out, /const char\* WIFI_PASSWORD\s*=\s*"supersecret";/);
  assert.match(out, /#define DHTPIN\s+14\b/);
  assert.match(out, /const int soilMoisturePin = 32;/);
  assert.match(out, /const bool LIGHT_SENSOR_ENABLED = true;/);
  assert.match(out, /const int\s+lightPin\s*=\s*33;/);
});

test('Blynk webhook supports batch and partial virtual-pin updates without wiping other sensors', async (t) => {
  const { call } = await start(t);
  const plant = (await call('POST', '/api/plants', { name: 'Blynk Tomato' })).body;

  const first = await call('POST', '/api/webhook/blynk', {
    values: { V0: 28.2, V1: 65.4 },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.id, plant.id);
  assert.equal(first.body.sensors.temperature.connected, true);
  assert.equal(first.body.sensors.temperature.value, 28.2);
  assert.equal(first.body.sensors.humidity.connected, true);
  assert.equal(first.body.sensors.humidity.value, 65.4);
  assert.equal(first.body.sensors.light.connected, false);
  assert.equal(first.body.sensors.soilMoisture.connected, false);

  // Single-pin update should keep V0 and V1 intact
  const second = await call('POST', '/api/webhook/blynk', { pin: 'V2', value: '1201' });
  assert.equal(second.status, 200);
  assert.equal(second.body.sensors.temperature.connected, true);
  assert.equal(second.body.sensors.temperature.value, 28.2);
  assert.equal(second.body.sensors.humidity.connected, true);
  assert.equal(second.body.sensors.humidity.value, 65.4);
  assert.equal(second.body.sensors.light.connected, true);
  assert.equal(second.body.sensors.light.value, 1201);

  const third = await call('POST', '/api/webhook/blynk', { pin: 'V3', value: '52' });
  assert.equal(third.status, 200);
  assert.equal(third.body.sensors.soilMoisture.connected, true);
  assert.equal(third.body.sensors.soilMoisture.value, 52);
  assert.equal(third.body.sensors.light.value, 1201);
});

test('BLYNK_AUTH_TOKEN automatically syncs live sensor values and hardware online status', async (t) => {
  let online = true;
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes('/external/api/isHardwareConnected')) {
      return new Response(online ? 'true' : 'false', { status: 200 });
    }
    if (u.includes('/external/api/get')) {
      return Response.json({ v0: 26.8, v1: 71.24, v2: 12000, v3: 44 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };

  const { call } = await start(t, { blynkToken: 'tok-123', fetch: fakeFetch });
  const plant = (await call('POST', '/api/plants', { name: 'Cloud Basil' })).body;

  const list = await call('GET', '/api/plants');
  assert.equal(list.status, 200);
  const synced = list.body.find((p) => p.id === plant.id);
  assert.equal(synced.sensors.temperature.connected, true);
  assert.equal(synced.sensors.temperature.value, 26.8);
  assert.equal(synced.sensors.humidity.connected, true);
  assert.equal(synced.sensors.humidity.value, 71.2);
  assert.equal(synced.sensors.light.connected, true);
  assert.equal(synced.sensors.light.value, 12000);
  assert.equal(synced.sensors.soilMoisture.connected, true);
  assert.equal(synced.sensors.soilMoisture.value, 44);
});

test('per-plant blynkToken links via PATCH without leaking token and syncs live readings', async (t) => {
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes('/external/api/isHardwareConnected') && u.includes('user-blynk-secret')) {
      return new Response('true', { status: 200 });
    }
    if (u.includes('/external/api/get') && u.includes('user-blynk-secret')) {
      return Response.json({ v0: 25.1, v1: 58.6, v2: 1201, v3: 61 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };

  const { call } = await start(t, { fetch: fakeFetch });
  const plant = (await call('POST', '/api/plants', { name: 'Balcony Mint' })).body;
  assert.equal(plant.blynkLinked, undefined);

  const linked = await call('PATCH', `/api/plants/${plant.id}`, { blynkToken: 'user-blynk-secret' });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.blynkLinked, true);
  assert.equal('blynkToken' in linked.body, false);
  assert.equal(linked.body.sensors.temperature.connected, true);
  assert.equal(linked.body.sensors.temperature.value, 25.1);
  assert.equal(linked.body.sensors.humidity.connected, true);
  assert.equal(linked.body.sensors.humidity.value, 58.6);
  assert.equal(linked.body.sensors.light.value, 1201);
  assert.equal(linked.body.sensors.soilMoisture.value, 61);

  const unlinked = await call('PATCH', `/api/plants/${plant.id}`, { blynkToken: '' });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.blynkLinked, false);
  assert.equal(unlinked.body.sensors.humidity.connected, false);
});

test('POST /api/plants/:id/sensors accepts ESP32 payloads and marks stale readings disconnected', async (t) => {
  const { call } = await start(t, { sensorTimeoutMs: 40 });
  const plant = (await call('POST', '/api/plants', { name: 'ESP32 Tomato' })).body;

  const updated = await call('POST', `/api/plants/${plant.id}/sensors`, {
    humidity: 64.26,
    temperature: 27.5,
    soilMoisture: 48,
    light: null,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.sensors.humidity.connected, true);
  assert.equal(updated.body.sensors.humidity.value, 64.3);
  assert.equal(updated.body.sensors.temperature.connected, true);
  assert.equal(updated.body.sensors.temperature.value, 27.5);
  assert.equal(updated.body.sensors.soilMoisture.connected, true);
  assert.equal(updated.body.sensors.soilMoisture.value, 48);
  assert.equal(updated.body.sensors.light.connected, false);
  assert.equal(updated.body.sensors.light.value, null);
  assert.ok(updated.body.sensorsUpdatedAt);

  // Wait past sensorTimeoutMs and confirm GET /api/plants flips all sensors to disconnected
  await new Promise((r) => setTimeout(r, 60));
  const after = (await call('GET', '/api/plants')).body.find((p) => p.id === plant.id);
  for (const key of Object.keys(SENSOR_UNITS)) {
    assert.equal(after.sensors[key].connected, false);
  }
});


