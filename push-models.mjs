#!/usr/bin/env node
// 把转换出来的模型同步进 VOXA 本地库。
//
// 为什么需要这一步：编辑器的 Models 面板读的是 extraProjectInfo.meshAssets，
// 它来自 VOXA 服务的 /api/local/models；只把模型登记进工程 project.assets 的话，
// 场景里能正常显示（脚本/实体按 mesh/<名字>.vb 查找），但模型面板里是空的，
// 没法重新拖放。
//
// VOXA 库的 modelFileHash 必须指向「模型元数据 JSON」({version, bounds, dataHash})，
// 内容与工程 blobs 里的那份一致，所以直接复用，不重复存。
//
// 用法：
//   node push-models.mjs --project <工程目录或 boxplay 解包目录> [--map-id N]
//   node push-models.mjs --all <游玩库目录>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOXA_ROOT = process.env.VOXA_DATA_PATH
  || path.resolve(__dirname, '..', 'box3-local-engine', '.local-data', 'apps', 'voxa', 'data');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSourceRoot(target) {
  // 支持三种输入：工程目录、<项目>/source、<boxplay>/worlds/<id>
  const candidates = [
    path.join(target, 'source'),
    path.join(target, 'data'),
    target,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'project-state.json'))) return candidate;
  }
  return null;
}

// 从工程文档链里取出 assets（模型注册表）
function readProjectAssets(sourceRoot) {
  const blobRoot = path.join(sourceRoot, 'blobs');
  const state = readJson(path.join(sourceRoot, 'project-state.json'));
  const readBlob = (h) => readJson(path.join(blobRoot, h));
  const permission = readBlob(state.permissionHash);
  const versionControl = readBlob(permission.versionControl);
  const project = readBlob(versionControl.branches.master.headHash);
  return {
    blobRoot,
    state,
    assets: project.assets ? readBlob(project.assets) : {},
    displayName: project.info ? (readBlob(project.info).displayName || '') : '',
  };
}

function ensureIndex() {
  fs.mkdirSync(VOXA_ROOT, { recursive: true });
  const indexPath = path.join(VOXA_ROOT, 'models.json');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      JSON.stringify({ formatVersion: 1, nextModelId: 1, nextSnapshotId: 1, models: [], blobTypes: {}, defaultSkinByMap: {} }, null, 2),
    );
  }
  return readJson(indexPath);
}

function writeIndex(index) {
  const indexPath = path.join(VOXA_ROOT, 'models.json');
  const temporary = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index, null, 2));
  fs.renameSync(temporary, indexPath);
}

// 把工程 blobs 里的模型元数据复制进 VOXA 的 blobs（内容寻址，同名即同一份）
function mirrorBlob(blobRoot, hash) {
  const target = path.join(VOXA_ROOT, 'blobs', hash);
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(blobRoot, hash), target);
  return true;
}

function pushModels(sourceRoot, { mapId, dryRun = false } = {}) {
  const { blobRoot, assets, displayName, state } = readProjectAssets(sourceRoot);
  // mapId 决定编辑器去哪一批模型里找：必须与 launcher 的 readCloudMapId 一致，
  // 也就是 project-state.json 里的 cloudMapId。外部显式指定优先。
  if (mapId === undefined && Number.isSafeInteger(state?.cloudMapId) && state.cloudMapId > 0) {
    mapId = state.cloudMapId;
  }
  const modelEntries = Object.entries(assets).filter(
    ([, asset]) => asset && (asset.type === 2 || asset.type === 9),
  );
  if (!modelEntries.length) return { pushed: 0, skipped: 0, reason: '工程里没有模型' };

  const index = ensureIndex();
  const now = new Date().toISOString();
  let pushed = 0;
  let skipped = 0;

  for (const [key, asset] of modelEntries) {
    // 模型名取自 key：mesh/<名字>.vb 或 gltf/<名字>
    const base = key.replace(/^(mesh|gltf|model)\//, '').replace(/\.vb$/i, '');
    if (!base || !asset.hash) {
      skipped += 1;
      continue;
    }
    // 同一地图下同名模型视为同一个，避免重复追加
    const existing = index.models.find(
      (model) => model.modelName === base && model.mapId === mapId,
    );
    if (existing) {
      existing.modelFileHash = asset.hash;
      existing.fileHash = asset.hash;
      existing.updatedAt = now;
      skipped += 1;
      continue;
    }
    const modelId = index.nextModelId++;
    index.models.push({
      animated: Boolean(asset.animated),
      createdAt: now,
      creativeMode: 1,
      fileHash: asset.hash,
      modelDescription: '',
      modelFileHash: asset.hash,
      modelFileUUID: asset.hash,
      modelFileUrl: '',
      mapId,
      modelId,
      modelName: base,
      modelPreviewHash: '',
      modelPreviewUUID: '',
      modelPreviewUrl: '',
      modelType: asset.type === 9 ? 3 : 0,
      projectFileHash: asset.hash,
      projectFileUUID: asset.hash,
      projectFileUrl: '',
      updatedAt: now,
      snapshots: [],
    });
    pushed += 1;
  }

  if (!dryRun) {
    writeIndex(index);
    // 复制 blob：模型元数据 + 它引用的 dataHash
    for (const [, asset] of modelEntries) {
      if (!asset.hash) continue;
      mirrorBlob(blobRoot, asset.hash);
      try {
        const meta = readJson(path.join(blobRoot, asset.hash));
        if (meta && meta.dataHash) mirrorBlob(blobRoot, meta.dataHash);
      } catch {
        // glTF 资产不是 JSON 元数据，跳过
      }
    }
  }
  return { pushed, skipped, name: displayName, total: modelEntries.length, mapId };
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mapIdFlag = args.indexOf('--map-id');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

let targets = [];
if (args[0] === '--all') {
  const root = args[1];
  targets = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name));
} else {
  const projectArg = argValue('--project');
  if (projectArg) targets = [projectArg];
}
if (!targets.length) {
  console.error('用法：node push-models.mjs --project <目录> [--map-id N] [--dry-run]');
  console.error('      node push-models.mjs --all <游玩库目录> [--dry-run]');
  process.exit(2);
}

let failed = 0;
for (const target of targets) {
  const sourceRoot = resolveSourceRoot(target);
  if (!sourceRoot) continue;
  const name = path.basename(target);
  try {
    // mapId 优先用命令行指定，否则尝试从 meta 目录读 mapId.txt
    let mapId = mapIdFlag >= 0 ? Number(args[mapIdFlag + 1]) : undefined;
    if (mapId === undefined) {
      const metaFile = path.join(target, 'meta', 'mapId.txt');
      if (fs.existsSync(metaFile)) {
        const parsed = Number(fs.readFileSync(metaFile, 'utf8').trim());
        if (Number.isFinite(parsed)) mapId = parsed;
      }
    }
    const result = pushModels(sourceRoot, { mapId, dryRun });
    if (result.reason) {
      console.log(`- ${name}: ${result.reason}`);
    } else {
      console.log(
        `${dryRun ? '◌' : '✓'} ${name}（${result.name || '未命名'}）: 新增 ${result.pushed} · 跳过 ${result.skipped} · 共 ${result.total}` +
          (mapId !== undefined ? ` · mapId=${mapId}` : ''),
      );
    }
  } catch (error) {
    failed += 1;
    console.log(`✗ ${name}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
