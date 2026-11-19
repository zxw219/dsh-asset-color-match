import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { ColorMatchSession, scopedDirectory, writeUnique, checkPng, safeName } from '../server.js';
import { AssetColorMatch, apply, inject, parameters } from '../index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i8AAAAASUVORK5CYII=', 'base64');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-color-test-'));
  const launches = [];
  const session = await new ColorMatchSession(root, { launch: async url => launches.push(url), ...options }).start();
  t.after(() => session.close());
  const client = randomUUID();
  const request = (path, options = {}) => fetch(session.origin + path, { ...options, headers: { Authorization: 'Bearer ' + session.token, 'X-Client-ID': client, ...options.headers } });
  const post = async (path, value) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post('/api/connect', {})).status, 200);
  return { root, session, request, post, launches };
}

test('loopback authentication, origin, host and single-client boundaries', async t => {
  const { session, request, post, launches } = await fixture(t);
  assert.equal(session.server.address().address, '127.0.0.1');
  assert.equal((await fetch(session.origin + '/api/next')).status, 401);
  assert.equal((await request('/api/next', { headers: { Origin: 'https://other.invalid' } })).status, 403);
  const wrongHost = await new Promise((accept, reject) => {
    const request = httpRequest(session.origin, { headers: { Host: 'other.invalid' } }, response => { response.resume(); accept(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await post('/api/connect', {})).status, 200);
  assert.equal((await request('/api/connect', { method: 'POST', headers: { 'X-Client-ID': randomUUID() } })).status, 409);
  const page = await fetch(session.origin);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /src="\/bridge.js"/);
  await session.openBrowser(); assert.equal(launches.length, 0);
});

test('sources stay inside project and snapshots identify original pixels', async t => {
  const { root, session, request } = await fixture(t);
  const original = join(root, '原图.png'); await writeFile(original, png);
  const source = await session.sourceFromPath(original);
  assert.deepEqual(await readFile(source.path), png);
  assert.equal((await session.sourceFromPath(original)).id, source.id);
  const snapshot = session.snapshotPaths({ assets: [{ id: 'asset', sourceId: source.id }], reference: null });
  assert.equal(snapshot.assets[0].path, source.path);
  assert.throws(() => session.snapshotPaths({ assets: [{ sourceId: 'unknown' }] }), /未保存/);
  const outside = await mkdtemp(join(tmpdir(), 'dsh-color-outside-'));
  await writeFile(join(outside, 'outside.png'), png);
  await assert.rejects(session.sourceFromPath(join(outside, 'outside.png')), /当前 DSH 项目/);
  await assert.rejects(scopedDirectory(root, outside), /当前 DSH 项目/);
  await symlink(outside, join(root, 'link'), 'junction');
  await assert.rejects(scopedDirectory(root, 'link/child'), /链接/);
  await assert.rejects(session.sourceFromPath('link/outside.png'), /当前 DSH 项目/);
  assert.equal((await request('/api/source?name=x.txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: png })).status, 400);
  assert.deepEqual(await readFile(original), png);
});

test('RPC and export use acknowledged current values and real saved paths', async t => {
  const { root, session, request, post } = await fixture(t);
  const pending = session.rpc('export', { outputDir: '配色输出' });
  const command = await (await request('/api/next')).json();
  assert.equal(command.action, 'export');
  const endpoint = '/api/export?commandId=' + command.id + '&name=' + encodeURIComponent('角色.png');
  const saved = await (await request(endpoint, { method: 'POST', body: png })).json();
  const saved2 = await (await request(endpoint, { method: 'POST', body: png })).json();
  assert.equal(basename(saved2.path), '角色_1.png');
  const used = [{ grade: { multiply: [0.8, 0.9, 1] } }];
  await post('/api/result', { id: command.id, value: { files: [{ path: 'fake' }], parametersUsed: used } });
  const result = await pending;
  assert.equal(result.files[0].path, saved.path); assert.deepEqual(result.parametersUsed, used);
  assert.deepEqual(await readFile(saved.path), png);
  assert.equal(saved.width, 1); assert.match(saved.path, /配色输出/);
  assert.equal((await request(endpoint, { method: 'POST', body: png })).status, 409);
  assert.equal(session.outputs.length, 2);
  const invalid = await request('/api/manual-export?name=bad.png', { method: 'POST', body: 'not png' });
  assert.equal(invalid.status, 400);
  await assert.rejects(scopedDirectory(root, '../escape'), /当前 DSH 项目/);
});

test('timeout and cancellation never replay, partial outputs remain discoverable', async t => {
  const { session, request } = await fixture(t, { timeout: 80 });
  const pending = session.rpc('export');
  const rejected = assert.rejects(pending, /已保存/);
  const command = await (await request('/api/next')).json();
  await request('/api/export?commandId=' + command.id + '&name=partial.png', { method: 'POST', body: png });
  await rejected;
  assert.equal(session.pending.size, 0); assert.equal(session.queue.length, 0); assert.equal(session.outputs.length, 1);
  const controller = new AbortController();
  const cancelled = assert.rejects(session.rpc('set', {}, controller.signal), /不要自动重试/);
  controller.abort(); await cancelled;
  assert.equal(session.pending.size, 0); assert.equal(session.queue.length, 0);
});

test('exclusive filenames, PNG bounds and Windows reserved names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-color-save-'));
  const files = await Promise.all(Array.from({ length: 5 }, () => writeUnique(directory, '角色.png', png)));
  assert.equal(new Set(files).size, 5);
  assert.equal(safeName('CON.png'), '_CON.png'); assert.equal(safeName('../x.png'), '.._x.png');
  assert.deepEqual(checkPng(png), { width: 1, height: 1 });
  const invalid = Buffer.from(png); invalid.writeUInt32BE(0, 16);
  assert.throws(() => checkPng(invalid), /尺寸/);
});

test('DSH adapter isolates chats, changes project and registers native entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-color-adapter-'));
  let directory = root; const made = []; const effects = []; let tool, command;
  const ctx = {
    workingDirectory: { ensure: async () => directory }, agents: { get: id => ({ id }) },
    tools: { register: definition => { tool = definition; return () => {}; } },
    commands: { register: definition => { command = definition; return () => {}; } },
    effect: callback => effects.push(callback())
  };
  const service = new AssetColorMatch(ctx, async rootDir => {
    const session = { rootDir, outputs: [], close: async () => { session.closed = true; }, openBrowser: async () => ({ rootDir }), rpc: async (action, payload) => ({ action, payload }) };
    made.push(session); return session;
  });
  t.after(() => service.dispose());
  await service.execute({ action: 'open' }, { id: 'a' });
  await service.execute({ action: 'open' }, { id: 'b' }); assert.equal(made.length, 2);
  directory = join(root, 'other'); await mkdir(directory);
  await service.execute({ action: 'open' }, { id: 'a' }); assert(made[0].closed); assert.equal(made.length, 3);
  assert.equal((await service.execute({ action: 'export' }, { id: 'a' })).payload.outputDir, '配色输出');
  await assert.rejects(service.execute({ action: 'set', updates: [] }, { id: 'a' }), /updates/);
  await apply(ctx);
  assert.deepEqual(inject, ['tools', 'commands', 'agents', 'workingDirectory']);
  assert.equal(tool.name, 'asset_color_match'); assert.equal(tool.parameters, parameters);
  assert.equal(command.name, 'asset-color-match'); assert.equal(tool.timeoutMs, 90000);
  assert.equal((await command.handler({ agent: { id: 'c' }, rawInput: 'bad' })).kind, 'error');
  for (const effect of effects.reverse()) await effect();
});
