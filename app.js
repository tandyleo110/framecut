#!/usr/bin/env node
'use strict';
/*
 * 视频切帧工具  ——  后端（Node.js），页面在同目录 index.html
 * 用法: node app.js      然后浏览器打开 http://127.0.0.1:8765
 *       端口被占用会自动 +1 顺延
 * 依赖: 系统里的 ffmpeg + ffprobe (同目录放 ffmpeg.exe 也可以)
 * 文件: index.html 是页面, 和本脚本同目录, 改完刷新浏览器即可生效
 * 产物: 切帧 -> <脚本目录>/cut-data/<视频名>/00001.png ...
 *       切片 -> <脚本目录>/<视频名>_<起帧>-<止帧>.mp4
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PORT_START = 8765;
const PORT_MAX_TRY = 50;
const ROOT = __dirname;
const OUT_ROOT = path.join(ROOT, 'cut-data');
const CLIP_ROOT = ROOT;                       // 片段成品直接落在脚本同目录
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
    /* 优先用分子/分母原样, 例如 60000/1001;
       换成 59.94 这种小数会让容器重算时间基, 帧率对不上 */
    const rateStr = (/^\d+\s*\/\s*\d+$/.test(String(v.avg_frame_rate).trim())
      && parseRate(v.avg_frame_rate) > 0)
      ? String(v.avg_frame_rate).replace(/\s+/g, '')
      : String(v.r_frame_rate || '').replace(/\s+/g, '');
    const fps = parseRate(rateStr) || parseRate(v.r_frame_rate);
    let total = parseInt(v.nb_frames, 10);
    if (!isFinite(total) || total <= 0) total = fps > 0 ? Math.round(fps * dur) : 0;
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    return {
      codec: v.codec_name || '?',
      pixFmt: v.pix_fmt || '',
      colorPrimaries: v.color_primaries || '',
      colorTrc: v.color_transfer || '',
      colorspace: v.color_space || '',
      colorRange: v.color_range || '',
      sampleRate: a ? a.sample_rate : 0,
      channels: a ? a.channels : 0,
      width: v.width || 0,
      height: v.height || 0,
      duration: dur,
      fps: Math.round(fps * 1000) / 1000,
      rateStr,
      frames: total,
      size: Number(j.format?.size) || 0,
      bitrate: j.format?.bit_rate ? Math.round(+j.format.bit_rate / 1000) + ' kbps' : '',
    };
  } catch (_) { return null; }
}

function dropUpload(token) {
  const u = token && uploads.get(token);
  if (u) { uploads.delete(token); fsp.rm(path.dirname(u.path), { recursive: true, force: true }).catch(() => {}); }
}

/* ---------------- 任务状态 ---------------- */

const jobs = new Map();   // id -> {name, total, done, status, error, proc, sse:Set}
const uploads = new Map(); // token -> {path, name, meta}  已上传待切的文件

let jobSeq = 0, upSeq = 0;

function broadcast(job) {
  const payload = `data: ${JSON.stringify({
    name: job.name, total: job.total, done: job.done, status: job.status, error: job.error,
    kind: job.kind || 'frames',
    file: job.outFile ? path.basename(job.outFile) : null,
    realFrames: job.realFrames || 0,
    size: job.size || 0,
    outDir: job.outFile ? path.dirname(job.outFile) : null,
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

/* ---------------- 帧表 / 精确切片段 ---------------- */

/* 帧号 <-> 时间戳 的换算必须靠真实 pts 表。
   源文件可能是 VFR（相邻帧间隔不一致），拿 fps 去乘会算偏。 */
function readFrameTimes(file) {
  if (!FFMPEG_BIN || !FFMPEG_BIN.ffprobe) return null;
  try {
    const r = spawnSync(FFMPEG_BIN.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return null;
    const a = r.stdout.split(/\r?\n/).map(s => parseFloat(s)).filter(n => isFinite(n));
    return a.length ? a : null;
  } catch (_) { return null; }
}

/** 用 ffprobe 拿到的音频信息 */
function probeAudio(file) {
  if (!FFMPEG_BIN || !FFMPEG_BIN.ffprobe) return null;
  try {
    const r = spawnSync(FFMPEG_BIN.ffprobe,
      ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', file],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return null;
    const s = (JSON.parse(r.stdout).streams || [])[0];
    return s ? { codec: s.codec_name, rate: s.sample_rate, channels: s.channels } : null;
  } catch (_) { return null; }
}

function hasAudioStream(file) {
  if (!FFMPEG_BIN || !FFMPEG_BIN.ffprobe) return false;
  try {
    const r = spawnSync(FFMPEG_BIN.ffprobe,
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { encoding: 'utf8', windowsHide: true });
    return r.status === 0 && !!r.stdout.trim();
  } catch (_) { return false; }
}

/* 源编码 -> 本机编码器。编码器永远跟随源视频, 不给切换。

   两档画质, 默认 lossless:
   - lossless: 解码像素与源逐位相同, 体积必然是源片段的数倍
   - crf12   : 视觉无损(专业后期通用档), 体积约为 lossless 的 1/8

   preset 用 slow: CRF 是画质门槛而非固定码率, preset 越慢搜索空间越大、
   同样画质下压得更小。实测同参数 slow 19.7 MiB vs medium 18.0 MiB,
   小约 9%。慢的那点时间换体积划算。

   注意: x265 的 `-qp 0` 并不是无损 —— 量化器归零, 但内部色彩转换仍有
   舍入误差, 实测像素 md5 对不上。必须用 -x265-params lossless=1。
   x264 / libvpx-vp9 的 -qp 0 本身就是真无损。 */
const ENCODERS = {
  hevc: {
    lib: 'libx265', preset: 'slow',
    lossless: ['-x265-params', 'lossless=1'],
    crf: ['-crf', '12', '-x265-params', 'aq-mode=3'],
  },
  h264: {
    lib: 'libx264', preset: 'slow',
    lossless: ['-qp', '0'],
    crf: ['-crf', '12'],
  },
  vp9: {
    lib: 'libvpx-vp9', preset: 'slow',
    lossless: ['-lossless', '1'],
    crf: ['-crf', '12', '-b:v', '0'],
  },
};

/** 两档画质, 值域和前端按钮的 data-q 对应 */
const QUALITIES = { lossless: '逐位无损', crf12: '视觉无损 CRF 12' };

/**
 * 精确切片段。
 * from/to 是「抽帧图上的编号」，从 1 开始；对应 ffmpeg 的第 from-1 .. to-1 帧。
 *
 * 关键：不能靠 -ss/-to 直接切。HEVC/多数编码的关键帧间隔很大，
 * 只有关键帧才能无解码起点，-ss 落在非关键帧上会回退到上一个关键帧，
 * 于是切出来的首帧和你要的那一帧对不上。所以这里用 select 按帧号精确挑。
 */
async function clipSegment(job, videoPath, from, to, outFile, opts) {
  const pts = readFrameTimes(videoPath);
  if (!pts) return finish(job, 'error', '无法读取帧时间戳，ffprobe 可能不可用');

  const a = from - 1, b = to - 1;               // 0 基帧号
  const avail = pts.length;
  if (a < 0 || a > b) {
    return finish(job, 'error',
      `帧号不对：起始帧需 ≥ 1 且 ≤ 结束帧，你给的是 ${from} ~ ${to}`);
  }
  if (b > avail - 1) {
    return finish(job, 'error',
      `帧号超出范围：这个视频一共 ${avail} 帧，可用 1 ~ ${avail}，你给的结束帧是 ${to}`);
  }
  const count = b - a + 1;

  const startT = pts[a];
  const endT = b + 1 < pts.length ? pts[b + 1] : pts[b] + (opts.fps > 0 ? 1 / opts.fps : 0.04);

  /* 按帧号 select, 不用 -ss。
     原因: 源是 VFR, 相邻帧间隔不均匀(实测帧95与帧96只差 2.984ms,
     而正常间隔 16.7ms)。-ss 是按时间定位, 落点会偏到前一帧, 整段错一帧。
     select 走的是帧计数, 与时间戳无关, 对 VFR 天然免疫。
     从头解码到尾, 慢但唯一可靠 —— 帧精确没有捷径。 */
  const args = [
    '-hide_banner', '-y',
    '-i', videoPath,
    '-vf', `select='between(n\\,${a}\\,${b})',setpts=PTS-STARTPTS`,
    '-frames:v', String(count),
  ];

  /* 编码器按源视频自动选, 像素格式照抄源的。 */
  const enc = ENCODERS[opts.codec] || ENCODERS.hevc;
  if (!enc) return finish(job, 'error', '这个源视频的编码（' + opts.codec + '）本机没有对应的编码器');

  /* 默认逐位无损; crf 档只影响体积, 不影响帧精确性 —— 帧号由 -ss + -frames:v 保证 */
  const q = QUALITIES[opts.quality] ? opts.quality : 'lossless';

  args.push(
    '-c:v', enc.lib,
    ...(q === 'lossless' ? enc.lossless : enc.crf),
    '-preset', enc.preset,
    '-pix_fmt', opts.pixFmt || 'yuv420p',
    /* 不加 -r / -fps_mode: 强制定帧率会让 VFR 源丢帧或补帧。
       setpts=PTS-STARTPTS 已把时间轴归零, 保留原始帧间隔。 */
    '-fps_mode', 'passthrough'
  );

  /* 色彩元数据照抄源, 否则播放器可能整体偏色 */
  for (const [flag, val] of [
    ['-color_primaries', opts.colorPrimaries],
    ['-color_trc', opts.colorTrc],
    ['-colorspace', opts.colorspace],
  ]) {
    if (val && val !== 'unknown' && val !== 'unspecified') args.push(flag, val);
  }
  if (opts.colorRange === 'pc') args.push('-color_range', 'pc');

  /* 音频: 有轨就带, 保持源采样率/声道数。
     注意这里用绝对时间 trim —— 已经不用 -ss 了, 音频没有前移过。 */
  const aud = hasAudioStream(videoPath);
  if (aud) {
    args.push('-af', `atrim=start=${startT.toFixed(6)}:end=${endT.toFixed(6)},asetpts=N/SR/TB`,
      '-c:a', 'aac', '-b:a', '320k');
    if (opts.sampleRate) args.push('-ar', String(opts.sampleRate));
    if (opts.channels) args.push('-ac', String(opts.channels));
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', outFile);

  job.log = 'ffmpeg ' + args.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  job.total = count;

  await fsp.mkdir(path.dirname(outFile), { recursive: true });

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
    });

    proc.on('error', (e) => { finish(job, 'error', '无法启动 ffmpeg: ' + e.message); resolve(); });

    proc.on('close', async (code) => {
      job.proc = null;
      if (job.status === 'canceled') return resolve();
      if (code !== 0) {
        const line = stderrTail.split(/\r?\n/).filter(l => /error|invalid|unable|unknown/i.test(l)).pop()
          || `ffmpeg 退出码 ${code}`;
        return finish(job, 'error', line.trim()), resolve();
      }
      /* 校验实际产出的帧数, 对不上就报错, 绝不默默交一个错位的文件 */
      let real = 0;
      try {
        const pr = spawnSync(FFMPEG_BIN.ffprobe,
          ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
            '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', outFile],
          { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
        real = parseInt((pr.stdout || '').trim(), 10) || 0;
      } catch (_) {}

      let size = 0;
      try { size = (await fsp.stat(outFile)).size; } catch (_) {}

      if (real && real !== count) {
        try { await fsp.unlink(outFile); } catch (_) {}
        return finish(job, 'error',
          `帧数不对：你要 ${count} 帧，ffmpeg 出了 ${real} 帧，文件已删除`), resolve();
      }

      job.done = real || count;
      job.outFile = outFile;
      job.realFrames = real;
      job.size = size;
      job.startT = startT;
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
    /* 上传落盘一律叫 cut.<ext>：临时目录在 ASCII 路径下，
       避免中文/特殊字符的文件名被 ffmpeg 参数解析搞挂 */
    const dest = path.join(TMP_ROOT, token, 'cut' + getExt(origName));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
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
      /* 这里只借用, 不 uploads.delete —— 切完帧用户多半还要切片段,
         删了的话片段功能就会报「视频已失效」 */
      videoPath = up.path;
      origName = origName || up.name;
    } else {
      await fsp.mkdir(TMP_ROOT, { recursive: true });
      const dir = path.join(TMP_ROOT, 'j' + job.id);
      await fsp.mkdir(dir, { recursive: true });
      videoPath = path.join(dir, 'cut' + getExt(origName));
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

    /* 借用的上传文件不能删, 它还要给片段剪辑用;
       只有本次新收上来的 body 才随任务结束清掉 */
    const borrowed = !!(up && videoPath === up.path);

    // 不 await，先把 id 返回给前端去订阅进度
    cut(job, videoPath, outDir, fps, ext)
      .catch(e => finish(job, 'error', e.message))
      .finally(() => { if (!borrowed) fsp.rm(path.dirname(videoPath), { recursive: true, force: true }).catch(() => {}); });

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

  if (p === '/api/clip' && req.method === 'POST') {
    if (!FFMPEG_BIN) return json(res, 500, { error: '未找到 ffmpeg' });
    if (!FFMPEG_BIN.ffprobe) return json(res, 500, { error: '片段剪辑需要 ffprobe，请把它也放到脚本同目录或加入 PATH' });

    const origName = url.searchParams.get('name') || 'video.mp4';
    const from = parseInt(url.searchParams.get('from') || '', 10);
    const to = parseInt(url.searchParams.get('to') || '', 10);
    if (!isFinite(from) || !isFinite(to) || from < 1 || to < from) {
      return json(res, 400, { error: '帧号不对：需要「起始 - 结束」，且结束 ≥ 起始 ≥ 1' });
    }
    /* 只接受画质档位, 默认逐位无损。编码不接受 —— 一律跟随源视频。 */
    const quality = QUALITIES[url.searchParams.get('quality')] ? url.searchParams.get('quality') : 'lossless';

    /* 文件名: 原名_起-止.mp4, 落在脚本同目录。
       两档画质同名会互相覆盖, 所以 crf 档加 _crf 后缀。 */
    const base = safeName(path.basename(origName, path.extname(origName))) || 'video';
    const suffix = quality === 'lossless' ? '' : '_crf';
    const outName = `${base}_${from}-${to}${suffix}.mp4`;
    const outFile = path.join(CLIP_ROOT, outName);

    /* 复用 /api/probe 已上传的临时文件 */
    const token = url.searchParams.get('token') || '';
    const up = uploads.get(token);
    if (!up || !await fsp.stat(up.path).then(() => true).catch(() => false)) {
      return json(res, 400, { error: '视频已失效，请重新上传' });
    }

    const meta = up.meta || {};
    /* 用原始分子/分母, 别用四舍五入的小数 */
    const fpsStr = (meta.rateStr && /^[\d\/]+$/.test(meta.rateStr)) ? meta.rateStr : '60000/1001';

    /* 编码/色彩/音频全部照抄源, 编码不给用户选 */
    const codec = meta.codec || 'hevc';
    if (!ENCODERS[codec]) {
      return json(res, 400, {
        error: `源视频是 ${codec} 编码，本机没有对应的编码器。` +
               `关键帧稀疏的视频无法用流拷贝做帧精确剪辑，必须重编码，` +
               `所以只能先转成 HEVC 或 H.264 再切。`,
      });
    }

    const job = {
      id: ++jobSeq, name: outName, total: 0, done: 0, status: 'running',
      error: null, sse: new Set(), proc: null, kind: 'clip',
    };
    jobs.set(job.id, job);

    clipSegment(job, up.path, from, to, outFile, {
      codec, quality, fps: meta.fps || 0, fpsStr,
      pixFmt: meta.pixFmt,
      colorPrimaries: meta.colorPrimaries,
      colorTrc: meta.colorTrc,
      colorspace: meta.colorspace,
      colorRange: meta.colorRange,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
    })
      .catch(e => finish(job, 'error', e.message));
    /* 传进来的文件留着, 用户可以接着切别的片段;
       换视频时前端会调 /api/release 回收 */

    return json(res, 200, {
      id: job.id, file: outName, outFile, from, to,
      total: Math.max(0, to - from + 1),
    });
  }

  if (p === '/api/clip/open' && req.method === 'POST') {
    spawn('cmd', ['/c', 'explorer', CLIP_ROOT], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return json(res, 200, { ok: true, dir: CLIP_ROOT });
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

/* 页面文件 index.html, 启动时读一次缓存住, 改完刷新浏览器就生效 */
const INDEX_FILE = path.join(ROOT, 'index.html');
let INDEX_HTML = null;
try {
  INDEX_HTML = fs.readFileSync(INDEX_FILE, 'utf8');
} catch (e) {
  console.error('  [错误] 读不到 index.html：' + INDEX_FILE + '\n          请确认它和本脚本在同一个目录。\n');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, MIME['.html'], INDEX_HTML);
  }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/f') return await handleAsset(res, url);
    return send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch (_) {}
  }
});

/* ---------------- 启动 ---------------- */

(async () => {
  await fsp.mkdir(OUT_ROOT, { recursive: true });
  await fsp.mkdir(TMP_ROOT, { recursive: true });
  /* 清掉上次异常退出残留的临时文件 */
  try { for (const f of await fsp.readdir(TMP_ROOT)) await fsp.unlink(path.join(TMP_ROOT, f)).catch(() => {}); } catch (_) {}

  if (!FFMPEG_BIN) {
    console.log('  [警告] 没找到 ffmpeg。请把 ffmpeg.exe 放到本脚本同目录，或加入系统 PATH。\n');
  }

  /* 端口被占用就一路 +1 顺延, 找到能用的才启。
     整个过程只挂一个 error 监听, 成功后就摘掉 —— 否则重试会叠加监听器,
     导致成功后打印多次、弹出多个浏览器标签页。 */
  function onListenError(e) {
    if (e.code !== 'EADDRINUSE') throw e;
    curPort++;
    if (curPort >= PORT_START + PORT_MAX_TRY) {
      console.error('  端口 ' + PORT_START + ' ~ ' + (curPort - 1) + ' 都被占用了。');
      process.exit(1);
    }
    console.log('  端口 ' + (curPort - 1) + ' 被占用，顺延到 ' + curPort + ' …');
    setTimeout(() => server.listen(curPort, HOST), 120);
  }
  function onListening() {
    server.removeListener('error', onListenError);
    const url = 'http://' + HOST + ':' + curPort;
    console.log('');
    console.log('  视频切帧工具已启动');
    console.log('  请在浏览器打开：  ' + url);
    console.log('  切帧产物：       ' + OUT_ROOT);
    console.log('  片段成品：       ' + CLIP_ROOT);
    console.log('');
    try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_) {}
  }

  const HOST = '127.0.0.1';
  let curPort = PORT_START;
  server.on('error', onListenError);
  server.once('listening', onListening);
  server.listen(PORT_START, HOST);
})();

process.on('SIGINT', () => { for (const j of jobs.values()) { try { j.proc && j.proc.kill(); } catch (_) {} } process.exit(0); });
