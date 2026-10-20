#!/usr/bin/env bash
# Generates small deterministic media fixtures for tests (idempotent; skips existing files).
# Solid colours + distinct tones make exported output easy to verify automatically.
set -euo pipefail
cd "$(dirname "$0")/media"
FF="ffmpeg -hide_banner -loglevel error -y"
mk() { [ -f "$1" ] && return 0; echo "making $1"; shift_name="$1"; shift; $FF "$@" "$shift_name"; }

# name, colour, seconds, tone
color_clip() {
  local out=$1 color=$2 dur=$3 freq=$4 size=${5:-640x360} rate=${6:-30}
  [ -f "$out" ] && return 0
  echo "making $out"
  $FF -f lavfi -i "color=c=${color}:s=${size}:r=${rate}:d=${dur}" \
      -f lavfi -i "sine=frequency=${freq}:sample_rate=48000:duration=${dur}" \
      -vf "drawbox=x='mod(t*160,iw-60)':y=ih/2-30:w=60:h=60:color=white@0.9:t=fill,format=yuv420p" \
      -c:v libx264 -profile:v high -preset veryfast -crf 26 -g 30 -c:a aac -b:a 96k -ac 2 -shortest -movflags +faststart "$out"
}

color_clip clip-red.mp4 red 4 440
color_clip clip-green.mp4 green 3 660
color_clip clip-blue.mp4 blue 5 880
color_clip clip-vertical.mp4 orange 3 550 360x640
color_clip clip-hd.mp4 purple 6 330 1280x720 24

if [ ! -f clip-noaudio.mp4 ]; then echo "making clip-noaudio.mp4"; $FF -f lavfi -i "color=c=yellow:s=640x360:r=30:d=2" -vf format=yuv420p -c:v libx264 -preset veryfast -crf 28 -movflags +faststart clip-noaudio.mp4; fi
if [ ! -f clip-cyan.webm ]; then echo "making clip-cyan.webm"; $FF -f lavfi -i "color=c=cyan:s=640x360:r=30:d=3" -f lavfi -i "sine=frequency=990:sample_rate=48000:duration=3" -c:v libvpx-vp9 -b:v 300k -deadline realtime -cpu-used 8 -c:a libopus -b:a 64k -shortest clip-cyan.webm; fi
if [ ! -f music.mp3 ]; then echo "making music.mp3"; $FF -f lavfi -i "aevalsrc=0.3*sin(2*PI*(220+110*floor(mod(t\,4)))*t)|0.3*sin(2*PI*(330+55*floor(mod(t\,2)))*t):s=44100:d=12" -c:a libmp3lame -b:a 128k music.mp3; fi
if [ ! -f voice.wav ]; then echo "making voice.wav"; $FF -f lavfi -i "sine=frequency=300:sample_rate=48000:duration=3" -ac 1 voice.wav; fi
# Brightness ramp (grey level = 60 x seconds): which source time a frame shows can be read off its pixels (clip tools).
if [ ! -f clip-ramp.mp4 ]; then echo "making clip-ramp.mp4"; $FF -f lavfi -i "color=c=black:s=640x360:r=30:d=4" -vf "geq=lum='16+T*55':cb=128:cr=128,format=yuv420p" -c:v libx264 -preset veryfast -crf 18 -g 30 -movflags +faststart clip-ramp.mp4; fi
if [ ! -f still.jpg ]; then echo "making still.jpg"; $FF -f lavfi -i "testsrc2=s=1024x1024:d=1" -frames:v 1 still.jpg; fi
if [ ! -f still.png ]; then echo "making still.png"; $FF -f lavfi -i "gradients=s=800x600:d=1" -frames:v 1 still.png; fi
for c in red green blue vertical hd; do
  [ -f "thumb-$c.jpg" ] || $FF -ss 0.5 -i "clip-$c.mp4" -frames:v 1 -q:v 4 "thumb-$c.jpg"
done
echo "fixtures ready"
