#!/usr/bin/env bash
set -e

echo "==> Installing Node dependencies..."
npm install

echo "==> Installing ffmpeg..."
apt-get update -qq && apt-get install -y -qq ffmpeg

echo "==> Installing yt-dlp (latest)..."
pip install -U yt-dlp

echo "==> Verifying installs..."
ffmpeg -version | head -1
yt-dlp --version

echo "==> Build complete!"
