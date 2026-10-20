const $ = (id) => document.getElementById(id);
const queue = [];

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function timeAgo(ms) {
  const delta = Date.now() - ms;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 4200);
}

function renderQueue() {
  const wrap = $('queue');
  wrap.hidden = queue.length === 0;
  $('queueCount').textContent = `${queue.length} 个`;
  const list = $('queueList');
  list.innerHTML = '';
  for (const item of queue) {
    const row = document.createElement('div');
    row.className = 'row';
    const pill =
      item.status === 'running' ? '<span class="pill run">转换中…</span>'
        : item.status === 'ok' ? '<span class="pill ok">完成</span>'
          : item.status === 'error' ? '<span class="pill err">失败</span>'
            : '<span class="pill">等待中</span>';
    let sub;
    if (item.status === 'ok') {
      const list = item.results || [];
      const first = list[0] || {};
      const totalSize = list.reduce((sum, r) => sum + (r.size || 0), 0);
      const parts = [];
      if (item.isGroup) parts.push(`地图组 ${list.length} 张`);
      parts.push(`${first.mapSize?.x}×${first.mapSize?.y}×${first.mapSize?.z}`);
      parts.push(`体素 ${fmtNum(list.reduce((s, r) => s + (r.voxelCount || 0), 0))}`);
      const scripts = list.reduce((s, r) => s + (r.scripts?.length || 0), 0);
      if (scripts) parts.push(`脚本 ${scripts}`);
      const pictures = list.reduce((s, r) => s + (r.pictureCount || 0), 0);
      if (pictures) parts.push(`图片 ${pictures}`);
      const gltf = list.reduce((s, r) => s + (r.gltfCount || 0), 0);
      if (gltf) parts.push(`glTF ${gltf}`);
      const audio = list.reduce((s, r) => s + (r.audioCount || 0), 0);
      if (audio) parts.push(`音频 ${audio}`);
      parts.push(`产出 ${fmtSize(totalSize)}`);
      sub = parts.join(' · ');
    } else if (item.status === 'error') {
      sub = item.error;
    } else if (item.status === 'running') {
      sub = `上传/转换中 ${item.progress}% · ${fmtSize(item.size)}`;
    } else {
      sub = `${fmtSize(item.size)} · ${item.file.name}`;
    }
    const bar = item.status === 'running'
      ? `<div class="bar"><div class="bar-fill" style="width:${item.progress}%"></div></div>`
      : '';
    const warnings = item.status === 'ok'
      ? (item.results || []).flatMap((r) => r.warnings || [])
      : [];
    const warn = warnings.length
      ? `<div class="row-warn">${warnings.map(escapeHtml).map((w) => `· ${w}`).join('<br />')}</div>`
      : '';
    // 地图组：每个产出各一个下载按钮；单包：一个
    const downloads = item.status === 'ok'
      ? (item.results || []).map((r) => {
          const label = item.isGroup ? escapeHtml(r.name) : '';
          const projectBtn = `<a class="btn small primary" href="${r.download}" title="工程包（创作端可导入编辑）：${escapeHtml(r.name)}">${label || '工程'}</a>`;
          const playBtn = r.play
            ? `<a class="btn small" href="${r.play.download}" title="游玩包（放进游玩库即可运行）：${escapeHtml(r.play.filename)}">${label ? label + '·游玩' : '游玩'}</a>`
            : '';
          return projectBtn + playBtn;
        }).join('')
      : '';
    row.innerHTML = `
      <div class="row-main">
        <div class="row-name">${escapeHtml(item.file.name)}</div>
        <div class="row-sub">${escapeHtml(sub)}</div>
        ${bar}
        ${warn}
      </div>
      <div class="row-actions">
        ${pill}
        ${downloads}
      </div>`;
    list.appendChild(row);
  }
}

async function loadOutputs() {
  try {
    const res = await fetch('/api/outputs');
    const data = await res.json();
    $('outputCount').textContent = `${data.outputs.length} 个`;
    const list = $('outputList');
    if (!data.outputs.length) {
      list.innerHTML = '<div class="empty">还没有产出。拖入一个 zip 开始。</div>';
      return;
    }
    list.innerHTML = '';
    for (const out of data.outputs) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="row-main">
          <div class="row-name">${escapeHtml(out.name)}</div>
          <div class="row-sub">${fmtSize(out.size)} · ${timeAgo(out.mtime)}</div>
        </div>
        <div class="row-actions">
          <a class="btn small primary" href="/download/${encodeURIComponent(out.name)}">下载</a>
        </div>`;
      list.appendChild(row);
    }
  } catch (error) {
    toast(`读取产出列表失败：${error.message}`, 'err');
  }
}

async function convertOne(item) {
  item.status = 'running';
  item.progress = 0;
  renderQueue();
  const form = new FormData();
  form.append('zip', item.file, item.file.name);
  try {
    // XMLHttpRequest 而不是 fetch：上传大包时能拿到真实进度
    const outcome = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/convert');
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        item.progress = Math.round((event.loaded / event.total) * 70);
        renderQueue();
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch {
          payload = { error: `HTTP ${xhr.status}` };
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload.ok) resolve(payload);
        else reject(new Error(payload.error || `HTTP ${xhr.status}`));
      });
      xhr.addEventListener('error', () => reject(new Error('网络错误')));
      xhr.addEventListener('abort', () => reject(new Error('已取消')));
      xhr.send(form);
    });
    item.status = 'ok';
    // 统一成 results 数组：单包长度 1，地图组多个。兼容旧响应（无 results 时用顶层字段）
    item.results = Array.isArray(outcome.results) && outcome.results.length
      ? outcome.results
      : [outcome];
    item.isGroup = !!outcome.isGroup;
    toast(item.isGroup ? `已转换 ${item.results.length} 个地图` : `已转换 ${outcome.name}`, 'ok');
  } catch (error) {
    item.status = 'error';
    item.error = error.message;
    toast(`转换失败 ${item.file.name}：${error.message}`, 'err');
  } finally {
    renderQueue();
    loadOutputs();
  }
}

function enqueue(files) {
  const zips = Array.from(files).filter((file) => file.name.toLowerCase().endsWith('.zip'));
  if (!zips.length) {
    toast('只支持 .zip 文件', 'err');
    return;
  }
  for (const file of zips) {
    queue.push({ file, size: file.size, status: 'pending' });
  }
  renderQueue();
  // 串行转换：单个包可能很大，并行会同时占满内存与磁盘
  (async () => {
    for (const item of queue) {
      if (item.status !== 'pending') continue;
      // eslint-disable-next-line no-await-in-loop
      await convertOne(item);
    }
  })();
}

const dz = $('dropzone');
const input = $('fileInput');
dz.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  enqueue(input.files);
  input.value = '';
});
['dragenter', 'dragover'].forEach((name) =>
  dz.addEventListener(name, (event) => {
    event.preventDefault();
    dz.classList.add('dragover');
  }),
);
['dragleave', 'drop'].forEach((name) =>
  dz.addEventListener(name, (event) => {
    event.preventDefault();
    dz.classList.remove('dragover');
  }),
);
dz.addEventListener('drop', (event) => {
  if (event.dataTransfer?.files?.length) enqueue(event.dataTransfer.files);
});

$('reveal').addEventListener('click', async () => {
  try {
    await fetch('/api/reveal', { method: 'POST' });
  } catch (error) {
    toast(error.message, 'err');
  }
});

loadOutputs();
