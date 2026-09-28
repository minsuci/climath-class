# -*- coding: utf-8 -*-
"""실전 시험 문항 그림 — 시험지 PDF 에서 문항마다 잘라 서버(examImgs)에 넣는다.
학생은 제출한 뒤 결과 화면에서 번호를 누르면 그 문항을 본다 (api/examimg.js).

  python tools/exam-img.py --pdf "…실전모의고사 1회(35제).pdf" --id 대성고-2중간-1회 --dry   잘라서 폴더에만
  python tools/exam-img.py --pdf "…" --id 대성고-2중간-1회                                  올리기
  python tools/exam-img.py --id 대성고-2중간-1회 --list                                     올라간 번호
  python tools/exam-img.py --id 대성고-2중간-1회 --del                                      빼기

해설: «정답과 해설» 쪽(2단)에서 굵은 «N.» 머리부터 같은 단의 다음 머리까지를 자른다. 단의 마지막
해설은 줄 사이가 크게 벌어지는 곳(출처 표 등)에서 끊는다. 해설 쪽이 없는 시험지(선덕고)는 문제만 올라간다.

기출백서 합본(학교별 회차가 한 PDF)은 --style gichul --pages 60-66 으로 그 학교 쪽만. 문항 위에 숨은
«N)» 표시(0.7pt)가 있고 2단(단 폭 약 320pt)이다. 해설은 없다.

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


STYLE = "ban"   # ban = 변형교재 시험지 · gichul = 기출백서 합본


def numbers(pg):
    out = []
    if STYLE == "gichul":
        for b in pg.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                sp = l["spans"][0]
                m = re.match(r"^(\d{1,2})\)", sp["text"].strip())
                if m and sp["size"] < 2:
                    out.append((int(m.group(1)), sp["bbox"][0], sp["bbox"][1]))
        return out
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
        if STYLE == "gichul" and b.get("type") == 1:
            continue   # 워터마크 그림 조각
        r = pymupdf.Rect(b["bbox"]) & clip
        if not r.is_empty:
            ys.append(r.y1)
    for dr in pg.get_drawings():
        r = pymupdf.Rect(dr["rect"]) & clip
        if not r.is_empty and r.height < clip.height * 0.95:   # 단 전체를 두르는 테두리는 빼고
            if STYLE == "gichul" and r.width < 3 and r.height > 60:
                continue   # 단 사이 세로줄
            ys.append(r.y1)
    for im in pg.get_image_info():
        if STYLE == "gichul":
            break      # 기출백서의 그림은 워터마크(CLIMATH)·로고뿐 — 문항 그림은 선으로 그려져 있다
        r = pymupdf.Rect(im["bbox"]) & clip
        if not r.is_empty:
            ys.append(r.y1)
    return max(ys) if ys else clip.y1


def crops(pdf, pages=None):
    d = pymupdf.open(pdf)
    got = {}
    for i in (pages or range(d.page_count)):
        pg = d[i]
        if "빠른 정답" in pg.get_text():
            break
        ns = numbers(pg)
        for n, x, y in ns:
            below = [yy for nn, xx, yy in ns if abs(xx - x) < 30 and yy > y + 5]
            y1 = min(below) - 6 if below else FOOT
            clip = pymupdf.Rect(x - 4, y - 4, min(x + COL_W, pg.rect.x1 - 10), y1)
            if STYLE == "gichul":
                # 보이는 머리(«2) ★☆☆☆»)는 숨은 표시보다 조금 위에서 시작한다 — 다음 머리가 딸려 오지 않게 넉넉히 뺀다
                y1 = (min(below) - 14) if below else pg.rect.y1 - 62   # 쪽 번호 줄(«60 클라이매쓰») 위까지
                clip = pymupdf.Rect(x - 8, y - 6, x + 306, y1)
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


def sol_heads(pg):
    """해설 머리 «N.» — 굵은 맑은 고딕, 본문 크기(9pt 안팎). 문제 번호(13pt)와 다르다"""
    out = []
    for b in pg.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            sps = l["spans"]
            for k, sp in enumerate(sps):
                t = sp["text"].strip()
                if re.fullmatch(r"\d{1,2}\.", t) and (sp["flags"] & 16) and 8 < sp["size"] < 11 and k == 0:
                    out.append((int(t[:-1]), sp["bbox"][0], sp["bbox"][1]))
    return out


def elements(pg):
    """줄·선·그림의 상자 (위에서 아래로)"""
    el = []
    for b in pg.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            el.append(pymupdf.Rect(l["bbox"]))
    for dr in pg.get_drawings():
        el.append(pymupdf.Rect(dr["rect"]))
    for im in pg.get_image_info():
        el.append(pymupdf.Rect(im["bbox"]))
    return el


def sol_crops(pdf):
    d = pymupdf.open(pdf)
    start = next((i for i in range(d.page_count) if "빠른 정답" in d[i].get_text()), None)
    got = {}
    if start is None:
        return got
    for i in range(start, d.page_count):
        pg = d[i]
        hs = sol_heads(pg)
        if not hs:
            continue
        el = elements(pg)
        for n, x, y in hs:
            col = pymupdf.Rect(x - 4, y - 3, min(x + COL_W, pg.rect.x1 - 10), FOOT)
            below = [yy for nn, xx, yy in hs if abs(xx - x) < 30 and yy > y + 5]
            if below:
                col.y1 = min(below) - 5
            # 내용이 끝나는 곳까지 — 줄 사이가 크게 벌어지면(22pt 넘게) 거기서 끊는다
            bottom = y + 10
            for r in sorted((r & col for r in el), key=lambda r: r.y0):
                if r.is_empty or r.y1 <= y or r.width > col.width * 0.98 and r.height < 2:
                    continue
                if r.y0 > bottom + 22:
                    break
                bottom = max(bottom, r.y1)
            col.y1 = min(col.y1, bottom + 6)
            if n in got:
                raise SystemExit("해설 %d번이 두 번 나옵니다" % n)
            got[n] = pg.get_pixmap(dpi=DPI, clip=col)
    d.close()
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf"); ap.add_argument("--id", required=True)
    ap.add_argument("--dry", action="store_true"); ap.add_argument("--list", action="store_true")
    ap.add_argument("--del", dest="delete", action="store_true"); ap.add_argument("--out")
    ap.add_argument("--style", default="ban", choices=["ban", "gichul"])
    ap.add_argument("--pages", help="쪽 범위 (1부터) 예: 60-66")
    a = ap.parse_args()
    global STYLE
    STYLE = a.style
    pages = None
    if a.pages:
        p0, p1 = [int(x) for x in a.pages.split("-")]
        pages = range(p0 - 1, p1)
    if a.list:
        r = call({"action": "imgList", "examId": a.id}); print(a.id, "→ 문제", r["ns"], "/ 해설", r.get("sols")); return
    if a.delete:
        print("뺐습니다:", call({"action": "imgDel", "examId": a.id})["deleted"], "장"); return
    if not a.pdf:
        raise SystemExit("--pdf 가 필요합니다")
    got = crops(a.pdf, pages)
    sols = sol_crops(a.pdf) if STYLE == "ban" else {}
    print("%d문항 잘랐습니다 · 해설 %d개" % (len(got), len(sols)))
    if sols and sorted(sols) != sorted(got):
        print("  ⚠ 해설 번호가 문제와 다릅니다 — 없는 것:", sorted(set(got) - set(sols)), "남는 것:", sorted(set(sols) - set(got)))
    if a.dry:
        out = a.out or os.path.join(os.getcwd(), "examimg_" + a.id)
        os.makedirs(out, exist_ok=True)
        for n, pix in got.items():
            pix.save(os.path.join(out, "%02d.png" % n))
        for n, pix in sols.items():
            pix.save(os.path.join(out, "%02d_해설.png" % n))
        print("→", out); return
    total = 0
    for kind, dd in (("q", got), ("sol", sols)):
        for n, pix in sorted(dd.items()):
            png = pix.tobytes("png"); total += len(png)
            call({"action": "imgPut", "examId": a.id, "n": n, "kind": kind,
                  "png": base64.b64encode(png).decode("ascii"), "w": pix.width, "h": pix.height})
    print("올렸습니다 — 문제 %d장 · 해설 %d장 · %.1f MB" % (len(got), len(sols), total / 1e6))
    r = call({"action": "imgList", "examId": a.id}); print(a.id, "→ 문제", len(r["ns"]), "장 · 해설", len(r.get("sols") or []), "장")


if __name__ == "__main__":
    main()
