// 神岛 zip → 官方 .boxproject 转换器（本地单文件服务，零依赖）
//   ./server.mjs            启动，默认 http://127.0.0.1:3215/
//   DAO3_CONV_PORT=端口     换端口
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertZipToBoxProjects } from './convert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DAO3_CONV_PORT || 8801);
const OUT_DIR = process.env.DAO3_CONV_OUT
  ? path.resolve(process.env.DAO3_CONV_OUT)
  : path.join(os.homedir(), 'Desktop', 'DAO3转换产出');
const MAX_ZIP_BYTES = Number(process.env.DAO3_CONV_MAX_ZIP || 2 * 1024 * 1024 * 1024);

fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function listOutputs() {
  try {
    return fs
      .readdirSync(OUT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.boxproject'))
      .map((entry) => {
        const stat = fs.statSync(path.join(OUT_DIR, entry.name));
        return { name: entry.name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// 流式读 body 到临时文件，避免大 zip 全驻留内存
function readBodyToTemp(req) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `dao3-upload-${process.pid}-${Date.now()}.zip`);
    const stream = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_ZIP_BYTES) {
        stream.destroy();
        fs.rmSync(tmp, { force: true });
        reject(new Error(`zip 超过大小上限 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB`));
        req.destroy();
      }
    });
    req.on('error', reject);
    stream.on('error', reject);
    stream.on('close', () => resolve({ tmp, size }));
    req.pipe(stream);
  });
}

// 浏览器 FormData 走 multipart/form-data。这里只抽 zip 字段的原始字节，
// 不需要完整解析：boundary 来自 content-type 头，按它切段，找到带 filename=
// 的段并去掉其头部即可。
function extractMultipartFile(buffer, contentType, fieldName = 'zip') {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!boundaryMatch) throw new Error('multipart 请求缺少 boundary');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    const afterBoundary = cursor + boundary.length;
    // 结束标记是 boundary 后紧跟 --
    if (buffer[afterBoundary] === 0x2d && buffer[afterBoundary + 1] === 0x2d) break;
    const partStart = buffer.indexOf('\r\n', afterBoundary) + 2;
    const nextBoundary = buffer.indexOf(boundary, partStart);
    if (nextBoundary < 0) break;
    // 段尾部在下一个 boundary 之前，去掉它前面的 \r\n
    const partEnd = nextBoundary - 2;
    const partHeaderEnd = buffer.indexOf('\r\n\r\n', partStart);
    if (partHeaderEnd < 0 || partHeaderEnd > partEnd) {
      cursor = nextBoundary;
      continue;
    }
    const partHeaders = buffer.subarray(partStart, partHeaderEnd).toString('latin1');
    if (new RegExp(`name="${fieldName}"`, 'i').test(partHeaders) && /filename=/i.test(partHeaders)) {
      const filenameMatch = partHeaders.match(/filename="?([^";\r\n]+)"?/i);
      parts.push({
        filename: filenameMatch ? filenameMatch[1] : `${fieldName}.zip`,
        data: Buffer.from(buffer.subarray(partHeaderEnd + 4, partEnd)),
      });
    }
    cursor = nextBoundary;
  }
  if (!parts.length) throw new Error('请求里没有 zip 文件字段');
  return parts[0];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_ZIP_BYTES) {
        reject(new Error(`请求超过大小上限 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function handleConvert(req, res) {
  const body = await readBody(req);
  const started = Date.now();
  const { filename, data } = extractMultipartFile(body, req.headers['content-type'], 'zip');
  const tmp = path.join(os.tmpdir(), `dao3-convert-${process.pid}-${Date.now()}.zip`);
  try {
    fs.writeFileSync(tmp, data);
    // 单包与地图组共用一条路径：一次产出 .boxproject（可编辑）+ .boxplay（可直接运行）
    const { isGroup, projects } = convertZipToBoxProjects(tmp, { outDir: OUT_DIR, sourceName: filename });
    const results = projects.map(({ result, built, play }) => ({
      filename: built.filename,
      download: `/download/${encodeURIComponent(built.filename)}`,
      size: built.size,
      mapSize: built.mapSize,
      name: result.displayName,
      worldId: result.worldId,
      voxelCount: result.voxelCount,
      blobCount: result.blobs.size,
      scripts: result.scriptNames,
      pictureCount: result.pictureCount,
      audioCount: result.audioCount,
      meshCount: result.meshCount,
      gltfCount: result.gltfCount,
      skippedVoxCount: result.skippedVoxCount,
      warnings: result.warnings,
      play: play
        ? {
            filename: play.filename,
            download: `/download/${encodeURIComponent(play.filename)}`,
            size: play.size,
          }
        : null,
    }));
    return json(res, 200, {
      ok: true,
      isGroup,
      results,
      // 单包时同时给出顶层字段，兼容旧前端
      ...results[0],
      inputSize: data.length,
      elapsedMs: Date.now() - started,
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/convert' && req.method === 'POST') {
      return await handleConvert(req, res);
    }
    if (url.pathname === '/api/outputs') {
      return json(res, 200, { outDir: OUT_DIR, outputs: listOutputs() });
    }
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const { spawn } = await import('node:child_process');
      spawn('open', [OUT_DIR]).unref();
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/download/')) {
      const name = decodeURIComponent(url.pathname.slice('/download/'.length));
      const file = path.join(OUT_DIR, name);
      if (!file.startsWith(OUT_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        'content-length': fs.statSync(file).size,
      });
      return fs.createReadStream(file).pipe(res);
    }
    const staticPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(__dirname, 'web', path.normalize(staticPath).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(path.join(__dirname, 'web'))) {
      res.writeHead(403);
      return res.end();
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(filePath));
    }
    res.writeHead(404);
    res.end('not found');
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DAO3 转换器: http://127.0.0.1:${PORT}/`);
  console.log(`产出目录: ${OUT_DIR}`);
});
