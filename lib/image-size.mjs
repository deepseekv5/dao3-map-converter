// 图片尺寸探测：只读文件头，不引第三方依赖。
// 引擎的 PictureAssetSchema 需要 { metadataHash, hash, width, height }，
// 其中 width/height 由我们探测后写进元数据文档。

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) return null;
  // IHDR 固定在第 8 字节后：length(4) + 'IHDR'(4) + width(4) + height(4)
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readGifSize(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'GIF') return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readBmpSize(buffer) {
  if (buffer.length < 26 || buffer.toString('latin1', 0, 2) !== 'BM') return null;
  // DIB 头：宽高是有符号 32 位，取绝对值
  return {
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22)),
  };
}

function readWebpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null;
  const fourCC = buffer.toString('latin1', 12, 16);
  if (fourCC === 'VP8 ') {
    // 简单无损格式：16 位尺寸各减 1
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (fourCC === 'VP8L') {
    // 有损格式：尺寸打包在一个字节流里
    const b = buffer;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourCC === 'VP8X') {
    // 扩展格式：24 位尺寸各减 1
    return { width: (buffer.readUInt8(24) | (buffer.readUInt8(25) << 8) | (buffer.readUInt8(26) << 16)) + 1,
             height: (buffer.readUInt8(27) | (buffer.readUInt8(28) << 8) | (buffer.readUInt8(29) << 16)) + 1 };
  }
  return null;
}

// JPEG：遍历 SOF 标记找尺寸
function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // 独立填充字节
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // SOS 或 EOI 之后就是扫描数据，尺寸标记不会出现在后面
    if (marker === 0xda || marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0/SOF1/SOF2/SOF3/SOF5-SOF7/SOF9-SOF11/SOF13-SOF15 都带尺寸
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 9 <= buffer.length) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

// 探测不到时给一个安全的非零值：引擎用宽高做布局，0 会让资源不可见
const FALLBACK = { width: 1, height: 1 };

// 老导出包的 images/ 目录里偶尔混着 JSON 元数据文档（误用图片扩展名）。
// 它们不是图片，登记进 pictureAssets 会把里面的 CID 变成悬空引用。
export function isRealImage(buffer, filename = '') {
  if (buffer.length < 12) return false;
  const head = buffer.subarray(0, 16);
  const isPng = head.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isGif = head.toString('latin1', 0, 3) === 'GIF';
  const isBmp = head.toString('latin1', 0, 2) === 'BM';
  const isWebp = head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  if (isPng || isJpeg || isGif || isBmp || isWebp) return true;
  // 文本型的 JSON 元数据文档：不以图片魔数开头就不是图片
  return false;
}

export function probeImageSize(buffer, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  const byExtension = {
    png: readPngSize,
    jpg: readJpegSize,
    jpeg: readJpegSize,
    gif: readGifSize,
    bmp: readBmpSize,
    webp: readWebpSize,
  };
  const reader = byExtension[ext];
  if (reader) {
    const size = reader(buffer);
    if (size && size.width > 0 && size.height > 0) return size;
  }
  // 扩展名不可信时按魔数重试一遍
  for (const reader2 of [readPngSize, readJpegSize, readGifSize, readBmpSize, readWebpSize]) {
    const size = reader2(buffer);
    if (size && size.width > 0 && size.height > 0) return size;
  }
  return FALLBACK;
}
