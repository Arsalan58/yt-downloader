const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();

// ─── Render requires binding to process.env.PORT ─────────────────────────────
const PORT = process.env.PORT || 2000;

// ─── Downloads folder ─────────────────────────────────────────────────────────
// Render's filesystem is ephemeral — use /tmp for temporary storage.
// Files only need to live long enough for the browser to download them.
const DOWNLOADS_DIR = process.env.RENDER
  ? '/tmp/snapload-downloads'
  : path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ─── Auto-clean files older than 10 minutes (keeps /tmp lean on Render) ──────
setInterval(() => {
  const TEN_MIN = 10 * 60 * 1000;
  try {
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > TEN_MIN) {
        fs.unlinkSync(fp);
        console.log('Cleaned up:', f);
      }
    });
  } catch (e) { /* ignore */ }
}, 5 * 60 * 1000);

// ─── Serve the HTML frontend ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── /down — SSE endpoint: runs yt-dlp, streams progress to browser ──────────
app.get('/down', (req, res) => {
  const { url, mode } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const isYouTube   = url.includes('youtube.com') || url.includes('youtu.be');
  const isInstagram = url.includes('instagram.com');
  if (!isYouTube && !isInstagram) {
    return res.status(400).json({ error: 'Only YouTube and Instagram URLs are supported.' });
  }

  const timestamp = Date.now();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${timestamp}_%(title)s.%(ext)s`);

  // ── Format selection ──────────────────────────────────────────────────────────
  let formatStr, mergeOutputFormat;
  const extraFlags = [];

  if (mode === 'mp3') {
    formatStr         = 'bestaudio/best';
    mergeOutputFormat = 'mp3';
    extraFlags.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (mode === 'sd') {
    formatStr         = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
    mergeOutputFormat = 'mp4';
  } else {
    // HD — best separate video + audio merged by ffmpeg
    formatStr         = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
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
    '--prefer-free-formats',
    '--remux-video', 'mp4',
    '--add-metadata',
    '--embed-thumbnail',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    ...extraFlags,
    url,
  ];

  console.log(`\n> yt-dlp ${args.join(' ')}\n`);

  // ── SSE setup ─────────────────────────────────────────────────────────────────
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('progress', { title: 'Starting yt-dlp…', status: 'Connecting', percent: 5 });

  const ytDlp = spawn('yt-dlp', args);
  let lastFilename = '';
  let buffer = '';

  ytDlp.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      console.log('[stdout]', t);

      const pm = t.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/);
      if (pm) {
        send('progress', {
          percent: parseFloat(pm[1]),
          title:   'Downloading…',
          status:  `${pm[1]}% of ${pm[2]} at ${pm[3]}/s — ETA ${pm[4]}`,
        });
        continue;
      }

      const dm = t.match(/^\[(?:download|Merger|ffmpeg)\]\s+Destination:\s+(.+)/);
      if (dm) {
        lastFilename = path.basename(dm[1]);
        send('progress', { title: lastFilename, status: 'Writing file…', percent: 85 });
        continue;
      }

      if (t.includes('[download] 100%')) {
        send('progress', { percent: 99, status: 'Finalizing…' });
      }

      const im = t.match(/^\[(?:info|youtube|instagram)\]\s+(.+)/i);
      if (im) send('progress', { status: im[1].slice(0, 80) });
    }
  });

  ytDlp.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    console.error('[stderr]', text);
    if (text && !text.startsWith('WARNING')) {
      send('progress', { status: text.slice(0, 100) });
    }
  });

  ytDlp.on('close', code => {
    console.log(`\nyt-dlp exited with code ${code}`);
    if (code === 0) {
      const prefix = `${timestamp}_`;
      const files  = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(prefix));
      const saved  = files[0] || lastFilename;
      send('done', {
        filename:    saved,
        downloadUrl: `/fetch?file=${encodeURIComponent(saved)}`,
      });
    } else {
      send('error-msg', {
        message: `yt-dlp failed (code ${code}). Check the URL or try again.`,
      });
    }
    res.end();
  });

  ytDlp.on('error', err => {
    console.error('yt-dlp spawn error:', err.message);
    send('error-msg', { message: 'yt-dlp not found on server.' });
    res.end();
  });

  req.on('close', () => {
    ytDlp.kill();
    console.log('Client disconnected — yt-dlp killed.');
  });
});

// ─── /fetch?file= — send saved file to browser as download ───────────────────
app.get('/fetch', (req, res) => {
  const filename = req.query.file;
  if (!filename) return res.status(400).send('Missing file param');

  const safe     = path.basename(filename);
  const filePath = path.join(DOWNLOADS_DIR, safe);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or already cleaned up. Try downloading again.');
  }

  const cleanName = safe.replace(/^\d+_/, '');

  res.setHeader('Content-Disposition', `attachment; filename="${cleanName}"`);
  res.setHeader('Content-Type',        'application/octet-stream');
  res.setHeader('Content-Length',      fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', err => {
    console.error('Stream error:', err);
    res.status(500).end();
  });

  // Delete after sending to save /tmp space
  res.on('finish', () => fs.unlink(filePath, () => {}));
});

// ─── /api/history ─────────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const files = fs.readdirSync(DOWNLOADS_DIR)
    .map(f => ({
      name: f.replace(/^\d+_/, ''),
      size: fs.statSync(path.join(DOWNLOADS_DIR, f)).size,
      url:  `/fetch?file=${encodeURIComponent(f)}`,
    }))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 20);
  res.json(files);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  SnapLoad running on port ${PORT}
  Downloads dir: ${DOWNLOADS_DIR}
  Render mode: ${process.env.RENDER ? 'YES' : 'NO'}
  `);
});
