const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 2000;

// ─── Downloads folder ────────────────────────────────────────────────────────
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// ─── Serve the HTML frontend ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── /down  — SSE endpoint that streams yt-dlp progress to the browser ───────
//
// Query params:
//   url          — the video URL
//   format       — yt-dlp -f value  (e.g. "bestvideo+bestaudio/best")
//   mergeFormat  — "mp4" | "mp3"
//   extra        — comma-separated extra flags, e.g. "-x,--audio-format,mp3"
//
app.get('/down', (req, res) => {
  const { url, format, mergeFormat, extra } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // ── Validate platform ──
  const isYouTube   = url.includes('youtube.com') || url.includes('youtu.be');
  const isInstagram = url.includes('instagram.com');
  if (!isYouTube && !isInstagram) {
    return res.status(400).json({ error: 'Only YouTube and Instagram URLs are supported.' });
  }

  // ── Output filename template ──
  const outputTemplate = path.join(DOWNLOADS_DIR, `${Date.now()}_%(title)s.%(ext)s`);

  // ── Build yt-dlp args — highest quality ──
  const mode = req.query.mode || 'hd';   // 'hd' | 'sd' | 'mp3'

  let formatStr, mergeOutputFormat;
  const extraFlags = [];

  if (mode === 'mp3') {
    // Best audio, extract to MP3 320kbps
    formatStr = 'bestaudio/best';
    mergeOutputFormat = 'mp3';
    extraFlags.push(
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',          // 0 = best (VBR ~320kbps)
    );
  } else if (mode === 'sd') {
    // Best quality up to 720p
    formatStr = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
    mergeOutputFormat = 'mp4';
  } else {
    // HD — absolute best: prefer VP9/AV1 for quality, fall back gracefully
    formatStr = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
    mergeOutputFormat = 'mp4';
  }

  const args = [
    '-f', formatStr,
    '--merge-output-format', mergeOutputFormat,
    '-o', outputTemplate,
    '--progress',
    '--newline',
    '--no-playlist',
    '--no-warnings',
    '--prefer-free-formats',           // prefer open formats when quality is equal
    '--remux-video', 'mp4',            // always remux to mp4 container
    '--add-metadata',                  // embed title/artist metadata
    '--embed-thumbnail',               // embed thumbnail where supported
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',  // web-optimised mp4
    ...extraFlags,
    url,
  ];

  console.log(`\n▶  yt-dlp ${args.join(' ')}\n`);

  // ── Set up SSE ──
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx buffering if behind proxy
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { title: 'Starting yt-dlp…', status: 'Connecting', percent: 5 });

  // ── Spawn yt-dlp ──
  const ytDlp = spawn('yt-dlp', args);
  let lastFilename = '';
  let buffer = '';

  ytDlp.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();          // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log('[yt-dlp stdout]', trimmed);

      // ── Parse progress: [download]  45.3% of  123.45MiB at  3.00MiB/s ETA 00:12
      const progressMatch = trimmed.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/);
      if (progressMatch) {
        send('progress', {
          percent: parseFloat(progressMatch[1]),
          title:   'Downloading…',
          status:  `${progressMatch[1]}% · ${progressMatch[2]} · ${progressMatch[3]}/s · ETA ${progressMatch[4]}`
        });
        continue;
      }

      // ── Destination / merge line ──
      const destMatch = trimmed.match(/^\[(?:download|Merger|ffmpeg)\]\s+Destination:\s+(.+)/);
      if (destMatch) {
        lastFilename = path.basename(destMatch[1]);
        send('progress', { title: lastFilename, status: 'Writing file…', percent: 80 });
        continue;
      }

      // ── Already downloaded ──
      if (trimmed.includes('[download] 100%')) {
        send('progress', { percent: 99, status: 'Finalizing…' });
      }

      // ── Generic info ──
      const infoMatch = trimmed.match(/^\[(?:info|youtube|instagram)\]\s+(.+)/i);
      if (infoMatch) {
        send('progress', { status: infoMatch[1].slice(0, 80) });
      }
    }
  });

  ytDlp.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    console.error('[yt-dlp stderr]', text);
    // Surface non-trivial errors to the client
    if (text && !text.startsWith('WARNING')) {
      send('progress', { status: text.slice(0, 100) });
    }
  });

  ytDlp.on('close', code => {
    console.log(`\n✅ yt-dlp exited with code ${code}`);
    if (code === 0) {
      // Find the actual saved file by its timestamp prefix
      const prefix = path.basename(outputTemplate).split('%(')[0];
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(prefix));
      const savedFile = files[0] || lastFilename;
      send('done', {
        filename: savedFile,
        downloadUrl: `/fetch?file=${encodeURIComponent(savedFile)}`,
      });
    } else {
      send('error-msg', {
        message: `yt-dlp failed (code ${code}). Check the URL or try again.`,
      });
    }
    res.end();
  });

  ytDlp.on('error', err => {
    console.error('Failed to start yt-dlp:', err.message);
    send('error-msg', { message: 'yt-dlp not found. Make sure it is installed: pip install yt-dlp' });
    res.end();
  });

  // ── If client disconnects, kill yt-dlp ──
  req.on('close', () => {
    ytDlp.kill();
    console.log('Client disconnected — yt-dlp killed.');
  });
});

// ─── /fetch?file=name  — push file to browser as a real download ─────────────
app.get('/fetch', (req, res) => {
  const filename = req.query.file;
  if (!filename) return res.status(400).send('Missing file param');

  // Safety: strip any path traversal attempts
  const safe = path.basename(filename);
  const filePath = path.join(DOWNLOADS_DIR, safe);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found. It may still be processing.');
  }

  // Strip the timestamp prefix (e.g. "1712345678_") before sending to browser
  const cleanName = safe.replace(/^\d+_/, '');

  res.setHeader('Content-Disposition', `attachment; filename="${cleanName}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', err => {
    console.error('Stream error:', err);
    res.status(500).end();
  });
});

// ─── /downloads/:file  — serve downloaded files back to browser ──────────────
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── List recent downloads ────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const files = fs.readdirSync(DOWNLOADS_DIR)
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(DOWNLOADS_DIR, f)).size,
      url:  `/downloads/${encodeURIComponent(f)}`
    }))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 20);
  res.json(files);
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ⚡  SnapLoad server running!
  ─────────────────────────────────
  🌐  Open: http://localhost:${PORT}
  📁  Downloads saved to: ${DOWNLOADS_DIR}
  ─────────────────────────────────
  `);
});