#!/usr/bin/env bash
# Contact sheets of the finished film, the way the references were reviewed:
#   ./review.sh full [fps]          every 4 s of film on one sheet (default 12 fps)
#   ./review.sh at START LEN [step] every Nth frame of a stretch at 60 fps (default every 2nd)
set -euo pipefail
cd "$(dirname "$0")"
IN=${IN:-out/codeply-3.0-launch.mp4}
OUT=${OUT:-out/review}
F=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
mkdir -p "$OUT"
if [ "$1" = full ]; then
  FPS=${2:-12}
  ffmpeg -v error -y -i "$IN" -vf "fps=$FPS,scale=400:-1,drawtext=fontfile=$F:text='%{pts\:hms}':x=4:y=4:fontsize=17:fontcolor=red:box=1:boxcolor=white,tile=8x6" "$OUT/full_%02d.jpg"
else
  S=$2; L=$3; STEP=${4:-2}
  ffmpeg -v error -y -ss "$S" -t "$L" -i "$IN" -copyts -vf "select='not(mod(n,$STEP))',scale=400:-1,drawtext=fontfile=$F:text='%{pts\:hms}':x=4:y=4:fontsize=17:fontcolor=red:box=1:boxcolor=white,tile=8x6" -frames:v 1 "$OUT/at_${S}.jpg"
fi
ls "$OUT"
