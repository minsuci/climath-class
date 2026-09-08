# -*- coding: utf-8 -*-
"""강의노트 단원을 정리한다.

앱의 강의노트는 **수업 날짜 하나가 단원 하나**여야 한다 — `9/7(월) 강의노트`.
그 안에 올라가는 것은 «정제된 풀이노트» 하나다.
한동안 「판서」「수업정리」「풀이노트」가 각각 단원이 되어 한 날짜가 세 군데로
갈려 있었다. 이 도구가 그 뒷정리를 한다.

  python tools/note-tidy.py --list                    지금 무엇이 있나
  python tools/note-tidy.py --retitle --dry           날짜 이름으로 바꿀 것 보기
  python tools/note-tidy.py --retitle                 실제로 바꾸기
  python tools/note-tidy.py --drop 판서 수업정리 --dry   지울 것 보기
  python tools/note-tidy.py --drop 판서 수업정리        실제로 지우기

⚠ --drop 은 **되돌릴 수 없다.** 조각까지 지운다. 원본이 PC 에 있는지 먼저 보라
   (`수업 풀이노트\\_준비\\{날짜}\\{날짜} 판서.pdf`, `수업 풀이노트\\{날짜} 수업정리.pdf`).
"""
import argparse
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
WD = "월화수목금토일"


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


def title_for(date_str):
    d = datetime.date.fromisoformat(date_str)
    return "%d/%d(%s) 강의노트" % (d.month, d.day, WD[d.weekday()])


def date_in(name):
    """파일 이름에서 수업 날짜. `2026-09-07 …` 도 `20260829 …` 도 읽는다."""
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", name)
    if m:
        return "-".join(m.groups())
    m = re.search(r"\b(20\d{2})(\d{2})(\d{2})\b", name)
    return "-".join(m.groups()) if m else None


def units(key, cid):
    """{uid: {title, files:[…]}} — noteFiles 는 파일 단위라 단원으로 묶는다."""
    out = {}
    for f in call(key, {"action": "noteFiles", "cid": cid})["files"]:
        u = out.setdefault(f["uid"], {"title": f.get("title", ""), "files": []})
        u["files"].append(f)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--retitle", action="store_true",
                    help="단원 안 파일의 날짜가 모두 같으면 «M/D(요일) 강의노트» 로")
    ap.add_argument("--drop", nargs="*", metavar="제목", help="이 제목의 단원을 통째로 지운다")
    ap.add_argument("--cid", help="한 반만")
    ap.add_argument("--dry", action="store_true", help="무엇을 할지 보기만")
    a = ap.parse_args()
    key = load_key()

    classes = call(key, {"action": "noteClasses"})["classes"]
    if a.cid:
        classes = [c for c in classes if c["id"] == a.cid]

    for c in classes:
        us = units(key, c["id"])
        if not us:
            continue
        print("== %s (%s)" % (c["name"], c["id"]))
        for uid, u in us.items():
            names = [f["name"] for f in u["files"]]
            dates = {date_in(n) for n in names}
            mark = ""

            if a.drop and u["title"] in a.drop:
                if a.dry:
                    mark = "  → 지울 것 (파일 %d)" % len(names)
                else:
                    r = call(key, {"action": "noteUnitDelete", "cid": c["id"], "uid": uid})
                    mark = "  → 지웠음 (파일 %d, 조각 %d)" % (r.get("files", 0), r.get("parts", 0))

            elif a.retitle:
                # 날짜가 하나로 모이는 단원만 바꾼다. 여러 날짜가 섞인 옛 단원은
                # 이름만 바꿔서는 갈리지 않는다 — 손대지 않고 그대로 둔다.
                if len(dates) == 1 and None not in dates:
                    want = title_for(dates.pop())
                    if want != u["title"]:
                        if a.dry:
                            mark = "  → 「%s」 로" % want
                        else:
                            call(key, {"action": "noteUnitRename", "cid": c["id"],
                                       "uid": uid, "title": want})
                            mark = "  → 「%s」 로 바꿈" % want
                elif len(dates) > 1:
                    mark = "  (날짜가 %d개 섞여 있어 그대로 둠)" % len(dates)

            print("   %-22s %s%s" % (u["title"], " · ".join(names)[:60], mark))
    if a.dry:
        print("\n(--dry 라 아무것도 바꾸지 않았습니다)")


if __name__ == "__main__":
    main()
