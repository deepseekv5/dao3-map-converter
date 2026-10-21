// 网页版界面逻辑：拖拽 → 转换 → 下载，全程在主线程之外的异步流程里。
import { convertZip, buildBoxProject, buildBoxPlay, findOfficialProjects } from './convert-browser.mjs';
import { readZip } from './lib-browser.mjs';

const $ = (id) => document.getElementById(id);
const queue = [];
let externalEntities = null;

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const fmtNum = (v) => Number(v || 0).toLocaleString('zh-CN');

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
      item.status === 'running' ? '<span class="pill run">转换中</span>'
        : item.status === 'ok' ? '<span class="pill ok">完成</span>'
          : item.status === 'error' ? '<span class="pill err">失败</span>'
            : '<span class="pill">等待</span>';

    let sub = '';
    if (item.status === 'running') sub = `${item.step || '处理中'} ${item.percent || 0}%`;
    else if (item.status === 'error') sub = item.error;
    else if (item.status === 'ok') {
      const r = item.result;
      const parts = [
        `${r.shape.x}×${r.shape.y}×${r.shape.z}`,
        `体素 ${fmtNum(r.voxelCount)}`,
      ];
      if (r.scriptNames.length) parts.push(`脚本 ${r.scriptNames.length}`);
      if (r.meshCount) parts.push(`模型 ${r.meshCount}`);
      if (r.pictureCount) parts.push(`图片 ${r.pictureCount}`);
      if (r.audioCount) parts.push(`音频 ${r.audioCount}`);
      parts.push(`资源 ${fmtNum(r.blobsCount)}`);
      sub = parts.join(' · ');
    } else sub = fmtSize(item.size);

    // 实体数从实体树里数出来
    let entityLine = '';
    if (item.status === 'ok' && item.entityCount) {
      entityLine = `<div class="row-sub">场景实体 ${fmtNum(item.entityCount)} 个</div>`;
    }

    const bar = item.status === 'running'
      ? `<div class="bar"><div class="bar-fill" style="width:${item.percent || 0}%"></div></div>`
      : '';
    const warn = item.status === 'ok' && item.result.warnings.length
      ? `<div class="row-warn">${item.result.warnings.slice(0, 6).map(escapeHtml).map((w) => `· ${w}`).join('<br />')}</div>`
      : '';
    const actions = item.status === 'ok'
      ? `<button class="btn small primary" data-dl="project">工程包</button>
         <button class="btn small" data-dl="play">游玩包</button>`
      : '';

    row.innerHTML = `
      <div class="row-main">
        <div class="row-name">${escapeHtml(item.file.name)}</div>
        <div class="row-sub">${escapeHtml(sub)}</div>
        ${entityLine}${bar}${warn}
      </div>
      <div class="row-actions">${pill}${actions}</div>`;

    const projBtn = row.querySelector('[data-dl="project"]');
    if (projBtn) projBtn.addEventListener('click', () => download(item.projectBlob, item.projectName));
    const playBtn = row.querySelector('[data-dl="play"]');
    if (playBtn) playBtn.addEventListener('click', () => download(item.playBlob, item.playName));

    list.appendChild(row);
  }
}

async function processOne(item) {
  item.status = 'running';
  item.percent = 0;
  renderQueue();

  const onProgress = (percent, step) => {
    item.percent = Math.min(99, Math.round(percent));
    item.step = step;
    renderQueue();
  };

  try {
    const result = await convertZip(item.file, {
      onProgress,
      entitiesTree: externalEntities || undefined,
    });
    item.result = result;

    onProgress(90, '打包工程包');
    const project = await buildBoxProject(result, onProgress);
    item.projectBlob = project.blob;
    item.projectName = project.filename;

    onProgress(96, '打包游玩包');
    const play = await buildBoxPlay(result, onProgress);
    item.playBlob = play.blob;
    item.playName = play.filename;

    item.entityCount = result.entityCount || 0;
    item.status = 'ok';
    item.percent = 100;
    toast(`已转换 ${result.displayName}`, 'ok');
  } catch (error) {
    item.status = 'error';
    item.error = error.message;
    toast(`转换失败：${error.message}`, 'err');
  } finally {
    renderQueue();
  }
}

function enqueue(files) {
  const zips = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.zip'));
  if (!zips.length) {
    toast('只支持 .zip 文件', 'err');
    return;
  }
  for (const file of zips) queue.push({ file, size: file.size, status: 'pending' });
  renderQueue();
  (async () => {
    for (const item of queue) {
      if (item.status !== 'pending') continue;
      await processOne(item);
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
['dragenter', 'dragover'].forEach((n) => dz.addEventListener(n, (e) => {
  e.preventDefault();
  dz.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((n) => dz.addEventListener(n, (e) => {
  e.preventDefault();
  dz.classList.remove('dragover');
}));
dz.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) enqueue(e.dataTransfer.files);
});

// 实体树选择
$('entitiesBtn').addEventListener('click', () => $('entitiesInput').click());
$('entitiesInput').addEventListener('change', async () => {
  const f = $('entitiesInput').files[0];
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    const nodes = Object.values(parsed).filter((n) => n && n.type === 1);
    externalEntities = parsed;
    $('entitiesHint').textContent = `已加载：${nodes.length} 个实体`;
    toast(`实体树已加载（${nodes.length} 个实体）`, 'ok');
  } catch (error) {
    toast(`实体树解析失败：${error.message}`, 'err');
  }
});

// 启动时探测引擎资源是否就位
(async () => {
  try {
    const res = await fetch('./runtime/runtime-blobs.json');
    if (res.ok) {
      const m = await res.json();
      $('engineBadge').textContent = `引擎资源就绪 · ${m.hashes?.length ?? 0} 个`;
      $('engineBadge').classList.add('ok');
    } else {
      $('engineBadge').textContent = '引擎资源缺失（产物可能无法在创作端打开）';
      $('engineBadge').classList.add('warn');
    }
  } catch {
    $('engineBadge').textContent = '引擎资源不可用';
    $('engineBadge').classList.add('warn');
  }
})();
