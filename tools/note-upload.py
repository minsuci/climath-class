# -*- coding: utf-8 -*-
"""PDF 를 앱의 «강의노트» 에 올린다.

강의노트는 원래 선생님이 브라우저에서 끌어다 놓는 자리다. 이 도구는 같은 자리에
같은 모양(parts/{n}.data)으로 넣어서, 화면은 아무것도 안 고치고 그대로 읽게 한다.

왜 서버를 거치나 — noteUnits 는 보안 규칙이 선생님만 쓰게 막아 두었고,
이 PC 에는 파이어베이스 열쇠를 두지 않는다. 서버가 서비스 계정으로 쓴다.
(→ api/noteview.js 와 같은 판단)

왜 조각으로 보내나 — 버셀은 요청 본문 4.5MB 를 넘으면 거절한다.
파일을 통째로 실으면 그 벽에 걸린다.

쓰기
  python tools/note-upload.py --cid <반ID> --file "…\\2026-09-04 판서.pdf"
  python tools/note-upload.py --cid <반ID> --file … --unit "판서" --fid board_2026-09-04
  python tools/note-upload.py --list                     반 목록만 보여준다

같은 --fid 로 다시 올리면 **덮어쓴다.** 매일 돌려도 파일이 늘어나지 않는다.
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.environ.get("CLIMATH_URL", "https://climath-class.vercel.app") + "/api/lesson"
MAX_BYTES = int(4.5 * 1024 * 1024)      # 앱 화면이 거는 한도와 같게


def load_key():
    p = os.path.join(HERE, "lesson-key.json")
    if not os.path.exists(p):
        sys.exit("lesson-key.json 이 없습니다: " + p)
    return json.load(io.open(p, encoding="utf-8"))["key"]


def call(key, payload):
    body = json.dumps(dict(payload, toolKey=key), ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        APP, data=body, headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit("서버가 거절했습니다 (%d): %s"
                         % (e.code, e.read().decode("utf-8", "replace")[:300]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cid")
    ap.add_argument("--file")
    ap.add_argument("--unit", default="판서")
    ap.add_argument("--fid")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    key = load_key()

    if a.list:
        r = call(key, {"action": "noteClasses"})
        for c in r.get("classes", []):
            print("%-24s %-16s %s%s" % (c["id"], c["name"], c.get("playlist", ""),
                                        "  (종강)" if c.get("endDate") else ""))
        return

    if not a.cid or not a.file:
        sys.exit("--cid 와 --file 이 필요합니다 (--list 로 반 ID 확인)")
    if not os.path.exists(a.file):
        sys.exit("파일이 없습니다: " + a.file)
    size = os.path.getsize(a.file)
    if size > MAX_BYTES:
        sys.exit("파일이 너무 큽니다 (%.1fMB). 앱 한도는 4.5MB 입니다." % (size / 1048576))

    name = os.path.basename(a.file)
    # 파일명에 날짜가 있으면 그것으로 자리를 정한다 — 같은 날은 언제나 같은 자리(덮어쓰기).
    m = re.search(r"(\d{4}-\d{2}-\d{2})", name)
    fid = a.fid or ("board_" + m.group(1) if m else "board_" + re.sub(r"\W+", "_", name)[:40])

    b = call(key, {"action": "noteBegin", "cid": a.cid, "unit": a.unit})
    uid, chunk = b["uid"], int(b.get("chunk") or 700000)

    b64 = base64.b64encode(io.open(a.file, "rb").read()).decode("ascii")
    parts = [b64[i:i + chunk] for i in range(0, len(b64), chunk)]
    for i, data in enumerate(parts):
        call(key, {"action": "notePart", "cid": a.cid, "uid": uid, "fid": fid,
                   "i": i, "data": data})
        print("  조각 %d/%d" % (i + 1, len(parts)))
    call(key, {"action": "noteDone", "cid": a.cid, "uid": uid, "fid": fid,
               "name": name, "mime": "application/pdf", "size": size,
               "chunks": len(parts)})
    print("올렸습니다 — %s / 단원 «%s» / %s (%.1fMB, 조각 %d)"
          % (a.cid, a.unit, name, size / 1048576, len(parts)))


if __name__ == "__main__":
    main()
