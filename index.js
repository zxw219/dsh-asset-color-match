import { ColorMatchSession } from './server.js';
import { realpath } from 'node:fs/promises';

export const inject = ['tools', 'commands', 'agents', 'workingDirectory'];
const ACTIONS = ['open', 'inspect', 'load', 'set', 'export', 'close'];

export class AssetColorMatch {
  constructor(ctx, createSession = async root => new ColorMatchSession(root).start()) {
    this.ctx = ctx; this.createSession = createSession; this.sessions = new Map();
  }
  async session(agent) {
    const root = await realpath(await this.ctx.workingDirectory.ensure(agent));
    let pending = this.sessions.get(agent.id);
    if (pending && (await pending).rootDir !== root) { await (await pending).close(); this.sessions.delete(agent.id); pending = null; }
    if (!pending) {
      pending = this.createSession(root); this.sessions.set(agent.id, pending);
      pending.catch(() => { if (this.sessions.get(agent.id) === pending) this.sessions.delete(agent.id); });
    }
    return pending;
  }
  async execute(args, agent, signal) {
    if (!args || !ACTIONS.includes(args.action)) throw new Error('未知操作，请使用 open / inspect / load / set / export / close');
    if (signal?.aborted) throw new Error('操作已取消');
    if (args.action === 'close') {
      const pending = this.sessions.get(agent.id); this.sessions.delete(agent.id);
      if (pending) await (await pending).close();
      return { closed: true, notice: '本地控制接口已关闭，原图和已保存图片保留。' };
    }
    const session = await this.session(agent);
    if (args.action === 'open') return session.openBrowser();
    if (args.action === 'inspect') {
      const snapshot = session.snapshotPaths(await session.rpc('snapshot', {}, signal));
      return { ...snapshot, previousOutputs: session.outputs, nextStep: '这些是图片路径和参数，不代表已看图。请使用 DSH 内置读图工具查看参考图及资产原图，再按用户要求调用 set。手调结果只在本次请求时读取。' };
    }
    if (args.action === 'load') {
      const files = args.files || [];
      if (!Array.isArray(files) || files.length > 64 || files.some(path => typeof path !== 'string') ||
          (args.reference !== undefined && typeof args.reference !== 'string') || (!files.length && !args.reference)) throw new Error('load 需要参考图路径或 1–64 张资产路径');
      const assets = [];
      for (const file of files) { const source = await session.sourceFromPath(file); assets.push({ id: source.id, name: source.name, mediaType: source.mediaType }); }
      let reference;
      if (args.reference) { const source = await session.sourceFromPath(args.reference); reference = { id: source.id, name: source.name, mediaType: source.mediaType }; }
      if (!session.connected()) await session.openBrowser();
      return session.snapshotPaths(await session.rpc('load', { assets, reference }, signal));
    }
    if (args.action === 'set') {
      if (!Array.isArray(args.updates) || !args.updates.length || args.updates.length > 64) throw new Error('set 需要 1–64 项 updates');
      return session.snapshotPaths(await session.rpc('set', { updates: args.updates }, signal));
    }
    if (args.action === 'export') {
      if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.some(id => typeof id !== 'string'))) throw new Error('ids 必须为资产 ID 数组');
      if (args.outputDir !== undefined && (typeof args.outputDir !== 'string' || args.outputDir.length > 1000)) throw new Error('outputDir 必须为项目内目录');
      if (args.suffix !== undefined && (typeof args.suffix !== 'string' || args.suffix.length > 100)) throw new Error('suffix 须为 100 字以内的文件名后缀');
      return session.rpc('export', { ids: args.ids, suffix: args.suffix, outputDir: args.outputDir || '配色输出' }, signal);
    }
  }
  async dispose() {
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    await Promise.allSettled(sessions.map(async pending => (await pending).close()));
  }
}

const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const grade = { type: 'object', properties: Object.fromEntries(['blackpoint','whitepoint','lift','gain','multiply','offset','gamma'].map(name => [name, vector])) };
grade.properties.blackClamp = { type: 'boolean' }; grade.properties.whiteClamp = { type: 'boolean' }; grade.additionalProperties = false;
const band = { type: 'object', properties: Object.fromEntries(['saturation','contrast','gamma','gain','offset'].map(name => [name, vector])), additionalProperties: false };
const cc = { type: 'object', properties: { enabled: { type: 'boolean' }, useKeyer: { type: 'boolean' }, mix: { type: 'number', minimum: 0, maximum: 1 }, master: band, shadows: band, midtones: band, highlights: band }, additionalProperties: false };
export const parameters = {
  type: 'object', required: ['action'], additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ACTIONS }, files: { type: 'array', items: { type: 'string' }, maxItems: 64 }, reference: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } }, outputDir: { type: 'string' }, suffix: { type: 'string' },
    updates: { type: 'array', minItems: 1, maxItems: 64, items: {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, name: { type: 'string' }, grade,
        quick: { type: 'object', properties: Object.fromEntries(['mix','exp','lift','temp','cont','sat'].map(name => [name,{type:'number'}])), additionalProperties: false },
        gradeMask: { type: 'boolean' }, cc,
        keyer: { type: 'object', additionalProperties: false, properties: {
          enabled: { type: 'boolean' }, operation: { type: 'string', enum: ['luminance','red','green','blue','saturation','max','min','redscreen','greenscreen','bluescreen'] },
          range: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, invert: { type: 'boolean' }, exportAlpha: { type: 'boolean' }
        } }
      }
    } }
  }
};

export async function apply(ctx) {
  const service = new AssetColorMatch(ctx);
  ctx.effect(() => () => service.dispose());
  ctx.effect(() => ctx.commands.register({
    name: 'asset-color-match', description: '打开资产光影匹配网页；JSON 操作可读图列表、填写数值、按当前参数输出', input: { hint: '留空打开网页，或输入 JSON 操作' },
    handler: async ({ agent, rawInput, signal }) => {
      try { return { kind: 'success', text: JSON.stringify(await service.execute(rawInput.trim() ? JSON.parse(rawInput) : { action: 'open' }, agent, signal)) }; }
      catch (error) { return { kind: 'error', text: error.message }; }
    }
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'asset_color_match', parameters, timeoutMs: 90000,
    description: '资产光影匹配（Grade / Keyer / CC）。open 在默认浏览器打开本地工作台；load 载入当前 DSH 项目中的参考图和资产路径，也可由用户在网页拖图；inspect 按需读取网页当前图片列表和参数，并返回本地原图路径。必须用 DSH 内置读图工具实际查看参考与资产后，才能给出针对图片的数值；文件名或参数元数据不等于看过图。用户说“帮我填好数值”时调用 set，updates 每项用 id（优先）或唯一 name 指定资产，支持部分更新 grade/quick/keyer/cc/gradeMask，省略字段保留当前值。Grade 主调，Keyer/CC 按需启用；Keyer 选区不具备语义识别。用户说“按当前数值输出”时调用 export，由网页读取此刻参数并原尺寸渲染，再保存至项目内 outputDir（默认配色输出）；无需实时同步手调结果，也不要拿上次 set 的旧参数覆盖用户手调。仅在用户要求输出时 export，超时或报错不可盲目重试，先 inspect 查看已输出文件和当前参数。输出路径由本地插件返回，不上传到外部网站。close 停止当前会话接口。',
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const agent = exec.agent && ctx.agents.get(exec.agent.id);
      if (!agent) throw new Error('需要有效的当前 DSH 对话');
      return service.execute(args, agent, exec.signal);
    }
  }));
}
