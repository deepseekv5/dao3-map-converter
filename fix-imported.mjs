#!/usr/bin/env node
// 把已导入的工程升级到当前转换器产出的格式（就地修复，纯增量）。
//
// 处理两类历史问题：
//   1) 缺引擎运行时资源 → 编辑运行时启动即崩（Runtime assets are incomplete）
//   2) pictureAssets 用了旧形状 {metadataHash,hash,width,height} 且 hash 指向 PNG
//      原图 → bake 阶段 JSON.parse(PNG) 崩溃，编辑器卡在 Start container
//
// pictureAssets 迁移会重建整条文档链（project → versionControl → permission），
// 因为 RDA 文档是内容寻址的：改了 project 就必须重算所有上层 hash。
//
// 用法：
//   node fix-imported.mjs --all <projects-root>
//   node fix-imported.mjs <project-dir>...
//   node fix-imported.mjs --all <projects-root> --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { contentHash, stableStringify } from './lib/qm.mjs';
import { probeImageSize } from './lib/image-size.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = process.env.DAO3_ENGINE_ROOT
  || path.resolve(__dirname, '..', 'box3-local-engine');

const REQUIRED_CLIENT_ASSET = 'QmUQg6ayL7bLmdso8b4Hc7nfxBUSJawPsQ7vsSUPhXNdv5';
const EMPTY_HASH = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n';
const PICTURE_TYPE = 8;

// 运行时 blob 来源：旁边有内核就用官方 runtimeBlobHashes 现算闭包（跟随内核
// 版本，最准）；否则用转换器自带的 runtime/。与 convert.mjs 保持同一策略，
// 这样单独分发转换器时 fix-imported.mjs 也能用。
function resolveRuntimeBlobs() {
  if (fs.existsSync(path.join(ENGINE_ROOT, 'apps', 'local-engine', 'data', 'blobs'))) {
    try {
      const { runtimeBlobHashes } = require(
        path.join(ENGINE_ROOT, 'apps', 'local-engine', 'src', 'runtime-assets.js'),
      );
      return {
        blobRoot: path.join(ENGINE_ROOT, 'apps', 'local-engine', 'data', 'blobs'),
        hashes: [...runtimeBlobHashes(ENGINE_ROOT)].sort(),
      };
    } catch {}
  }
  const blobRoot = path.join(__dirname, 'runtime', 'blobs');
  const manifest = path.join(__dirname, 'runtime', 'runtime-blobs.json');
  if (fs.existsSync(blobRoot) && fs.existsSync(manifest)) {
    try {
      const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (Array.isArray(list.hashes) && list.hashes.length) {
        return { blobRoot, hashes: [...list.hashes].sort() };
      }
    } catch {}
  }
  throw new Error('既找不到内核模板库，也没有内置 runtime/（可设 DAO3_ENGINE_ROOT）');
}

function copyIfMissing(source, target) {
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'w', 0o644);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const sourceFd = fs.openSync(source, 'r');
    try {
      let read = 0;
      while ((read = fs.readSync(sourceFd, buffer)) > 0) {
        fs.writeSync(fd, buffer, 0, read);
      }
    } finally {
      fs.closeSync(sourceFd);
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function writeBlob(blobRoot, bytes) {
  const hash = contentHash(bytes);
  const target = path.join(blobRoot, hash);
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { mode: 0o644 });
  return hash;
}

function writeJSONBlob(blobRoot, value) {
  return writeBlob(blobRoot, Buffer.from(stableStringify(value), 'utf8'));
}

// 图片魔数检测：不能只看 PNG——包里还有 JPEG/WebP/GIF/BMP。
// 之前只判 PNG，导致 JPEG 被当成「非 JSON」跳过，迁移后仍是坏引用。
function looksLikeImage(bytes) {
  if (bytes.length < 12) return false;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true; // PNG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
  if (bytes.toString('latin1', 0, 3) === 'GIF') return true; // GIF
  if (bytes.toString('latin1', 0, 2) === 'BM') return true; // BMP
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return true;
  return false;
}

// 把一条 pictureAssets 从旧形状升级成 GroupAssetEntryRDA 形状。
// 旧形状有三种历史变体，都要归一化：
//   a) { metadataHash, hash: <png>, width, height }  ← 最早的 hot 形状
//   b) { metadataHash, hash: <元数据JSON>, ... }       ← 半迁移残留
//   c) 直接是 <png hash> 字符串
// 新形状: { id, updateAt, type: 8, hash: <元数据JSON>, size, previewImage }
// 关键是必须重建整条记录：保留 metadataHash 之类旧字段会让它既非新形状也不可解析。
function upgradePictureEntry(blobRoot, key, entry) {
  const candidate = entry && typeof entry === 'object' ? entry.hash : entry;
  if (typeof candidate !== 'string' || !candidate) return null;
  const candidatePath = path.join(blobRoot, candidate);
  if (!fs.existsSync(candidatePath)) return null;
  const bytes = fs.readFileSync(candidatePath);

  // 已是元数据 JSON：取出真正的图片 hash，重建标准形状
  if (!looksLikeImage(bytes)) {
    try {
      const meta = JSON.parse(bytes.toString('utf8'));
      if (meta && meta.hash && meta.width && meta.height && fs.existsSync(path.join(blobRoot, meta.hash))) {
        return {
          id: '',
          updateAt: 0,
          type: PICTURE_TYPE,
          hash: candidate,
          size: entry && typeof entry === 'object' ? Number(entry.size) || 0 : 0,
          previewImage: '',
        };
      }
    } catch {}
    return null;
  }

  // 是图片原图：生成元数据文档，记录指向它
  const { width, height } = probeImageSize(bytes, key);
  const metadataHash = writeBlob(
    blobRoot,
    Buffer.from(JSON.stringify({ hash: candidate, width, height }), 'utf8'),
  );
  return {
    id: '',
    updateAt: 0,
    type: PICTURE_TYPE,
    hash: metadataHash,
    size: bytes.length,
    previewImage: '',
  };
}

function fixProject(projectDir, { dryRun = false } = {}) {
  const sourceRoot = fs.existsSync(path.join(projectDir, 'source'))
    ? path.join(projectDir, 'source')
    : projectDir;
  const blobRoot = path.join(sourceRoot, 'blobs');
  const name = path.basename(projectDir);
  if (!fs.existsSync(blobRoot)) {
    return { name, skipped: '缺少 source/blobs' };
  }
  const report = { name, runtimeBlobs: 0, picturesUpgraded: 0, picturesKept: 0, chainRebuilt: false };

  // ---- 1) 运行时资源 ----
  const { blobRoot: runtimeSource, hashes } = resolveRuntimeBlobs();
  for (const hash of hashes) {
    const source = path.join(runtimeSource, hash);
    const target = path.join(blobRoot, hash);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    if (!dryRun) copyIfMissing(source, target);
    report.runtimeBlobs += 1;
  }
  if (!dryRun) {
    copyIfMissing('/dev/null', path.join(blobRoot, EMPTY_HASH));
    fs.writeFileSync(
      path.join(sourceRoot, 'runtime-blobs.json'),
      `${JSON.stringify({ formatVersion: 1, hashes }, null, 2)}\n`,
      { mode: 0o644 },
    );
  }

  // ---- 2) 读文档链 ----
  const statePath = path.join(sourceRoot, 'project-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state.extraProjectHash && !dryRun) {
    state.extraProjectHash = EMPTY_HASH;
    state.extraProjectMode = '';
  }
  // cloudMapId：编辑器按它向 VOXA 查模型。老转换器没写这个字段，模型面板因此
  // 永远是空的。能从工程旁边的 meta/mapId.txt 找到就补上。
  if (state.cloudMapId === undefined) {
    const mapIdFile = path.join(projectDir, 'meta', 'mapId.txt');
    const mapIdText = fs.existsSync(mapIdFile)
      ? fs.readFileSync(mapIdFile, 'utf8').trim()
      : '';
    if (/^\d+$/.test(mapIdText)) {
      state.cloudMapId = Number(mapIdText);
      report.cloudMapId = state.cloudMapId;
    }
  }
  const readBlobJson = (hash) => JSON.parse(fs.readFileSync(path.join(blobRoot, hash), 'utf8'));
  const perm = readBlobJson(state.permissionHash);
  const vc = readBlobJson(perm.versionControl);
  const projectHash = vc.branches.master.headHash;
  const project = readBlobJson(projectHash);
  const pictures = project.pictureAssets ? readBlobJson(project.pictureAssets) : {};

  // ---- 3) 升级 pictureAssets ----
  const upgraded = {};
  let changed = false;
  for (const [key, entry] of Object.entries(pictures)) {
    const next = upgradePictureEntry(blobRoot, key, entry);
    if (!next) {
      upgraded[key] = entry;
      report.picturesKept += 1;
      continue;
    }
    // 判据是整条记录形状一致，而不是只看 hash——旧记录可能带着 metadataHash 等
    // 残留字段，字段集不同就必须重建。
    const normalized =
      entry && typeof entry === 'object'
        ? {
            id: entry.id || '',
            updateAt: entry.updateAt || 0,
            type: entry.type,
            hash: entry.hash,
            size: entry.size || 0,
            previewImage: entry.previewImage || '',
          }
        : null;
    const sameShape =
      normalized && stableStringify(normalized) === stableStringify(next);
    if (sameShape) {
      upgraded[key] = entry;
      report.picturesKept += 1;
      continue;
    }
    upgraded[key] = next;
    report.picturesUpgraded += 1;
    changed = true;
  }

  if (!changed) {
    if (!dryRun) fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
    return report;
  }
  if (dryRun) return report;

  // ---- 4) 重建文档链（内容寻址，改 project 必须重算上层）----
  const newPicturesHash = writeJSONBlob(blobRoot, upgraded);
  const newProject = { ...project, pictureAssets: newPicturesHash };
  const newProjectHash = writeJSONBlob(blobRoot, newProject);
  const newVc = {
    ...vc,
    branches: {
      ...vc.branches,
      master: { ...vc.branches.master, headHash: newProjectHash },
    },
  };
  const newVcHash = writeJSONBlob(blobRoot, newVc);
  const newPerm = { ...perm, versionControl: newVcHash };
  const newPermHash = writeJSONBlob(blobRoot, newPerm);
  state.permissionHash = newPermHash;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  report.chainRebuilt = true;

  // 编辑运行时缓存了旧的 prebake 结果，清掉让它重建
  const buildCache = path.join(sourceRoot, 'build-cache.json');
  if (fs.existsSync(buildCache)) fs.rmSync(buildCache, { force: true });
  report.cacheCleared = true;
  return report;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filtered = args.filter((a) => a !== '--dry-run');
let targets = [];
if (filtered[0] === '--all') {
  const root = filtered[1];
  targets = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'source', 'project-state.json')));
} else {
  targets = filtered;
}
if (!targets.length) {
  console.error('用法：node fix-imported.mjs --all <projects-root> [--dry-run]');
  process.exit(2);
}
for (const target of targets) {
  const label = path.basename(target);
  try {
    const r = fixProject(target, { dryRun });
    if (r.skipped) {
      console.log(`- ${r.name}: ${r.skipped}`);
      continue;
    }
    const bits = [];
    if (r.runtimeBlobs) bits.push(`补运行时 ${r.runtimeBlobs}`);
    if (r.picturesUpgraded) bits.push(`升级图片 ${r.picturesUpgraded}`);
    if (r.picturesKept) bits.push(`已是新形状 ${r.picturesKept}`);
    if (r.chainRebuilt) bits.push('重建文档链');
    if (r.cacheCleared) bits.push('清缓存');
    console.log(`${dryRun ? '◌' : '✓'} ${r.name}: ${bits.join(' · ') || '无需改动'}`);
  } catch (error) {
    console.log(`✗ ${label}: ${error.message}`);
  }
}
