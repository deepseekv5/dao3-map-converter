import crypto from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(buffer) {
  const digits = [0];
  for (const byte of buffer) {
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
  let result = '';
  for (const byte of buffer) {
    if (byte !== 0) break;
    result += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    result += ALPHABET[digits[i]];
  }
  return result;
}

// 引擎的哈希规则：base58(0x1220 || sha256(content))，与官方导出包里的 Qm 名一致
export function contentHash(buffer) {
  const digest = crypto.createHash('sha256').update(buffer).digest();
  return encodeBase58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}
