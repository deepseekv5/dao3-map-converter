// 浏览器版底层原语：哈希、base58、stableStringify、压缩/解压、tar 打包。
// 全部基于 Web 标准 API，不依赖 Node，可直接跑在静态托管上。

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += BASE58[0];
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58[digits[i]];
  return out;
}

// 引擎的哈希规则：base58(0x1220 || sha256(content))，与官方 Qm 名一致
export async function contentHash(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const payload = new Uint8Array(34);
  payload[0] = 0x12;
  payload[1] = 0x20;
  payload.set(digest, 2);
  return encodeBase58(payload);
}

// 稳定序列化：键排序、跳过 undefined，保证同内容得到同 hash
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (ArrayBuffer.isView(value)) {
    return `[${Array.from(value).map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

// ---- 压缩 ----

async function streamThrough(bytes, stream) {
  const source = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

export async function gunzip(bytes) {
  return streamThrough(bytes, new DecompressionStream('gzip'));
}

export async function inflateRaw(bytes) {
  return streamThrough(bytes, new DecompressionStream('deflate-raw'));
}

export async function gzip(bytes) {
  return streamThrough(bytes, new CompressionStream('gzip'));
}

// ---- tar 打包 ----
// 只实现生成 tar（不解析），支持 ustar 长文件名前缀，足够官方导入端读取。
const BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeString(target, offset, text, length) {
  const bytes = new TextEncoder().encode(text);
  target.set(bytes.subarray(0, length), offset);
}

// 把路径拆成 ustar 的 prefix(155) + name(100)
function splitName(fullPath) {
  const encoded = new TextEncoder().encode(fullPath);
  if (encoded.length <= 100) return { name: fullPath, prefix: '' };
  // 从后往前找能放进 name 的分段
  for (let i = fullPath.length - 1; i > 0; i -= 1) {
    if (fullPath[i] !== '/') continue;
    const prefix = fullPath.slice(0, i);
    const name = fullPath.slice(i + 1);
    const prefixBytes = new TextEncoder().encode(prefix);
    const nameBytes = new TextEncoder().encode(name);
    if (prefixBytes.length <= 155 && nameBytes.length <= 100) {
      return { name, prefix };
    }
  }
  // 实在放不下就截断（引擎里文件名都不会这么长）
  return { name: fullPath.slice(-100), prefix: '' };
}

function tarHeader({ path, size, mode = 0o644, mtime = Math.floor(Date.now() / 1000) }) {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(path);
  writeString(header, 0, name, 100);
  writeString(header, 100, octal(mode, 8), 8);
  writeString(header, 108, octal(0, 8), 8);
  writeString(header, 116, octal(0, 8), 8);
  writeString(header, 124, octal(size, 12), 12);
  writeString(header, 136, octal(mtime, 12), 12);
  writeString(header, 148, '        ', 8); // 校验和先填空格
  header[156] = 0x30; // typeflag '0' = 普通文件
  writeString(header, 257, 'ustar\0', 6);
  writeString(header, 263, '00', 2);
  writeString(header, 345, prefix, 155);

  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, `${sum.toString(8).padStart(6, '0')}\0 `, 8);
  return header;
}

// entries: [{ path, data: Uint8Array }]
export function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    blocks.push(tarHeader({ path: entry.path, size: data.length }));
    blocks.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(BLOCK * 2)); // 结束标记
  let total = 0;
  for (const block of blocks) total += block.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

export async function buildTarGz(entries) {
  return gzip(buildTar(entries));
}

// ---- 简易 zip 读取（浏览器版）----
// 只需要能读中央目录 + 解压 deflate/stored，够解析神岛导出包。
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const decoderGbk = (() => {
    try {
      return new TextDecoder('gbk');
    } catch {
      return null;
    }
  })();

  const decodeName = (raw, utf8Flag) => {
    if (utf8Flag) return decoder.decode(raw);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return decoderGbk ? decoderGbk.decode(raw) : decoder.decode(raw);
    }
  };

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = decodeName(rawName, (flags & 0x800) !== 0);
    const isDir = name.endsWith('/');
    let data = null;
    if (!isDir) {
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) data = compressed;
      else if (method === 8) data = await inflateRaw(compressed);
      else throw new Error(`不支持的压缩方式 ${method}：${name}`);
    }
    entries.push({ name, dir: isDir, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
