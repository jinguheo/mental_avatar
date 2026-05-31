#!/bin/bash
# 다양한 얼굴 이미지로 아바타 영상 생성 테스트
API="http://127.0.0.1:8766"
SADTALKER_IMGS="D:/MyWork/SadTalker/examples/source_image"
TEXT="안녕하세요. 저는 디지털 아바타입니다. 잘 부탁드립니다."

run_test() {
  local label=$1
  local imgpath=$2
  echo ""
  echo "=== [$label] ==="
  echo "이미지: $imgpath"
  local start=$(date +%s)
  local resp=$(curl -s -X POST "$API/avatar/tts_generate" \
    -F "face=@$imgpath" \
    -F "text=$TEXT" \
    --max-time 300)
  local end=$(date +%s)
  local elapsed=$((end - start))
  echo "소요: ${elapsed}s"
  echo "응답: $resp" | python3 -c "import sys,json; d=json.load(sys.stdin.read() if False else sys.stdin); print('mp4:', d.get('video_url','ERROR'), '| error:', d.get('error','없음'))" 2>/dev/null || echo "응답: $resp"
}

echo "### 아바타 다중 얼굴 테스트 시작 ###"
run_test "실사사람_people_0"   "$SADTALKER_IMGS/people_0.png"
run_test "감정_happy"          "$SADTALKER_IMGS/happy.png"
run_test "감정_sad"            "$SADTALKER_IMGS/sad.png"
run_test "아트_art_0"          "$SADTALKER_IMGS/art_0.png"
run_test "전신_full_body_1"    "$SADTALKER_IMGS/full_body_1.png"
echo ""
echo "### 완료 ###"
