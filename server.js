import http from 'node:http';
import { readFile, writeFile, mkdir, realpath, open, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const MAX_BYTES = 64 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const error = (message, status = 400) => Object.assign(new Error(message), { status });

export async function scopedDirectory(root, requested) {
  const target = resolve(root, requested);
  if (!inside(root, target)) throw error('输出目录必须位于当前 DSH 项目中');
  let ancestor = target;
  while (true) {
    try { if (!inside(root, await realpath(ancestor))) throw error('目录链接指向项目之外'); break; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; const parent = resolve(ancestor, '..'); if (parent === ancestor) throw cause; ancestor = parent; }
  }
  await mkdir(target, { recursive: true });
  const canonical = await realpath(target);
  if (!inside(root, canonical)) throw error('输出目录链接指向项目之外');
  return canonical;
}

export function safeName(value, fallback = '图片.png') {
  let name = String(value || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..') name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

export function checkPng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw error('导出结果不是完整的 PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 100000000 || bytes[24] !== 8) throw error('导出须为有效尺寸的 8-bit PNG');
  return { width, height };
}

export async function writeUnique(directory, filename, bytes) {
  const name = safeName(filename).replace(/\.png$/i, '');
  for (let index = 0; ; index++) {
    const path = join(directory, name + (index ? '_' + index : '') + '.png');
    let handle;
    try { handle = await open(path, 'wx'); }
    catch (cause) { if (cause.code === 'EEXIST') continue; throw cause; }
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    return path;
  }
}

export async function openDefaultBrowser(url) {
  if (process.platform !== 'win32') throw error('自动打开默认浏览器目前支持 Windows；可手动打开返回的工作台地址');
  await new Promise((accept, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore', detached: true, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); accept(); });
  });
}

async function bodyOf(request, maxBytes = MAX_BYTES) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw error('文件或请求过大', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

function json(response, status, value) {
  if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
}

export class ColorMatchSession {
  constructor(rootDir, { launch = openDefaultBrowser, timeout = 60000 } = {}) {
    this.rootDir = resolve(rootDir); this.launch = launch; this.timeout = timeout;
    this.token = randomBytes(32).toString('hex'); this.sessionId = randomUUID();
    this.sources = new Map(); this.sourceHashes = new Map(); this.pending = new Map(); this.queue = [];
    this.client = null; this.lastSeen = 0; this.outputs = []; this.waiter = null; this.closed = false;
  }
  async start() {
    this.rootDir = await realpath(this.rootDir);
    this.cacheDir = await scopedDirectory(this.rootDir, '.dsh-asset-color-match/' + this.sessionId);
    this.outputDir = await scopedDirectory(this.rootDir, '配色输出');
    this.html = await readFile(join(WEB, 'index.html'), 'utf8');
    this.bridge = await readFile(join(WEB, 'bridge.js'));
    this.server = http.createServer((request, response) => this.handle(request, response).catch(cause => json(response, cause.status || 500, { error: cause.message })));
    await new Promise((accept, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', accept); });
    this.origin = 'http://127.0.0.1:' + this.server.address().port;
    this.url = this.origin + '/#' + this.token;
    return this;
  }
  connected() { return !!this.client && Date.now() - this.lastSeen < 30000; }
  async openBrowser() {
    if (!this.connected()) await this.launch(this.url);
    return { url: this.url, projectRoot: this.rootDir, outputDirectory: this.outputDir, connected: this.connected(), notice: '请在默认浏览器中载入参考图和资产。图片仅在请求 inspect/export 时交给本地插件，手调不实时推送给智能体。' };
  }
  async storeSource(bytes, name, mediaType) {
    if (typeof name !== 'string' || !name || name.length > 512) throw error('需要有效的图片文件名');
    if (!IMAGE_TYPES.has(mediaType) || !bytes.length || bytes.length > MAX_BYTES) throw error('仅支持 PNG/JPEG/WebP/GIF，单张不超过 64 MB');
    const hash = createHash('sha256').update(bytes).update(name).digest('hex');
    if (this.sourceHashes.has(hash)) return this.sources.get(this.sourceHashes.get(hash));
    const id = randomUUID(), extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mediaType];
    const source = { id, name: safeName(name), mediaType, path: join(this.cacheDir, id + extension), bytes: bytes.length };
    await writeFile(source.path, bytes, { flag: 'wx' });
    this.sources.set(id, source); this.sourceHashes.set(hash, id);
    return source;
  }
  async sourceFromPath(filePath) {
    const canonical = await realpath(resolve(this.rootDir, filePath));
    if (!inside(this.rootDir, canonical)) throw error('载入路径必须位于当前 DSH 项目中；项目外图片可由用户在网页选择');
    const info = await stat(canonical); if (!info.isFile() || info.size > MAX_BYTES) throw error('图片须为不超过 64 MB 的普通文件');
    const mediaType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(canonical).toLowerCase()];
    return this.storeSource(await readFile(canonical), basename(canonical), mediaType);
  }
  snapshotPaths(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.assets)) throw error('网页没有返回有效资产列表');
    const attach = asset => {
      if (!asset) return null;
      const source = this.sources.get(asset.sourceId);
      if (!source) throw error('网页图片未保存到本地缓存，请重新 inspect');
      return { ...asset, path: source.path, mediaType: source.mediaType };
    };
    return { ...snapshot, reference: attach(snapshot.reference), assets: snapshot.assets.map(attach), outputDirectory: this.outputDir };
  }
  async rpc(action, payload = {}, signal) {
    if (this.closed) throw error('工作台已关闭');
    if (signal?.aborted) throw error('操作已取消');
    const id = randomUUID();
    const result = new Promise((accept, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.clean();
        this.queue = this.queue.filter(c => c.id !== id);
        reject(error('操作未获网页确认，可能已部分执行；请先检查当前参数或已输出文件，不要自动重试。' + (pending.files.length ? ' 已保存：' + pending.files.map(f => f.path).join('、') : '')));
      };
      const timer = setTimeout(cancel, this.timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { action, payload, files: [], accept, reject, timer, clean: () => signal?.removeEventListener('abort', cancel) });
    });
    this.queue.push({ id, action, payload }); this.flush();
    return result;
  }
  flush() {
    if (this.waiter && this.queue.length) {
      const waiter = this.waiter; this.waiter = null; clearTimeout(waiter.timer);
      json(waiter.response, 200, this.queue.shift());
    }
  }
  async handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url, this.origin);
    if (request.headers.host !== new URL(this.origin).host) throw error('无效的 Host', 403);
    if (request.headers.origin && request.headers.origin !== this.origin) throw error('拒绝跨站请求', 403);
    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(this.html.replace('</body>', '<script src="/bridge.js"></script></body>')); return;
    }
    if (request.method === 'GET' && url.pathname === '/bridge.js') { response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(this.bridge); return; }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const credential = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(this.token);
    if (credential.length !== expected.length || !timingSafeEqual(credential, expected)) throw error('需要从当前 DSH 对话打开工作台', 401);
    const client = request.headers['x-client-id'];
    if (typeof client !== 'string' || !/^[a-f0-9-]{36}$/i.test(client)) throw error('缺少浏览器连接标识', 400);
    if (request.method === 'POST' && url.pathname === '/api/connect') {
      if (this.connected() && this.client !== client) throw error('当前 DSH 对话已有连接的工作台，请使用原页面；关闭原页面约 30 秒后可重新连接', 409);
      this.client = client; this.lastSeen = Date.now();
      json(response, 200, { projectRoot: this.rootDir, outputDirectory: this.outputDir }); return;
    }
    if (client !== this.client) throw error('此页面不是当前工作台', 409);
    this.lastSeen = Date.now();
    if (request.method === 'GET' && url.pathname === '/api/next') {
      if (this.waiter) { clearTimeout(this.waiter.timer); json(this.waiter.response, 200, null); }
      const waiter = { response, timer: setTimeout(() => { if (this.waiter === waiter) this.waiter = null; json(response, 200, null); }, 15000) };
      response.once('close', () => { if (this.waiter === waiter) { this.waiter = null; clearTimeout(waiter.timer); } });
      this.waiter = waiter; this.flush(); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/source') {
      const source = await this.storeSource(await bodyOf(request), url.searchParams.get('name'), request.headers['content-type']?.split(';')[0]);
      json(response, 200, { id: source.id, name: source.name }); return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/source/')) {
      const source = this.sources.get(url.pathname.slice('/api/source/'.length));
      if (!source) throw error('找不到图片', 404);
      response.writeHead(200, { 'Content-Type': source.mediaType, 'Cache-Control': 'no-store' }); response.end(await readFile(source.path)); return;
    }
    if (request.method === 'POST' && (url.pathname === '/api/export' || url.pathname === '/api/manual-export')) {
      const commandId = url.searchParams.get('commandId'); const pending = this.pending.get(commandId);
      if (url.pathname === '/api/export' && pending?.action !== 'export') throw error('导出指令已失效，先检查已保存文件', 409);
      const bytes = await bodyOf(request), dimensions = checkPng(bytes);
      const directory = await scopedDirectory(this.rootDir, pending?.payload.outputDir || '配色输出');
      const path = await writeUnique(directory, url.searchParams.get('name'), bytes);
      const result = { path, ...dimensions, bytes: bytes.length, assetId: url.searchParams.get('assetId') || undefined };
      this.outputs.push(result); pending?.files.push(result);
      json(response, 200, result); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/result') {
      const result = JSON.parse((await bodyOf(request, 2 * 1024 * 1024)).toString('utf8'));
      const pending = this.pending.get(result.id); if (!pending) throw error('指令已结束，请先检查当前状态', 409);
      this.pending.delete(result.id); clearTimeout(pending.timer); pending.clean();
      if (typeof result.error === 'string') pending.reject(error(result.error + (pending.files.length ? '；部分文件已保存：' + pending.files.map(f => f.path).join('、') : '')));
      else if (pending.action === 'export') pending.accept({ files: pending.files, parametersUsed: result.value?.parametersUsed });
      else pending.accept(result.value);
      json(response, 200, { ok: true }); return;
    }
    throw error('找不到接口', 404);
  }
  async close() {
    this.closed = true;
    if (this.waiter) { clearTimeout(this.waiter.timer); json(this.waiter.response, 200, null); this.waiter = null; }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.clean(); pending.reject(error('插件已停用；已保存图片仍保留')); }
    this.pending.clear(); this.queue = [];
    if (this.server) await new Promise(accept => { this.server.close(accept); this.server.closeAllConnections(); });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const session = await new ColorMatchSession(process.argv[2] || process.cwd()).start();
  console.log('本地工作台：' + session.url);
  console.log('项目目录：' + session.rootDir);
  process.once('SIGINT', async () => { await session.close(); process.exit(0); });
}
