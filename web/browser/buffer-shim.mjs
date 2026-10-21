// 浏览器端 Buffer 兼容层。
//
// lib/ 下的模块是为 Node 写的，用到了 Buffer 专有 API：
//   Buffer.from / Buffer.concat / .equals() / .toString('latin1', start, end)
// 浏览器没有这些，这里在 Uint8Array 上补齐，并把 Buffer 映射为带这些方法的
// Uint8Array 构造器。只覆盖本项目实际用到的形态，不做完整 polyfill。

function toUint8(value, encoding) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value, (v) => v & 0xff);
  if (typeof value === 'string') {
    if (encoding === 'latin1' || encoding === 'binary') {
      const out = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
      return out;
    }
    if (encoding === 'hex') {
      const out = new Uint8Array(value.length / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.substr(i * 2, 2), 16);
      return out;
    }
    return new TextEncoder().encode(value);
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

function concat(list) {
  let total = 0;
  for (const item of list) total += item.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of list) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

export function installBufferShim() {
  // 给 Uint8Array 补 equals / 带编码的 toString（只补缺失的，不覆盖原生行为）
  const proto = Uint8Array.prototype;
  if (!proto.equals) {
    Object.defineProperty(proto, 'equals', {
      value(other) {
        const a = this;
        const b = other instanceof Uint8Array ? other : toUint8(other);
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
        return true;
      },
      writable: true,
      configurable: true,
    });
  }
  if (!proto.__bufferToString) {
    const nativeToString = proto.toString;
    Object.defineProperty(proto, '__bufferToString', { value: nativeToString });
    Object.defineProperty(proto, 'toString', {
      value(encoding, start, end) {
        // 无参数或非字符串编码：走原生（"1,2,3"）
        if (typeof encoding !== 'string') return nativeToString.call(this);
        const bytes = this.subarray(start ?? 0, end ?? this.length);
        if (encoding === 'latin1' || encoding === 'binary') {
          let out = '';
          for (const byte of bytes) out += String.fromCharCode(byte);
          return out;
        }
        if (encoding === 'hex') {
          let out = '';
          for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
          return out;
        }
        if (encoding === 'base64') {
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return btoa(binary);
        }
        return new TextDecoder(encoding === 'utf8' || encoding === 'utf-8' ? 'utf-8' : encoding).decode(bytes);
      },
      writable: true,
      configurable: true,
    });
  }

  // 补 Buffer 的定长读写（lib/ 里用于解析 PNG/GIF/BMP/WebP 头与体素区块）
  const reads = {
    readUInt32BE(offset = 0) {
      const v = new DataView(this.buffer, this.byteOffset, this.byteLength);
      return v.getUint32(offset, false);
    },
    readUInt32LE(offset = 0) {
      const v = new DataView(this.buffer, this.byteOffset, this.byteLength);
      return v.getUint32(offset, true);
    },
    readUInt16BE(offset = 0) {
      const v = new DataView(this.buffer, this.byteOffset, this.byteLength);
      return v.getUint16(offset, false);
    },
    readUInt16LE(offset = 0) {
      const v = new DataView(this.buffer, this.byteOffset, this.byteLength);
      return v.getUint16(offset, true);
    },
    readInt32LE(offset = 0) {
      const v = new DataView(this.buffer, this.byteOffset, this.byteLength);
      return v.getInt32(offset, true);
    },
    readUInt8(offset = 0) {
      return this[offset];
    },
  };
  for (const [name, fn] of Object.entries(reads)) {
    if (!proto[name]) {
      Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
    }
  }

  if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = { from: toUint8, concat };
  }
}
