#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""컷 리스트(.json)의 시각을 영상에 맞춘다 — 표식음을 찾아서 자동으로.

수업 로그 앱은 "수업 시작"을 누를 때 두겹 순음(1000Hz + 1600Hz, 0.35초)을 낸다.
캠코더가 그 소리를 같이 녹음하므로, 영상 오디오에서 그 지점을 찾으면
"로그의 0초가 영상의 몇 초인가"가 그대로 나온다. 영화 촬영의 슬레이트와 같은 원리다.
사람이 영상을 열어 스크럽하며 맞출 일이 없어진다.

    python fix_sync.py 컷리스트-2026-08-20.json 원본.mp4
    python fix_sync.py 컷리스트.json 1.mp4 2.mp4     # 캠코더가 쪼갠 파일 (붙일 순서대로)

찾은 값을 먼저 보여주고 물어본 뒤에 고친다. 원본은 .bak 으로 남는다.
종료할 때 낸 두 번째 표식음까지 찾으면 캠코더 시계 드리프트도 재준다(--drift 로 적용).

필요: ffmpeg, numpy    (없으면 앱의 "영상 맞추기" 칸에 손으로 적으면 된다)
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

try:
    import numpy as np
except ImportError:
    sys.exit("numpy 가 필요합니다:  pip install numpy")

SR = 8000          # 8kHz면 1600Hz까지 충분하다 (나이퀴스트 4000Hz)
FRAME = 200        # 25ms — 0.35초 표식음이 14프레임에 걸친다
DEFAULT_TONES = [1000.0, 1600.0]
DEFAULT_DUR = 0.35


def hms(t):
    t = float(t)
    sign = "-" if t < 0 else ""
    t = abs(t)
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return "%s%d:%02d:%05.2f" % (sign, h, m, s) if h else "%s%d:%05.2f" % (sign, m, s)


def read_wav(path):
    """.wav 는 ffmpeg 없이 바로 읽는다 (오디오만 따로 뽑아둔 경우)."""
    import wave
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            return None
        ch, sr = w.getnchannels(), w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != SR:                       # 검출용이라 선형 보간이면 충분하다
        n = int(len(x) * SR / sr)
        x = np.interp(np.arange(n) * (sr / SR), np.arange(len(x)), x).astype(np.float32)
    return x


def read_audio(paths):
    """영상들의 오디오를 8kHz 모노로 이어붙여 읽는다. 파일 경계도 같이 돌려준다."""
    chunks, bounds, at = [], [], 0.0
    for p in paths:
        if not os.path.exists(p):
            sys.exit("파일이 없습니다: " + p)
        if p.lower().endswith(".wav"):
            x = read_wav(p)
            if x is not None:
                chunks.append(x); at += len(x) / SR; bounds.append((p, at))
                continue
        cmd = ["ffmpeg", "-v", "error", "-i", p, "-vn", "-ac", "1",
               "-ar", str(SR), "-f", "s16le", "-"]
        try:
            r = subprocess.run(cmd, capture_output=True, check=True)
        except FileNotFoundError:
            sys.exit("ffmpeg 을 찾을 수 없습니다. 설치하거나 PATH에 넣어주세요.")
        except subprocess.CalledProcessError as e:
            sys.exit("오디오를 읽지 못했습니다 (%s)\n%s" % (p, e.stderr.decode("utf-8", "replace")[:400]))
        x = np.frombuffer(r.stdout, dtype="<i2").astype(np.float32) / 32768.0
        if not len(x):
            sys.exit("오디오가 비어 있습니다: " + p + "  (소리 없이 녹화된 파일인가요?)")
        chunks.append(x)
        at += len(x) / SR
        bounds.append((p, at))
    return np.concatenate(chunks), bounds


def find_tones(x, tones, dur, sens):
    """두 순음이 동시에 서 있는 구간을 찾는다.

    "전체 소리 중 몇 %인가"로 재면 떠드는 교실에서 표식음이 묻힌다.
    대신 두 가지를 같이 본다 —
      · 제 이력 대비: 그 주파수가 이 영상 내내 있던 크기보다 훨씬 큰가
      · 이웃 대비:   같은 순간의 옆 주파수들보다 뾰족하게 솟아 있는가
    말소리는 에너지가 낮은 쪽에 넓게 퍼지고, 의자 끄는 소리 같은 충격음은
    넓은 띠를 한꺼번에 올리므로 둘 다를 동시에 만족시키지 못한다.
    게다가 두 음이 **동시에** 서야 하므로 휘파람·벨소리도 걸러진다.
    오검출 하나가 오탭 하나보다 훨씬 비싸다 — 애매하면 안 잡는 쪽으로 둔다.
    """
    n = len(x) // FRAME * FRAME
    if n < FRAME * 4:
        return []
    f = x[:n].reshape(-1, FRAME) * np.hanning(FRAME)
    mag = np.abs(np.fft.rfft(f, axis=1))
    nb_bins = mag.shape[1]
    bins = [int(round(t * FRAME / SR)) for t in tones]

    hist = np.median(mag, axis=0) + 1e-9          # 이 영상에서 그 주파수의 평소 크기
    hit = np.ones(len(mag), dtype=bool)
    for b in bins:
        near = [j for j in range(max(0, b - 6), min(nb_bins, b + 7)) if abs(j - b) > 2]
        floor = np.median(mag[:, near], axis=1) + 1e-9
        hit &= (mag[:, b] / hist[b] > 6.0 * sens)     # 제 이력 대비 (기본 15dB 위)
        hit &= (mag[:, b] / floor > 4.0 * sens)       # 이웃 대비 (기본 12dB 위)
    hit &= f.std(axis=1) > 0.0006                     # 디지털 무음에서 0으로 나누는 것 방지

    need = max(3, int(dur * 0.5 * SR / FRAME))        # 절반 이상 이어져야 한 번의 표식음
    runs, i = [], 0
    while i < len(hit):
        if not hit[i]:
            i += 1
            continue
        j = i
        while j < len(hit) and hit[j]:
            j += 1
        if j - i >= need:
            conf = float(min(np.median(mag[i:j, b] / hist[b]) for b in bins))
            runs.append({"start": i * FRAME / SR, "end": j * FRAME / SR, "score": conf})
        i = j
    return runs


def shift_times(doc, new_off, old_off, rate):
    """모든 영상 기준 시각을 새 오프셋(과 드리프트)에 맞춰 다시 쓴다."""
    def conv(t):
        return new_off + (float(t) - old_off) * rate

    for out in doc.get("outputs", []):
        parts = []
        for p in out.get("parts", []):
            a, b = conv(p["start"]), conv(p["end"])
            if b <= 0:                      # 영상이 시작되기 전 = 녹화에 없다
                continue
            p["start"], p["end"] = int(round(max(0.0, a))), int(round(b))
            parts.append(p)
        out["parts"] = parts
    doc["outputs"] = [o for o in doc.get("outputs", []) if o["parts"]]

    for g in doc.get("segments", []):
        g["start"], g["end"] = int(round(conv(g["start"]))), int(round(conv(g["end"])))

    doc["videoOffset"] = round(new_off, 2)
    doc["shift"] = 0                        # 위 시각에 이미 반영됨 — 또 더하지 말 것
    doc["syncedBy"] = "fix_sync.py"
    if rate != 1.0:
        doc["driftRate"] = rate
    return doc


def main():
    ap = argparse.ArgumentParser(description="표식음을 찾아 컷 리스트를 영상에 맞춘다")
    ap.add_argument("cutlist", help="앱에서 받은 컷 리스트 .json")
    ap.add_argument("video", nargs="+", help="원본 영상 (쪼개졌으면 붙일 순서대로)")
    ap.add_argument("-y", "--yes", action="store_true", help="묻지 않고 적용")
    ap.add_argument("-n", "--dry-run", action="store_true", help="찾기만 하고 고치지 않음")
    ap.add_argument("--drift", action="store_true",
                    help="종료 표식음까지 찾았으면 캠코더 시계 드리프트도 보정")
    ap.add_argument("--sens", type=float, default=1.0,
                    help="검출 문턱 배수. 소리가 작아 못 찾으면 0.5 로 낮춰본다 (기본 1.0)")
    a = ap.parse_args()

    with open(a.cutlist, encoding="utf-8-sig") as fp:
        doc = json.load(fp)

    sync = doc.get("sync") or {}
    tones = [float(t) for t in (sync.get("tones") or DEFAULT_TONES)]
    dur = float(sync.get("dur") or DEFAULT_DUR)
    end_log_t = sync.get("endBeepLogT")
    old_off = float(doc.get("videoOffset") or 0)

    if sync and sync.get("beeped") is False:
        print("※ 이 수업은 표식음을 내지 않았습니다(소리 꺼짐). 그래도 한 번 찾아봅니다.\n")

    print("오디오를 읽는 중… (%s)" % ", ".join(os.path.basename(v) for v in a.video))
    x, bounds = read_audio(a.video)
    total = len(x) / SR
    print("길이 %s · 표식음 %s Hz %.2f초\n" % (hms(total), "+".join("%d" % t for t in tones), dur))

    runs = find_tones(x, tones, dur, a.sens)
    if not runs:
        print("표식음을 찾지 못했습니다.")
        print("  · 캠코더가 소리를 담지 못했을 수 있어요 (폰이 멀거나, 볼륨이 작거나)")
        print("  · --sens 0.5 로 문턱을 낮춰 다시 해보세요")
        print("  · 그래도 안 나오면 앱의 '영상 맞추기' 칸에 손으로 적으면 됩니다")
        sys.exit(2)

    for r in runs:
        where = ""
        if len(bounds) > 1:
            for p, upto in bounds:
                if r["start"] < upto:
                    where = "  [%s]" % os.path.basename(p)
                    break
        print("  표식음  %s  (평소보다 %.0f배 큼)%s" % (hms(r["start"]), r["score"], where))
    print()

    new_off = runs[0]["start"]
    rate = 1.0
    if end_log_t and len(runs) > 1:
        want = new_off + float(end_log_t)
        cand = min(runs[1:], key=lambda r: abs(r["start"] - want))
        gap = cand["start"] - want
        if abs(gap) <= max(30.0, float(end_log_t) * 0.02):
            measured = cand["start"] - new_off
            rate = measured / float(end_log_t)
            print("종료 표식음도 찾았습니다 — 예상보다 %+.1f초 (%.4f배)" % (gap, rate))
            if not a.drift:
                print("  드리프트 보정은 --drift 를 붙이면 적용합니다\n")
                rate = 1.0
            else:
                print("  드리프트를 적용합니다 (2시간에 %+.1f초)\n" % ((rate - 1) * 7200))
        else:
            print("두 번째 표식음이 예상 위치와 %s 떨어져 있어 무시합니다\n" % hms(abs(gap)))

    print("로그의 0초 = 영상 %s" % hms(new_off))
    if old_off:
        print("  (지금 컷 리스트는 %s 로 되어 있음 → %+.2f초 이동)" % (hms(old_off), new_off - old_off))
    kept = [g for g in doc.get("segments", []) if g.get("keep")]
    if kept:
        g = kept[0]
        print("  확인: 첫 강의(%s)는 영상 %s 부터" % (g.get("student") or "?", hms(new_off + (g["start"] - old_off))))
    print()

    if a.dry_run:
        return
    if not a.yes:
        try:
            ans = input("이대로 컷 리스트를 고칠까요? [Y/n] ").strip().lower()
        except EOFError:
            ans = "n"
        if ans not in ("", "y", "yes", "ㅛ"):
            print("그대로 두었습니다.")
            return

    shutil.copyfile(a.cutlist, a.cutlist + ".bak")
    shift_times(doc, new_off, old_off, rate)
    with open(a.cutlist, "w", encoding="utf-8") as fp:
        json.dump(doc, fp, ensure_ascii=False, indent=2)
    print("고쳤습니다: %s  (원본은 %s.bak)" % (a.cutlist, os.path.basename(a.cutlist)))
    print("이제 split_by_log.py 를 돌리면 됩니다.")


if __name__ == "__main__":
    main()
