// 区块二进制编解码，与官方 services/game-server/src/voxel/box-encode.ts /
// internals/schema/voxel/box-decode.ts 逐行对齐（varint=LEB128）。
export const CHUNK_SIZE = 32;
export const CHUNK_MASK = CHUNK_SIZE - 1;
export const ROT_SHIFT = 14;
export const BLOCK_MASK = 0x0fff;

export function packBlock(id, rot = 0) {
  return ((id + rot * 16384) >>> 0) & 0xffff;
}
export function unpackBlock(value) {
  return { id: value & BLOCK_MASK, rot: value >>> ROT_SHIFT };
}

function signEncode(x) {
  const y = x & CHUNK_MASK;
  if (y > 16) return ((CHUNK_MASK - y) << 1) + 1;
  return y << 1;
}
function signDecode(x) {
  if (x & 1) return -(x >> 1) - 1;
  return x >> 1;
}
export function interleave3(x_, y_, z_) {
  let x = x_;
  x = (x | (x << 16)) & 4278190335;
  x = (x | (x << 8)) & 251719695;
  x = (x | (x << 4)) & 3272356035;
  x = (x | (x << 2)) & 1227133513;
  let y = y_;
  y = (y | (y << 16)) & 4278190335;
  y = (y | (y << 8)) & 251719695;
  y = (y | (y << 4)) & 3272356035;
  y = (y | (y << 2)) & 1227133513;
  x |= y << 1;
  let z = z_;
  z = (z | (z << 16)) & 4278190335;
  z = (z | (z << 8)) & 251719695;
  z = (z | (z << 4)) & 3272356035;
  z = (z | (z << 2)) & 1227133513;
  return x | (z << 2);
}
export function deinterleave3(v_) {
  let v = v_ & 1227133513;
  v = (v | (v >>> 2)) & 3272356035;
  v = (v | (v >>> 4)) & 251719695;
  v = (v | (v >>> 8)) & 4278190335;
  v = (v | (v >>> 16)) & 0x3ff;
  return (v << 22) >> 22;
}

export function writeVarint(out, x) {
  const v = x >>> 0;
  if (v < 0x80) {
    out.push(v);
  } else if (v < 0x4000) {
    out.push((v & 0x7f) | 0x80, v >>> 7);
  } else if (v < 0x200000) {
    out.push((v & 0x7f) | 0x80, ((v >> 7) & 0x7f) | 0x80, v >>> 14);
  } else if (v < 0x10000000) {
    out.push((v & 0x7f) | 0x80, ((v >> 7) & 0x7f) | 0x80, ((v >> 14) & 0x7f) | 0x80, v >>> 21);
  } else {
    out.push(
      (v & 0x7f) | 0x80,
      ((v >> 7) & 0x7f) | 0x80,
      ((v >> 14) & 0x7f) | 0x80,
      ((v >> 21) & 0x7f) | 0x80,
      v >>> 28,
    );
  }
}
export function readVarint(buf, state) {
  let x = 0;
  let shift = 0;
  for (;;) {
    const b = buf[state.o++];
    x |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return x >>> 0;
}

// boxes: [{minX,minY,minZ,maxX,maxY,maxZ,block}]，max 为开区间上界（0..32）
export function boxCompress(boxes) {
  // 官方用普通对象计数：整数键经 Object.keys 按数值升序返回，编码字节才能与官方产物一致
  const counts = {};
  for (const box of boxes) {
    counts[box.block] = (counts[box.block] || 0) + 1;
  }
  const ids = Object.keys(counts)
    .map((key) => +key)
    .sort((a, b) => counts[a] - counts[b]);
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  const out = [];
  writeVarint(out, ids.length);
  writeVarint(out, boxes.length);
  for (const id of ids) writeVarint(out, id);
  let pX = 0;
  let pY = 0;
  let pZ = 0;
  for (const box of boxes) {
    const { minX, minY, minZ, maxX, maxY, maxZ, block } = box;
    const minCode = interleave3(
      signEncode(minX - pX),
      signEncode(minY - pY),
      signEncode(minZ - pZ),
    );
    const maxCode = interleave3(maxX - minX, maxY - minY, maxZ - minZ);
    writeVarint(out, minCode);
    writeVarint(out, maxCode);
    writeVarint(out, idIndex.get(block));
    pX = minX;
    pY = minY;
    pZ = minZ;
  }
  return Buffer.from(out);
}

export function boxDecompress(buf) {
  const state = { o: 0 };
  const numIds = readVarint(buf, state);
  const numBoxes = readVarint(buf, state);
  const idTable = [];
  for (let i = 0; i < numIds; i += 1) idTable.push(readVarint(buf, state));
  const boxes = [];
  let pX = 0;
  let pY = 0;
  let pZ = 0;
  for (let i = 0; i < numBoxes; i += 1) {
    const minCode = readVarint(buf, state);
    const maxCode = readVarint(buf, state);
    const idCode = readVarint(buf, state);
    const x0 = deinterleave3(minCode);
    const y0 = deinterleave3(minCode >>> 1);
    const z0 = deinterleave3(minCode >>> 2);
    const box = {
      minX: (signDecode(x0) + pX) & CHUNK_MASK,
      minY: (signDecode(y0) + pY) & CHUNK_MASK,
      minZ: (signDecode(z0) + pZ) & CHUNK_MASK,
    };
    const x1 = deinterleave3(maxCode);
    const y1 = deinterleave3(maxCode >>> 1);
    const z1 = deinterleave3(maxCode >>> 2);
    box.maxX = x1 + box.minX;
    box.maxY = y1 + box.minY;
    box.maxZ = z1 + box.minZ;
    box.block = idTable[idCode];
    pX = box.minX;
    pY = box.minY;
    pZ = box.minZ;
    boxes.push(box);
  }
  return boxes;
}

// 与官方 meshChunkToBoxes 同目标：把 32³ 区块数组压缩成不重叠长方体。
// 官方按 x→y→z 贪心生长；这里做同样的三维贪心，保证与官方产物同量级。
export function meshChunkToBoxes(data32) {
  const visited = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
  const boxes = [];
  const val = (x, y, z) => data32[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE];
  const mark = (x0, x1, y0, y1, z0, z1) => {
    for (let z = z0; z < z1; z += 1)
      for (let y = y0; y < y1; y += 1)
        for (let x = x0; x < x1; x += 1) visited[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE] = 1;
  };
  for (let z = 0; z < CHUNK_SIZE; z += 1) {
    for (let y = 0; y < CHUNK_SIZE; y += 1) {
      for (let x = 0; x < CHUNK_SIZE; x += 1) {
        if (visited[x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE]) continue;
        const block = val(x, y, z);
        if (block === 0) continue;
        let x1 = x + 1;
        while (x1 < CHUNK_SIZE && !visited[x1 + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE] && val(x1, y, z) === block) x1 += 1;
        let y1 = y + 1;
        yloop: while (y1 < CHUNK_SIZE) {
          for (let i = x; i < x1; i += 1) {
            if (visited[i + y1 * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE] || val(i, y1, z) !== block) break yloop;
          }
          y1 += 1;
        }
        let z1 = z + 1;
        zloop: while (z1 < CHUNK_SIZE) {
          for (let j = y; j < y1; j += 1) {
            for (let i = x; i < x1; i += 1) {
              if (visited[i + j * CHUNK_SIZE + z1 * CHUNK_SIZE * CHUNK_SIZE] || val(i, j, z1) !== block) break zloop;
            }
          }
          z1 += 1;
        }
        mark(x, x1, y, y1, z, z1);
        boxes.push({ minX: x, minY: y, minZ: z, maxX: x1, maxY: y1, maxZ: z1, block });
      }
    }
  }
  return boxes;
}

export const EMPTY_CHUNK_BYTES = Buffer.from([0, 0]);
