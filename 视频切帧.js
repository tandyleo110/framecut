#!/usr/bin/env node
'use strict';
/*
 * 视频切帧工具  ——  单文件版（Node.js + 内置 HTML）
 * 用法: node 视频切帧.js      然后浏览器打开 http://127.0.0.1:8765
 * 依赖: 系统里的 ffmpeg (同目录放 ffmpeg.exe 也可以)
 * 产物: <脚本所在目录>/cut-data/<视频名>/00001.png ...
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PORT = 8765;
const ROOT = __dirname;
const OUT_ROOT = path.join(ROOT, 'cut-data');
const TMP_ROOT = path.join(os.tmpdir(), 'vcut-tmp');

/* ---------------- 工具 ---------------- */

function findFF() {
  const local = path.join(ROOT, 'ffmpeg.exe');
  if (fs.existsSync(local)) return { ffmpeg: local, ffprobe: path.join(ROOT, 'ffprobe.exe') };
  const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
  const hasProbe = !probe.error;
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!ff.error) return { ffmpeg: 'ffmpeg', ffprobe: hasProbe ? 'ffprobe' : null };
  return null;
}

const FFMPEG_BIN = findFF();

/* ffmpeg 版本号, 启动时探测一次 */
const FFMPEG_VER = (() => {
  if (!FFMPEG_BIN) return null;
  try {
    const r = spawnSync(FFMPEG_BIN.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
    const m = (r.stdout || '').match(/ffmpeg version (\S+)/);
    return m ? m[1] : 'unknown';
  } catch (_) { return 'unknown'; }
})();

/** 把用户给的名字变成一个安全的单层文件夹名 */
function safeName(raw) {
  let n = String(raw || '').trim();
  n = n.replace(/[\\/:*?"<>|]/g, '_');   // 非法字符
  n = n.replace(/\.+$/, '');             // 去掉结尾的点
  n = n.replace(/^\.+/, '');
  n = n.replace(/[\x00-\x1f]/g, '');
  if (!n) return null;
  if (n.length > 120) n = n.slice(0, 120);
  return n;
}

function getExt(name) {
  const e = path.extname(name).toLowerCase();
  return /^\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|3gp)$/.test(e) ? e : '.mp4';
}

/* ---------------- ffprobe 读视频信息 ---------------- */

function parseRate(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) { const d = +m[2]; return d ? (+m[1]) / d : 0; }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function probeMedia(file) {
  if (!FFMPEG_BIN || !FFMPEG_BIN.ffprobe) return null;
  try {
    const r = spawnSync(FFMPEG_BIN.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return null;
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find(s => s.codec_type === 'video');
    if (!v) return null;
    const dur = parseFloat(j.format?.duration ?? v.duration ?? 0) || 0;
    const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
    let total = parseInt(v.nb_frames, 10);
    if (!isFinite(total) || total <= 0) total = fps > 0 ? Math.round(fps * dur) : 0;
    return {
      codec: v.codec_name || '?',
      width: v.width || 0,
      height: v.height || 0,
      duration: dur,
      fps: Math.round(fps * 1000) / 1000,
      frames: total,
      size: Number(j.format?.size) || 0,
      bitrate: j.format?.bit_rate ? Math.round(+j.format.bit_rate / 1000) + ' kbps' : '',
    };
  } catch (_) { return null; }
}

function dropUpload(token) {
  const u = token && uploads.get(token);
  if (u) { uploads.delete(token); fsp.unlink(u.path).catch(() => {}); }
}

/* ---------------- 任务状态 ---------------- */

const jobs = new Map();   // id -> {name, total, done, status, error, proc, sse:Set}
const uploads = new Map(); // token -> {path, name, meta}  已上传待切的文件

let jobSeq = 0, upSeq = 0;

function broadcast(job) {
  const payload = `data: ${JSON.stringify({
    name: job.name, total: job.total, done: job.done, status: job.status, error: job.error
  })}\n\n`;
  for (const res of job.sse) { try { res.write(payload); } catch (_) {} }
}

function finish(job, status, error) {
  job.status = status;
  job.error = error || null;
  broadcast(job);
  if (status !== 'running') {
    for (const res of job.sse) { try { res.end(); } catch (_) {} }
    job.sse.clear();
  }
}

/* ---------------- ffmpeg 抽帧 ---------------- */

async function cut(job, videoPath, outDir, fps, ext) {
  const args = ['-hide_banner', '-y', '-i', videoPath, '-pix_fmt', 'rgb24'];
  if (Number(fps) > 0) args.push('-r', String(Math.floor(fps)));
  if (ext === 'jpg') args.push('-q:v', '2');
  args.push('-start_number', '1', path.join(outDir, '%5d.' + ext));

  const argsStr = 'ffmpeg ' + args.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  job.log = argsStr;

  await fsp.mkdir(outDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN.ffmpeg, args, { windowsHide: true });
    job.proc = proc;
    let stderrTail = '';

    proc.stderr.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderrTail = (stderrTail + s).slice(-4000);
      for (const m of s.matchAll(/frame=\s*(\d+)/g)) {
        const n = parseInt(m[1], 10);
        if (n > job.done) { job.done = n; broadcast(job); }
      }
      if (/Error|Invalid|Unknown|Unable|failed/i.test(s) && job.status === 'running') {
        // 只记日志，不立刻判死，ffmpeg 退出码才是准的
      }
    });

    proc.on('error', (e) => { finish(job, 'error', '无法启动 ffmpeg: ' + e.message); resolve(); });

    proc.on('close', async (code) => {
      job.proc = null;
      if (job.status === 'canceled') return resolve();
      if (code !== 0) {
        const line = stderrTail.split(/\r?\n/).filter(l => /error|invalid|unable/i.test(l)).pop() || `ffmpeg 退出码 ${code}`;
        return finish(job, 'error', line.trim()), resolve();
      }
      let n = 0;
      try {
        const files = await fsp.readdir(outDir);
        n = files.filter(f => f.toLowerCase().endsWith('.' + ext)).length;
      } catch (_) {}
      job.total = n; job.done = n;
      finish(job, 'done');
      resolve();
    });
  });
}

/* ---------------- HTTP ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.json': 'application/json; charset=utf-8',
};

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, MIME['.json'], JSON.stringify(obj));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('文件太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 只能访问 cut-data 下的直接子项，防目录穿越 */
function resolveInOut(relName) {
  const n = safeName(relName);
  if (!n) return null;
  const p = path.join(OUT_ROOT, n);
  if (path.dirname(p) !== path.resolve(OUT_ROOT)) return null;
  return p;
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/list') {
    let dirs = [];
    try {
      dirs = (await fsp.readdir(OUT_ROOT, { withFileTypes: true }))
        .filter(d => d.isDirectory()).map(d => d.name);
    } catch (_) {}
    const out = [];
    for (const d of dirs) {
      const n = safeName(d);
      if (n !== d) continue;
      try {
        const files = await fsp.readdir(path.join(OUT_ROOT, d));
        const png = files.filter(f => /\.png$/i.test(f)).length;
        const jpg = files.filter(f => /\.(jpg|jpeg)$/i.test(f)).length;
        const ext = png ? 'png' : 'jpg';
        if (png || jpg) out.push({ name: d, count: png || jpg, ext });
      } catch (_) {}
    }
    return json(res, 200, { dirs: out, hasFfmpeg: !!FFMPEG_BIN, ffmpegVer: FFMPEG_VER, ffmpegPath: FFMPEG_BIN ? FFMPEG_BIN.ffmpeg : null });
  }

  if (p === '/api/frames') {
    const dir = resolveInOut(url.searchParams.get('dir') || '');
    if (!dir) return json(res, 400, { error: '无效的名称' });
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (_) { return json(res, 404, { error: '目录不存在' }); }

    // 一次 readdir 拿全量, 不再对每帧发一次 HEAD
    const files = [];
    let bytes = 0;
    for (const d of entries) {
      if (!d.isFile()) continue;
      if (!/^\d{5,}\.(png|jpg|jpeg)$/i.test(d.name)) continue;
      files.push(d.name);
      try { bytes += (await fsp.stat(path.join(dir, d.name))).size; } catch (_) {}
    }
    files.sort();                       // 已补零, 字典序即帧序
    return json(res, 200, { dir: path.basename(dir), count: files.length, bytes, files });
  }

  if (p === '/api/probe' && req.method === 'POST') {
    if (!FFMPEG_BIN) return json(res, 500, { error: '未找到 ffmpeg' });
    const origName = url.searchParams.get('name') || '';
    await fsp.mkdir(TMP_ROOT, { recursive: true });
    const token = 'u' + (++upSeq) + '_' + Date.now().toString(36);
    const dest = path.join(TMP_ROOT, token + getExt(origName));
    let body;
    try { body = await readBody(req, 8 * 1024 * 1024 * 1024); }
    catch (e) { return json(res, 400, { error: e.message }); }
    if (!body.length) return json(res, 400, { error: '没有收到文件内容' });
    await fsp.writeFile(dest, body);

    const meta = probeMedia(dest);
    uploads.set(token, { path: dest, name: origName, meta });
    return json(res, 200, { token, meta });
  }

  if (p === '/api/cut' && req.method === 'POST') {
    if (!FFMPEG_BIN) return json(res, 500, { error: '未找到 ffmpeg' });
    let origName = url.searchParams.get('name') || '';
    /* 文件夹名 = 视频文件名去掉扩展名, 例如 apple.mp4 -> cut-data/apple */
    const name = safeName(path.basename(origName, path.extname(origName)));
    if (!name) return json(res, 400, { error: '无效的文件名' });
    const fps = Math.max(0, Math.min(240, parseInt(url.searchParams.get('fps') || '0', 10) || 0));
    const ext = (url.searchParams.get('ext') || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';

    const job = { id: ++jobSeq, name, total: 0, done: 0, status: 'running', error: null, sse: new Set(), proc: null, ext };
    jobs.set(job.id, job);

    // 清理旧产物
    const outDir = path.join(OUT_ROOT, name);
    await fsp.mkdir(OUT_ROOT, { recursive: true });
    try {
      for (const f of await fsp.readdir(outDir)) {
        if (/^\d{5,}\.(png|jpg|jpeg)$/i.test(f)) await fsp.unlink(path.join(outDir, f)).catch(() => {});
      }
    } catch (_) {}

    /* 优先复用 /api/probe 已上传的临时文件, 省掉二次上传 */
    const token = url.searchParams.get('token') || '';
    const up = uploads.get(token);
    let videoPath;

    if (up && await fsp.stat(up.path).then(() => true).catch(() => false)) {
      uploads.delete(token);
      videoPath = up.path;
      origName = origName || up.name;
    } else {
      await fsp.mkdir(TMP_ROOT, { recursive: true });
      videoPath = path.join(TMP_ROOT, job.id + getExt(origName));
      let body;
      try {
        body = await readBody(req, 8 * 1024 * 1024 * 1024);
      } catch (e) {
        finish(job, 'error', e.message);
        return json(res, 400, { error: e.message, id: job.id });
      }
      if (!body.length) { finish(job, 'error', '没有收到文件内容'); return json(res, 400, { error: '没有收到文件内容', id: job.id }); }
      await fsp.writeFile(videoPath, body);
    }

    // 已知总帧数时进度条才能显示百分比
    if (up && up.meta && up.meta.frames) {
      if (fps > 0) job.total = Math.round(up.meta.frames * fps / (up.meta.fps || 1));
      else job.total = up.meta.frames;
    }

    // 不 await，先把 id 返回给前端去订阅进度
    cut(job, videoPath, outDir, fps, ext)
      .catch(e => finish(job, 'error', e.message))
      .finally(() => fsp.unlink(videoPath).catch(() => {}));

    return json(res, 200, { id: job.id, name, outDir, total: job.total });
  }

  if (p === '/api/events') {
    const id = parseInt(url.searchParams.get('id') || '0', 10);
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'no job' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    job.sse.add(res);
    if (job.status !== 'running') { broadcast(job); res.end(); }
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ka); job.sse.delete(res); });
    return;
  }

  if (p === '/api/cancel' && req.method === 'POST') {
    const id = parseInt(url.searchParams.get('id') || '0', 10);
    const job = jobs.get(id);
    if (job && job.proc) { job.status = 'canceled'; try { job.proc.kill(); } catch (_) {} finish(job, 'canceled'); return json(res, 200, { ok: true }); }
    return json(res, 200, { ok: false });
  }

  /* 放弃已上传但还没切的临时文件 */
  if (p === '/api/release' && req.method === 'POST') {
    dropUpload(url.searchParams.get('token') || '');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/delete' && req.method === 'POST') {
    const dir = resolveInOut(url.searchParams.get('name') || '');
    if (!dir) return json(res, 400, { error: '无效的名称' });
    await fsp.rm(dir, { recursive: true, force: true });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/open' && req.method === 'POST') {
    const dir = resolveInOut(url.searchParams.get('name') || '');
    if (!dir) return json(res, 400, { error: '无效的名称' });
    spawn('cmd', ['/c', 'explorer', dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

async function handleAsset(res, url) {
  const name = safeName(url.searchParams.get('dir') || '');
  const file = path.basename(url.searchParams.get('f') || '');
  if (!name || !/^\d{5,}\.(png|jpg|jpeg)$/i.test(file)) return send(res, 400, 'text/plain', 'bad');
  const dir = path.join(OUT_ROOT, name);
  if (path.dirname(path.join(dir, file)) !== path.resolve(dir)) return send(res, 400, 'text/plain', 'bad');
  let st;
  try { st = await fsp.stat(path.join(dir, file)); } catch (_) { return send(res, 404, 'text/plain', 'not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000' });
  fs.createReadStream(path.join(dir, file)).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' ) return send(res, 200, MIME['.html'], PAGE);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/f') return await handleAsset(res, url);
    return send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch (_) {}
  }
});

/* ---------------- 内置页面 ---------------- */

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>视频切帧</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2430; --line:#2a3441;
    --tx:#e6edf3; --dim:#8b949e; --ac:#4493f8; --ac2:#2f81f7; --ok:#3fb950; --er:#f85149;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{padding:14px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px}
  h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.5px}
  .tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:2px 10px}
  main{max-width:1400px;margin:0 auto;padding:22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px}
  #drop{border:2px dashed var(--line);border-radius:10px;padding:44px 20px;text-align:center;cursor:pointer;transition:.15s}
  #drop:hover{border-color:var(--ac);background:#11161f}
  #drop.hot{border-color:var(--ac2);background:#12243d}
  #drop .big{font-size:15px;margin-bottom:6px}
  #drop .sm{color:var(--dim);font-size:12px}
  .opts{display:flex;gap:26px;flex-wrap:wrap;margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}
  .pwrap{display:flex;gap:18px;flex-wrap:wrap}
  .player{position:relative;width:300px;flex:0 0 300px;background:#000;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .player video{width:100%;display:block;max-height:340px;background:#000}
  .player .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px;background:rgba(13,17,23,.92);text-align:center;padding:12px}
  .meta{flex:1;min-width:240px;display:flex;flex-direction:column;gap:10px;justify-content:center}
  .fname{font-size:14px;font-weight:600;word-break:break-all;line-height:1.4}
  .mrow{display:flex;flex-wrap:wrap;gap:6px}
  .mrow i{font-style:normal;font-size:11px;background:#0d1117;border:1px solid var(--line);border-radius:20px;padding:3px 10px;color:var(--dim)}
  .mrow i b{color:var(--tx);font-weight:600}
  .presets{display:flex;gap:6px;flex-wrap:wrap}
  .presets button{background:#0d1117;border:1px solid var(--line);color:var(--dim);border-radius:20px;padding:4px 11px;cursor:pointer;font:inherit;font-size:11px}
  .presets button:hover{border-color:var(--ac);color:var(--tx)}
  .presets button.on{background:var(--ac2);border-color:var(--ac2);color:#fff}
  .opt{display:flex;flex-direction:column;gap:7px}
  .opt label{font-size:12px;color:var(--dim)}
  .opt label b{color:var(--tx);font-weight:600}
  input[type=number],input[type=text]{background:#0d1117;border:1px solid var(--line);color:var(--tx);
    border-radius:6px;padding:7px 10px;width:150px;font:inherit}
  input:focus{outline:none;border-color:var(--ac)}
  .segs{display:flex;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;width:150px}
  .segs button{flex:1;background:#0d1117;border:0;color:var(--dim);padding:8px 0;cursor:pointer;font:inherit}
  .segs button.on{background:var(--ac2);color:#fff}
  .bar{height:6px;background:#0d1117;border-radius:4px;overflow:hidden;margin-top:16px}
  .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--ac),var(--ok));transition:width .2s}
  .status{margin-top:10px;font-size:12px;color:var(--dim);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  .status .err{color:var(--er)}
  button.act{background:var(--ac2);color:#fff;border:0;border-radius:6px;padding:8px 18px;cursor:pointer;font:inherit}
  button.act:disabled{background:#30363d;color:#6e7681;cursor:not-allowed}
  button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:5px 11px;cursor:pointer;font-size:12px}
  button.ghost:hover{border-color:var(--ac);color:var(--tx)}
  button.ghost.del{color:#f0883e;border-color:#5a3a1e}
  button.ghost.del:hover{background:#3d1d0d;border-color:var(--er);color:#ff7b72}
  button.ghost.del.busy{opacity:.5;pointer-events:none}
  h2{font-size:14px;margin:26px 0 12px;display:flex;align-items:center;gap:10px}
  h2 .n{color:var(--dim);font-weight:400;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:9px}
  .cell{position:relative;aspect-ratio:1;border-radius:7px;overflow:hidden;background:#0d1117;border:1px solid var(--line);cursor:zoom-in;content-visibility:auto;contain-intrinsic-size:132px}
  .cell img{width:100%;height:100%;object-fit:cover;display:block}
  .cell span{position:absolute;left:0;bottom:0;right:0;background:rgba(0,0,0,.65);color:#fff;font-size:10px;padding:2px 5px;text-align:center}
  .dirs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}
  .dirs button{background:var(--panel2);border:1px solid var(--line);color:var(--tx);border-radius:20px;padding:6px 13px;cursor:pointer;font:inherit;font-size:12px}
  .dirs button:hover{border-color:var(--ac)}
  .dirs button.on{background:var(--ac2);border-color:var(--ac2);color:#fff}
  #lb{position:fixed;inset:0;background:rgba(0,0,0,.93);display:none;align-items:center;justify-content:center;z-index:99;flex-direction:column;gap:12px;padding:26px}
  #lb img{max-width:100%;max-height:88vh;object-fit:contain}
  #lb .cap{color:#c9d1d9;font-size:12px}
  #lb .x{position:absolute;top:16px;right:22px;color:#fff;font-size:28px;cursor:pointer;line-height:1}
  .empty{color:var(--dim);font-size:12px;padding:18px 0}
  code{background:#0d1117;border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>视频切帧</h1>
  <span class="tag">cut-data / &lt;视频名&gt; / 00001.png</span>
  <span class="tag" id="ff"></span>
</header>

<main>
  <div class="card">
    <div id="drop">
      <div class="big">把视频拖到这里，或点击选择文件</div>
      <div class="sm">支持 mp4 / mov / mkv / avi / webm / flv 等</div>
    </div>
    <input type="file" id="file" accept="video/*" hidden>

    <div id="prev" style="display:none">
      <div class="pwrap">
        <div class="player">
          <video id="vid" controls preload="metadata" playsinline></video>
          <div class="ph" id="ph">读取视频信息…</div>
        </div>
        <div class="meta">
          <div class="fname" id="pname"></div>
          <div class="mrow" id="mrow"></div>
          <div class="mrow" id="mcalc"></div>
        </div>
      </div>

      <div class="opts">
        <div class="opt">
          <label><b>问题 1</b> &nbsp;一秒钟切几张图（0 = 按原视频全部帧）</label>
          <input type="number" id="fps" value="0" min="0" max="240" step="1">
          <div class="presets" id="presets"></div>
        </div>
        <div class="opt">
          <label><b>问题 2</b> &nbsp;输出图片格式</label>
          <div class="segs">
            <button class="on" data-ext="png">png</button>
            <button data-ext="jpg">jpg</button>
          </div>
          <div class="presets" id="pfmt"></div>
        </div>
        <div class="opt" style="justify-content:flex-end;flex-direction:row;gap:8px;align-items:flex-end">
          <button class="act" id="go" disabled>开始切帧</button>
          <button class="ghost" id="reset" style="display:none">换一个</button>
        </div>
      </div>

      <div class="bar" id="bar" style="display:none"><i id="fill"></i></div>
      <div class="status" id="status"></div>
    </div>
  </div>

  <div id="hist" style="display:none">
    <h2>历史产物 <span class="n" id="histn"></span></h2>
    <div class="dirs" id="dirs"></div>
  </div>

  <div id="out" style="display:none">
    <h2><span id="tname"></span> <span class="n" id="tn"></span> <span class="n" id="tinfo"></span>
        <button class="ghost" id="openDir">打开文件夹</button>
        <button class="ghost del" id="delDir">删除这批</button></h2>
    <div id="ctl" style="display:none;margin-bottom:12px">
      <button class="ghost" id="btnMore">再显示 200 张</button>
      <button class="ghost" id="btnAll">一次加载全部</button>
      <span class="n" style="color:var(--dim);font-size:12px;margin-left:8px">往下滚会自动继续加载</span>
    </div>
    <div class="grid" id="grid"></div>
    <div id="sentinel" style="height:1px"></div>
  </div>
</main>

<div id="lb"><span class="x">&times;</span><img id="lbimg"><div class="cap" id="lbcap"></div></div>

<script>
const $ = s => document.querySelector(s);
/* 绑定事件: 元素不存在时只警告, 绝不抛错 ——
   否则一处写错 id 就会让后面所有代码(包括 const 声明)全部不执行 */
const bind = (s, fn) => { const el = $(s); if (el) fn(el); else console.warn('bind: 页面缺少元素', s); return el; };
const NL = String.fromCharCode(10);
window.onerror = (m,s,l) => { st('页面脚本出错: ' + m + ' (行' + l + ')', 'err'); };

let picked = null, ext = 'png', jobId = 0, es = null, curDir = '', meta = null, token = null, objUrl = null;

/* ffmpeg 检测 */
fetch('/api/list').then(r=>r.json()).then(d=>{
  const t=$('#ff');
  if(d.hasFfmpeg){
    t.textContent='ffmpeg ' + (d.ffmpegVer||'') + ' 已就绪';
    t.style.color='#3fb950'; t.title=d.ffmpegPath||'';
  }else{
    t.textContent='未找到 ffmpeg';
    t.style.color='#f85149';
  }
  if(d.dirs.length) { $('#hist').style.display=''; renderDirs(d.dirs); }
});

/* 格式切换 */
document.querySelectorAll('.segs button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.segs button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); ext=b.dataset.ext;
});

/* 选择文件 */
const drop=$('#drop'), inp=$('#file');
if (inp) inp.onchange=()=>{ if(inp.files[0]) setFile(inp.files[0]); };
if (drop) {
  drop.onclick=()=>inp.click();
  ['dragenter','dragover'].forEach(e=>drop.addEventListener(e,x=>{x.preventDefault();drop.classList.add('hot');}));
  ['dragleave','drop'].forEach(e=>drop.addEventListener(e,x=>{x.preventDefault();drop.classList.remove('hot');}));
  drop.addEventListener('drop',x=>{ const f=x.dataTransfer.files[0]; if(f) setFile(f); });
}
window.addEventListener('dragover',e=>e.preventDefault());
window.addEventListener('drop',e=>e.preventDefault());

/* 选中文件: 立刻出预览 + 传上去读元信息 */
function setFile(f){
  const looksVideo = String(f.type||'').startsWith('video/') ||
                     /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|3gp)$/i.test(f.name);
  if(!looksVideo){
    st('这不像是个视频文件：'+esc(f.name),'err'); return;
  }
  picked=f; meta=null; token=null;

  if(objUrl) URL.revokeObjectURL(objUrl);
  objUrl=URL.createObjectURL(f);
  const v=$('#vid'); v.src=objUrl;

  $('#drop').style.display='none';
  $('#prev').style.display='';
  $('#reset').style.display='';
  $('#pname').textContent=f.name;
  $('#mrow').innerHTML='<i>大小 <b>'+mb(f.size)+'</b></i>';
  $('#mcalc').innerHTML='';
  $('#ph').style.display='flex'; $('#ph').textContent='读取视频信息…';
  $('#go').disabled=true;
  $('#bar').style.display='none';
  st('上传中 0% …');
  upload(f);
}

/* 带进度的上传, 顺带用 ffprobe 读元信息 */
function upload(f){
  const q=new URLSearchParams({name:f.name});
  const x=new XMLHttpRequest();
  x.open('POST','/api/probe?'+q);
  x.upload.onprogress=e=>{
    if(!e.lengthComputable) return;
    const p=Math.round(e.loaded/e.total*100);
    $('#fill').style.width=p+'%';
    st('上传中 '+p+'%　('+mb(e.loaded)+' / '+mb(e.total)+')');
  };
  x.onload=()=>{
    let d={}; try{ d=JSON.parse(x.responseText); }catch(_){}
    if(x.status!==200 || d.error){ st(d.error||'上传失败','err'); return; }
    token=d.token; meta=d.meta;
    st('');
    if(meta){
      $('#mrow').innerHTML=
        '<i>大小 <b>'+mb(f.size)+'</b></i>'+
        '<i>时长 <b>'+dur(meta.duration)+'</b></i>'+
        '<i>分辨率 <b>'+meta.width+'×'+meta.height+'</b></i>'+
        '<i>帧率 <b>'+meta.fps+' fps</b></i>'+
        '<i>总帧数 <b>'+meta.frames+'</b></i>'+
        '<i>编码 <b>'+esc(meta.codec)+'</b></i>'+
        (meta.bitrate?'<i>码率 <b>'+esc(meta.bitrate)+'</b></i>':'');
      presets();
      calc();
      const cur=String(parseInt($('#fps').value||'0',10));
      document.querySelectorAll('#presets button').forEach(x=>x.classList.toggle('on',x.dataset.v===cur));
    }else{
      $('#mrow').innerHTML='<i>大小 <b>'+mb(f.size)+'</b></i><i>未能读取视频信息</i>';
    }
    $('#ph').style.display='none';
    $('#go').disabled=false;
  };
  x.onerror=()=>st('上传失败，请重试','err');
  x.send(f);
}

/* 根据 fps 实时算出将产出多少张 */
function calc(){
  if(!meta || !meta.fps){ $('#mcalc').innerHTML=''; return; }
  const n=parseInt($('#fps').value||'0',10);
  const cnt = n>0 ? Math.round(meta.duration*n) : meta.frames;
  const dir=fnameOf(picked.name);
  $('#mcalc').innerHTML='将产出约 <b>'+cnt+'</b> 张　→　cut-data/'+esc(dir)+'/';
}

/* 帧率预设 */
function presets(){
  const box=$('#presets'); box.innerHTML='';
  const src=meta?meta.fps:0;
  const list=[];
  list.push(['全部帧（0）',0]);
  if(src) list.push(['原帧率 '+src, Math.round(src)]);
  [1,5,10,25,30].forEach(v=>{ if(v!==Math.round(src)) list.push([String(v),v]); });
  box.innerHTML=list.map(([t,v])=>'<button data-v="'+v+'">'+esc(t)+'</button>').join('');
  box.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    $('#fps').value=b.dataset.v;
    box.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    calc();
  });
}
const fnameOf=n=>String(n).replace(/[.][^.]+$/,'');
const dur=s=>{ s=+s||0; const m=Math.floor(s/60), x=(s%60).toFixed(1);
  return (m?m+':':'')+x; };
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mb=n=>(n/1048576).toFixed(1)+' MB';

/* 开始切帧 */
bind('#go', el => el.onclick = async () => {
  if(!picked) return;
  if(es){es.close();es=null;}
  $('#go').disabled=true; $('#bar').style.display=''; $('#fill').style.width='0%';
  const q=new URLSearchParams({name:picked.name, fps:$('#fps').value||0, ext});
  if(token) q.set('token',token);
  st('准备切帧…');
  let d;
  try{ d = await (await fetch('/api/cut?'+q,{method:'POST'})).json(); }
  catch(err){ st('切帧请求失败：'+err.message,'err'); $('#go').disabled=false; return; }
  if(d.error){ st(d.error,'err'); $('#go').disabled=false; return; }
  token=null; jobId=d.id; curDir=d.name;
  listen(jobId);
});

/* 换一个视频 */
bind('#reset', el => el.onclick = () => {
  if(token) fetch('/api/release?token='+encodeURIComponent(token),{method:'POST'});
  token=null; picked=null; meta=null;
  if(objUrl){ URL.revokeObjectURL(objUrl); objUrl=null; }
  $('#vid').removeAttribute('src'); $('#vid').load();
  $('#prev').style.display='none';
  $('#reset').style.display='none';
  $('#drop').style.display='';
  $('#go').disabled=true;
  st('');
});
$('#fps').addEventListener('input',()=>{
  calc();
  document.querySelectorAll('#presets button').forEach(b=>b.classList.toggle('on', b.dataset.v===$('#fps').value));
});

function listen(id){
  es=new EventSource('/api/events?id='+id);
  es.onmessage=e=>{
    const s=JSON.parse(e.data);
    if(s.status==='running'){
      const pct=s.total?Math.min(100,Math.round(s.done/s.total*100)):0;
      $('#fill').style.width=pct+'%';
      st('切帧中 '+pct+'%　已输出 <b>'+s.done+'</b> / '+(s.total||'?')+' 张');
    }else if(s.status==='done'){
      $('#fill').style.width='100%';
      st('完成，共 <b>'+s.total+'</b> 张 '+ext+' 图片　→　cut-data/'+esc(s.name)+'/');
      $('#go').disabled=false;
      load(s.name);
      refreshList();
    }else if(s.status==='error'){
      st(s.error||'出错了','err'); $('#go').disabled=false;
    }else if(s.status==='canceled'){
      st('已取消'); $('#go').disabled=false;
    }
  };
  es.onerror=()=>{es.close();es=null;};
}

function st(html,cls){ $('#status').innerHTML='<span class="'+(cls||'')+'">'+html+'</span>'; }

/* 缩略图: 一次拿到清单, 分批渲染, 滚到底自动续 */
let allFiles = [], shown = 0, totalBytes = 0;
const BATCH = 200;

async function load(name){
  curDir=name;
  allFiles=[]; shown=0;
  const grid=$('#grid'); grid.innerHTML='<div class="empty">读取中…</div>';
  $('#out').style.display='';
  $('#tname').textContent=name;

  let d;
  try{ d = await (await fetch('/api/frames?dir='+encodeURIComponent(name))).json(); }
  catch(e){ grid.innerHTML='<div class="empty">读取失败</div>'; return; }
  if(d.error){ grid.innerHTML='<div class="empty">'+esc(d.error)+'</div>'; $('#tn').textContent=''; return; }

  allFiles = d.files || [];
  if(!allFiles.length){ grid.innerHTML='<div class="empty">没有图片</div>'; $('#tn').textContent=''; return; }
  totalBytes = d.bytes || 0;

  $('#tn').textContent='共 '+allFiles.length+' 张';
  $('#tinfo').innerHTML='体积 '+mb(d.bytes)+'　·　已显示 <b id="shown">0</b> / '+allFiles.length;
  $('#ctl').style.display='';
  grid.innerHTML='';
  more();

  // 滚到接近底部时自动续一批
  io.observe($('#sentinel'));
}

function more(){
  if(shown>=allFiles.length){ $('#sentinel').style.display='none'; return; }
  const slice=allFiles.slice(shown, shown+BATCH);
  const frag=document.createElement('div');
  frag.style.display='contents';
  frag.innerHTML=slice.map(f=>
    '<div class="cell" data-f="'+esc(f)+'">'+
    '<img loading="lazy" decoding="async" src="/f?dir='+encodeURIComponent(curDir)+'&f='+encodeURIComponent(f)+'">'+
    '<span>'+esc(f.replace(/[.][^.]+$/,''))+'</span></div>').join('');
  while(frag.firstElementChild) $('#grid').appendChild(frag.firstElementChild);
  shown+=slice.length;
  const s=$('#shown'); if(s) s.textContent=shown;
  if(shown>=allFiles.length) $('#sentinel').style.display='none';
}

const io=new IntersectionObserver(es=>{ for(const e of es) if(e.isIntersecting) more(); }, {rootMargin:'1200px'});

bind('#btnMore', el => el.onclick = () => more());
bind('#btnAll', el => el.onclick = () => {
  const rest=allFiles.length-shown;
  if(rest>0){
    const avg=totalBytes/allFiles.length;
    if(!confirm('还有 '+rest+' 张未显示。' + NL + NL +
        '全部加载会再下载约 ' + mb(avg*rest) + ' 图片数据' + NL +
        '（共 '+mb(totalBytes)+'）。本机很快，建议直接滚到底。' + NL + NL +
        '确定要一次全部加载吗？')) return;
  }
  while(shown<allFiles.length) more();
});
$('#btnReset') && ($('#btnReset').onclick=()=>{
  io.unobserve($('#sentinel'));
  $('#grid').innerHTML=''; allFiles=[]; shown=0; totalBytes=0;
  $('#ctl').style.display='none';
  io.observe($('#sentinel'));
});

/* 大图 */
const lb=$('#lb');
bind('#grid', el => el.addEventListener('click', e => {
  const c=e.target.closest('.cell');
  if(c && c.dataset.f) show(c.dataset.f);
}));
function show(f){ $('#lbimg').src='/f?dir='+encodeURIComponent(curDir)+'&f='+encodeURIComponent(f); $('#lbcap').textContent=f; lb.style.display='flex'; }
if(lb) lb.onclick=()=>lb.style.display='none';
document.addEventListener('keydown',e=>{if(e.key==='Escape')lb.style.display='none';});

/* 历史目录 */
async function refreshList(){
  const d=await (await fetch('/api/list')).json();
  if(d.dirs.length){ $('#hist').style.display=''; renderDirs(d.dirs); } else { $('#hist').style.display='none'; }
}
function renderDirs(dirs){
  $('#histn').textContent='';
  $('#dirs').innerHTML=dirs.map(d=>
    '<button data-n="'+esc(d.name)+'">'+esc(d.name)+' · '+d.count+'</button>').join('');
  $('#dirs').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    $('#dirs').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); load(b.dataset.n);
  });
}
bind('#openDir', el => el.onclick = () => {
  if(curDir) fetch('/api/open?name='+encodeURIComponent(curDir),{method:'POST'});
});

/* 删除当前这批 */
bind('#delDir', el => el.onclick = async () => {
  if(!curDir) return;
  const n = parseInt($('#tn').textContent.replace(/[^0-9]/g, ''), 10) || 0;
  if (!confirm('确定要删除吗？' + NL + NL +
      'cut-data/' + curDir + NL + NL +
      '共 ' + n + ' 张图片，删除后无法恢复。')) return;
  const btn = $('#delDir');
  btn.classList.add('busy'); btn.textContent = '删除中…';
  try{
    const r = await (await fetch('/api/delete?name='+encodeURIComponent(curDir),{method:'POST'})).json();
    if(r.error){ alert('删除失败：'+r.error); }
    else{
      io.unobserve($('#sentinel'));
      allFiles=[]; shown=0;
      $('#grid').innerHTML='';
      $('#out').style.display='none';
      $('#ctl').style.display='none';
      $('#tname').textContent=''; $('#tn').textContent=''; $('#tinfo').textContent='';
      st('已删除 cut-data/' + esc(curDir));
      curDir='';
      await refreshList();
    }
  }catch(e){
    alert('删除失败：'+e.message);
  }
  btn.classList.remove('busy'); btn.textContent='删除这批';
});
</script>
</body>
</html>`;

/* ---------------- 启动 ---------------- */

(async () => {
  await fsp.mkdir(OUT_ROOT, { recursive: true });
  await fsp.mkdir(TMP_ROOT, { recursive: true });
  /* 清掉上次异常退出残留的临时文件 */
  try { for (const f of await fsp.readdir(TMP_ROOT)) await fsp.unlink(path.join(TMP_ROOT, f)).catch(() => {}); } catch (_) {}

  if (!FFMPEG_BIN) {
    console.log('  [警告] 没找到 ffmpeg。请把 ffmpeg.exe 放到本脚本同目录，或加入系统 PATH。\n');
  }

  server.listen(PORT, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + PORT;
    console.log('');
    console.log('  视频切帧工具已启动');
    console.log('  请在浏览器打开：  ' + url);
    console.log('  产物目录：       ' + OUT_ROOT);
    console.log('');
    try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {}
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error('  端口 ' + PORT + ' 被占用，关掉占用它的程序再试。'); process.exit(1); }
    throw e;
  });
})();

process.on('SIGINT', () => { for (const j of jobs.values()) { try { j.proc && j.proc.kill(); } catch (_) {} } process.exit(0); });
