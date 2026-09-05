# -*- coding: utf-8 -*-
"""수업 영상 자막 → 보고서의 «그날 다룬 내용» 을 개념어로 바꾼다.

크론이 매일 채우는 것은 영상 **제목**이다 (「수평교 51-130」).
정확하지만 학부모에게는 교재 이름일 뿐이라 뜻이 잘 안 통한다.
이 도구는 자막을 받아 **개념어**로 바꿔 올린다 (「원의 접선의 방정식을 다뤘습니다」).

왜 PC 에서 도나:
  yt-dlp 는 윈도우 실행파일이라 서버(버셀)에서 못 돈다.
  유튜브도 자막 요청을 막는다(429) — 데이터센터 IP 는 더 심하다.
  그래서 **PC 는 자막만 받고, 요약·저장은 서버가 한다.**
  덕분에 이 PC 에 AI 키도 파이어베이스 열쇠도 두지 않는다.

처음 한 번:
  1) 앱에 관리자로 로그인한 브라우저 콘솔에서 도구 열쇠를 만든다
       const t = await firebase.auth().currentUser.getIdToken();
       await (await fetch("/api/lesson",{method:"POST",
         headers:{"Content-Type":"application/json"},
         body:JSON.stringify({idToken:t, action:"makeToolKey"})})).json()
  2) 나온 key 를 이 폴더의 lesson-key.json 에 넣는다
       { "key": "lk_..." }

쓰기:
  python tools/lesson-captions.py            최근 30일 중 아직 개념이 없는 날
  python tools/lesson-captions.py --days 90  더 거슬러
  python tools/lesson-captions.py --dry      받아서 보여만 주고 안 올림
"""
import argparse, io, json, os, re, subprocess, sys, tempfile, time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.environ.get("CLIMATH_URL", "https://climath-class.vercel.app") + "/api/lesson"
YTDLP = os.environ.get("YTDLP", r"C:\Users\user\Desktop\vidwork\bin\yt-dlp.exe")


def load_key():
    p = os.path.join(HERE, "lesson-key.json")
    if not os.path.exists(p):
        sys.exit("lesson-key.json 이 없습니다. 파일 맨 위 설명대로 열쇠를 먼저 만드세요:\n  " + p)
    return json.load(io.open(p, encoding="utf-8"))["key"]


def call(key, payload):
    body = json.dumps(dict(payload, toolKey=key), ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(APP, data=body,
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8", "replace"))


def captions(vid, workdir):
    """자막 한 편을 글자로. 없으면 ""."""
    out = os.path.join(workdir, vid)
    cmd = [YTDLP, "--skip-download", "--write-auto-subs", "--sub-langs", "ko",
           "--sub-format", "vtt", "-o", out + ".%(ext)s",
           "https://www.youtube.com/watch?v=" + vid]
    subprocess.run(cmd, capture_output=True)
    f = out + ".ko.vtt"
    if not os.path.exists(f):
        return ""
    raw = io.open(f, encoding="utf-8", errors="replace").read()
    lines = []
    for l in raw.split("\n"):
        l = l.strip()
        if not l or l.startswith(("WEBVTT", "Kind:", "Language:")) or "-->" in l:
            continue
        l = re.sub(r"<[^>]+>", "", l).replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&")
        # 자동 자막은 같은 줄을 계속 다시 낸다. 바로 앞과 같으면 버린다.
        if l and (not lines or lines[-1] != l):
            lines.append(l)
    return " ".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry", action="store_true", help="받아서 보여만 주고 안 올린다")
    ap.add_argument("--max", type=int, default=20, help="한 번에 처리할 날 수")
    a = ap.parse_args()

    if not os.path.exists(YTDLP):
        sys.exit("yt-dlp 를 못 찾았습니다: " + YTDLP + "\n  환경변수 YTDLP 로 경로를 줄 수 있습니다.")
    key = load_key()

    r = call(key, {"action": "todo", "days": a.days})
    if not r.get("ok"):
        sys.exit("할 일을 못 받았습니다: " + str(r.get("error")))
    todo = r["todo"][: a.max]
    if not todo:
        print("개념을 넣을 날이 없습니다. (제목으로 채워진 날이 없거나 이미 다 했습니다)")
        return
    print("대상 %d일\n" % len(todo))

    work = tempfile.mkdtemp(prefix="cap_")
    for i, t in enumerate(todo, 1):
        print("[%d/%d] %s %s — %s" % (i, len(todo), t["cname"], t["date"], t["title"]))
        texts = []
        for j, vid in enumerate(t["ids"]):
            # ⚠ 유튜브가 연속 요청을 막는다(429). 사이를 띄운다.
            if j: time.sleep(3)
            c = captions(vid, work)
            print("      %s  자막 %s자" % (vid, len(c) if c else "없음"))
            if c: texts.append(c)
        if not texts:
            print("      → 자막이 하나도 없어 건너뜁니다\n")
            continue
        joined = "\n".join(texts)
        if a.dry:
            print("      → (dry) 자막 %d자, 안 올림\n" % len(joined))
            continue
        p = call(key, {"action": "put", "cid": t["cid"], "date": t["date"],
                       "text": joined, "keepTitle": t["title"]})
        if p.get("skipped"):
            print("      → 건너뜀: %s\n" % p.get("why"))
        elif p.get("ok"):
            print("      → %s\n" % p.get("line"))
        else:
            print("      → 실패: %s\n" % p.get("error"))
        time.sleep(2)

    print("끝. 보고서에서 그날 줄이 바뀌어 있습니다.")


if __name__ == "__main__":
    main()
