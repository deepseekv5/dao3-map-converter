// MagicaVoxel .vox → 官方 VbFileData（.vb blob 内容）
//
// 引擎对 type=2 (VOXEL_MODEL) 资产的处理：blob 内容 JSON.parse 成 VbFileData，
// 交给官方 parseVbFile（内部跑 ao-mesher 网格化）。见
// services/game-server/src/…/migrate-voxel.ts 的 migrateIPFSModel。
// 所以转换器只需产出合法的 VbFileData JSON：
//   { HEXCOLORS[4][256], PBRATTRBS[4][256], CURRENTCOLORINDEX, ENCODEVOXELS, filename }
//
// ENCODEVOXELS = int32 nx,ny,nz + RLE(varint runLen-1, varint block)，
// 扫描顺序 x→y→z（与 packages/utils/src/rle-compress.ts 的 compress 一致，
// 体素 stride [1,nx,nx*ny]）。
//
// 轴变换：MagicaVoxel 是 z 朝上，引擎是 y 朝上——
// engine(x,y,z) = vox(x, z, y)。

const VOX_MAGIC = Buffer.from('VOX ', 'latin1');
const VOX_DEFAULT_PALETTE = buildDefaultPalette();

function buildDefaultPalette() {
  // MagicaVoxel 官方默认调色板（无 RGBA chunk 时使用）
  const hex = [
    'ffffff','ffffcc','ffff99','ffff66','ffff33','ffff00','ffccff','ffcccc','ffcc99','ffcc66','ffcc33','ffcc00','ff99ff','ff99cc','ff9999','ff9966',
    'ff9933','ff9900','ff66ff','ff66cc','ff6699','ff6666','ff6633','ff6600','ff33ff','ff33cc','ff3399','ff3366','ff3333','ff3300','ff00ff','ff00cc',
    'ff0099','ff0066','ff0033','ff0000','ccffff','ccccff','cc99ff','cc66ff','cc33ff','cc00ff','ccffcc','cccccc','cc99cc','cc66cc','cc33cc','cc00cc',
    'ccff99','cccb99','cc9999','cc6699','cc3399','cc0099','ccff66','cccb66','cc9966','cc6666','cc3366','cc0066','ccff33','cccc33','cc9933','cc6633',
    'cc3300','cc0000','99ffff','99ccff','9999ff','9966ff','9933ff','9900ff','99ffcc','99cccc','9999cc','9966cc','9933cc','9900cc','99ff99','99cc99',
    '999999','996699','993399','990099','99ff66','99cb66','999966','996666','993366','990066','99ff33','99cc33','999933','996633','993333','990033',
    '99ff00','99cc00','999900','996600','993300','990000','66ffff','66ccff','6699ff','6666ff','6633ff','6600ff','66ffcc','66cccc','6699cc','6666cc',
    '6633cc','6600cc','66ff99','66cb99','669999','666699','663399','660099','66ff66','66cc66','666666','663366','660066','66ff33','66cb33','669933',
    '666633','663333','660033','66ff00','66cb00','669900','666600','663300','660000','33ffff','33cbff','3399ff','3366ff','3333ff','3300ff','33ffcc',
    '33cccc','3399cc','3366cc','3333cc','3300cc','33ff99','33cb99','339999','336699','333399','330099','33ff66','33cb66','339966','336666','333366',
    '330066','33ff33','33cb33','339933','336633','333333','330033','33ff00','33cb00','339900','336600','333300','330000','00ffff','00ccff','0099ff',
    '0066ff','0033ff','0000ff','00ffcc','00cccc','0099cc','0066cc','0033cc','0000cc','00ff99','00cb99','009999','006699','003399','000099','00ff66',
    '00cb66','009966','006666','003366','000066','00ff33','00cb33','009933','006633','003333','000033','00ff00','00cb00','009900','006600','003300',
    '000000',
  ];
  return hex.map((h) => `#${h}`);
}

// 解析 .vox 二进制 → { sizeX, sizeY, sizeZ, voxels: Map('x,y,z' -> colorIndex), palette }
export function parseVox(buffer) {
  if (buffer.length < 20 || !buffer.subarray(0, 4).equals(VOX_MAGIC)) {
    throw new Error('不是有效的 MagicaVoxel .vox 文件');
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 150 && version !== 200) {
    throw new Error(`不支持的 .vox 版本：${version}`);
  }
  let sizeX = 0;
  let sizeY = 0;
  let sizeZ = 0;
  const voxels = new Map(); // key = x + y*sx + z*sx*sy（vox 坐标）
  let palette = null;
  // 遍历 chunk：跳过 MAIN header 后逐个读 chunk id
  let offset = 20;
  while (offset + 12 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const contentSize = buffer.readUInt32LE(offset + 4);
    const childrenSize = buffer.readUInt32LE(offset + 8);
    const contentStart = offset + 12;
    if (id === 'SIZE') {
      sizeX = buffer.readUInt32LE(contentStart);
      sizeY = buffer.readUInt32LE(contentStart + 4);
      sizeZ = buffer.readUInt32LE(contentStart + 8);
    } else if (id === 'XYZI') {
      const numVoxels = buffer.readUInt32LE(contentStart);
      for (let i = 0; i < numVoxels; i += 1) {
        const base = contentStart + 4 + i * 4;
        const x = buffer[base];
        const y = buffer[base + 1];
        const z = buffer[base + 2];
        const colorIndex = buffer[base + 3];
        if (colorIndex) {
          voxels.set(x + y * sizeX + z * sizeX * sizeY, colorIndex);
        }
      }
    } else if (id === 'RGBA') {
      palette = [];
      for (let i = 0; i < 256; i += 1) {
        const base = contentStart + i * 4;
        palette.push(
          `#${buffer[base].toString(16).padStart(2, '0')}${buffer[base + 1]
            .toString(16)
            .padStart(2, '0')}${buffer[base + 2].toString(16).padStart(2, '0')}`,
        );
      }
    }
    offset = contentStart + contentSize + childrenSize;
  }
  if (!sizeX || !sizeY || !sizeZ) throw new Error('.vox 缺少 SIZE chunk');
  if (!voxels.size) throw new Error('.vox 没有体素数据');
  return { sizeX, sizeY, sizeZ, voxels, palette: palette || VOX_DEFAULT_PALETTE };
}

function writeVarint(out, value) {
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

// 生成 ENCODEVOXELS：int32 尺寸 + RLE。注意轴变换 vox(x,y,z)→engine(x,z,y)。
export function buildEncodeVoxels(sizeX, sizeY, sizeZ, voxels) {
  // 引擎尺寸：nx=voxX, ny=voxZ, nz=voxY
  const nx = sizeX;
  const ny = sizeZ;
  const nz = sizeY;
  const grid = new Uint16Array(nx * ny * nz);
  for (const [key, colorIndex] of voxels) {
    const vx = key % sizeX;
    const vy = Math.floor(key / sizeX) % sizeY;
    const vz = Math.floor(key / (sizeX * sizeY));
    // engine 索引：x + y*nx + z*nx*ny，y=voxZ，z=voxY
    grid[vx + vz * nx + vy * nx * ny] = colorIndex;
  }
  const out = [];
  // int32 LE ×3
  for (const dim of [nx, ny, nz]) {
    out.push(dim & 0xff, (dim >> 8) & 0xff, (dim >> 16) & 0xff, (dim >> 24) & 0xff);
  }
  let prev = -1;
  let run = 0;
  const flush = () => {
    if (run) {
      writeVarint(out, run - 1);
      writeVarint(out, prev);
      run = 0;
    }
  };
  for (let i = 0; i < grid.length; i += 1) {
    const b = grid[i];
    if (b !== prev) {
      flush();
      prev = b;
    }
    run += 1;
  }
  flush();
  return { bytes: out, nx, ny, nz, grid };
}

// VbFileData：4 个 tab；tab0 放 .vox 调色板（index 对齐 .vox 的 colorIndex）。
export function buildVbFileData(sizeX, sizeY, sizeZ, voxels, palette, filename) {
  const { bytes } = buildEncodeVoxels(sizeX, sizeY, sizeZ, voxels);
  const effectivePalette = palette || VOX_DEFAULT_PALETTE;
  const hexColors = Array.from({ length: 4 }, () => Array(256).fill(null));
  for (let i = 1; i < 256; i += 1) {
    // RGBA[i] 对应 colorIndex i；vb-parser 用 hexColors[idx] 直接索引
    hexColors[0][i] = effectivePalette[i] || null;
  }
  const pbr = Array.from({ length: 4 }, () => Array.from({ length: 256 }, () => [0, 0, 0]));
  return {
    HEXCOLORS: hexColors,
    PBRATTRBS: pbr,
    TR: Array.from({ length: 4 }, () => Array(256).fill([255, 1])),
    CURRENTCOLORINDEX: 0,
    ENCODEVOXELS: bytes,
    filename: String(filename || 'model'),
  };
}
