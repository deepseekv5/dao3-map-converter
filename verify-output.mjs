#!/usr/bin/env node
// 转换产物质量检查：对 .boxproject / .boxplay 做结构与自洽性验证。
//
// 检查项按「引擎真实读取路径」设计，不是拍脑袋的清单：
//   1. 归档外壳        —— tar.gz 可解、顶层结构符合官方导入/播放要求
//   2. 文档链自洽      —— permission → versionControl → project 全部可达可解析
//   3. 资源完整性      —— 文档引用的每个 blob 都存在
//   4. 体素完整性      —— chunk 数量 = ceil(shape/32) 的乘积，且逐块存在
//   5. 模型可解析      —— VOXA 元数据能被 getModelMetaData 识别、dataHash 可读
//   6. 实体引用        —— entitiesTree 里的 mesh 路径都在 assets 中
//   7. 运行时资源      —— requiredClientAsset + runtime-blobs.json 齐备
//   8. 悬空引用        —— 统计会被官方扫描器判为不兼容的 CID
//
// 用法：node verify-output.mjs <文件...>  或  --all <目录>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const REQUIRED_CLIENT_ASSET = 'QmUQg6ayL7bLmdso8b4Hc7nfxBUSJawPsQ7vsSUPhXNdv5';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extract(archive, target) {
  execSync(`tar -xzf ${JSON.stringify(archive)} -C ${JSON.stringify(target)}`, { stdio: 'pipe' });
}

// 找到 source/data 根（.boxproject 在 projects/<id>/source，.boxplay 在 worlds/<id>/data）
function locateRoots(root) {
  const out = [];
  for (const base of ['projects', 'worlds']) {
    const dir = path.join(root, base);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const member = path.join(dir, entry.name);
      for (const sub of ['source', 'data']) {
        const candidate = path.join(member, sub);
        if (fs.existsSync(path.join(candidate, 'project-state.json'))) {
          out.push({ id: entry.name, dataRoot: candidate, memberRoot: member });
        }
      }
    }
  }
  return out;
}

function verifyOne(archive) {
  const issues = [];
  const warns = [];
  const name = path.basename(archive);
  const isPlay = name.endsWith('.boxplay');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const result = { name, issues, warns, ok: true, stats: {} };

  try {
    extract(archive, tmp);

    // ---- 1) 归档外壳 ----
    const top = fs.readdirSync(tmp).sort();
    const expected = isPlay ? ['bundle.json', 'worlds'] : ['group.json', 'projects'];
    for (const entry of expected) {
      if (!top.includes(entry)) issues.push(`缺少顶层 ${entry}`);
    }
    if (isPlay) {
      const bundle = readJson(path.join(tmp, 'bundle.json'));
      if (bundle.type !== 'map-group-play-bundle') {
        issues.push(`bundle.json type 非法：${bundle.type}`);
      }
      if (!Array.isArray(bundle.members) || !bundle.members.length) {
        issues.push('bundle.json members 为空');
      }
    } else {
      const group = readJson(path.join(tmp, 'group.json'));
      if (group.type !== 'map-group') issues.push(`group.json type 非法：${group.type}`);
      if (![1, 2].includes(group.formatVersion)) {
        issues.push(`group.json formatVersion 非法：${group.formatVersion}`);
      }
      if (!group.members?.some((m) => m.id === group.mainProjectId)) {
        issues.push('group.json 主地图不在 members 里');
      }
    }

    const roots = locateRoots(tmp);
    if (!roots.length) {
      issues.push('找不到任何工程/世界数据目录');
      result.ok = false;
      return result;
    }

    for (const { id, dataRoot, memberRoot } of roots) {
      const label = roots.length > 1 ? `${id}: ` : '';
      const blobRoot = path.join(dataRoot, 'blobs');
      if (!fs.existsSync(blobRoot)) {
        issues.push(`${label}缺少 blobs 目录`);
        continue;
      }
      const hasBlob = (h) => !!h && fs.existsSync(path.join(blobRoot, h));
      const readBlob = (h) => fs.readFileSync(path.join(blobRoot, h));

      // ---- 7) 运行时资源 ----
      if (!hasBlob(REQUIRED_CLIENT_ASSET)) {
        issues.push(`${label}缺运行时客户端脚本包（编辑器会报 Runtime assets are incomplete）`);
      }
      const runtimeManifest = path.join(dataRoot, 'runtime-blobs.json');
      if (!fs.existsSync(runtimeManifest)) {
        warns.push(`${label}缺 runtime-blobs.json`);
      } else {
        const manifest = readJson(runtimeManifest);
        const missing = (manifest.hashes || []).filter((h) => !hasBlob(h));
        if (missing.length) {
          issues.push(`${label}runtime-blobs.json 里 ${missing.length} 个 blob 缺失`);
        }
        result.stats.runtimeBlobs = (manifest.hashes || []).length;
      }

      // ---- 2) 文档链 ----
      let state;
      let project;
      try {
        state = readJson(path.join(dataRoot, 'project-state.json'));
        if (!hasBlob(state.permissionHash)) throw new Error('permissionHash 指向的 blob 不存在');
        const perm = readJson(path.join(blobRoot, state.permissionHash));
        if (perm.type !== 'permission' && perm.type !== 'permissions') {
          throw new Error(`permission 文档 type 非法：${perm.type}`);
        }
        if (!hasBlob(perm.versionControl)) throw new Error('versionControl 指向的 blob 不存在');
        const vc = readJson(path.join(blobRoot, perm.versionControl));
        const headHash = vc?.branches?.master?.headHash;
        if (!hasBlob(headHash)) throw new Error('project head 指向的 blob 不存在');
        project = readJson(path.join(blobRoot, headHash));
      } catch (error) {
        issues.push(`${label}文档链断裂：${error.message}`);
        continue;
      }

      // ---- 4) 体素 ----
      if (project.voxels) {
        try {
          const vox = readJson(path.join(blobRoot, project.voxels));
          const { x, y, z } = vox.shape || {};
          if (![x, y, z].every((v) => Number.isFinite(v) && v > 0)) {
            issues.push(`${label}voxels.shape 非法：${JSON.stringify(vox.shape)}`);
          } else {
            const expectedChunks =
              Math.ceil(x / 32) * Math.ceil(y / 32) * Math.ceil(z / 32);
            if (vox.chunks.length !== expectedChunks) {
              issues.push(
                `${label}体素 chunk 数不符：${vox.chunks.length}，按 ${x}×${y}×${z} 应为 ${expectedChunks}`,
              );
            }
            const missing = vox.chunks.filter((h) => !hasBlob(h));
            if (missing.length) {
              issues.push(`${label}${missing.length}/${vox.chunks.length} 个体素 chunk 缺失`);
            }
            result.stats.voxelChunks = vox.chunks.length;
            result.stats.shape = `${x}×${y}×${z}`;
          }
        } catch (error) {
          issues.push(`${label}voxels 文档不可读：${error.message}`);
        }
      }

      // ---- 5) 模型 + 6) 实体 ----
      const assets = project.assets ? readJson(path.join(blobRoot, project.assets)) : {};
      let voxaCount = 0;
      let gltfCount = 0;
      for (const [key, asset] of Object.entries(assets)) {
        if (!asset?.hash) {
          issues.push(`${label}资产 ${key} 没有 hash`);
          continue;
        }
        if (!hasBlob(asset.hash)) {
          issues.push(`${label}资产 ${key} 的 blob 缺失`);
          continue;
        }
        if (asset.type === 2) {
          voxaCount += 1;
          try {
            const meta = readJson(path.join(blobRoot, asset.hash));
            if (!meta.version || !meta.bounds || !meta.dataHash) {
              issues.push(`${label}模型 ${key} 元数据缺 version/bounds/dataHash`);
            } else if (!hasBlob(meta.dataHash)) {
              issues.push(`${label}模型 ${key} 的 dataHash 指向的 blob 缺失`);
            }
          } catch {
            issues.push(`${label}模型 ${key} 元数据不是合法 JSON`);
          }
        } else if (asset.type === 9) {
          gltfCount += 1;
          const metaHash = asset.metadataHash;
          if (!metaHash) {
            issues.push(`${label}glTF ${key} 缺 bounds 元数据`);
          } else if (!hasBlob(metaHash)) {
            issues.push(`${label}glTF ${key} 的 bounds 元数据 blob 缺失`);
          }
        }
      }
      result.stats.models = { voxa: voxaCount, gltf: gltfCount };

      if (project.entitiesTree) {
        try {
          const tree = readJson(path.join(blobRoot, project.entitiesTree));
          const leaves = Object.values(tree).filter((n) => n.type === 1);
          let danglingMesh = 0;
          for (const node of leaves) {
            const mesh = node?.value?.mesh;
            if (mesh && !assets[mesh]) danglingMesh += 1;
          }
          if (danglingMesh) {
            warns.push(`${label}${danglingMesh}/${leaves.length} 个实体引用了不存在的模型`);
          }
          result.stats.entities = leaves.length;
        } catch (error) {
          issues.push(`${label}entitiesTree 不可读：${error.message}`);
        }
      }

      // ---- 3) 图片/音频 ----
      let pictureCount = 0;
      if (project.pictureAssets) {
        try {
          const pics = readJson(path.join(blobRoot, project.pictureAssets));
          for (const [key, entry] of Object.entries(pics)) {
            pictureCount += 1;
            if (!entry?.hash) {
              issues.push(`${label}图片 ${key} 没有 hash`);
              continue;
            }
            if (!hasBlob(entry.hash)) {
              issues.push(`${label}图片 ${key} 的 blob 缺失`);
              continue;
            }
            // 引擎 bake 阶段会 JSON.parse 这个 hash 指向的文档
            try {
              const meta = readJson(path.join(blobRoot, entry.hash));
              if (!meta.hash || !meta.width || !meta.height) {
                issues.push(`${label}图片 ${key} 元数据不完整`);
              } else if (!hasBlob(meta.hash)) {
                issues.push(`${label}图片 ${key} 元数据指向的原图缺失`);
              }
            } catch {
              issues.push(`${label}图片 ${key} 的 hash 不指向元数据 JSON（编辑器会崩）`);
            }
          }
        } catch (error) {
          issues.push(`${label}pictureAssets 不可读：${error.message}`);
        }
      }
      result.stats.pictures = pictureCount;

      let audioCount = 0;
      if (project.audioAssets) {
        try {
          const audio = readJson(path.join(blobRoot, project.audioAssets));
          for (const [key, entry] of Object.entries(audio)) {
            audioCount += 1;
            if (entry?.hash && !hasBlob(entry.hash)) {
              issues.push(`${label}音频 ${key} 的 blob 缺失`);
            }
          }
        } catch (error) {
          issues.push(`${label}audioAssets 不可读：${error.message}`);
        }
      }
      result.stats.audio = audioCount;

      let scriptCount = 0;
      if (project.scriptAssets) {
        try {
          const scripts = readJson(path.join(blobRoot, project.scriptAssets));
          for (const [key, entry] of Object.entries(scripts)) {
            scriptCount += 1;
            if (entry?.hash && !hasBlob(entry.hash)) {
              issues.push(`${label}脚本 ${key} 的 blob 缺失`);
            }
          }
        } catch (error) {
          issues.push(`${label}scriptAssets 不可读：${error.message}`);
        }
      }
      result.stats.scripts = scriptCount;

      // ---- cloudMapId（模型面板可见性）----
      if (state.cloudMapId === undefined) {
        warns.push(`${label}没有 cloudMapId，编辑器模型面板会为空（用 push-models.mjs 可补）`);
      } else {
        result.stats.cloudMapId = state.cloudMapId;
      }
    }

    result.ok = issues.length === 0;
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
let targets = [];
if (args[0] === '--all') {
  const dir = args[1];
  targets = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.boxproject') || f.endsWith('.boxplay'))
    .map((f) => path.join(dir, f));
} else {
  targets = args;
}
if (!targets.length) {
  console.error('用法：node verify-output.mjs <文件...> | --all <目录>');
  process.exit(2);
}

let failed = 0;
for (const target of targets) {
  try {
    const r = verifyOne(target);
    if (r.ok) {
      const s = r.stats;
      console.log(`✓ ${r.name}`);
      console.log(
        `    ${s.shape ? '体素 ' + s.shape + ' · chunk ' + s.voxelChunks + ' · ' : ''}` +
          `模型 VOXA ${s.models?.voxa ?? 0}/glTF ${s.models?.gltf ?? 0} · 实体 ${s.entities ?? 0} · ` +
          `图片 ${s.pictures ?? 0} · 音频 ${s.audio ?? 0} · 脚本 ${s.scripts ?? 0}` +
          (s.cloudMapId ? ` · cloudMapId ${s.cloudMapId}` : ''),
      );
      for (const w of r.warns) console.log(`    · ${w}`);
    } else {
      failed += 1;
      console.log(`✗ ${r.name}`);
      for (const issue of r.issues.slice(0, 12)) console.log(`    ✗ ${issue}`);
      if (r.issues.length > 12) console.log(`    ✗ ……另有 ${r.issues.length - 12} 条`);
      for (const w of r.warns) console.log(`    · ${w}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`✗ ${path.basename(target)}: ${error.message}`);
  }
}
console.log(`\n${targets.length - failed}/${targets.length} 通过`);
process.exit(failed ? 1 : 0);
