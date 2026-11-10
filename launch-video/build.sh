#!/usr/bin/env bash
# Builds the Codeply 3.0 launch film: cues -> music -> 4 parallel video parts -> one MP4 with sound.
#   ./build.sh            (needs node, ffmpeg, python3 with numpy+scipy, and Playwright's Chromium)
set -euo pipefail
cd "$(dirname "$0")"
PORT=8830
if ! curl -s -o /dev/null "http://localhost:$PORT/comp/index.html"; then
  node serve.js $PORT > /dev/null 2>&1 &
  SERVER=$!; trap 'kill $SERVER' EXIT; sleep 1
fi
mkdir -p out
node render.js cues --out music/cues.json
python3 music/make_music.py
PARTS=(0 15 30 45 60)
for i in 0 1 2 3; do
  node render.js video --from ${PARTS[$i]} --to ${PARTS[$((i+1))]} --out out/part$i.mp4 --crf ${CRF:-12} --preset ${PRESET:-slow} > out/part$i.log 2>&1 &
done
wait
printf "file 'part0.mp4'\nfile 'part1.mp4'\nfile 'part2.mp4'\nfile 'part3.mp4'\n" > out/parts.txt
ffmpeg -v error -y -f concat -safe 0 -i out/parts.txt -i music/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart out/codeply-3.0-launch.mp4
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact out/codeply-3.0-launch.mp4
