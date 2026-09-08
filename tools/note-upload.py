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
  python tools/note-upload.py --cid <반ID> --file … --kind 풀이노트
  python tools/note-upload.py --list                     반 목록만 보여준다

강의노트 제목은 **수업 날짜 하나로** 정해진다 — `9/7(월) 강의노트`.
--kind 는 «판서/풀이노트» 를 가르는 데만 쓰고 제목에는 안 들어간다.
그래서 같은 날 판서와 풀이노트를 올리면 **같은 강의노트 안에 파일 둘**로 들어간다.

같은 --fid 로 다시 올리면 **덮어쓴다.** 매일 돌려도 파일이 늘어나지 않는다.
"""
import argparse
import base64
import datetime
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


WD = "월화수목금토일"


def unit_title(date_str):
    """강의노트 제목 = 수업 날짜. `9/7(월) 강의노트`

    ⚠ 예전에는 부르는 쪽이 제목을 정해서 「판서」「수업정리」「풀이노트」가
       한 반의 강의노트 목록에 뒤섞였다. 학생이 찾는 기준은 «무슨 노트인가» 가
       아니라 «며칠 수업인가» 다. 그래서 제목은 도구가 정한다 — 부르는 쪽이
       잊어버릴 자리를 없앤다.
    """
    d = datetime.date.fromisoformat(date_str)
    return "%d/%d(%s) 강의노트" % (d.month, d.day, WD[d.weekday()])


def date_of(path, given):
    """수업 날짜: --date → 파일명의 YYYY-MM-DD → 오늘."""
    if given:
        return given
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", os.path.basename(path))
    if m:
        return "%s-%s-%s" % m.groups()
    return datetime.date.today().isoformat()


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
    ap.add_argument("--kind", default="판서", help="판서 / 풀이노트 — 파일을 가르는 데만 쓴다")
    ap.add_argument("--date", help="수업 날짜 YYYY-MM-DD (없으면 파일명에서)")
    ap.add_argument("--title", help="제목을 손으로 정할 때만. 보통은 쓰지 않는다")
    ap.add_argument("--unit", help="옛 이름 — --kind 로 받는다")
    ap.add_argument("--fid")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--verify", action="store_true", help="올린 것만 되읽어 확인")
    a = ap.parse_args()
    # 옛 --unit 은 «제목» 이었지만 이제 «종류» 다. 조용히 제목이 되면 예전 상태로 돌아간다.
    if a.unit:
        a.kind = a.unit
        print("--unit 은 이제 --kind 입니다. 제목은 수업 날짜로 들어갑니다.")
    key = load_key()

    if a.list:
        r = call(key, {"action": "noteClasses"})
        for c in r.get("classes", []):
            print("%-24s %-16s %s%s" % (c["id"], c["name"], c.get("playlist", ""),
                                        "  (종강)" if c.get("endDate") else ""))
        return

    if a.verify:
        if not a.cid:
            sys.exit("--cid 가 필요합니다")
        for f in call(key, {"action": "noteFiles", "cid": a.cid}).get("files", []):
            ok = f["partsFound"] == f["chunks"] and f["b64len"] > 0
            print("%s  %-18s %-28s 조각 %d/%d  base64 %d자  %s"
                  % ("OK " if ok else "!! ", f.get("title", ""), f["name"],
                     f["partsFound"], f["chunks"],
                     f["b64len"], f.get("source", "")))
        return

    if not a.cid or not a.file:
        sys.exit("--cid 와 --file 이 필요합니다 (--list 로 반 ID 확인)")
    if not os.path.exists(a.file):
        sys.exit("파일이 없습니다: " + a.file)
    size = os.path.getsize(a.file)
    if size > MAX_BYTES:
        sys.exit("파일이 너무 큽니다 (%.1fMB). 앱 한도는 4.5MB 입니다." % (size / 1048576))

    name = os.path.basename(a.file)
    date = date_of(a.file, a.date)
    title = a.title or unit_title(date)
    # 같은 날은 언제나 같은 자리(덮어쓰기).
    #
    # ※ 자리 이름에 **종류를 섞는다.** 안 그러면 「판서」와 「풀이노트」가 같은 날짜라는
    #   이유로 같은 자리를 갖고 서로를 덮어쓴다(실제로 그랬다). 제목이 날짜 하나로
    #   합쳐진 뒤로는 이게 **둘을 가르는 유일한 것**이라 더 중요해졌다.
    slug = re.sub(r"\W+", "", a.kind)[:12] or "note"
    fid = a.fid or (slug + "_" + date)

    b = call(key, {"action": "noteBegin", "cid": a.cid, "unit": title})
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
    # «보냈다» 로 끝내지 않는다. 되읽어서 조각 수가 맞는지 본다.
    got = [f for f in call(key, {"action": "noteFiles", "cid": a.cid}).get("files", [])
           if f["fid"] == fid and f["uid"] == uid]
    ok = bool(got) and got[0]["partsFound"] == len(parts) and got[0]["b64len"] == len(b64)
    print("올렸습니다 — %s / 「%s」 / %s %s (%.1fMB, 조각 %d)"
          % (a.cid, title, a.kind, name, size / 1048576, len(parts)))
    if ok:
        print("  되읽어 확인 — 조각 %d개, base64 %d자 그대로" % (len(parts), len(b64)))
    else:
        print("  !! 되읽으니 다릅니다:", got or "그 자리에 아무것도 없음")
        sys.exit(1)


if __name__ == "__main__":
    main()
