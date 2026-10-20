// glTF 资产支持：解析 accessor 的 min/max 算出模型包围盒。
//
// 引擎对 GLTF_MODEL 类型只要求两样东西：
//   1) gltf 文件本体的 blob（hash）
//   2) 一个 { bounds: [x,y,z] } 元数据文档（bake 阶段 retrieveContentFromS3 读）
// 见 internals/build-system/project/bake.ts 的 getMeshInfo()。
//
// 包围盒直接从 gltf 的 accessor min/max 汇总，不需要解析二进制 buffer——
// gltf 规范要求 POSITION accessor 必须带 min/max，这是确定性信息。

const MAX_GLTF_BYTES = 64 * 1024 * 1024;

export function parseGltfBounds(buffer) {
  if (buffer.length > MAX_GLTF_BYTES) return null;
  let gltf;
  try {
    gltf = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!gltf || !Array.isArray(gltf.accessors)) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = 0;
  for (const accessor of gltf.accessors) {
    if (!accessor || accessor.type !== 'VEC3') continue;
    if (!Array.isArray(accessor.min) || !Array.isArray(accessor.max)) continue;
    found += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const lo = Number(accessor.min[axis]);
      const hi = Number(accessor.max[axis]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (lo < min[axis]) min[axis] = lo;
      if (hi > max[axis]) max[axis] = hi;
    }
  }
  if (!found) return null;
  const bounds = [0, 1, 1].map((fallback, axis) => {
    const size = max[axis] - min[axis];
    return Number.isFinite(size) && size > 0 ? size : fallback;
  });
  return { bounds };
}

// 自包含检查：gltf 可以外挂 .bin / 贴图，转换器不搬运这些依赖文件时，
// 模型在引擎里会因缺资源而不可用。这里只报告情况，由调用方决定是否登记。
export function inspectGltf(buffer) {
  let gltf;
  try {
    gltf = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { ok: false, reason: '不是有效的 gltf JSON' };
  }
  const externalBuffers = [];
  for (const bufferEntry of gltf.buffers || []) {
    const uri = String(bufferEntry?.uri || '');
    // data: application/octet-stream;base64,... 是内嵌，其它都是外挂
    if (uri && !/^data:/i.test(uri)) externalBuffers.push(uri);
  }
  const externalImages = [];
  for (const image of gltf.images || []) {
    const uri = String(image?.uri || '');
    if (uri && !/^data:/i.test(uri)) externalImages.push(uri);
  }
  return {
    ok: true,
    externalBuffers,
    externalImages,
    selfContained: externalBuffers.length === 0 && externalImages.length === 0,
  };
}
