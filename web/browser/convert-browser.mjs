// 浏览器版转换核心：zip → .boxproject / .boxplay，全程在页面内完成。
//
// 与 Node 版 convert.mjs 的差异只在 IO 与压缩：
//   fs            → zip 条目（已在内存里）
//   zlib          → DecompressionStream / CompressionStream
//   spawn tar     → lib-browser 里的纯 JS tar 生成器
//   crypto.createHash → crypto.subtle
// 转换语义（体素编码、模型格式、实体树、key 约定）与 Node 版逐条一致。
import {
  contentHash,
  stableStringify,
  gunzip,
  buildTarGz,
  readZip,
} from './lib-browser.mjs';
// lib/ 下的编码器是给 Node 写的，少量用 Buffer；先装 shim 再导入它们
import { installBufferShim } from './buffer-shim.mjs';

installBufferShim();

const { boxCompress, meshChunkToBoxes, packBlock, CHUNK_SIZE, EMPTY_CHUNK_BYTES } = await import('./lib/box-encode.mjs');
const { probeImageSize, isRealImage } = await import('./lib/image-size.mjs');
const { parseGltfBounds } = await import('./lib/gltf.mjs');
const { parseVox, buildVbFileData } = await import('./lib/vox-to-vb.mjs');

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

const DEFAULT_ENTITIES_TREE = {
  ROOT_ID: { type: 0, childrenIds: [], id: 'ROOT_ID', name: 'Root', parentId: '' },
};

const LUT_NAMES = new Set([
  'bleachbypass', 'candlelight', 'coolcontrast', 'desaturatedfog', 'evening', 'fall',
  'filmic', 'filmic2', 'filmic3', 'filmic4', 'flashback', 'foggy', 'warmcontrast',
  'sunset', 'moonlight', 'night', 'noir', 'spring', 'summer', 'winter',
]);

let DEFAULTS = null;
async function loadDefaults() {
  if (DEFAULTS) return DEFAULTS;
  const res = await fetch('./defaults.json');
  if (!res.ok) throw new Error('无法加载引擎默认文档 defaults.json');
  DEFAULTS = await res.json();
  return DEFAULTS;
}

const text = (bytes) => new TextDecoder('utf-8').decode(bytes);
const utf8 = (s) => new TextEncoder().encode(s);

// ---------- 体素 ----------

function buildChunksFromDense(shape, dense) {
  const nxc = Math.ceil(shape.x / CHUNK_SIZE);
  const nyc = Math.ceil(shape.y / CHUNK_SIZE);
  const nzc = Math.ceil(shape.z / CHUNK_SIZE);
  const slice = new Uint16Array(CHUNK_SIZE ** 3);
  const out = [];
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
            // row 已含 chunk 的 x 基址，chunk 内只加局部 x（与 Node 版一致）
            const row = (gz * shape.y + gy) * shape.x + cx * CHUNK_SIZE;
            for (let x = 0; x < CHUNK_SIZE; x += 1) {
              if (cx * CHUNK_SIZE + x >= shape.x) break;
              slice[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE] = dense[row + x];
            }
          }
        }
        out.push(boxCompress(meshChunkToBoxes(slice)));
      }
    }
  }
  return out;
}

// ---------- 实体树 ----------

function isEntitiesTree(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.ROOT_ID) return true;
  const nodes = Object.values(value).filter((v) => v && typeof v === 'object');
  if (!nodes.length) return false;
  return nodes.every(
    (n) => typeof n.type === 'number' && typeof n.parentId === 'string' && Array.isArray(n.childrenIds),
  );
}

const ENTITY_VALUE_KEYS = new Set([
  'name', 'tags', 'editLock', 'staticShadow', 'position', 'collision', 'gravity',
  'fixed', 'mass', 'friction', 'restitution', 'bounds', 'meshId', 'mesh', 'scale',
  'orientation', 'tint', 'metalness', 'shininess', 'emissive', 'defaultMotionId',
  'particle', 'damage', 'sound',
]);

function buildEntitiesTree(entitiesJson) {
  const tree = { ROOT_ID: { ...DEFAULT_ENTITIES_TREE.ROOT_ID, childrenIds: [] } };
  if (!entitiesJson || typeof entitiesJson !== 'object') return tree;
  const folders = new Map();
  for (const id of Object.keys(entitiesJson)) {
    const entity = entitiesJson[id];
    if (!entity || typeof entity !== 'object') continue;
    const value = {};
    for (const key of Object.keys(entity)) {
      if (ENTITY_VALUE_KEYS.has(key)) value[key] = entity[key];
    }
    if (value.defaultMotionId === undefined) value.defaultMotionId = '';
    const nodeId = `e_${id}`;
    let parentId = 'ROOT_ID';
    if (entity.folderId) {
      if (!folders.has(entity.folderId)) {
        const folderId = `folder_${entity.folderId}`;
        tree[folderId] = { type: 2, childrenIds: [], id: folderId, name: String(entity.folderId), parentId: 'ROOT_ID' };
        tree.ROOT_ID.childrenIds.push(folderId);
        folders.set(entity.folderId, folderId);
      }
      parentId = folders.get(entity.folderId);
    }
    tree[nodeId] = { type: 1, childrenIds: [], id: nodeId, name: String(value.name || id), parentId, value };
    tree[parentId].childrenIds.push(nodeId);
  }
  return tree;
}

// ---------- 主转换 ----------

export async function convertZip(file, options = {}) {
  const warnings = [];
  const onProgress = options.onProgress || (() => {});
  const defaults = await loadDefaults();

  onProgress(5, '读取压缩包');
  const buffer = await file.arrayBuffer();
  const entries = (await readZip(buffer)).filter((e) => !e.dir && e.data);
  if (!entries.length) throw new Error('压缩包里没有文件');

  const pick = (re) => entries.find((e) => re.test(e.name));
  const pickAll = (re) => entries.filter((e) => re.test(e.name));

  // 官方新包 = 有 config/info.json 且带 voxel；老包靠 block.json
  const officialProjects = findOfficialProjects(entries);
  const projectRoot =
    options.projectRoot ||
    officialProjects[0] ||
    (pick(/(^|\/)config\/info\.json$/i)?.name.replace(/config\/info\.json$/i, '') ?? '');
  const isOfficial = !!projectRoot && !!pick(/(^|\/)voxel-sparse\.gz$/i);

  let block = {};
  if (!isOfficial) {
    const blockEntry = pick(/(^|\/)(block|project)\.json$/i);
    if (!blockEntry) throw new Error('包内缺少 block.json / project.json：不是神岛/DAO3 导出包');
    block = JSON.parse(text(blockEntry.data));
  }

  const mapEntry = pick(/(^|\/)map\.json$/i);
  let mapJson;
  if (mapEntry) {
    try {
      mapJson = JSON.parse(text(mapEntry.data));
    } catch {}
  }

  const readTextUnder = (rel) => {
    const suffix = `${projectRoot}/${rel}`.toLowerCase();
    const entry = entries.find((e) => e.name.toLowerCase() === suffix);
    return entry ? text(entry.data).trim() : '';
  };

  const readJsonUnder = (name) => {
    const suffix = isOfficial ? `${projectRoot}/config/${name}.json`.toLowerCase() : `json/${name}.json`.toLowerCase();
    const entry = entries.find((e) => e.name.toLowerCase().endsWith(suffix));
    if (!entry) return undefined;
    try {
      return JSON.parse(text(entry.data));
    } catch (error) {
      warnings.push(`${name}.json 解析失败：${error.message}`);
      return undefined;
    }
  };

  // ---- blob 存储（内容寻址）----
  const blobs = new Map();
  const storeBlob = async (bytes) => {
    const hash = await contentHash(bytes);
    if (!blobs.has(hash)) blobs.set(hash, bytes);
    return hash;
  };
  const storeJSON = async (value) =>
    value === undefined ? undefined : storeBlob(utf8(stableStringify(value)));

  onProgress(20, '解析脚本与资源');
  const scriptEntries = (isOfficial
    ? entries.filter((e) => {
        if (!e.name.startsWith(`${projectRoot}/`)) return false;
        return /^assets\/scripts\/(server|client|other)\/[^/]+\.(js|ts)$/i.test(e.name.slice(projectRoot.length + 1));
      })
    : pickAll(/(^|\/)(scripts|code)\/[^/]+\.(js|ts)$/i)
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (!scriptEntries.length) warnings.push('包内没有脚本');
  const scriptAssets = {};
  const scriptSources = new Map();
  for (const entry of scriptEntries) {
    const base = entry.name.split('/').pop();
    const isClient = officialProjects.length
      ? /\/client\//i.test(entry.name)
      : /^client/i.test(base) || /clientindex/i.test(base);
    scriptSources.set(base, entry.data);
    scriptAssets[base] = {
      ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
      type: isClient ? 7 : 1,
      hash: await storeBlob(entry.data),
      size: entry.data.length, previewImage: '',
    };
  }

  // ---- 体素 ----
  onProgress(35, '展开体素');
  const payloadEntry = isOfficial
    ? entries.find((e) => e.name === `${projectRoot}/voxel-sparse.gz`)
    : pick(/(^|\/)voxel-sparse\.gz$/i);
  let shape = null;
  let dense = null;
  let voxelCount = 0;
  if (payloadEntry) {
    try {
      const payload = JSON.parse(text(await gunzip(payloadEntry.data)));
      if (payload && Array.isArray(payload.shape)) {
        const [sx, sy, sz] = payload.shape.map((v) => Number(v) | 0);
        shape = { x: sx, y: sy, z: sz };
        dense = new Uint16Array(sx * sy * sz);
        const { indices = [], data = [], rot = [] } = payload;
        for (let k = 0; k < indices.length; k += 1) {
          const id = data[k] | 0;
          if (!id) continue;
          dense[indices[k]] = packBlock(id, rot[k] | 0);
          voxelCount += 1;
        }
      }
    } catch (error) {
      warnings.push(`voxel-sparse.gz 解析失败：${error.message}`);
    }
  }

  const rawChunks = new Map();
  for (const entry of pickAll(/(^|\/)terrain\/raw\/chunk_(\d+)_Qm[1-9A-HJ-NP-Za-km-z]{44}\.bin$/i)) {
    const m = entry.name.match(/chunk_(\d+)_Qm/i);
    rawChunks.set(Number(m[1]), entry.data);
  }

  const chunks = [];
  if (shape && dense) {
    const built = buildChunksFromDense(shape, dense);
    for (const bytes of built) {
      const isEmpty = bytes.length === 2 && bytes[0] === 0 && bytes[1] === 0;
      chunks.push(await storeBlob(isEmpty ? EMPTY_CHUNK_BYTES : bytes));
    }
  } else if (rawChunks.size) {
    warnings.push('缺少 voxel-sparse.gz：改用 terrain/raw 区块重建（可能不完整）');
    const total = Math.max(...rawChunks.keys()) + 1;
    const side = Math.round(Math.cbrt(total));
    const dim = side ** 3 === total ? side * CHUNK_SIZE : 128;
    shape = { x: dim, y: dim, z: dim };
    for (let i = 0; i < total; i += 1) {
      chunks.push(await storeBlob(rawChunks.get(i) || EMPTY_CHUNK_BYTES));
    }
  } else {
    warnings.push('包内没有体素数据');
    shape = { x: 128, y: 128, z: 128 };
  }

  // ---- 配置文档 ----
  const player = readJsonUnder('player');
  const physics = readJsonUnder('physics');
  const environment = readJsonUnder('environment');
  const zones = readJsonUnder('zones') ?? [];
  const info = readJsonUnder('info');
  const ambientSound = readJsonUnder('ambientSound');
  const uiTreeDoc = readJsonUnder('uiTree');
  const gamepadDoc = readJsonUnder('gamepad');
  const deleteAssetsDoc = readJsonUnder('deleteAssets');

  let entitiesDoc = readJsonUnder('entities');
  let entitiesTreeDoc = readJsonUnder('entitiesTree');
  // 外部传入的实体树优先（精简导出包常把 entitiesTree 单独导出）
  if (options.entitiesTree && isEntitiesTree(options.entitiesTree)) {
    entitiesTreeDoc = options.entitiesTree;
    entitiesDoc = undefined;
  }
  if (!entitiesTreeDoc && isEntitiesTree(entitiesDoc)) {
    entitiesTreeDoc = entitiesDoc;
    entitiesDoc = undefined;
  }

  // ---- 资源 ----
  onProgress(55, '登记模型与媒体');
  const assets = {};
  const audioAssets = {};
  let gltfCount = 0;
  let voxaCount = 0;
  let voxConverted = 0;

  const audioEntries = isOfficial
    ? pickAll(/(^|\/)public\/audios\/[^/]+\.(mp3|wav|ogg|m4a|aac)/i)
    : pickAll(/(^|\/)audio\/[^/]+\.(mp3|wav|ogg|m4a|aac)/i);
  for (const entry of audioEntries) {
    const base = entry.name.split('/').pop();
    audioAssets[`audio/${base}`] = {
      id: '', updateAt: 0, type: 6, hash: await storeBlob(entry.data),
      size: entry.data.length, previewImage: '',
    };
  }

  // 图片：registry 的 hash 必须指向 {hash,width,height} 元数据（bake 会 JSON.parse）
  const pictureAssets = {};
  const imageEntries = isOfficial
    ? pickAll(/(^|\/)public\/images\/(.+\.(?:png|jpe?g|webp|gif|bmp))$/i)
    : pickAll(/(^|\/)images\/(.+\.(?:png|jpe?g|webp|gif|bmp))$/i);
  for (const entry of imageEntries) {
    const relative = isOfficial
      ? `picture/${entry.name.split('/').pop()}`
      : entry.name.match(/images\/(.+\.(?:png|jpe?g|webp|gif|bmp))$/i)[1];
    if (!isRealImage(entry.data, relative)) continue;
    const hash = await storeBlob(entry.data);
    const { width, height } = probeImageSize(entry.data, relative);
    const metadataHash = await storeJSON({ hash, width, height });
    if (LUT_NAMES.has(relative.replace(/\.[^.]+$/, '').toLowerCase())) continue;
    pictureAssets[relative] = {
      id: '', updateAt: 0, type: 8, hash: metadataHash,
      size: entry.data.length, previewImage: '',
    };
  }

  // 模型
  if (isOfficial) {
    const modelFiles = pickAll(/(^|\/)public\/models\/([^/]+)\/([^/]+\.(?:json|bin|gltf))$/i);
    const byName = new Map();
    for (const entry of modelFiles) {
      const m = entry.name.match(/public\/models\/([^/]+)\/([^/]+\.(?:json|bin|gltf))$/i);
      if (!byName.has(m[1])) byName.set(m[1], {});
      byName.get(m[1])[m[2].toLowerCase().split('.').pop()] = entry;
    }
    for (const [name, parts] of byName) {
      if (parts.json && parts.bin) {
        try {
          const meta = JSON.parse(text(parts.json.data));
          const binHash = await storeBlob(parts.bin.data);
          const metaHash = await storeJSON({ ...meta, dataHash: binHash });
          assets[`mesh/${name}.vb`] = {
            ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
            type: 2, hash: metaHash, size: parts.json.data.length + parts.bin.data.length, previewImage: '',
          };
          voxaCount += 1;
        } catch {
          warnings.push(`模型 ${name} 元数据解析失败`);
        }
      }
      if (parts.gltf) {
        const bounds = parseGltfBounds(parts.gltf.data);
        if (bounds) {
          const gltfHash = await storeBlob(parts.gltf.data);
          const metadataHash = await storeJSON({ bounds: bounds.bounds });
          const record = {
            ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
            type: 9, hash: gltfHash, metadataHash, size: parts.gltf.data.length, previewImage: '',
          };
          assets[`gltf/${name}`] = record;
          if (!assets[`mesh/${name}.vb`]) assets[`mesh/${name}.vb`] = { ...record };
          gltfCount += 1;
        }
      }
    }
  } else {
    const MODEL_ENTRY = /(^|\/)(?:meshes|models)\/(.+\.(?:vox|vb|glb|gltf))$/i;
    for (const entry of pickAll(MODEL_ENTRY)) {
      const relative = entry.name.match(MODEL_ENTRY)[2];
      const ext = relative.toLowerCase().split('.').pop();
      const base = relative.split('/').pop().replace(/\.[^.]+$/, '');

      if (ext === 'vox') {
        try {
          const { sizeX, sizeY, sizeZ, voxels, palette } = parseVox(entry.data);
          const vb = buildVbFileData(sizeX, sizeY, sizeZ, voxels, palette, base);
          const dataHash = await storeBlob(utf8(JSON.stringify(vb)));
          const metaHash = await storeJSON({
            version: 7, bounds: [sizeX, sizeZ, sizeY], dataHash, motionList: [],
          });
          assets[`mesh/${base}.vb`] = {
            ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
            type: 2, hash: metaHash, size: entry.data.length, previewImage: '',
          };
          voxConverted += 1;
        } catch (error) {
          warnings.push(`.vox 转换失败 ${relative}：${error.message.slice(0, 40)}`);
        }
        continue;
      }

      if (ext === 'gltf' || ext === 'glb') {
        const bounds = parseGltfBounds(entry.data);
        if (!bounds) {
          warnings.push(`glTF ${relative} 包围盒解析失败`);
          continue;
        }
        const hash = await storeBlob(entry.data);
        const metadataHash = await storeJSON({ bounds: bounds.bounds });
        const record = {
          ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
          type: 9, hash, metadataHash, size: entry.data.length, previewImage: '',
        };
        assets[`gltf/${base}`] = record;
        if (!assets[`mesh/${base}.vb`]) assets[`mesh/${base}.vb`] = { ...record };
        gltfCount += 1;
        continue;
      }

      // .vb：内容本身就是元数据 JSON
      assets[`mesh/${base}.vb`] = {
        ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
        type: 2, hash: await storeBlob(entry.data), size: entry.data.length, previewImage: '',
      };
      voxaCount += 1;
    }
  }

  // 实体引用的缺失模型 → 占位方块
  if (entitiesDoc && typeof entitiesDoc === 'object' && !entitiesTreeDoc) {
    const missing = new Set();
    for (const entity of Object.values(entitiesDoc)) {
      const mesh = entity && typeof entity === 'object' ? entity.mesh : undefined;
      if (typeof mesh === 'string' && mesh.startsWith('mesh/') && !assets[mesh]) missing.add(mesh);
    }
    for (const meshPath of missing) {
      const base = meshPath.replace(/^mesh\//, '').replace(/\.vb$/, '');
      const vb = buildVbFileData(1, 1, 1, new Map([[0, 1]]), null, base);
      const dataHash = await storeBlob(utf8(JSON.stringify(vb)));
      assets[meshPath] = {
        ownerId: 0, contentId: 0, bounds: [0, 0, 0], animated: false,
        type: 2, hash: await storeJSON({ version: 7, bounds: [1, 1, 1], dataHash, motionList: [] }),
        size: 0, previewImage: '',
      };
    }
    if (missing.size) warnings.push(`${missing.size} 个实体的模型原包缺失，已生成占位方块`);
  }

  // ---- 工程文档 ----
  onProgress(75, '组装工程文档');
  const scriptIndex = scriptAssets['index.js'] ? 'index.js' : Object.keys(scriptAssets)[0] || 'index.js';
  const zipBaseName = file.name.replace(/\.zip$/i, '');
  const rawName = String(
    (isOfficial ? readTextUnder('meta/displayName.txt') : '') ||
      info?.displayName || block?.info?.displayName || mapJson?.name || '',
  );
  const GENERIC = new Set(['project', 'untitled', 'new map', 'blank map', '新作品', '未命名', '无标题']);
  const cleaned = rawName.replace(/\s+/g, ' ').trim();
  const zipBase = zipBaseName.replace(/[-_ ]?master[-_ ]?export$/i, '').replace(/\s+/g, ' ').trim();
  const displayName =
    cleaned && !GENERIC.has(cleaned.toLowerCase()) ? cleaned : zipBase || cleaned || zipBaseName || '未命名地图';

  const worldId = `map-${(await contentHash(utf8(displayName))).slice(-6).toLowerCase()}`;

  const resolvedEntitiesTree =
    entitiesTreeDoc || (entitiesDoc ? buildEntitiesTree(entitiesDoc) : defaults.entitiesTree || DEFAULT_ENTITIES_TREE);
  const entityCount = Object.values(resolvedEntitiesTree).filter((n) => n && n.type === 1).length;

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
    voxels: await storeJSON({ shape, chunks }),
    scriptAssets: await storeJSON(scriptAssets),
    deleteAssets: await storeJSON(deleteAssetsDoc ?? []),
    uiTree: await storeJSON(uiTreeDoc || defaults.uiTree || DEFAULT_UI_TREE),
    info: await storeJSON({ ...defaults.info, ...(info || {}), displayName }),
    entitiesTree: await storeJSON(resolvedEntitiesTree),
    player: await storeJSON({ ...defaults.player, ...(player || {}) }),
    environment: await storeJSON({ ...defaults.environment, ...(environment || {}) }),
    physics: await storeJSON({ ...defaults.physics, ...(physics || {}) }),
    ambientSound: await storeJSON({ ...defaults.ambientSound, ...(ambientSound || {}) }),
    gamepad: await storeJSON(gamepadDoc || defaults.gamepad),
    zones: await storeJSON(zones),
    assets: await storeJSON(assets),
    audioAssets: await storeJSON(audioAssets),
    pictureAssets: await storeJSON(pictureAssets),
  };

  const projectHash = await storeJSON(projectDoc);
  const versionControlHash = await storeJSON({
    branches: { master: { headHash: projectHash, name: 'master' } },
    currentBranch: 'master',
  });
  const emptyObj = await storeJSON({});
  const emptyList = await storeJSON([]);
  const permissionHash = await storeJSON({
    type: 'permission',
    version: PERMISSION_VERSION,
    accessLevel: 1,
    banned: emptyList,
    collaborators: emptyList,
    groups: emptyObj,
    owner: 0,
    prevHash: '',
    timestamp: new Date(0).toISOString(),
    users: emptyObj,
    versionControl: versionControlHash,
  });

  const extraProjectHash = await storeBlob(new Uint8Array(0));
  let cloudMapId = isOfficial ? readTextUnder('meta/mapId.txt') : '';
  if (!cloudMapId) {
    const mapMeta = entries.find((e) => /(^|\/)project\/map\.json$/i.test(e.name));
    if (mapMeta) {
      try {
        const parsed = JSON.parse(text(mapMeta.data));
        if (Number.isSafeInteger(parsed?.id) && parsed.id > 0) cloudMapId = String(parsed.id);
      } catch {}
    }
  }
  if (!cloudMapId) {
    const mf = entries.find((e) => /(^|\/)export-manifest\.json$/i.test(e.name));
    if (mf) {
      try {
        const parsed = JSON.parse(text(mf.data));
        if (Number.isSafeInteger(parsed?.map?.id) && parsed.map.id > 0) cloudMapId = String(parsed.map.id);
      } catch {}
    }
  }
  const state = { formatVersion: 1, permissionHash, extraProjectHash };
  if (cloudMapId && /^\d+$/.test(cloudMapId)) state.cloudMapId = Number(cloudMapId);

  const permanentMapId = (await contentHash(utf8(displayName))).slice(0, 20);

  onProgress(85, '打包');
  return {
    worldId,
    displayName,
    shape,
    voxelCount,
    blobs,
    blobsCount: blobs.size,
    scriptNames: Object.keys(scriptAssets),
    meshCount: Object.keys(assets).length,
    gltfCount,
    voxaCount,
    voxConverted,
    entityCount,
    pictureCount: Object.keys(pictureAssets).length,
    audioCount: Object.keys(audioAssets).length,
    warnings,
    manifest: {
      id: worldId,
      publicId: worldId,
      permanentMapId,
      permanentMapGroupId: permanentMapId,
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
    defaults,
  };
}

export function findOfficialProjects(entries) {
  const roots = [];
  for (const entry of entries) {
    if (!/voxel-sparse\.gz$/i.test(entry.name)) continue;
    const root = entry.name.split('/').slice(0, -1).join('/');
    if (!root) continue;
    const hasMeta = entries.some(
      (c) => c.name.toLowerCase() === `${root.toLowerCase()}/meta/displayname.txt`,
    );
    if (hasMeta) roots.push(root);
  }
  return roots;
}

// ---------- 打包 ----------

async function runtimeBlobs() {
  const res = await fetch('./runtime/runtime-blobs.json');
  if (!res.ok) return { hashes: [], load: async () => null };
  const manifest = await res.json();
  const hashes = Array.isArray(manifest.hashes) ? manifest.hashes : [];
  return {
    hashes,
    load: async (hash) => {
      const r = await fetch(`./runtime/blobs/${encodeURIComponent(hash)}`);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

// 只把运行时资源里「工程没有的」补进来
async function collectAllBlobs(result) {
  const all = new Map(result.blobs);
  const runtime = await runtimeBlobs();
  for (const hash of runtime.hashes) {
    if (all.has(hash)) continue;
    const bytes = await runtime.load(hash);
    if (bytes) all.set(hash, bytes);
  }
  return { all, runtimeHashes: runtime.hashes };
}

export async function buildBoxProject(result, onProgress = () => {}) {
  const { all, runtimeHashes } = await collectAllBlobs(result);
  onProgress(92, '写入工程包');
  const entries = [];
  const member = `projects/${result.worldId}`;
  for (const [hash, bytes] of all) entries.push({ path: `${member}/source/blobs/${hash}`, data: bytes });
  entries.push({
    path: `${member}/source/project-state.json`,
    data: utf8(stableStringify(result.state)),
  });
  entries.push({
    path: `${member}/source/runtime-blobs.json`,
    data: utf8(JSON.stringify({ formatVersion: 1, hashes: [...runtimeHashes].sort() }, null, 2)),
  });
  const now = new Date().toISOString();
  entries.push({
    path: `${member}/project.json`,
    data: utf8(JSON.stringify({
      formatVersion: 1, id: result.worldId, permanentMapId: result.manifest.permanentMapId,
      publicId: result.worldId, name: result.displayName, author: '', description: result.manifest.description,
      cover: '', loadingCover: '', theme: 'sunset', createdAt: now, updatedAt: now, releases: [],
      mapGroupId: result.worldId, mapRole: 'main', mainProjectId: result.worldId,
    }, null, 2)),
  });
  entries.push({
    path: `${member}/group-state.json`,
    data: utf8(JSON.stringify({ formatVersion: 1, mapGroupId: result.worldId, mainProjectId: result.worldId, createdAt: now, updatedAt: now }, null, 2)),
  });
  entries.push({
    path: 'group.json',
    data: utf8(JSON.stringify({
      formatVersion: 2, type: 'map-group', mapGroupId: result.worldId, mainProjectId: result.worldId,
      exportedProjectId: result.worldId, exportedAt: now,
      members: [{ id: result.worldId, publicId: result.worldId, name: result.displayName, mapRole: 'main', mainProjectId: result.worldId }],
    }, null, 2)),
  });
  const tar = await buildTarGz(entries);
  return { blob: new Blob([tar], { type: 'application/gzip' }), filename: `${safeName(result.displayName)}_${result.worldId}.boxproject` };
}

export async function buildBoxPlay(result, onProgress = () => {}) {
  const { all, runtimeHashes } = await collectAllBlobs(result);
  onProgress(92, '写入游玩包');
  const entries = [];
  const world = `worlds/${result.worldId}`;
  for (const [hash, bytes] of all) entries.push({ path: `${world}/data/blobs/${hash}`, data: bytes });
  entries.push({ path: `${world}/data/project-state.json`, data: utf8(stableStringify(result.state)) });
  entries.push({
    path: `${world}/data/runtime-blobs.json`,
    data: utf8(JSON.stringify({ formatVersion: 1, hashes: [...new Set([...runtimeHashes, ...result.blobs.keys()])].sort() }, null, 2)),
  });
  entries.push({ path: `${world}/data/private-blobs.json`, data: utf8(JSON.stringify({ formatVersion: 1, hashes: [] }, null, 2)) });
  entries.push({
    path: `${world}/manifest.json`,
    data: utf8(JSON.stringify({
      id: result.worldId, version: result.manifest.version, mapGroupId: result.manifest.mapGroupId,
      permanentMapId: result.manifest.permanentMapId, publicId: result.manifest.publicId,
      mainProjectId: result.manifest.mainProjectId, mapRole: result.manifest.mapRole,
      projectName: result.displayName, author: '', description: result.manifest.description,
      cover: '', loadingCover: '', playEnabled: true, permissionHash: result.manifest.permissionHash,
    }, null, 2)),
  });
  const now = new Date().toISOString();
  entries.push({
    path: 'bundle.json',
    data: utf8(JSON.stringify({
      formatVersion: 1, type: 'map-group-play-bundle', mapGroupId: result.manifest.mapGroupId,
      permanentMapGroupId: result.manifest.permanentMapGroupId, mainProjectId: result.worldId,
      version: result.manifest.version, createdAt: now,
      members: [{ id: result.worldId, permanentMapId: result.manifest.permanentMapId, publicId: result.manifest.publicId, name: result.displayName, mapRole: 'main', mainProjectId: result.worldId }],
    }, null, 2)),
  });
  const tar = await buildTarGz(entries);
  return { blob: new Blob([tar], { type: 'application/gzip' }), filename: `${safeName(result.displayName)}_${result.worldId}.boxplay` };
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '作品';
}
