(() => {
  'use strict';
  const api = window.assetColorMatch;
  const token = location.hash.slice(1) || sessionStorage.getItem('dsh-color-token');
  const badge = document.createElement('span');
  badge.className = 'cs-pill'; badge.textContent = 'DSH 正在连接';
  document.querySelector('.brand').appendChild(badge);
  if (!api || !token) { badge.textContent = '请从 DSH 打开工作台'; return; }
  sessionStorage.setItem('dsh-color-token', token);
  history.replaceState(null, '', location.pathname);
  let clientId = sessionStorage.getItem('dsh-color-client');
  if (!clientId) { clientId = crypto.randomUUID(); sessionStorage.setItem('dsh-color-client', clientId); }

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { Authorization: 'Bearer ' + token, 'X-Client-ID': clientId, ...(options.headers || {}) } });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ error: '本地连接失败：' + response.status }));
      const error = new Error(failure.error); error.status = response.status; throw error;
    }
    return response;
  }
  const postJson = async (path, body) => (await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  async function snapshot() {
    const current = api.snapshot();
    const originals = api.sources();
    for (const source of originals) {
      if (!source.file) throw new Error('找不到原始图片，请在网页重新载入：' + source.id);
      if (!source.file.dshSourceId) {
        const value = await (await request('/api/source?name=' + encodeURIComponent(source.file.name), {
          method: 'POST', headers: { 'Content-Type': source.file.type || 'image/png' }, body: source.file
        })).json();
        source.file.dshSourceId = value.id;
      }
      const metadata = source.id === 'reference' ? current.reference : current.assets.find(asset => asset.id === source.id);
      if (metadata) metadata.sourceId = source.file.dshSourceId;
    }
    return current;
  }

  async function sourceFile(source) {
    const blob = await (await request('/api/source/' + source.id)).blob();
    const file = new File([blob], source.name, { type: source.mediaType });
    file.dshSourceId = source.id;
    return file;
  }

  async function execute(command) {
    if (command.action === 'snapshot') return snapshot();
    if (command.action === 'load') {
      const files = [];
      for (const source of command.payload.assets) files.push(await sourceFile(source));
      const reference = command.payload.reference ? await sourceFile(command.payload.reference) : undefined;
      await api.load(files, reference);
      return snapshot();
    }
    if (command.action === 'set') { api.setParameters(command.payload.updates); return snapshot(); }
    if (command.action === 'export') {
      const current = await snapshot();
      const ids = command.payload.ids === undefined ? current.assets.map(asset => asset.id) : command.payload.ids;
      const files = [], parametersUsed = [];
      for await (const output of api.renderExports(ids, command.payload.suffix)) {
        const path = '/api/export?commandId=' + encodeURIComponent(command.id) + '&assetId=' + encodeURIComponent(output.id) + '&name=' + encodeURIComponent(output.name);
        files.push(await (await request(path, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: output.blob })).json());
        parametersUsed.push(output.parameters);
      }
      return { files, parametersUsed };
    }
    throw new Error('未知网页指令：' + command.action);
  }

  async function connect() {
    const info = await postJson('/api/connect', {});
    badge.textContent = 'DSH 已连接';
    const picker = document.getElementById('btnPickDir');
    picker.textContent = '输出到项目目录'; picker.disabled = true;
    picker.title = info.outputDirectory;
    const directory = document.getElementById('dirPill');
    directory.textContent = '插件输出目录：' + info.outputDirectory; directory.classList.add('show');
    window.dshColorMatch = {
      async saveBlob(blob, filename) {
        const response = await request('/api/manual-export?name=' + encodeURIComponent(filename), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
        return response.json();
      }
    };
    while (true) {
      let command;
      try {
        command = await (await request('/api/next')).json();
        if (!command) continue;
        let result;
        try { result = { id: command.id, value: await execute(command) }; }
        catch (error) { result = { id: command.id, error: error.message }; }
        // A write or render is never automatically replayed after a lost acknowledgement.
        await postJson('/api/result', result);
        badge.textContent = result.error ? 'DSH 指令失败，可查看对话' : 'DSH 已连接';
      } catch (error) {
        badge.textContent = 'DSH 连接中断，参数保留在网页';
        if (error.status === 409 || error.status === 401) return;
        await new Promise(accept => setTimeout(accept, 1500));
      }
    }
  }
  connect().catch(error => { badge.textContent = error.message; });
})();
