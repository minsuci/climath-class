# -*- coding: utf-8 -*-
"""실전 시험 문항 그림 — 시험지 PDF 에서 문항마다 잘라 서버(examImgs)에 넣는다.
학생은 제출한 뒤 결과 화면에서 번호를 누르면 그 문항을 본다 (api/examimg.js).

  python tools/exam-img.py --pdf "…실전모의고사 1회(35제).pdf" --id 대성고-2중간-1회 --dry   잘라서 폴더에만
  python tools/exam-img.py --pdf "…" --id 대성고-2중간-1회                                  올리기
  python tools/exam-img.py --id 대성고-2중간-1회 --list                                     올라간 번호
  python tools/exam-img.py --id 대성고-2중간-1회 --del                                      빼기

자르는 법: 변형교재 시험지는 2단이고 문항 번호가 «N.» 13pt 굵은 글자다. 번호에서 같은 단의
다음 번호(또는 쪽 끝)까지를 자르고, 아래 풀이 여백은 내용이 끝나는 곳까지 걷어 낸다.
«빠른 정답» 쪽부터는 안 본다 (해설에 번호가 또 나온다).
"""
import argparse, base64, io, json, os, re, sys, urllib.request

import pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
HERE = os.path.dirname(os.path.abspath(__file__))
API = (os.environ.get("CLIMATH_URL") or "https://climath-class.vercel.app") + "/api/examimg"
DPI = 150
COL_W = 256          # 단 폭(pt). 2단 A4 에서 왼쪽 단 37~293, 오른쪽 310~566
FOOT = 800           # 쪽 번호 줄 위까지


def call(payload):
    key = json.load(open(os.path.join(HERE, "lesson-key.json"), encoding="utf-8"))["key"]
    req = urllib.request.Request(API, data=json.dumps({**payload, "toolKey": key}).encode("utf-8"),
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit("서버가 거절했습니다 (%d): %s" % (e.code, e.read().decode("utf-8", "replace")[:300]))


def numbers(pg):
    out = []
    for b in pg.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for sp in l["spans"]:
                t = sp["text"].strip()
                if re.fullmatch(r"\d{1,2}\.", t) and sp["size"] > 12:
                    out.append((int(t[:-1]), sp["bbox"][0], sp["bbox"][1]))
    return out


def content_bottom(pg, clip):
    """clip 안에서 글자·선·그림이 끝나는 y. 풀이 여백을 걷어 낸다"""
    ys = []
    for b in pg.get_text("dict", clip=clip)["blocks"]:
        r = pymupdf.Rect(b["bbox"]) & clip
        if not r.is_empty:
            ys.append(r.y1)
    for dr in pg.get_drawings():
        r = pymupdf.Rect(dr["rect"]) & clip
        if not r.is_empty and r.height < clip.height * 0.95:   # 단 전체를 두르는 테두리는 빼고
            ys.append(r.y1)
    for im in pg.get_image_info():
        r = pymupdf.Rect(im["bbox"]) & clip
        if not r.is_empty:
            ys.append(r.y1)
    return max(ys) if ys else clip.y1


def crops(pdf):
    d = pymupdf.open(pdf)
    got = {}
    for i in range(d.page_count):
        pg = d[i]
        if "빠른 정답" in pg.get_text():
            break
        ns = numbers(pg)
        for n, x, y in ns:
            below = [yy for nn, xx, yy in ns if abs(xx - x) < 30 and yy > y + 5]
            y1 = min(below) - 6 if below else FOOT
            clip = pymupdf.Rect(x - 4, y - 4, min(x + COL_W, pg.rect.x1 - 10), y1)
            clip.y1 = min(clip.y1, content_bottom(pg, clip) + 8)
            pix = pg.get_pixmap(dpi=DPI, clip=clip)
            if n in got:
                raise SystemExit("%d번이 두 번 나옵니다 — 시험지 모양이 다릅니다" % n)
            got[n] = pix
    d.close()
    ns = sorted(got)
    if not ns or ns != list(range(1, ns[-1] + 1)):
        raise SystemExit("번호가 이어지지 않습니다: %s" % ns)
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf"); ap.add_argument("--id", required=True)
    ap.add_argument("--dry", action="store_true"); ap.add_argument("--list", action="store_true")
    ap.add_argument("--del", dest="delete", action="store_true"); ap.add_argument("--out")
    a = ap.parse_args()
    if a.list:
        print(a.id, "→", call({"action": "imgList", "examId": a.id})["ns"]); return
    if a.delete:
        print("뺐습니다:", call({"action": "imgDel", "examId": a.id})["deleted"], "장"); return
    if not a.pdf:
        raise SystemExit("--pdf 가 필요합니다")
    got = crops(a.pdf)
    print("%d문항 잘랐습니다" % len(got))
    if a.dry:
        out = a.out or os.path.join(os.getcwd(), "examimg_" + a.id)
        os.makedirs(out, exist_ok=True)
        for n, pix in got.items():
            pix.save(os.path.join(out, "%02d.png" % n))
        print("→", out); return
    total = 0
    for n, pix in sorted(got.items()):
        png = pix.tobytes("png"); total += len(png)
        call({"action": "imgPut", "examId": a.id, "n": n, "png": base64.b64encode(png).decode("ascii"),
              "w": pix.width, "h": pix.height})
    print("올렸습니다 — %d장 · %.1f MB" % (len(got), total / 1e6))
    print(a.id, "→", call({"action": "imgList", "examId": a.id})["ns"])


if __name__ == "__main__":
    main()
