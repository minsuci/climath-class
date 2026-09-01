# -*- coding: utf-8 -*-
"""학교 학사일정에서 정기고사 기간을 뽑아낸다.

앱(api/schedule.js)이 못 잡는 학교를 위한 손도구다. 앱은 Vercel 함수라 PDF를 못 뜯는다.
여기서 뽑은 값을 학교일정 메뉴에 넣으면 내신참여표가 자동 생성된다.

  python tools/schoolcal.py 경기고
  python tools/schoolcal.py 경기고 --pdf C:/받은/학사일정.pdf     # 파일을 직접 줄 때

--- 어디에 올라와 있나 (2026-09 조사) ---
  나이스(open.neis.go.kr)   학교가 올리면 여기서 끝. 경기고는 9~12월 일정이 0건,
                            중대부고·휘문고는 휴업일만 있고 시험은 없다.
  서울 교육청 CMS(*.sen.hs.kr)
                            학교일정 달력 = /NNNNN/subMenu.do 에 viewType=list POST.
                            ⚠ siteId(SEI_...) 를 같이 안 보내면 빈 표가 온다.
                            ⚠ 그마저도 목록을 JS로 그리는 학교가 있다(중대부고).
                            학사일정 글 찾기는 메뉴를 뒤지는 것보다 **통합검색**이 확실하다:
                              POST /dggb/module/unitySearch/selectUnitySearch.do  {schValue}
                            첨부 내려받기:
                              /dggb/board/boardFile/downFile.do?atchFileId=FILE_...&fileSn=1
                            ⚠ fileSn 은 **1부터**. 0으로 부르면 빈 HTML 이 200 으로 온다.
  경기도 교육청 CMS(*.goebc.kr)
                            POST /{sysId}/ps/schdul/selectSchdulList.do?mi={menuId}
                            폼 그대로 + schdulLevel=Y + srchYear=2026 → 연간 표가 JSON 문자열로.
  사립 자체 사이트          규칙이 없다. 휘문고는 학교소식>학사안내에 PDF 첨부.

--- PDF 에서 날짜를 뽑을 때 (여기가 진짜 함정이다) ---
  학사력은 두 모양뿐인데 둘 다 "낱말만" 읽으면 날짜를 못 붙인다. 좌표로 칸을 맞춰야 한다.
  (1) 월별 달력 12쪽 (휘문고) — 쪽마다 영어 달 이름(September)이 있다. 이걸 쓴다. 쪽 번호로
      달을 세면 안 된다.
  (2) 연간 주표 (경기고) — 맨 왼쪽에 **'월' 라벨 열이 하나 더** 있다. 이걸 날짜 열로 세면
      전부 한 칸씩 밀린다. 시험이 토·일에 떨어지면 이걸 의심할 것.

  ★ 검증 두 가지를 반드시 통과시킨다. 안 그러면 조용히 틀린 날짜가 나온다.
     - 계산한 날짜의 요일 == 그 칸의 요일 열
     - 계산한 날짜의 '일' == 칸에 인쇄된 숫자
     경기고 표는 132칸 전부 일치해야 정상이다. 하나라도 틀리면 결과를 믿지 말 것.
"""
import argparse, datetime, http.cookiejar, io, json, os, re, ssl, sys, urllib.parse, urllib.request

sys.stdout.reconfigure(encoding="utf-8")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
WD = "월화수목금토일"

ALIAS = {"건대부고": "건국대학교사범대학부속고등학교", "한대부고": "한양대학교사범대학부속고등학교",
         "중대부고": "중앙대학교사범대학부속고등학교", "단대부고": "단국대학교사범대학부속고등학교"}

# 낱말은 넓게, 아닌 것은 확실히. api/schedule.js 의 EXAM_WORD/NOT_EXAM 과 같은 뜻이다.
EXAM_WORD = re.compile(r"(중간|기말|지필|고사|정기\s*시험|정기\s*평가)")
NOT_EXAM = re.compile(r"(모의|학력평가|수능|모평|대학수학능력|학업성취도|검정|자격)")
JUNK = re.compile(r"(성적|이의|발표|정정|준비|대비|안내|미실시|없음|출제|보안|연수)")


def is_exam(nm):
    return bool(EXAM_WORD.search(nm)) and not NOT_EXAM.search(nm) and not JUNK.search(nm)


# ⚠ 서울 CMS 의 검색·상세 AJAX 는 **세션 쿠키가 있어야** 내용을 준다.
# 쿠키 없이 부르면 빈 껍데기가 200 으로 온다 — 오류가 아니라서 알아채기 어렵다.
_OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=CTX))


def http_(url, data=None, headers=None):
    h = dict(UA); h.update(headers or {})
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=h)
    with _OPENER.open(req, timeout=45) as r:
        raw = r.read()
        return r.getcode(), r.url, raw, r.headers


# ---------------- 나이스 ----------------
def neis_school(short):
    want = ALIAS.get(short) or re.sub(r"여고$", "여자고등학교", short)
    if want == short:
        want = re.sub(r"고$", "고등학교", short)
    stem = ALIAS.get(short) or re.sub(r"여?고$", "", short)
    for params in ({"SCHUL_KND_SC_NM": "고등학교", "SCHUL_NM": stem},
                   {"SCHUL_KND_SC_NM": "고등학교", "SCHUL_NM": want}):
        q = urllib.parse.urlencode({"Type": "json", "pIndex": "1", "pSize": "5", **params})
        try:
            _, _, raw, _ = http_("https://open.neis.go.kr/hub/schoolInfo?" + q)
            box = json.loads(raw.decode("utf-8")).get("schoolInfo")
        except Exception:
            continue
        if not box:
            continue
        rows = (box[1] or {}).get("row", [])
        hit = next((r for r in rows if r.get("SCHUL_NM") == want), rows[0] if len(rows) == 1 else None)
        if hit:
            return {"official": hit["SCHUL_NM"], "code": hit["SD_SCHUL_CODE"],
                    "office": hit["ATPT_OFCDC_SC_CODE"], "officeName": hit["ATPT_OFCDC_SC_NM"],
                    "hmpg": hit.get("HMPG_ADRES") or ""}
    return None


# ---------------- 서울 CMS: 통합검색 → 학사일정 첨부 ----------------
def sen_find_calendar_pdf(base, out_path):
    """통합검색으로 학사일정 글을 찾아 첨부 PDF 를 내려받는다. 경로만 규칙이고 나머지는 학교마다 다르다."""
    origin = base.rstrip("/")
    try:
        http_(origin + "/")        # 세션 쿠키를 받아둔다
    except Exception:
        pass
    for kw in ("학사일정", "학사력", "연간일정"):
        try:
            _, _, raw, _ = http_(origin + "/dggb/module/unitySearch/selectUnitySearch.do",
                                {"schValue": kw},
                                {"Content-Type": "application/x-www-form-urlencoded"})
        except Exception:
            continue
        html = raw.decode("utf-8", "replace")
        # 검색 결과에서 글 열기 함수 fnView('bbsId','nttId')
        hits = re.findall(r"fnView\('([^']+)',\s*'([^']+)'\)", html)
        for bbs, ntt in hits[:6]:
            fid = _sen_atch(origin, bbs, ntt)
            if fid and _sen_download(origin, fid, out_path):
                return out_path
    return None


def sen_board_calendar_pdf(base, out_path):
    """통합검색이 못 찾을 때. 메뉴에서 '학사력/학교일정' 게시판을 찾아 글 목록을 훑는다.

    ⚠ 통합검색은 공지·가정통신문·앨범만 훑는다. 경기고 학사력처럼 자료실형 게시판에
      올라간 글은 검색에 안 걸린다 — 그래서 메뉴를 직접 뒤지는 이 길이 따로 필요하다.
    """
    origin = base.rstrip("/")
    try:
        _, final, raw, _ = http_(origin + "/")
    except Exception:
        return None
    html = raw.decode("utf-8", "replace")
    menus = []
    for m in re.finditer(r'href="([^"]*/\d+/subMenu\.do[^"]*)"[^>]*>([\s\S]{0,120}?)</a>', html):
        t = re.sub(r"<[^>]+>", "", m.group(2)).replace(" ", "").strip()
        if not re.search(r"(일정|학사|캘린더)", t) or "급식" in t:
            continue
        u = urllib.parse.urljoin(final, m.group(1))
        if u not in menus:
            menus.append(u)
    for url in menus[:4]:
        try:
            _, _, raw, _ = http_(url)
        except Exception:
            continue
        page = raw.decode("utf-8", "replace")
        m = re.search(r'name="bbsId"[^>]*value="([^"]+)"', page)
        if not m:
            continue
        bbs = m.group(1)
        try:
            _, _, raw, _ = http_(origin + "/dggb/module/board/selectBoardListAjax.do",
                                 {"bbsId": bbs, "bbsTyCode": "base", "pageIndex": "1",
                                  "customRecordCountPerPage": "30", "searchCondition": "",
                                  "searchKeyword": "", "cmntSe": "N"},
                                 {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                                  "X-Requested-With": "XMLHttpRequest", "Referer": url})
        except Exception:
            continue
        lst = raw.decode("utf-8", "replace")
        posts = []
        for pm in re.finditer(r"fnView\('([^']+)',\s*'([^']+)'\)[^>]*>([\s\S]{0,140}?)</a>", lst):
            title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", pm.group(3))).strip()
            posts.append((pm.group(1), pm.group(2), title))
        want = re.compile(r"(학사\s*일정|학사\s*력|연간\s*일정)")
        yr = str(datetime.date.today().year)
        pick = [x for x in posts if want.search(x[2]) and yr in x[2]] or \
               [x for x in posts if want.search(x[2])]
        for bbs2, ntt, title in pick[:3]:
            fid = _sen_atch(origin, bbs2, ntt)
            if fid and _sen_download(origin, fid, out_path):
                print("       글: %s" % title[:60])
                return out_path
    return None


def _sen_atch(origin, bbs, ntt):
    try:
        _, _, raw, _ = http_(origin + "/dggb/module/board/selectBoardDetailAjax.do",
                            {"bbsId": bbs, "nttId": ntt, "bbsTyCode": "base",
                             "pageIndex": "1", "cmntSe": "N", "customRecordCountPerPage": "30"},
                            {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                             "X-Requested-With": "XMLHttpRequest", "Referer": origin})
    except Exception:
        return None
    m = re.search(r'name="atchFileId"[^>]*value="([^"]+)"', raw.decode("utf-8", "replace"))
    return m.group(1) if m else None


def _sen_download(origin, fid, out_path):
    # ⚠ fileSn 은 1부터. 0 은 빈 HTML 을 200 으로 돌려준다.
    for sn in ("1", "2", "3"):
        try:
            _, _, raw, hdr = http_("%s/dggb/board/boardFile/downFile.do?atchFileId=%s&fileSn=%s"
                                  % (origin, fid, sn), headers={"Referer": origin})
        except Exception:
            continue
        if raw[:5] == b"%PDF-":
            io.open(out_path, "wb").write(raw)
            return True
    return False


# ---------------- PDF: 월별 달력형 ----------------
def pdf_monthly(doc):
    """쪽마다 영어 달 이름이 있는 12쪽짜리. 달은 쪽 번호가 아니라 문서에서 읽는다."""
    MON = {m: i + 1 for i, m in enumerate(
        "January February March April May June July August September October November December".split())}
    found = {}
    for page in doc:
        ws = page.get_text("words")
        names = [w for w in ws if w[4] in MON]
        if not names:
            continue
        m = MON[min(names, key=lambda w: w[1])[4]]
        y = 2026 if m >= 3 else 2027
        nums = [w for w in ws if re.fullmatch(r"\d{1,2}", w[4]) and w[1] > 120]
        for w in ws:
            if not EXAM_WORD.search(w[4]) or NOT_EXAM.search(w[4]):
                continue
            same = [n for n in nums if abs(n[0] - w[0]) < 40 and n[3] <= w[1] + 2]
            if not same:
                continue
            n = max(same, key=lambda n: n[3])
            try:
                dt = datetime.date(y, m, int(n[4]))
            except ValueError:
                continue
            found.setdefault(dt, set()).add(w[4])
    return found, None


# ---------------- PDF: 연간 주표형 ----------------
def pdf_weekgrid(doc, start_year, start_month):
    """월~토 6열 주표.

    ⚠ 맨 왼쪽에 '월' 라벨 열이 하나 더 있다(8,9,10,… 이 적혀 있다). 이걸 날짜 열로 세면
      모든 칸이 한 칸씩 밀린다. 대신 이 열이 **그 쪽이 몇 월부터인지** 알려주므로
      시작 달을 추측할 필요가 없다 — 쪽마다 여기서 읽는다.
    ⚠ 쪽 사이로 달을 이어받으면 안 된다. 1쪽=1학기(3월~), 2쪽=2학기(8월~)처럼
      쪽마다 새로 시작한다.
    """
    found, ok, bad = {}, 0, 0
    for page in doc:
        ws = page.get_text("words")
        nums = [w for w in ws if re.fullmatch(r"\d{1,2}", w[4]) and 1 <= int(w[4]) <= 31 and w[1] > 145]
        if len(nums) < 20:
            continue
        colx = _cluster([w[0] for w in nums], 8)
        if len(colx) < 7:
            continue
        labelx, daycols = colx[0], colx[1:]
        # '월' 라벨 열에서 이 쪽의 시작 달을 읽는다
        labels = [w for w in nums if abs(w[0] - labelx) < 8]
        page_month = int(min(labels, key=lambda w: w[1])[4]) if labels else start_month
        year = start_year if page_month >= 3 else start_year + 1

        rowy = _cluster([w[1] for w in nums], 6)
        cell = {}
        for w in nums:
            if abs(w[0] - labelx) < 8:
                continue
            ci = min(range(len(daycols)), key=lambda k: abs(daycols[k] - w[0]))
            ri = min(range(len(rowy)), key=lambda k: abs(rowy[k] - w[1]))
            cell[(ri, ci)] = int(w[4])

        y, m, prev, dates = year, page_month, 0, {}
        for ri in range(len(rowy)):
            for ci in range(len(daycols)):
                v = cell.get((ri, ci))
                if v is None:
                    continue
                if v < prev:
                    m += 1
                    if m > 12:
                        m, y = 1, y + 1
                prev = v
                try:
                    dt = datetime.date(y, m, v)
                except ValueError:
                    continue
                dates[(ri, ci)] = dt
                # 검증: 계산한 날짜의 요일이 그 칸의 요일 열과 같아야 한다
                if dt.weekday() == ci:
                    ok += 1
                else:
                    bad += 1
        for w in ws:
            if not EXAM_WORD.search(w[4]) or NOT_EXAM.search(w[4]):
                continue
            ci = min(range(len(daycols)), key=lambda k: abs(daycols[k] - (w[0] - 13)))
            above = [ri for ri in range(len(rowy)) if rowy[ri] <= w[1] + 2]
            if not above:
                continue
            dt = dates.get((max(above), ci))
            if dt:
                found.setdefault(dt, set()).add(w[4])
    return found, (ok, bad)


def _cluster(vals, gap):
    xs, out = sorted(set(round(v) for v in vals)), []
    for v in xs:
        if out and v - out[-1][-1] <= gap:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(b) / len(b) for b in out]


def read_pdf(path, start_month):
    import pymupdf
    doc = pymupdf.open(path)
    txt = "".join(p.get_text() for p in doc)
    if re.search(r"(January|September|December)", txt):
        return pdf_monthly(doc)
    return pdf_weekgrid(doc, 2026, start_month)


# ---------------- 묶기 ----------------
def group(found):
    """붙어 있는 날을 한 덩어리로. 주말·공휴일로 하루 끊기는 건 이어 붙인다."""
    out = []
    for dt in sorted(found):
        label = " ".join(sorted(found[dt]))
        if out and (dt - out[-1][-1]).days <= 4:
            out[-1][-1] = dt
            out[-1][0].add(label)
        else:
            out.append([{label}, dt, dt])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("school")
    ap.add_argument("--pdf", help="이미 받아둔 학사일정 PDF")
    ap.add_argument("--start-month", type=int, default=8, help="연간 주표가 몇 월부터인가 (기본 8)")
    a = ap.parse_args()

    s = neis_school(a.school)
    print("학교 : %s" % (s["official"] if s else a.school + "  (나이스에서 못 찾음)"))
    if s:
        print("       %s · 홈 %s" % (s["officeName"], s["hmpg"] or "(없음)"))

    path = a.pdf
    if not path:
        if not (s and s["hmpg"]):
            print("\n홈페이지를 몰라 PDF 를 못 받는다. --pdf 로 파일을 직접 주면 읽는다.")
            return 1
        base = s["hmpg"].replace("http://", "https://")
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cal_%s.pdf" % a.school)
        print("\n학사일정 첨부 찾는 중 …")
        if not (sen_find_calendar_pdf(base, path) or sen_board_calendar_pdf(base, path)):
            print("못 찾았다. 사립이거나 로그인 뒤에 있는 학교다. 브라우저로 받아서 --pdf 로 줄 것.")
            return 1
        print("받음: %s" % path)

    found, check = read_pdf(path, a.start_month)
    if check:
        ok, bad = check
        print("\n칸 검증: 요일 일치 %d / 어긋남 %d" % (ok, bad))
        if bad:
            print("  ⚠ 어긋난 칸이 있다. '월' 라벨 열이나 시작 월(--start-month)을 의심할 것.")
    if not found:
        print("\n시험으로 보이는 항목이 없다.")
        return 1
    print("\n--- 뽑은 날짜 ---")
    for dt in sorted(found):
        print("  %s (%s)  %s" % (dt, WD[dt.weekday()], " ".join(sorted(found[dt]))))
    print("\n--- 묶으면 ---")
    for labels, a1, b1 in group(found):
        print("  %s ~ %s   %s" % (a1, b1, " / ".join(sorted(labels))[:70]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
