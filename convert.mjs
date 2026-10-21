// 神岛/DAO3 导出 zip → 官方可导入的 .boxproject（tar.gz）
//
// 产物格式与 apps/local-engine/src/project-manager.js 的 importProject() 逐字段对齐：
//   group.json                     { formatVersion:2, type:'map-group', mapGroupId, mainProjectId, exportedProjectId, members[] }
//   projects/<id>/project.json     { formatVersion:1, id, permanentMapId, publicId, name, description, author, cover,
//                                    loadingCover, theme, createdAt, updatedAt, releases, mapGroupId, mapRole, mainProjectId }
//   projects/<id>/source/blobs/*   内容寻址 blob，文件名 = base58(0x1220||sha256(content))
//   projects/<id>/source/project-state.json  { formatVersion:1, permissionHash }
//   projects/<id>/group-state.json          主地图的地图组状态
//
// 引擎导入时只校验 source/ 内部自洽（validateProjectSource）与 group.json 形状，
// project.json 的 permanentMapId / publicId / id 会由引擎重新生成，这里只占位。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { contentHash, stableStringify } from './lib/qm.mjs';
import { probeImageSize, isRealImage } from './lib/image-size.mjs';
import { parseGltfBounds, inspectGltf } from './lib/gltf.mjs';
import { parseVox, buildVbFileData } from './lib/vox-to-vb.mjs';
import { boxCompress, meshChunkToBoxes, packBlock, CHUNK_SIZE, EMPTY_CHUNK_BYTES } from './lib/box-encode.mjs';

// ---------- 引擎运行时资源 ----------

// 转换器自带一份引擎运行时 blob（runtime/blobs + runtime/runtime-blobs.json）。
// 这样单独分发转换器也能产出可编辑的工程：编辑运行时以项目 source/ 为数据根
// 启动，launcher.js 会校验引擎的客户端脚本包（QmUQg6ay... 硬编码在
// requiredClientAsset）必须已在项目 blobs 里，缺了编辑器容器反复崩溃（503）。
// 官方空白工程由 createProject → copyRuntimeData 灌入，云端导出的作品天然带着；
// 老 zip 转换包没有，必须自己补。
//
// 若旁边有 box3-local-engine 内核，则用官方 runtimeBlobHashes 现算闭包（更准，
// 跟随内核版本）；否则用内置清单。
function bundledRuntimeBlobs() {
  const root = path.resolve(import.meta.dirname ?? '.', 'runtime');
  const blobRoot = path.join(root, 'blobs');
  const manifest = path.join(root, 'runtime-blobs.json');
  if (!fs.existsSync(blobRoot) || !fs.existsSync(manifest)) return null;
  try {
    const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const hashes = Array.isArray(list.hashes) ? list.hashes : [];
    if (!hashes.length) return null;
    return { blobRoot, hashes: [...hashes].sort(), mode: 'bundled' };
  } catch {
    return null;
  }
}

// 内核仓库位置：转换器与内核同仓（../box3-local-engine），也可用环境变量指到别处
function findEngineRoot() {
  const candidates = [
    process.env.DAO3_ENGINE_ROOT,
    path.resolve(import.meta.dirname ?? '.', '..', 'box3-local-engine'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const marker = path.join(candidate, 'apps', 'local-engine', 'data', 'blobs');
    if (fs.existsSync(marker)) return candidate;
  }
  return null;
}

// 把编辑运行时必需的引擎 blob 复制进 <sourceRoot>/blobs/。
function copyEngineRuntimeBlobs(sourceRoot) {
  const outputBlobRoot = path.join(sourceRoot, 'blobs');
  fs.mkdirSync(outputBlobRoot, { recursive: true });

  // 优先用内核现算的引用闭包（跟随内核版本，最准）
  const engineRoot = findEngineRoot();
  let hashes = [];
  let mode = 'bundled';
  let blobSource = null;
  if (engineRoot) {
    try {
      // 官方模块是 CommonJS；转换器是 ESM，用 createRequire 桥接。
      const require = createRequire(import.meta.url);
      const { runtimeBlobHashes } = require(
        path.join(engineRoot, 'apps', 'local-engine', 'src', 'runtime-assets.js'),
      );
      hashes = [...runtimeBlobHashes(engineRoot)].sort();
      blobSource = path.join(engineRoot, 'apps', 'local-engine', 'data', 'blobs');
      mode = 'closure';
    } catch {
      hashes = [];
    }
  }

  // 回退到内置清单
  if (!hashes.length) {
    const bundled = bundledRuntimeBlobs();
    if (!bundled) {
      return { count: 0, hashes: [], note: '未内置运行时资源且找不到内核（设 DAO3_ENGINE_ROOT），产出的工程编辑器可能打不开' };
    }
    hashes = bundled.hashes;
    blobSource = bundled.blobRoot;
    mode = 'bundled';
  }

  let copied = 0;
  for (const hash of hashes) {
    const target = path.join(outputBlobRoot, hash);
    if (fs.existsSync(target)) continue; // 地图自己的同名 blob 优先
    try {
      fs.copyFileSync(path.join(blobSource, hash), target);
      fs.chmodSync(target, 0o644);
      copied += 1;
    } catch {}
  }
  return { count: copied, hashes, mode };
}

// 官方 ProjectRDA / PermissionRDA 的常量字段：缺失时运行时会认不出文档类型
const DEFAULTS = JSON.parse(fs.readFileSync(new URL('./lib/defaults.json', import.meta.url), 'utf8'));

const PROJECT_VERSION = '0.3.31';
const PERMISSION_VERSION = '0.1.8';
const DEFAULT_SCREEN_ID = 'DEFAULT_SCREEN_ID';

const DEFAULT_UI_TREE = {
  ROOT_ID: { childrenIds: [DEFAULT_SCREEN_ID], id: 'ROOT_ID', name: 'Root', parentId: '', type: 0 },
  [DEFAULT_SCREEN_ID]: {
    childrenIds: [],
    id: DEFAULT_SCREEN_ID,
    name: 'screen',
    parentId: 'ROOT_ID',
    type: 2,
    value: { data: { enable: true, layout: { data: null, type: 'none' } }, type: 'screen' },
  },
};

const LUT_NAMES = new Set([
  'bleachbypass', 'candlelight', 'coolcontrast', 'desaturatedfog', 'evening', 'fall',
  'filmic', 'filmic2', 'filmic3', 'filmic4', 'flashback', 'foggy', 'warmcontrast',
  'sunset', 'moonlight', 'night', 'noir', 'spring', 'summer', 'winter',
]);

// ---------- zip 读取 ----------

function decodeEntryName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {}
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {}
  return Buffer.from(bytes).toString('latin1');
}

export function readZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const rawSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLen);
    const name = flags & 0x800 ? rawName.toString('utf8') : decodeEntryName(rawName);
    const directory = name.endsWith('/');
    let data = null;
    if (!directory) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = buffer.subarray(dataStart, dataStart + compSize);
      if (method === 0) data = Buffer.from(compressed);
      else if (method === 8) data = zlib.inflateRawSync(compressed);
      else throw new Error(`zip 条目不支持的压缩方式 ${method}: ${name}`);
    }
    entries.push({ name, dir: directory, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- ID ----------

// 官方 projectIdPattern: /^[a-z0-9][a-z0-9-]{0,62}$/ —— 只接受小写字母数字连字符。
// 纯中文名 NFKD 后会变成空串，此时退化为 map-<hash6>；引擎导入时会再分配自己的 ID，
// 所以这里只求稳定可读、不重复。
function slugId(input, fallbackSeed) {
  const ascii = (input || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const base = ascii || 'map';
  return `${base}-${crypto.createHash('sha1').update(String(fallbackSeed)).digest('hex').slice(0, 6)}`;
}

// 官方 projectIdPattern: /^[a-z0-9][a-z0-9-]{0,62}$/
function assertOfficialId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`生成的工程 ID 不符合官方规则：${id}`);
  return id;
}

// ---------- 实体树 ----------

// entities.json 是扁平字典 {实体ID: {name, position, mesh, bounds, ...}}，字段与
// 引擎 EntitySeedRDA 一一对应。工程文档要的是 MuRDATree：ROOT_ID 根节点 + 每个
// 实体一个叶子，value 放实体属性。folderId 非空时先建分组节点。
// 见 internals/schema/project/murda-tree.ts（nodeSchema identity）与
// project-0.3.17.ts 迁移（node.value 承载实体字段）。
const ENTITY_VALUE_KEYS = new Set([
  'name', 'tags', 'editLock', 'staticShadow', 'position', 'collision', 'gravity',
  'fixed', 'mass', 'friction', 'restitution', 'bounds', 'meshId', 'mesh', 'scale',
  'orientation', 'tint', 'metalness', 'shininess', 'emissive', 'defaultMotionId',
  'particle', 'damage', 'sound',
]);

// 判断一个对象是不是已经是 MuRDATree 形态（有 ROOT_ID 或节点带 type+parentId）。
// 与扁平 entities.json 区分：扁平版本每个值是实体属性（有 mesh/position），
// 没有 type/parentId/childrenIds 三件套。
export function isEntitiesTree(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.ROOT_ID) return true;
  const entries = Object.values(value).filter((v) => v && typeof v === 'object');
  if (!entries.length) return false;
  return entries.every(
    (node) =>
      typeof node.type === 'number' &&
      typeof node.parentId === 'string' &&
      Array.isArray(node.childrenIds),
  );
}

export function buildEntitiesTree(entitiesJson) {
  const tree = {
    ROOT_ID: { type: 0, childrenIds: [], id: 'ROOT_ID', name: 'Root', parentId: '' },
  };
  if (!entitiesJson || typeof entitiesJson !== 'object') return tree;

  const ids = Object.keys(entitiesJson);
  // folderId → 分组节点 id（引擎用 type=2 的 node 承载文件夹）
  const folderNodes = new Map();
  const ensureFolder = (folderId) => {
    if (folderNodes.has(folderId)) return folderNodes.get(folderId);
    const nodeId = `folder_${folderId}`;
    tree[nodeId] = {
      type: 2,
      childrenIds: [],
      id: nodeId,
      name: String(folderId),
      parentId: 'ROOT_ID',
    };
    tree.ROOT_ID.childrenIds.push(nodeId);
    folderNodes.set(folderId, nodeId);
    return nodeId;
  };

  for (const id of ids) {
    const entity = entitiesJson[id];
    if (!entity || typeof entity !== 'object') continue;
    const value = {};
    for (const key of Object.keys(entity)) {
      if (ENTITY_VALUE_KEYS.has(key)) value[key] = entity[key];
    }
    if (value.defaultMotionId === undefined) value.defaultMotionId = '';
    const nodeId = `e_${id}`;
    const folderId = entity.folderId;
    const parentId = folderId ? ensureFolder(folderId) : 'ROOT_ID';
    tree[nodeId] = {
      type: 1,
      childrenIds: [],
      id: nodeId,
      name: String(value.name || id),
      parentId,
      value,
    };
    tree[parentId].childrenIds.push(nodeId);
  }
  return tree;
}

// ---------- 体素 ----------

export function buildChunksFromDense(shape, dense) {
  const nxc = Math.ceil(shape.x / CHUNK_SIZE);
  const nyc = Math.ceil(shape.y / CHUNK_SIZE);
  const nzc = Math.ceil(shape.z / CHUNK_SIZE);
  const slice = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
  const buffers = [];
  for (let cz = 0; cz < nzc; cz += 1) {
    for (let cy = 0; cy < nyc; cy += 1) {
      for (let cx = 0; cx < nxc; cx += 1) {
        slice.fill(0);
        for (let z = 0; z < CHUNK_SIZE; z += 1) {
          const gz = cz * CHUNK_SIZE + z;
          if (gz >= shape.z) break;
          for (let y = 0; y < CHUNK_SIZE; y += 1) {
            const gy = cy * CHUNK_SIZE + y;
            if (gy >= shape.y) break;
            // row 已含 chunk 的 x 基址（cx * CHUNK_SIZE），chunk 内只需加局部 x。
            // 之前误写成全局 gx（= 基址 + x），x 方向每个 chunk 多偏移一次基址，
            // 整张地图在 x 方向错位成"两半对调"。
            const row = (gz * shape.y + gy) * shape.x + cx * CHUNK_SIZE;
            for (let x = 0; x < CHUNK_SIZE; x += 1) {
              const gx = cx * CHUNK_SIZE + x;
              if (gx >= shape.x) break;
              slice[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE] = dense[row + x];
            }
          }
        }
        buffers.push(boxCompress(meshChunkToBoxes(slice)));
      }
    }
  }
  return buffers;
}

// ---------- 主转换 ----------

// 探测包内的官方项目目录：带 meta/displayName.txt 的顶层目录算一个项目。
// 体素就在项目目录下（<root>/voxel-sparse.gz）。地图组会返回多个。
export function findOfficialProjects(files) {
  const projects = [];
  for (const entry of files) {
    if (!/voxel-sparse\.gz$/i.test(entry.name)) continue;
    const parts = entry.name.split('/');
    const root = parts.slice(0, -1).join('/');
    // 单项目包（体素在 zip 根）没有项目目录可探测
    if (!root) continue;
    const hasMeta = files.some(
      (candidate) =>
        candidate.name.toLowerCase() === `${root.toLowerCase()}/meta/displayname.txt`,
    );
    if (hasMeta) projects.push(root);
  }
  return projects;
}

export function convertDao3Zip(zipPath, options = {}) {
  const warnings = [];
  const buffer = fs.readFileSync(zipPath);
  const allEntries = readZipEntries(buffer);
  const files = allEntries.filter((entry) => !entry.dir && entry.data);

  const pick = (pattern) => files.find((entry) => pattern.test(entry.name));
  const pickAll = (pattern) => files.filter((entry) => pattern.test(entry.name));

  // 双格式支持：
  //   legacy  —— 老神岛导出：block.json + json/*.json + terrain/ + scripts/ + images/ + audio/
  //   official—— 官方新导出：<proj>/{meta,config,assets/scripts} + public/{images,audios,models,…}
  // 地图组会含多个 <proj>，用 options.projectRoot 指定转换哪一个（默认第一个）。
  const officialProjects = findOfficialProjects(files);
  const projectRoot = options.projectRoot
    || officialProjects[0]
    || pick(/(^|\/)config\/info\.json$/i)?.name.replace(/config\/info\.json$/i, '')
    || '';
  const isOfficial = !!projectRoot && !!pick(/(^|\/)voxel-sparse\.gz$/i);

  let block = {};
  if (!isOfficial) {
    const blockEntry = pick(/(^|\/)(block|project)\.json$/i);
    if (!blockEntry) throw new Error('包内缺少 block.json / project.json：不是神岛/DAO3 工程导出包');
    try {
      block = JSON.parse(blockEntry.data.toString('utf8'));
    } catch (error) {
      throw new Error(`${blockEntry.name} 解析失败：${error.message}`);
    }
  }

  const mapEntry = pick(/(^|\/)map\.json$/i);
  let mapJson;
  if (mapEntry) {
    try {
      mapJson = JSON.parse(mapEntry.data.toString('utf8'));
    } catch {}
  }

  // 官方包的真实地图名在 meta/displayName.txt（config/info.json 里是 "Blank Map"）
  // 子串匹配而非正则：项目目录名含 [ ] • 等正则元字符，转义容易漏。
  // 地图组里多个项目都有 config/info.json，所以必须带 projectRoot 前缀。
  const readTextUnder = (rel) => {
    const suffix = `${projectRoot}/${rel}`.toLowerCase();
    const entry = files.find((candidate) => candidate.name.toLowerCase() === suffix);
    return entry ? entry.data.toString('utf8').trim() : '';
  };
  const officialDisplayName = isOfficial ? readTextUnder('meta/displayName.txt') : '';

  // 配置文档：老包在 json/<name>.json，官方包在 <proj>/config/<name>.json
  // 子串匹配而非正则：项目目录名可能含 [ ] • 等正则元字符
  const readJsonUnder = (name) => {
    const suffix = isOfficial
      ? `${projectRoot}/config/${name}.json`.toLowerCase()
      : `json/${name}.json`.toLowerCase();
    const entry = files.find((candidate) => candidate.name.toLowerCase().endsWith(suffix));
    if (!entry) return undefined;
    try {
      return JSON.parse(entry.data.toString('utf8'));
    } catch (error) {
      warnings.push(`${isOfficial ? 'config' : 'json'}/${name}.json 解析失败：${error.message}`);
      return undefined;
    }
  };

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---- blob 存储 ----
  const blobs = new Map();
  const storeBlob = (bytes) => {
    const hash = contentHash(bytes);
    if (!blobs.has(hash)) blobs.set(hash, bytes);
    return hash;
  };
  const storeJSON = (value) => (value === undefined ? undefined : storeBlob(Buffer.from(stableStringify(value), 'utf8')));

  // ---- 脚本 ----
  // 官方包按目录分类：<proj>/assets/scripts/{server,client,other}/*.js
  // （server/other=服务端 type 1，client=客户端 type 7）；老包 scripts/*.js 按
  // 文件名前缀猜。子串匹配而非正则：项目目录名可能含 [ ] • 等正则元字符。
  // 前缀必须带上尾部斜杠，否则 '[恒光学院]' 会误匹配 '[恒光学院（怀旧服）]'
  // 这种以它为前缀的兄弟项目。
  const projectPrefix = `${projectRoot}/`;
  const officialScripts = isOfficial
    ? files.filter((entry) => {
        if (!entry.name.startsWith(projectPrefix)) return false;
        const rest = entry.name.slice(projectPrefix.length);
        return /^assets\/scripts\/(server|client|other)\/[^/]+\.(js|ts)$/i.test(rest);
      })
    : [];
  // 地图组里每个项目各有 voxel-sparse.gz，必须按 projectRoot 前缀取，
  // 否则会把整组的体素当成同一个地图的。
  const legacyScripts = pickAll(/(^|\/)(scripts|code)\/[^/]+\.(js|ts)$/i);
  const scriptEntries = (officialScripts.length ? officialScripts : legacyScripts).sort((a, b) => {
    const score = (name) => {
      if (/\/client\//i.test(name)) return 1;
      if (/\/server\/(index)\.js$/i.test(name)) return 0;
      return 2;
    };
    return score(a.name) - score(b.name) || a.name.localeCompare(b.name);
  });
  if (!scriptEntries.length) warnings.push('包内没有脚本');
  const scriptAssets = {};
  const scriptSources = new Map(); // base -> 原始字节，稍后统一清理悬空 CID
  for (const entry of scriptEntries) {
    const base = entry.name.split('/').pop();
    const isClient = officialScripts.length
      ? /\/client\//i.test(entry.name)
      : /^client/i.test(base) || /clientindex/i.test(base);
    scriptSources.set(base, entry.data);
    scriptAssets[base] = {
      ownerId: 0,
      contentId: 0,
      bounds: [0, 0, 0],
      animated: false,
      type: isClient ? 7 : 1,
      hash: storeBlob(entry.data),
      size: entry.data.length,
      previewImage: '',
    };
  }

  // ---- 体素 ----
  const payloadEntry = isOfficial
    ? files.find((entry) => entry.name === `${projectRoot}/voxel-sparse.gz`)
    : pick(/(^|\/)voxel-sparse\.gz$/i);
  let shape = null;
  let dense = null;
  let voxelCount = 0;
  if (payloadEntry) {
    let payload;
    try {
      payload = JSON.parse(zlib.gunzipSync(payloadEntry.data).toString('utf8'));
    } catch (error) {
      warnings.push(`voxel-sparse.gz 解析失败：${error.message}（将尝试 raw 区块）`);
    }
    if (payload && Array.isArray(payload.shape)) {
      const [sx, sy, sz] = payload.shape.map((v) => Number(v) | 0);
      shape = { x: sx, y: sy, z: sz };
      dense = new Uint16Array(sx * sy * sz);
      const indices = payload.indices || [];
      const data = payload.data || [];
      const rot = payload.rot || [];
      for (let k = 0; k < indices.length; k += 1) {
        const id = data[k] | 0;
        if (!id) continue;
        dense[indices[k]] = packBlock(id, rot[k] | 0);
        voxelCount += 1;
      }
    }
  }

  const rawChunks = new Map();
  for (const entry of pickAll(/(^|\/)terrain\/raw\/chunk_(\d+)_(Qm[1-9A-HJ-NP-Za-km-z]{44})\.bin$/i)) {
    const match = entry.name.match(/chunk_(\d+)_(Qm[1-9A-HJ-NP-Za-km-z]{44})\.bin$/i);
    rawChunks.set(Number(match[1]), entry.data);
  }

  let chunks = [];
  if (shape && dense) {
    for (const bytes of buildChunksFromDense(shape, dense)) {
      chunks.push(storeBlob(bytes.length === 2 && bytes[0] === 0 && bytes[1] === 0 ? EMPTY_CHUNK_BYTES : bytes));
    }
  } else if (rawChunks.size) {
    warnings.push('缺少 voxel-sparse.gz：改用 terrain/raw 区块重建（可能不完整）');
    const maxIndex = Math.max(...rawChunks.keys());
    const total = maxIndex + 1;
    const side = Math.round(Math.cbrt(total));
    const dim = side ** 3 === total ? side * CHUNK_SIZE : 128;
    shape = { x: dim, y: dim, z: dim };
    for (let i = 0; i < total; i += 1) {
      chunks.push(storeBlob(rawChunks.get(i) || EMPTY_CHUNK_BYTES));
    }
  } else {
    warnings.push('包内没有体素数据（voxel-sparse.gz 与 terrain/raw 都缺失）');
    shape = { x: 128, y: 128, z: 128 };
  }

  // ---- 配置文档 ----
  const player = readJsonUnder('player');
  const physics = readJsonUnder('physics');
  const environment = readJsonUnder('environment');
  const zones = readJsonUnder('zones') ?? [];
  const info = readJsonUnder('info');
  const ambientSound = readJsonUnder('ambientSound');
  // uiTree / gamepad / deleteAssets：老包不带（用引擎默认），官方包在 config/ 里
  const uiTreeDoc = readJsonUnder('uiTree');
  const gamepadDoc = readJsonUnder('gamepad');
  const deleteAssetsDoc = readJsonUnder('deleteAssets');
  // 场景实体：两种来源
  //   a) 老包 json/entities.json —— 扁平字典 {id: {name, mesh, position...}}
  //   b) 完整导出 / 外挂 json/entitiesTree.json —— 已是 MuRDATree
  //      {id: {id, type, name, parentId, childrenIds, value:{...}}}
  // 没有实体，放置的模型/机关全部消失，地图只剩地形——直接决定"可游玩"。
  let entitiesDoc = readJsonUnder('entities');
  let entitiesTreeDoc = readJsonUnder('entitiesTree');
  // 允许从外部指定实体树文件（有些导出工具把 entitiesTree 单独存放）
  if (!entitiesTreeDoc && options.entitiesTreePath && fs.existsSync(options.entitiesTreePath)) {
    try {
      const external = JSON.parse(fs.readFileSync(options.entitiesTreePath, 'utf8'));
      if (isEntitiesTree(external)) entitiesTreeDoc = external;
    } catch (error) {
      warnings.push(`外部 entitiesTree 读取失败：${error.message}`);
    }
  }

  // 配置文档里的 previewImage / bannerImages / texture 之类字段写成 "<cid>.png"。
  // 老导出包常不带这些图片实体，但有时带了、只是文件名与 CID 无关联。
  // CID 就是内容哈希，所以可以反查：把包内每张图片算一遍 contentHash 建索引，
  // 命中就把引用改写成 pictureAssets 的 key，让封面/横幅真的能用上；
  // 确实没有的才清空（官方把这些字段归为纯展示元数据，缺失不会导致不兼容）。
  const CID_IN_FIELD = /^Qm[1-9A-HJ-NP-Za-km-z]{44}(?:\.[A-Za-z0-9]+)?$/;
  const cidToPictureKey = new Map(); // contentHash -> pictureAssets key
  const neutralizeDocCids = (value, label, seen = new Set()) => {
    if (typeof value === 'string') {
      if (CID_IN_FIELD.test(value)) {
        const bare = value.split('.')[0];
        if (blobs.has(bare)) return value;
        const mapped = cidToPictureKey.get(bare);
        if (mapped) {
          if (!seen.has(label)) {
            seen.add(label);
            resolvedDocCids.push(label);
          }
          return mapped;
        }
        if (!seen.has(label)) {
          seen.add(label);
          docDanglingCids.push(label);
        }
        return '';
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => neutralizeDocCids(item, label, seen));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = neutralizeDocCids(child, `${label}.${key}`, seen);
    }
    return out;
  };

  // ---- 资源 ----
  const assets = {};
  const audioAssets = {};
  const docDanglingCids = [];
  const resolvedDocCids = [];
  // 音频：老包 audio/<name>.mp3，官方包 public/audios/<name>.mp3
  const audioEntries = isOfficial
    ? pickAll(/(^|\/)public\/audios\/[^/]+\.(mp3|wav|ogg|m4a|aac)/i)
    : pickAll(/(^|\/)audio\/[^/]+\.(mp3|wav|ogg|m4a|aac)/i);
  for (const entry of audioEntries) {
    const base = entry.name.split('/').pop();
    audioAssets[`audio/${base}`] = {
      id: '', updateAt: 0, type: 6, hash: storeBlob(entry.data), size: entry.data.length, previewImage: '',
    };
  }
  // ---- 图片资产 ----
  // cold pictureAssets 的 schema 是 GroupAssetEntryRDA：
  //   { id, updateAt, type(8=PICTURE), hash, size, previewImage }
  // 其中 hash 必须指向「元数据 JSON」({hash, width, height})——bake 阶段
  // _getPicture(spec.hash) 会 JSON.parse 它。早期版本误用了 hot 的
  // {metadataHash, hash, width, height} 形状且 hash 指向 PNG 原图，
  // 导致 bake JSON.parse(PNG) 崩溃、编辑运行时起不来。
  // key 用包内相对 images/ 的路径（如 picture/公告框1.png）：脚本里 loadPicture
  // 引用的正是这个形式，用 basename 会对不上。
  const pictureAssets = {};
  const lutAssets = {};
  let pictureBytes = 0;
  let fakeImageCount = 0;
  const buildPictureEntry = (entry, relative) => {
    const hash = storeBlob(entry.data);
    const { width, height } = probeImageSize(entry.data, relative);
    const metadataHash = storeBlob(Buffer.from(JSON.stringify({ hash, width, height }), 'utf8'));
    return {
      id: '',
      updateAt: 0,
      type: 8,
      hash: metadataHash,
      size: entry.data.length,
      previewImage: '',
    };
  };
  // 图片来源：官方包 public/images/<name>（key 固定 picture/<name>，与官方
  // pictureAssets.json 一致；其 lut/snow 是引擎共享资源，官方导出不登记，
  // 登记了反而引入悬空引用）；老包 images/<子路径>（key=子路径，脚本 loadPicture
  // 直接按这个形式引用）。
  const imageEntries = isOfficial
    ? pickAll(/(^|\/)public\/images\/(.+\.(?:png|jpe?g|webp|gif|bmp))$/i)
    : pickAll(/(^|\/)images\/(.+\.(?:png|jpe?g|webp|gif|bmp))$/i);
  for (const entry of imageEntries) {
    const relative = isOfficial
      ? `picture/${entry.name.split('/').pop()}`
      : entry.name.match(/images\/(.+\.(?:png|jpe?g|webp|gif|bmp))$/i)[1];
    // 老包 images/ 里混着的 JSON 元数据文档（误用图片扩展名）不是图片：登记它会把
    // 里面的 CID 变成悬空引用，让整包被官方判为不兼容。
    if (!isRealImage(entry.data, relative)) {
      fakeImageCount += 1;
      continue;
    }
    // 反查索引用图片内容哈希（cidToPictureKey 的 value 是 pictureAssets 的 key）
    const pictureHash = contentHash(entry.data);
    const pictureEntry = buildPictureEntry(entry, relative);
    // LUT 是调色查找表，单独归类；两者都登记，脚本与 environment 各取所需
    if (LUT_NAMES.has(relative.replace(/\.[^.]+$/, '').toLowerCase())) {
      lutAssets[relative] = pictureEntry;
    } else {
      pictureAssets[relative] = pictureEntry;
    }
    if (!cidToPictureKey.has(pictureHash)) cidToPictureKey.set(pictureHash, relative);
    pictureBytes += entry.data.length;
  }
  if (fakeImageCount) {
    warnings.push(`${fakeImageCount} 个 images/ 下的文件不是图片（实为 JSON 元数据文档），已跳过`);
  }
  const pictureCount = Object.keys(pictureAssets).length + Object.keys(lutAssets).length;
  // ---- 模型资产 ----
  // 引擎 AssetType：VOXEL_MODEL(2) 走 VOXA（元数据 json 的 hash，dataHash 指向
  // 数据 bin——migrateVoxel→migrateS3Model 原生链路），GLTF_MODEL(9) 走
  // gltf + bounds 元数据。老包的 .vox（MagicaVoxel）转成 VbFileData 走同一 VOXA 链路。
  let skippedVoxCount = 0;
  const voxSkipped = [];
  let gltfCount = 0;
  let gltfBytes = 0;
  let gltfNotSelfContained = 0;
  let voxaCount = 0;
  let voxConverted = 0;
  // 只有 VOXA 元数据、没有模型字节的 .vox（原包导出时丢了数据）
  const metadataOnly = [];

  if (isOfficial) {
    // 官方包模型：public/models/<name>/<name>.{json,bin,gltf}
    // json = {version, bounds, dataHash, motionList}，dataHash 指向 bin。
    const modelFiles = pickAll(/(^|\/)public\/models\/([^/]+)\/([^/]+\.(?:json|bin|gltf))$/i);
    const byName = new Map();
    for (const entry of modelFiles) {
      const match = entry.name.match(/public\/models\/([^/]+)\/([^/]+\.(?:json|bin|gltf))$/i);
      const name = match[1];
      const ext = match[2].toLowerCase().split('.').pop();
      if (!byName.has(name)) byName.set(name, {});
      byName.get(name)[ext] = entry;
    }
    for (const [name, parts] of byName) {
      // VOXA 主链路：bin 数据 + json 元数据
      if (parts.json && parts.bin) {
        try {
          const meta = JSON.parse(parts.json.data.toString('utf8'));
          const binHash = storeBlob(parts.bin.data);
          // 元数据里的 dataHash 重写为我们 blob 的实际 hash
          const rewritten = { ...meta, dataHash: binHash };
          const modelMetaHash = storeJSON(rewritten);
          // 引擎权威 key 格式：VOXA 模型 = mesh/<name>.vb（见 hot-schema 的
          // getMeshPath，脚本与已放置实体都按 mesh/土豆.vb 查找）。用 model/<name>
          // 会导致运行时查不到、模型全部不可用。
          assets[`mesh/${name}.vb`] = {
            ownerId: 0,
            contentId: 0,
            bounds: [0, 0, 0],
            animated: false,
            type: 2,
            hash: modelMetaHash,
            size: parts.json.data.length + parts.bin.data.length,
            previewImage: '',
          };
          voxaCount += 1;
        } catch (error) {
          skippedVoxCount += 1;
          voxSkipped.push(`${name}(元数据解析失败)`);
        }
      } else if (parts.json && !parts.bin) {
        // 只有 json 无 bin：数据缺失，登记会让运行时取不到内容，跳过并说明
        skippedVoxCount += 1;
        voxSkipped.push(`${name}(缺 .bin 数据)`);
      }
      // 同目录的 gltf 也登记（编辑器模型面板用）
      if (parts.gltf) {
        const bounds = parseGltfBounds(parts.gltf.data);
        if (bounds) {
          const info = inspectGltf(parts.gltf.data);
          if (!info.selfContained) gltfNotSelfContained += 1;
          const gltfHash = storeBlob(parts.gltf.data);
          const metadataHash = storeJSON({ bounds: bounds.bounds });
          const officialGltfEntry = {
            ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
            type: 9, hash: gltfHash, metadataHash, size: parts.gltf.data.length, previewImage: '',
          };
          assets[`gltf/${name}`] = officialGltfEntry;
          // 脚本按 mesh/<名字>.vb 查找模型的包，也需要这个别名
          const officialMeshAlias = `mesh/${name}.vb`;
          if (!assets[officialMeshAlias]) assets[officialMeshAlias] = { ...officialGltfEntry };
          gltfCount += 1;
          gltfBytes += parts.gltf.data.length;
        }
      }
    }
  } else {
    const MODEL_ENTRY = /(^|\/)(?:meshes|models)\/(.+\.(?:vox|vb|glb|gltf))$/i;
    for (const entry of pickAll(MODEL_ENTRY)) {
      const relative = entry.name.match(MODEL_ENTRY)[2];
      const ext = relative.toLowerCase().split('.').pop();
      if (ext === 'vox') {
        // 老导出包里 .vox 有两种截然不同的东西：
        //   a) MagicaVoxel 二进制（有 "VOX " 魔数）→ 转成 VOXA
        //   b) VOXA 元数据 JSON（{version, bounds, dataHash}）→ 数据本来就丢了
        // b 的情况说明导出时只留了索引、没带模型字节，如实报告比报
        // "不是有效的 MagicaVoxel" 有用得多。
        const head = entry.data.subarray(0, 4).toString('latin1');
        if (head !== 'VOX ') {
          let meta = null;
          try {
            const parsed = JSON.parse(entry.data.toString('utf8'));
            if (parsed && parsed.version && parsed.bounds) meta = parsed;
          } catch {}
          if (meta) {
            metadataOnly.push(relative);
            continue;
          }
        }
        // MagicaVoxel .vox → VOXA：(1) VbFileData 作为数据 blob，
        // (2) {version, bounds, dataHash} 元数据作为 assets 的 hash。
        // 引擎的 migrateVoxel/getModelMetaData 只认元数据，直接把 VbFileData
        // 挂在 assets 上会被判为无效模型（缺 version/bounds/dataHash）。
        try {
          const { sizeX, sizeY, sizeZ, voxels, palette } = parseVox(entry.data);
          const base = relative.split('/').pop().replace(/\.vox$/i, '');
          const vb = buildVbFileData(sizeX, sizeY, sizeZ, voxels, palette, base);
          const dataHash = storeJSON(vb);
          // 轴变换后引擎尺寸为 (sizeX, sizeZ, sizeY)
          const bounds = [sizeX, sizeZ, sizeY];
          const metaHash = storeJSON({
            version: 7,
            bounds,
            dataHash,
            motionList: [],
          });
          assets[`mesh/${base}.vb`] = {
            ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
            type: 2, hash: metaHash, size: entry.data.length, previewImage: '',
          };
          voxConverted += 1;
        } catch (error) {
          skippedVoxCount += 1;
          voxSkipped.push(`${relative}(${error.message.slice(0, 30)})`);
        }
        continue;
      }
      if (ext === 'gltf') {
        const bounds = parseGltfBounds(entry.data);
        const info = inspectGltf(entry.data);
        if (!bounds) {
          skippedVoxCount += 1;
          voxSkipped.push(`${relative}(bounds 解析失败)`);
          continue;
        }
        if (!info.selfContained) gltfNotSelfContained += 1;
        const hash = storeBlob(entry.data);
        // bake 的 getMeshInfo 会 retrieveContentFromS3(hash) 读这个 { bounds } 文档
        const metadataHash = storeBlob(Buffer.from(JSON.stringify({ bounds: bounds.bounds }), 'utf8'));
        // glTF 的权威 key 是 gltf/<name>（无扩展名，见 asset-controller 的 format 表）。
        // 但脚本/实体是按 mesh/<名字>.vb 查找的（如赛车模版里的 mesh/汽车模板-1.vb），
        // 所以同一个模型再挂一个 mesh/ 别名，两套查找都能命中。
        const gltfName = relative.split('/').pop().replace(/\.(gltf|glb)$/i, '');
        const gltfEntry = {
          ownerId: 0,
          contentId: 0,
          bounds: [0, 0, 0],
          animated: false,
          type: 9,
          hash,
          metadataHash,
          size: entry.data.length,
          previewImage: '',
        };
        assets[`gltf/${gltfName}`] = gltfEntry;
        const meshAlias = `mesh/${gltfName}.vb`;
        if (!assets[meshAlias]) assets[meshAlias] = { ...gltfEntry };
        gltfCount += 1;
        gltfBytes += entry.data.length;
        continue;
      }
      // .vb → mesh/<name>.vb；.glb → gltf/<name>（两种格式 key 约定不同）
      if (ext === 'glb') {
        const glbName = relative.split('/').pop().replace(/\.glb$/i, '');
        assets[`gltf/${glbName}`] = {
          ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
          type: 9, hash: storeBlob(entry.data), size: entry.data.length, previewImage: '',
        };
        gltfCount += 1;
        gltfBytes += entry.data.length;
        continue;
      }
      assets[`mesh/${relative}`] = {
        ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
        type: 2, hash: storeBlob(entry.data), size: entry.data.length, previewImage: '',
      };
    }
  }
  if (voxaCount) {
    warnings.push(`${voxaCount} 个 VOXA 模型已登记（json 元数据 + bin 数据走引擎原生迁移链路）`);
  }
  if (voxConverted) {
    warnings.push(`${voxConverted} 个 MagicaVoxel .vox 已转成 VOXA 模型`);
  }
  if (gltfCount) {
    warnings.push(
      `${gltfCount} 个 glTF 模型已登记（${(gltfBytes / 1024 / 1024).toFixed(1)} MB）` +
        (gltfNotSelfContained ? `，其中 ${gltfNotSelfContained} 个外挂了 .bin/贴图，运行时可能缺资源` : ''),
    );
  }
  if (skippedVoxCount) warnings.push(`${skippedVoxCount} 个模型未转换（${voxSkipped.slice(0, 4).join('、')}${voxSkipped.length > 4 ? ' 等' : ''}）`);
  if (metadataOnly.length) {
    warnings.push(
      `${metadataOnly.length} 个模型只有索引没有数据（原包导出时未带模型字节，如 ${metadataOnly.slice(0, 3).join('、')}${metadataOnly.length > 3 ? ' 等' : ''}）——这些模型无法还原`,
    );
  }

  // ---- 实体引用的缺失模型：补占位模型 ----
  // 老包里偶尔有实体引用了没随包导出的模型（如"单元方块"）。留着悬空引用会让
  // 引擎在加载实体时取不到 mesh。这里生成一个 1×1×1 的占位体素模型，
  // 保证实体有几何可挂载，同时在 warnings 里如实说明。
  if (entitiesDoc && typeof entitiesDoc === 'object') {
    const missing = new Set();
    for (const entity of Object.values(entitiesDoc)) {
      const mesh = entity && typeof entity === 'object' ? entity.mesh : undefined;
      if (typeof mesh === 'string' && mesh.startsWith('mesh/') && !assets[mesh]) {
        missing.add(mesh);
      }
    }
    for (const meshPath of missing) {
      const base = meshPath.replace(/^mesh\//, '').replace(/\.vb$/, '');
      // 1×1×1 单方块：nx=ny=nz=1，RLE 一个 run（length-1=0, block=1）
      const vb = buildVbFileData(1, 1, 1, new Map([[0, 1]]), null, base);
      const dataHash = storeJSON(vb);
      const metaHash = storeJSON({ version: 7, bounds: [1, 1, 1], dataHash, motionList: [] });
      assets[meshPath] = {
        ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
        type: 2, hash: metaHash, size: 0, previewImage: '',
      };
    }
    if (missing.size) {
      warnings.push(
        `${missing.size} 个实体的模型原包缺失，已生成占位方块（${[...missing].slice(0, 3).join('、')}${missing.size > 3 ? ' 等' : ''}）`,
      );
    }
  }

  // ---- 悬空 CID 清理 ----
  // 官方 scanProjectCompatibility 把脚本文本里所有 Qm<44> 子串当资源引用，缺一个就判
  // error 级不兼容。老导出包脚本里常有两类非资源 CID：指向云端 block 服务的绝对地址，
  // 以及 base64 数据里偶然出现的同形状序列。它们不是本工程资源，统一中性化掉。
  // 放在所有资源 blob 生成之后、projectDoc 构建之前，所以真正的资源引用（此时已在
  // blobs 中）不会被误伤，scriptAssets 记录的也是清理后的 hash。
  {
    const CID_PATTERN = /Qm[1-9A-HJ-NP-Za-km-z]{44}/g;
    // 替换目标不能仍是 CID 形状，否则扫描器会把它当成又一个缺失的资源引用。
    // base58 字母表排除 0/O/I/l 与 _，用等长的下划线填充可保持脚本内偏移稳定。
    const PLACEHOLDER = '_'.repeat(46);
    let neutralizedTotal = 0;
    const touched = [];
    for (const [base, bytes] of scriptSources) {
      const text = bytes.toString('utf8');
      if (!CID_PATTERN.test(text)) continue;
      CID_PATTERN.lastIndex = 0;
      let count = 0;
      const cleaned = text.replace(CID_PATTERN, (match) => {
        if (blobs.has(match)) return match;
        count += 1;
        return PLACEHOLDER;
      });
      if (!count) continue;
      neutralizedTotal += count;
      touched.push(`${base}(${count})`);
      // 脚本原文的 blob 在脚本入库时已经存过；不清掉它会跟着工程一起导出，
      // 扫描器扫到它里面的悬空 CID，清理就白做了。
      const staleHash = scriptAssets[base].hash;
      const cleanedBytes = Buffer.from(cleaned, 'utf8');
      scriptSources.set(base, cleanedBytes);
      scriptAssets[base].hash = storeBlob(cleanedBytes);
      if (staleHash !== scriptAssets[base].hash) blobs.delete(staleHash);
    }
    if (neutralizedTotal) {
      warnings.push(
        `脚本中 ${neutralizedTotal} 处指向不存在资源的 CID 已中性化（${touched.join('、')}）` +
          '——这些是老导出包遗留的云端地址/base64 片段，不是本地资源',
      );
    }
  }

  // ---- 工程文档 ----
  const scriptIndex = scriptAssets['index.js'] ? 'index.js' : Object.keys(scriptAssets)[0] || 'index.js';
  // 上传的文件名可能被客户端编码成点号或随机临时名，显示名一律优先取包内 info.displayName
  const zipBaseName = path.basename(options.sourceName || zipPath, path.extname(options.sourceName || zipPath));
  const rawDisplayName = String(
    officialDisplayName || info?.displayName || block?.info?.displayName || mapJson?.name || '',
  );
  // 老平台作者没改地图名时 info.displayName 是 "Project" 这类泛默认名，
  // 用户认的是 zip 文件名（如 神岛世界大厅.zip）——此时优先用文件名。
  const GENERIC_NAMES = new Set(['project', 'untitled', 'new map', 'blank map', '新作品', '未命名', '无标题']);
  const zipDisplayBase = zipBaseName.replace(/[-_ ]?master[-_ ]?export$/i, '').replace(/\s+/g, ' ').trim();
  // 地图名可能带前导空格（如 "    新赛车模版"），统一折叠空白再 trim
  const cleanedDisplayName = rawDisplayName.replace(/\s+/g, ' ').trim();
  const displayName =
    cleanedDisplayName && !GENERIC_NAMES.has(cleanedDisplayName.toLowerCase())
      ? cleanedDisplayName
      : zipDisplayBase || cleanedDisplayName || zipBaseName || '未命名地图';

  const projectDoc = {
    type: 'project',
    version: PROJECT_VERSION,
    prevHash: '',
    timestamp: new Date(block?.timestamp || Date.now()).toISOString(),
    storageMode: block?.storageMode || 'sqlite',
    features: block?.features || { enableTriggerAPI: false },
    committerId: 0,
    defaultScreenId: DEFAULT_SCREEN_ID,
    scriptIndex,
    collisionFilter: block?.collisionFilter || [],
    voxels: storeJSON({ shape, chunks }),
    scriptAssets: storeJSON(scriptAssets),
    // deleteAssets 是「已删除资产」的墓碑记录，其 hash 本就指向不存在的 blob。
    // 官方兼容性扫描会把这些 hash 当资源引用判为缺失，所以同样过一遍 CID 清理。
    deleteAssets: storeJSON(neutralizeDocCids(deleteAssetsDoc ?? [], 'deleteAssets')),
    uiTree: storeJSON(uiTreeDoc || DEFAULTS.uiTree || DEFAULT_UI_TREE),
    info: storeJSON(neutralizeDocCids({ ...DEFAULTS.info, ...(info || {}), displayName }, 'info')),
    entitiesTree: storeJSON(
      entitiesTreeDoc
        ? entitiesTreeDoc
        : entitiesDoc
          ? buildEntitiesTree(entitiesDoc)
          : (DEFAULTS.entitiesTree || {
              ROOT_ID: { type: 0, childrenIds: [], id: 'ROOT_ID', name: 'Root', parentId: '' },
            }),
    ),
    player: storeJSON(neutralizeDocCids({ ...DEFAULTS.player, ...(player || {}) }, 'player')),
    environment: storeJSON(neutralizeDocCids({ ...DEFAULTS.environment, ...(environment || {}) }, 'environment')),
    physics: storeJSON(neutralizeDocCids({ ...DEFAULTS.physics, ...(physics || {}) }, 'physics')),
    ambientSound: storeJSON(neutralizeDocCids({ ...DEFAULTS.ambientSound, ...(ambientSound || {}) }, 'ambientSound')),
    gamepad: storeJSON(gamepadDoc || DEFAULTS.gamepad),
    zones: storeJSON(neutralizeDocCids(zones, 'zones')),
    assets: storeJSON(assets),
    audioAssets: storeJSON(audioAssets),
    pictureAssets: storeJSON({ ...pictureAssets, ...lutAssets }),
  };

  if (resolvedDocCids.length) {
    warnings.push(
      `配置文档中 ${resolvedDocCids.length} 处图片引用已按内容哈希找回（${resolvedDocCids.slice(0, 6).join('、')}${resolvedDocCids.length > 6 ? ' 等' : ''}）——封面/横幅恢复可用`,
    );
  }
  if (docDanglingCids.length) {
    warnings.push(
      `配置文档中 ${docDanglingCids.length} 处图片/资源引用已清空（${docDanglingCids.slice(0, 6).join('、')}${docDanglingCids.length > 6 ? ' 等' : ''}）` +
        '——对应的图片没有随导出包提供，引擎会改用默认外观',
    );
  }

  // permission → versionControl → head 链，与 createReleaseData 的发布形状一致
  const projectHash = storeJSON(projectDoc);
  const versionControlHash = storeJSON({
    branches: { master: { headHash: projectHash, name: 'master' } },
    currentBranch: 'master',
  });
  const emptyObjectHash = storeJSON({});
  const emptyListHash = storeJSON([]);
  const permissionHash = storeJSON({
    type: 'permission',
    version: PERMISSION_VERSION,
    accessLevel: 1,
    banned: emptyListHash,
    collaborators: emptyListHash,
    groups: emptyObjectHash,
    owner: 0,
    prevHash: '',
    timestamp: new Date(0).toISOString(),
    users: emptyObjectHash,
    versionControl: versionControlHash,
  });

  // ID 用显示名派生：上传文件名可能被客户端编码坏，包内 info.displayName 才是稳定标识。
  // 纯中文名 slug 化后为空会退化成 map-<hash6>，仍满足官方 /^[a-z0-9][a-z0-9-]{0,62}$/。
  const worldId = assertOfficialId(options.worldId || slugId(displayName, displayName));
  // extraProjectHash 是空内容的哈希（ExtraProjectInfo 的空 diff identity），
  // 与官方空白工程 project-state.json 里的固定值一致。编辑运行时按它走
  // reachable 引用图，缺了会让工程的资源闭包不完整。
  const extraProjectHash = storeBlob(Buffer.alloc(0));
  // cloudMapId：编辑器运行时会读它（launcher 的 readCloudMapId）来决定向 VOXA
  // 查模型时用哪个 mapId。写上原包的云地图 ID，模型才能按原 ID 关联到本工程；
  // 不写则退回 '0'，VOXA 库里按该 ID 登记的模型就查不到。
  // 三种来源：官方包的 meta/mapId.txt、精简导出包的 project/map.json、
  // 以及 export-manifest.json 里的 map.id。
  let cloudMapId = readTextUnder('meta/mapId.txt');
  if (!cloudMapId) {
    const mapJsonEntry = files.find((e) => /(^|\/)project\/map\.json$/i.test(e.name));
    if (mapJsonEntry) {
      try {
        const parsed = JSON.parse(mapJsonEntry.data.toString('utf8'));
        if (Number.isSafeInteger(parsed?.id) && parsed.id > 0) cloudMapId = String(parsed.id);
      } catch {}
    }
  }
  if (!cloudMapId) {
    const manifestEntry = files.find((e) => /(^|\/)export-manifest\.json$/i.test(e.name));
    if (manifestEntry) {
      try {
        const parsed = JSON.parse(manifestEntry.data.toString('utf8'));
        if (Number.isSafeInteger(parsed?.map?.id) && parsed.map.id > 0) {
          cloudMapId = String(parsed.map.id);
        }
      } catch {}
    }
  }
  const state = { formatVersion: 1, permissionHash, extraProjectHash };
  if (cloudMapId && /^\d+$/.test(cloudMapId)) {
    state.cloudMapId = Number(cloudMapId);
  }

  return {
    worldId,
    manifest: {
      id: worldId,
      publicId: worldId,
      permanentMapId: crypto.createHash('sha1').update(displayName).digest('hex').slice(0, 20),
      permanentMapGroupId: crypto.createHash('sha1').update(displayName).digest('hex').slice(0, 20),
      mapGroupId: worldId,
      mapRole: 'main',
      mainProjectId: worldId,
      version: '1.0.0',
      permissionHash,
      projectName: displayName,
      author: '',
      description: String(info?.description || ''),
      cover: '',
      loadingCover: '',
      playEnabled: true,
    },
    state,
    blobs,
    shape,
    voxelCount,
    scriptNames: Object.keys(scriptAssets),
    pictureCount,
    pictureBytes,
    audioCount: Object.keys(audioAssets).length,
    meshCount: Object.keys(assets).length,
    // 模型清单：供同步到 VOXA 本地库（编辑器 Models 面板读的是 VOXA 库，
    // 只登记到 project.assets 的话场景里能用、但面板里看不到）。
    modelManifest: Object.entries(assets)
      .filter(([, a]) => a.type === 2 || a.type === 9)
      .map(([key, a]) => ({
        key,
        hash: a.hash,
        type: a.type,
        animated: false,
        size: a.size || 0,
      })),
    gltfCount,
    skippedVoxCount,
    warnings,
    displayName,
    baseName: zipBaseName,
  };
}

// 把转换结果打包成官方 .boxproject（tar.gz）
export function buildBoxProject(result, options = {}) {
  const { worldId, manifest, state, blobs, displayName, shape } = result;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao3-boxproject-'));
  try {
    const memberDir = path.join(temporaryRoot, 'projects', worldId);
    fs.mkdirSync(path.join(memberDir, 'source', 'blobs'), { recursive: true });
    for (const [hash, bytes] of blobs) {
      fs.writeFileSync(path.join(memberDir, 'source', 'blobs', hash), bytes, { mode: 0o644 });
    }

    // ---- 引擎运行时资源 ----
    // 编辑运行时以项目 source/ 为数据根启动，launcher.js 会校验引擎的客户端
    // 脚本包等运行时 blob 必须已在项目 blobs 里（QmUQg6ay... 硬编码在
    // requiredClientAsset）。官方空白工程由 createProject → copyRuntimeData
    // 灌入；官方云端导出的作品则天然带着。老 zip 转换包没有，必须补上，
    // 否则编辑器容器反复崩溃（Runtime assets are incomplete → 503）。
    const runtimeInfo = copyEngineRuntimeBlobs(path.join(memberDir, 'source'));
    if (runtimeInfo.note) {
      result.warnings.push(runtimeInfo.note);
    }
    if (runtimeInfo.count) {
      fs.writeFileSync(
        path.join(memberDir, 'source', 'runtime-blobs.json'),
        `${JSON.stringify({ formatVersion: 1, hashes: runtimeInfo.hashes }, null, 2)}\n`,
        { mode: 0o644 },
      );
    }

    fs.writeFileSync(path.join(memberDir, 'source', 'project-state.json'), stableStringify(state), { mode: 0o644 });

    const now = new Date().toISOString();
    const projectMeta = {
      formatVersion: 1,
      id: worldId,
      permanentMapId: manifest.permanentMapId,
      publicId: worldId,
      name: displayName,
      author: '',
      description: manifest.description,
      cover: '',
      loadingCover: '',
      theme: 'sunset',
      createdAt: now,
      updatedAt: now,
      releases: [],
      mapGroupId: worldId,
      mapRole: 'main',
      mainProjectId: worldId,
    };
    fs.writeFileSync(path.join(memberDir, 'project.json'), JSON.stringify(projectMeta, null, 2));

    // 主地图才写 group-state.json；导入端会按它恢复地图组共享状态
    const groupState = {
      formatVersion: 1,
      mapGroupId: worldId,
      mainProjectId: worldId,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(memberDir, 'group-state.json'), JSON.stringify(groupState, null, 2));

    fs.writeFileSync(
      path.join(temporaryRoot, 'group.json'),
      JSON.stringify(
        {
          formatVersion: 2,
          type: 'map-group',
          mapGroupId: worldId,
          mainProjectId: worldId,
          exportedProjectId: worldId,
          exportedAt: now,
          members: [
            {
              id: worldId,
              publicId: worldId,
              name: displayName,
              mapRole: 'main',
              mainProjectId: worldId,
            },
          ],
        },
        null,
        2,
      ),
    );

    fs.mkdirSync(options.outDir || '.', { recursive: true });
    const safeName = displayName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '作品';
    const archivePath = path.join(options.outDir || '.', `${safeName}_${worldId}.boxproject`);
    const tar = spawnSync('tar', ['-czf', archivePath, '-C', temporaryRoot, 'group.json', 'projects'], {
      encoding: 'utf8',
    });
    if (tar.status !== 0) {
      throw new Error(`tar 打包失败：${tar.stderr || tar.status}`);
    }
    return {
      archivePath,
      filename: path.basename(archivePath),
      size: fs.statSync(archivePath).size,
      mapSize: shape,
      runtimeBlobs: runtimeInfo.count,
      runtimeMode: runtimeInfo.mode || null,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

// 把转换结果打包成官方 .boxplay（可直接放进游玩库运行的发布包）。
//
// 格式对齐 apps/local-engine/src/project-manager.js 的 exportPlayBundle：
//   bundle.json
//   worlds/<mapId>/manifest.json
//   worlds/<mapId>/data/project-state.json
//   worlds/<mapId>/data/runtime-blobs.json   ← play 侧据此校验/预取资源
//   worlds/<mapId>/data/private-blobs.json   ← 不对外公开的私有资源
//   worlds/<mapId>/data/blobs/<hash>         ← 全部资源
// 与 .boxproject 的区别：boxplay 不带 source/runtime 元数据包装，是给 play
// 运行时直接当"世界目录"消费的成品包。
export function buildBoxPlay(result, options = {}) {
  const { worldId, manifest, state, blobs, displayName, shape } = result;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao3-boxplay-'));
  try {
    const worldRoot = path.join(temporaryRoot, 'worlds', worldId);
    const dataRoot = path.join(worldRoot, 'data');
    const blobRoot = path.join(dataRoot, 'blobs');
    fs.mkdirSync(blobRoot, { recursive: true });

    for (const [hash, bytes] of blobs) {
      fs.writeFileSync(path.join(blobRoot, hash), bytes, { mode: 0o644 });
    }

    // 引擎运行时资源（与 .boxproject 同源）：play 运行时同样要校验客户端脚本包
    const runtimeInfo = copyEngineRuntimeBlobs(dataRoot);
    if (runtimeInfo.note) result.warnings.push(runtimeInfo.note);

    const runtimeHashes = [...new Set([...runtimeInfo.hashes, ...blobs.keys()])].sort();

    fs.writeFileSync(
      path.join(dataRoot, 'project-state.json'),
      stableStringify(state),
      { mode: 0o644 },
    );
    fs.writeFileSync(
      path.join(dataRoot, 'runtime-blobs.json'),
      `${JSON.stringify({ formatVersion: 1, hashes: runtimeHashes }, null, 2)}\n`,
      { mode: 0o644 },
    );
    // 私有资源：本项目没有需要隐藏的条目，但仍要写文件——
    // play 侧会读它来决定哪些 hash 不对外开放。
    fs.writeFileSync(
      path.join(dataRoot, 'private-blobs.json'),
      `${JSON.stringify({ formatVersion: 1, hashes: [] }, null, 2)}\n`,
      { mode: 0o644 },
    );

    fs.writeFileSync(
      path.join(worldRoot, 'manifest.json'),
      JSON.stringify(
        {
          id: worldId,
          version: manifest.version,
          mapGroupId: manifest.mapGroupId,
          permanentMapId: manifest.permanentMapId,
          publicId: manifest.publicId,
          mainProjectId: manifest.mainProjectId,
          mapRole: manifest.mapRole,
          projectName: displayName,
          author: manifest.author,
          description: manifest.description,
          cover: manifest.cover,
          loadingCover: manifest.loadingCover,
          playEnabled: true,
          permissionHash: manifest.permissionHash,
        },
        null,
        2,
      ),
      { mode: 0o644 },
    );

    fs.writeFileSync(
      path.join(temporaryRoot, 'bundle.json'),
      JSON.stringify(
        {
          formatVersion: 1,
          type: 'map-group-play-bundle',
          mapGroupId: manifest.mapGroupId,
          permanentMapGroupId: manifest.permanentMapGroupId,
          mainProjectId: worldId,
          version: manifest.version,
          createdAt: new Date().toISOString(),
          members: [
            {
              id: worldId,
              permanentMapId: manifest.permanentMapId,
              publicId: manifest.publicId,
              name: displayName,
              mapRole: 'main',
              mainProjectId: worldId,
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o644 },
    );

    fs.mkdirSync(options.outDir || '.', { recursive: true });
    const safeName = displayName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '作品';
    const archivePath = path.join(options.outDir || '.', `${safeName}_${worldId}.boxplay`);
    const tar = spawnSync('tar', ['-czf', archivePath, '-C', temporaryRoot, 'bundle.json', 'worlds'], {
      encoding: 'utf8',
    });
    if (tar.status !== 0) {
      throw new Error(`tar 打包失败：${tar.stderr || tar.status}`);
    }
    return {
      archivePath,
      filename: path.basename(archivePath),
      size: fs.statSync(archivePath).size,
      mapSize: shape,
      runtimeBlobs: runtimeInfo.count,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

// ---------- 统一多项目入口 ----------
// 一个 zip 可能是单地图，也可能是官方地图组（含多个项目）。这里一次调用产出
// 全部 .boxproject（可导入创作端编辑）以及 .boxplay（放入游玩库直接运行）。
// CLI / 服务端 / 界面共用这一条路径，避免各处重复探测逻辑。
// 返回 { projects: [{ projectRoot, result, built, play }], isGroup }。
export function convertZipToBoxProjects(zipPath, options = {}) {
  const { outDir, sourceName = zipPath, formats = ['boxproject', 'boxplay'], entitiesTreePath } = options;
  const wantProject = formats.includes('boxproject');
  const wantPlay = formats.includes('boxplay');
  const entries = readZipEntries(fs.readFileSync(zipPath)).filter((e) => !e.dir && e.data);
  const projects = findOfficialProjects(entries);

  const buildOne = (result) => ({
    built: wantProject ? buildBoxProject(result, { outDir }) : null,
    play: wantPlay ? buildBoxPlay(result, { outDir }) : null,
  });

  // 单项目（老格式，或官方单地图）：走一次即可
  if (projects.length <= 1) {
    const result = convertDao3Zip(zipPath, { sourceName, projectRoot: projects[0], entitiesTreePath });
    return {
      isGroup: false,
      projects: [{ projectRoot: projects[0] || '', result, ...buildOne(result) }],
    };
  }

  // 地图组：逐个转换。共享资源（public/models 等）会进每个项目的 blob，
  // 这是官方导入端的设计（每个工程自带完整闭包），不做跨包去重。
  const built = [];
  for (const projectRoot of projects) {
    const result = convertDao3Zip(zipPath, { sourceName, projectRoot, entitiesTreePath });
    built.push({ projectRoot, result, ...buildOne(result) });
  }
  return { isGroup: true, projects: built };
}
