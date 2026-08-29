# CLIMATH 수업관리 웹앱

CLIMATH 학원(한민수 선생님)의 수업관리 앱. **빌드 없는 단일 HTML 파일** + Vercel 서버리스 함수 1개.

```
repo/
├── index.html              # 앱 전체 (CSS + React, 4,786줄)
├── api/hint.js             # AI 힌트 중계 (Vercel serverless)
├── api/note.js             # 수업기록 초안 생성 (Vercel serverless)
├── tools/check-jsx.mjs     # JSX 문법 검사 (배포 안 됨)
├── tools/test-detect.mjs   # 수업 로그 이름/단원 감지 테스트
├── tools/make-preview.mjs  # Firestore를 메모리 가짜로 바꾼 preview.html 생성
├── tools/fix_sync.py       # 영상에서 표식음을 찾아 컷 리스트 시각을 맞춤 (PC에서 실행)
└── CLAUDE.md               # 이 문서
```

- 배포: https://climath-class.vercel.app  (관리자 `?admin=1`)
- GitHub: `minsuci/climath-class` (main) → 커밋 시 Vercel 자동 배포
- DB: Firebase Firestore (project id `climath-class`)
- 로컬 작업 폴더: `C:\Users\Lenovo\Desktop\climath-class` (git clone)

---

## ⚠️ 먼저 알아야 할 것 (사고 방지)

### 1. 앱 코드는 `<script type="text/plain" id="__appSource">` 안에 있다
Babel 자동 변환을 쓰지 않는다. 앱 코드를 `text/plain`으로 숨겨두고, 아래 스크립트가
`Babel.transform(src, { presets:["react"], sourceType:"script" })`로 직접 변환해 실행한다.

이유: 자동 변환(`type="text/babel"`)은 한국 보안 프로그램(INISAFE/TouchEn 등)이 주입한
스크립트에 휘말려 `Cannot use import statement outside a module`로 앱 전체가 죽은 적이 있다.

**따라서 JSX 문법 검사는 이 블록만 뽑아서 해야 한다.**

### 2. CDN 버전을 절대 `latest`로 바꾸지 말 것
```
react@18.3.1 / react-dom@18.3.1 / @babel/standalone@7.25.6
firebasejs 10.12.0 (compat) / KaTeX 0.16.9 (defer)
```
과거 `react@18`, `@babel/standalone`(latest)로 두었더니 **라이브러리가 업데이트되면서
코드를 안 건드렸는데 앱이 죽었다.** 전부 고정 버전이다.

### 3. 전역 함수 이름과 useState 세터 이름이 겹치면 조용히 죽는다
전역에 `setAttendance`를 만들었는데 `AdminDay` 안에 같은 이름의 state 세터가 있어서,
호출하면 Firestore가 아니라 state가 불렸다. 에러도 안 났다.
→ 현재는 `markAttendance`로 개명. **전역 함수는 `set*` 이름을 피할 것.**

### 4. GitHub Pages(`minsuci.github.io/climath-class`)는 쓰지 않는다
옛 코드가 남아 있어 디버깅 중 여러 번 혼란을 일으켰다. Vercel 주소만 사용.

---

## 개발 워크플로

### JSX 검사 (수정 후 필수)
```bash
node tools/check-jsx.mjs
```
`__appSource` 블록만 뽑아 브라우저와 같은 조건(`presets:["react"]`, `sourceType:"script"`)으로
변환해본다. 실패하면 **index.html 기준 줄 번호**를 알려주고 exit 1. 추출본은 `tools/appsrc.js`.

검사 도구를 `tools/` 하위에 둔 이유는 **루트에 `package.json`이 생기면 Vercel 빌드 동작이
바뀔 수 있어서**다. Vercel은 루트만 보므로 `tools/package.json`은 배포에 영향이 없다.
스크립트는 커밋하고 `node_modules`·lock·추출본은 `.gitignore`. 새 PC에서는
`cd tools && npm install` 한 번이면 된다.

### 운영 DB를 건드리지 않고 화면 확인하기
```bash
node tools/make-preview.mjs      # tools/preview.html 생성 (Firestore를 메모리 가짜로 교체)
node tools/test-detect.mjs       # 수업 로그 이름·단원 감지 테스트
```
> [!warning] 메모리 Firestore는 진짜가 아니다
> `onSnapshot`이 **한 번만 쏘고 갱신을 안 보낸다.** 새로 만든 항목이 화면에 안 나타나면
> 앱 버그가 아니라 이것이다 — 화면을 나갔다 들어오면 보인다.
> `.doc()`을 인자 없이 부를 때 id를 만들어 주는 것과 `snap().ref`는 2026-08-24에 채웠다.

`index.html`을 그대로 열면 **운영 Firestore에 바로 쓴다.** 클릭해 보며 확인할 때는
`preview.html`을 쓴다. 여기엔 마이크 콜백을 `window.__mic`으로 노출하는 줄이 들어가는데
**생성물에만** 들어가고 `index.html`은 손대지 않는다. `preview.html`은 gitignore.

### 코드 수정
4,100줄짜리 단일 파일이라 통째로 재작성하지 말 것. 부분 치환으로 작업하고,
앵커를 못 찾으면 즉시 실패하도록 할 것(엉뚱한 위치에 붙는 사고 방지).

> [!warning] index.html을 PowerShell로 읽고 쓰지 말 것
> Windows PowerShell 5.1의 `Get-Content` → `Set-Content` 왕복만으로 한글이 깨진다
> (218,145바이트 → 220,059바이트, 앱은 엉뚱한 줄에서 문법 오류가 난다).
> 편집은 Edit 도구나 UTF-8을 명시한 node/python으로 한다.

### 배포
`index.html` 커밋 → Vercel 자동 배포. 환경변수 변경 시에는 Redeploy 필요.
CDN 캐시가 남으면 `?v=123` 붙여 우회하거나 "Use existing Build Cache" 끄고 Redeploy.

---

## Firestore 데이터 구조

```
classes/{cid}
  name, classDays[], type("regular"|"individual"), books[], merge{partnerId,days[]}, order, time, endDate
  roster[]  ← 배열 필드. { id, name, days[], books[], startDate, endDate, teacher?, defaultPin? }
  ├─ students/{sid}      { pin }            # 구버전 반별 PIN (통합 PIN으로 자동 이전됨)
  ├─ homework/{sid}      { books: {교재명: [문항번호]} }
  ├─ questioned/{sid}    { books: {교재명: [문항번호]} }
  ├─ makeups/{sid_date}  { sid, sname, date, planned, videoDone, memo }
  ├─ dailyNotes/{sid_date} { sid, sname, date, text, teacher, time }   # 수업별 코멘트
  ├─ aiLogs/{id}         { sid, name, q, a, img, time }
  ├─ notice/current, dms/{sid}
  ├─ progress/{key}      key="class" 또는 sid → parts/{n} 에 base64 조각
  ├─ noteUnits/{uid}     { title } → files/{fid} → parts/{n}
  ├─ lessonLogs/{date}   { startedAt, endedAt, shift, marks[], segments[], transcript[], teacher }
  │                        segments = { sid, name, kind, unit, start, end }  start/end는 영상 기준 초
  │                        kind = lesson(남김) | qa | brk | mic | etc(버림)
  │                        beeped = 시작 때 표식음을 냈는지, endBeepAt = 종료 표식음 시각
  ├─ config/lessonLog    { units:{sid:[단원]}, aliases:{sid:[자막 오인식 표기]} }
  └─ days/{date}
       ├─ attendance/{sid}  { name, time }   # 문서 존재 = 출석
       ├─ questions/{qid}   { sid, name, book, num, memo, resolved, fromCid, fromClass }
       └─ scores/{id}       { sid, name, score, correct, total, label, time }

teachers/{tid}       { name, pin, classIds[], role("owner"|"teacher"), status("active"|"pending") }
userPins/{이름}      { pin }        # 공백 제거한 이름이 문서 id. 사람 단위 통합 PIN
consultations/{id}   { cid, sid, sname, withWho, cat, date, content, risk(0~3),
                       needFollow, followNote, followDone, teacher, time }
reports/{cid_sid_ym} { comment, hwSnapshot, sname, cname }   # 월간 보고서
```

**드래그 업로드**: 강의노트는 단원을 펼친 영역이 드롭존이다(`useFileDrop`).
`dragenter`/`dragleave`는 자식 위를 지날 때마다 쌍으로 또 나므로 **카운터로 센다**
(불리언이면 자식 하나 지날 때마다 꺼진다 — `hasSide`와 같은 함정).
`dragover`에서 `preventDefault`를 안 하면 `drop`이 아예 안 난다.
드래그로는 `accept`가 안 먹으므로 `isNoteFile()`로 손수 거른다.
드롭존 밖에 놓으면 브라우저가 그 파일로 이동해 앱이 통째로 사라지므로
`useBlockStrayDrop()`이 window에서 막는다. **터치 기기엔 드래그가 없으니 버튼은 항상 남긴다.**

진도계획표(`ProgressEditor`)도 같은 훅을 쓰는데 **한 장짜리라 드롭이 곧 교체**다.
버튼은 두 단계(누르고 고르고)지만 드롭은 한 번에 끝나 실수가 그대로 통과하므로,
**이미 게시본이 있을 때만 confirm을 띄운다.** 여러 개를 놓으면 첫 장만 올리고 그렇다고 알린다.
`msg`는 진행/안내/실패를 겸하므로 `msgOk`로 색을 가른다 — 안 그러면 안내가 빨간 오류로 보인다.

**파일 저장**: Firebase Storage 미사용. base64를 700KB씩 쪼개 `parts` 하위 컬렉션에 저장.
공용 함수 `saveFileToDoc()` / `loadFileB64FromDoc()` / `deleteFileDoc()`. 파일당 최대 4.5MB.

---

## 기능 맵

### 학생 화면 (사이드바)
출석 · 질문 · 과제 · 점수 (출석해야 열림) / 진도계획표 · 강의노트 · AI힌트 (출석 없이 열림)
→ 게이팅 예외는 `noGateTabs = ["prog","notes","ai"]`

### 선생님 화면 — 통합 사이드바 하나로 전 화면 공통
```
내 수업
─── 보강 관리 / 위험신호 / 학습관리 보고서
─── [반 진입 시] 반이름: 날짜별·월간출석부·공지·진도표·강의노트·AI질문·상담·반설정
─── 새 반 만들기 / 선생님 관리 / 로그아웃
```
반 내부 상태(`classView`, `dayPick`)는 **AdminView가 보유**하고 AdminDays/AdminDay에 props로 내려준다.
사이드바를 한 곳에서만 렌더하기 위한 구조이므로 되돌리지 말 것.

### 인증 (2026-08-28 전면 교체)

> [!warning] PIN을 이 문서나 코드에 적지 말 것
> 저장소가 **공개(public)** 다. 예전에는 관리자 PIN이 `ADMIN_PIN` 상수로 소스에도
> 이 문서에도 박혀 있었다. 개발자도구를 열 필요도 없이 GitHub에서 읽히는 상태였다.
> 지금은 지웠지만 **git 이력에는 남아 있다** — 그 값은 이미 노출된 것으로 보고 바꿔야 한다.

**검사는 전부 서버에서 한다.** 클라이언트에는 PIN이 내려가지 않는다.

```
브라우저 → POST /api/auth {action:"login", ...}
             ↓ 서비스 계정으로 PIN 대조 (Firestore REST)
           커스텀 토큰(JWT) 발급
             ↓ signInWithCustomToken
        보안 규칙이 토큰의 claims를 보고 서버에서 거절
```

- `api/_google.js` — 서비스 계정 JWT 서명 → 커스텀 토큰 + OAuth2 → Firestore REST.
  **firebase-admin을 안 쓴다.** 루트에 `package.json`이 생기면 Vercel 빌드 동작이
  바뀌는데(위 참고) 이 앱은 빌드 없는 단일 HTML이 전제다. node `crypto`로 충분하다.
- `api/auth.js` — `teachers`(이름만) / `login`(teacher·student) / `register` /
  `changePin`(학생) / `changeTeacherPin`(선생님 본인. 사이드바 "내 PIN 변경") /
  `defaultPinReport`(초기 비번 학생 현황).
  선생님 관리 화면의 PIN 초기화는 **다른** 선생님용이라 본인 것은 여기서만 바꾼다.

**초기 비번(`1234`) 대책.** 무차별 대입은 시도 제한으로 막았지만 기본 PIN은 대입이
필요 없다 — 이름만 알면 한 번에 들어간다. 제한은 이름 하나당이라 여러 이름에
1234를 한 번씩 넣는 건 걸리지도 않는다. 그래서 두 가지를 건다.
  - 학생이 기본 PIN으로 들어오면 서버가 `mustChangePin`을 내려주고 앱이 변경 화면을 먼저 띄운다
    (`verifyStudentPin`이 통과 경로를 `personal`/`legacy`/`default`로 알려준다)
  - 선생님 홈에 `DefaultPinNotice` — 초기 비번 학생 수와 반별 이름

> [!warning] `defaultPinReport`는 반드시 인증을 확인한다
> 그 목록은 **"이 이름들은 1234로 들어간다"는 지도**다. `_google.js`의
> `verifyIdToken()`이 구글 공개키로 서명·aud·iss·exp를 검증한 뒤 선생님일 때만 응답한다.
> 클라이언트가 보낸 role을 그냥 믿으면 다시 클라이언트를 믿는 것이 된다.
  **시도 8회 / 10분 제한**(`authAttempts`). 검사를 서버로 옮기면 4자리 PIN을 전부
  넣어보는 게 가능해지므로 이게 없으면 오히려 전보다 나쁘다.
- 환경변수 **`FIREBASE_SERVICE_ACCOUNT`** = 서비스 계정 JSON 전체.
  Vercel 환경변수는 Production/Preview/Development **스코프가 따로**다. 셋 다 켜둘 것.

**토큰 claims** — 보안 규칙이 이걸 본다.

| | claims |
|---|---|
| 선생님 | `{ role: "teacher"\|"owner", tid }` |
| 학생 | `{ role: "student", sname, cids: [반id…] }` |

담당 반은 claims에 넣지 않는다. 반이 늘면 1000바이트 제한에 걸리고, 담당이 바뀌어도
다시 로그인할 때까지 옛 값이 남는다. 규칙이 `teachers/{tid}`를 직접 읽는다.

**보안 규칙은 `firestore.rules`** 에 있다. 저장소에서 관리하고 **콘솔에 붙여넣어 게시**한다
(자동 배포되지 않는다). 함정은 그 파일 주석과 [[Firestore 보안 규칙 함정]] 참고.

- 익명 로그인은 **꺼져 있다.** 켜면 안 된다 — 예전에 이것 때문에 `request.auth != null`
  규칙이 무의미했다(방문자 전원이 자동 로그인됐다).
- 로그인 유지는 Firebase 세션이 한다. 새로고침하면 claims로 신분을 복구하고
  담당 반은 본인 `teachers/{tid}` 문서에서 읽는다. `sessionStorage`는 더 쓰지 않는다.
- **화면도 규칙과 같이 좁혀야 한다.** `MY_SCOPE`/`inScope`가 일반 선생님을 담당 반으로
  제한한다. 안 맞추면 목록에는 뜨는데 들어가면 아무것도 안 나오는 상태가 된다.

### 주요 도메인 로직
- **합반**(`merge`): 특정 요일에 두 반을 한 화면에서. 질문은 대표 반 한 곳에 통합 저장,
  출석/과제/점수는 각 반에 저장하고 화면만 병합(`반id:학생id` 복합키). 학생 화면엔 노출 안 함
- **개별진도반**(`type:"individual"`): 학생마다 `days`·`books`. 수강기간 `startDate`~`endDate`,
  종료일 지나면 자동으로 명단에서 빠짐(기록은 보존). 헬퍼: `isActiveOn` `isEnded` `attendsOn` `addMonths`
- **반 종강**(`endDate`): 학생 수강종료와 **같은 문법을 반 단위로** 확장한 것.
  `isClassEnded(cls)` = `todayStr > cls.endDate` (종강일 = 마지막 수업일, 그 다음 날부터 빠진다).
  헬퍼 `activeClasses()` / `endedClasses()`로 목록을 가른다. 쓰기는 `saveClassEnd(cid, endDate)`.
  종강한 반은 **내 수업 목록에서 접히고**(`종강한 반 N개`), 위험신호·보강 관리·합반 상대·
  선생님 담당 반 선택·순서 편집·학생 로그인에서 **빠진다.** 반 안으로는 그대로 들어가지고
  (배너로 알림) 학습관리 보고서에도 남는다 — 지난 학기 보고서를 뽑을 일이 있어서다.
  개진반이라도 **수업 로그(`c:live`) 메뉴는 숨긴다.** endDate를 지우면 전부 되살아난다.

  **종강하면 합반은 함께 푼다.** `mergePartner`는 `findClass`로 반을 찾을 뿐 종강 여부를
  안 보기 때문에, 안 풀면 종강한 반 학생이 **상대 반 출석 화면에 계속 끌려온다.**
  `saveClassEnd`가 `clearMerge`까지 호출하고 무엇을 풀었는지 이름을 돌려준다.

  > [!warning] 종강한 반을 삭제로 치우면 안 된다
  > `deleteClass`는 **반 문서 하나만** 지운다. Firestore는 문서를 지워도 하위 컬렉션이
  > 남으므로 attendance·homework·dailyNotes·lessonLogs·progress·noteUnits가 전부 고아가 되고
  > **앱에서 영영 못 본다.** 상담·월간보고서는 최상위라 문서는 살지만 반이 없어 열 길이 없다.
  > 그래서 반 설정의 삭제 버튼 위에 "종강을 쓰라"는 안내를 붙여 뒀다. 삭제는 잘못 만든 반 전용.

- **월간 출석부 날짜**: `days/{date}` 문서는 그날 뭔가 일어나야 생긴다. 그래서 출석을
  한 번도 안 찍은 날은 칸 자체가 없어 **나중에 채워 넣을 방법이 없었다.**
  이제 **기록이 있는 날 ∪ 수업이 있었어야 할 날(오늘까지)** 을 합쳐 보여준다
  (`scheduledDates`). 요일 밖 보강수업도 기록이 있으면 그대로 남는다.
  칸을 누르면 `touchDay`가 날짜 문서를 만들어 주므로 과거 날짜도 바로 찍힌다.
  개별진도반은 전원의 요일을 합쳐 컬럼을 만들고 표에서 학생별로 다시 거른다.

  > [!warning] 최근 N개월 목록은 반드시 1일로 만들 것 (`recentMonths`)
  > `d.setMonth(d.getMonth() - i)`는 오늘이 29~31일이면 넘친다. 8/29에서 6개월 전은
  > 2/29인데 그런 날이 없어 3/1이 되고, **2월이 목록에서 사라지고 3월이 두 번** 나온다.

- **안내문**(`flyer.html`): 진도계획 A4 한 장을 만드는 도구. **자체 style·script를 가진
  완결된 HTML**이라 앱 DOM에 인라인하면 CSS가 서로 밟는다. 저장소 루트에 두고
  **iframe으로 띄우며 postMessage로만 주고받는다**(`?cid=` 반 구분, `?view=1` 읽기전용).
  단독으로 열어도 예전처럼 동작한다 — 다리는 iframe 안일 때만 켜진다.
  - 저장은 localStorage가 아니라 앱이 Firestore에 한다.
    `config/flyer`(초안, **선생님만**) / `config/flyerPub`(게시본, 학생도 읽음)로 나눈다.
  - 학생 탭은 **게시본이 있을 때만** 뜬다. 인쇄는 `새 창에서 열기`로 원본 그대로.

  > [!warning] `config/{x}` 로 뭉뚱그려 열지 말 것
  > 규칙을 `match /config/{x} { read: inClass }` 로 두면 **게시 전 초안까지 학생이 읽는다.**
  > 게시 구분이 무의미해진다. config는 문서마다 공개 범위가 다르므로 하나씩 적는다.

  > [!warning] iframe 초기화를 "변경"으로 세지 말 것
  > 부모가 데이터를 내려주기 전의 `commit()`도 `save()`를 부른다. 그대로 두면
  > 열자마자 "저장 안 된 변경"이 뜬다. `ready` 플래그로 막는다.

- **보강**(`makeups`): 결석 예정 / 동영상 보강 완료. 월간 출석부 칸 클릭 시
  O → 예(결석예정) → 영(동영상완료) → / 순환. 전역 "보강 관리"에서 미래 날짜 예약(학생→날짜→수업 3단계)
- **수업 로그**(`LessonLogger`, 사이드바 `c:live`): **개별진도반에서만** 보인다.
  개진반은 한 교실에서 학생마다 다른 단원을 하므로 녹화본을 학생별로 갈라야 하는데,
  "몇 분부터가 누구 것인지"는 수업이 끝나면 사라진다. 수업 중에 학생 카드를 눌러 그 자리에 적는다.
  종료하면 컷 리스트(.json)와 ffmpeg 명령이 나오고 `split_by_log.py`가 실제로 자른다.

  **영상 맞추기**(`shift`): 녹화를 켠 뒤 앱을 열기까지의 공백. 로그의 0초가 영상 몇 초인지를 넣는다.
  종료 후 "영상 맞추기" 칸에 두 가지로 적을 수 있고 형식을 보고 고른다 —
  `3:12`(영상 지점) / `16:58`(녹화 켠 시각, `startedAt`과의 차이가 곧 shift).
  16:58은 양쪽으로 읽히므로 **시(hour)가 그날 수업 시작 시각 언저리일 때만 시각으로 본다.**
  고른 해석은 한 줄 문장으로 띄우고 알약 단추로 뒤집을 수 있게 했다(자동으로 정하고 말하지 않으면
  틀린 걸 영상 다 자른 뒤에 안다). 값을 바꾸면 아래 구간 표가 같이 움직이는 것이 유일한 검증 수단.
  `marks`가 남아 있으므로 shift는 나중에 몇 번이고 고칠 수 있다(`clReseg`).
  음수면(녹화를 늦게 켬) 그 앞은 영상에 없으므로 `clGroup`이 잘라낸다.

  **소리 슬레이트**(`clBeep`): 손으로 맞추는 건 매주 반복되는 일이라, 신호를 아예 심어둔다.
  시작·종료에 두겹 순음(1000Hz+1600Hz, 0.35초)을 낸다. 캠코더가 그걸 같이 녹음하므로
  `tools/fix_sync.py`가 영상 오디오에서 찾아 **오프셋을 자동으로 채운다.** 선생님 손은 안 간다.
  종료 표식음까지 찾으면 캠코더 시계 드리프트도 잰다(`--drift`로 적용).

  순음을 **두 개 겹치는** 이유: 하나면 휘파람·벨소리에 걸린다. 1600/1000=1.6배라 배음 관계도
  아니어서 서로의 하모닉으로 오인되지 않는다. 검출은 "전체 소리 중 몇 %"가 아니라
  **제 이력 대비 + 이웃 주파수 대비** 두 조건을 함께 본다(비율만 보면 떠드는 교실에서 묻힌다).
  합성 시험에서 배경잡음과 같은 크기(0dB)까지 잡았고, 휘파람(1000Hz·1600Hz 단음)·박수·
  벨소리에 오검출 0. 못 찾으면 `--sens 0.5`.

  > [!warning] iOS에서 소리를 내려면 장벽이 **두 개**다
  > **무음 모드**: `navigator.audioSession.type = "playback"`(사파리 16.4+)으로 넘어가고,
  > 안 되는 기기를 위해 소리를 `<video>`로 흘려보내는 우회로를 함께 둔다.
  > **잠금 해제**: iOS는 페이지가 소리를 한 번 내본 뒤에야 소리가 난다.
  > 처음엔 매번 새 `AudioContext`를 만들었더니 **"수업 시작"의 첫 삐가 통째로 사라졌다**
  > (끄고 다시 켜면 났다 — 그때는 이미 풀려 있으니까). 하필 그 한 번이 영상에 남아야 할
  > 유일한 표식이다. 지금은 컨텍스트를 하나만 만들어 재사용하고, 화면에 들어오면
  > 첫 터치에 1샘플 무음을 흘려 미리 푼다(`clUnlock`). "수업 시작"을 누르는 터치도
  > pointerdown이 click보다 먼저라 그 사이에 풀린다.
  > **미디어 볼륨 0은 웹에서 못 올린다** — 그래서 "소리 시험" 단추가 있다.
  >
  > 삐는 `CL_BEEP_LEAD`(0.12초) 뒤에 울리므로 로그 0초와 어긋난다. 울린 시각을
  > `beepAt`/`endBeepAt`으로 따로 적고 컷 리스트의 `startBeepLogT`로 실어서
  > `fix_sync.py`가 빼도록 한다(문서를 먼저 쓰고 삐를 내야 순서가 안 뒤집힌다).

  > [!warning] 저장은 blur가 아니라 디바운스로
  > 입력칸 `onBlur`에 저장을 걸었더니 **모드 알약을 누를 때 blur가 먼저 일어나**
  > 바뀌기 전 해석("3:12"을 시각으로 읽은 49800초)이 저장됐다. 800ms 디바운스로 바꿨다.

  컷 리스트 JSON의 `shift`는 **항상 0**이다. `parts`·`segments` 시각에 이미 반영돼 있어서
  `split_by_log.py`가 또 더하면 안 된다. 실제 값은 기록용으로 `videoOffset`,
  절대시각은 `startedAt`/`startedAtIso`로 따로 싣는다(나중에 영상 메타데이터와 대조하려고).
  `sync{tones,dur,startBeepLogT,endBeepLogT}`는 `fix_sync.py`가 무엇을 어디서 찾을지 보는 곳이다.
  `clDownload`는 BOM을 붙이지 않는다 — 파이썬 `json.load`가 BOM에서 죽는다.
  같이 나오는 것이 본체에 가깝다 — **학생별 배분 시간**(강의/질문 분리)과 **계획 대비 진도**.
  강의 구간이 20초 미만이면 오탭으로 보고 버린다(그래서 눌러보기만 하면 내보내기가 안 뜬다).

  **수업기록 초안**: `clSplitTranscript`가 받아쓴 발화를 학생 구간에 맞춰 나누고
  (버릴 구간·구간 밖은 제외), `/api/note`가 학생별 수업기록으로 요약한다.
  저장하면 `dailyNotes`에 들어가 **학습관리 보고서에 그대로 실린다.**
  원문은 두 갈래다 — 마이크를 켰으면 라이브 자막, 아니면 PC에서
  `split_by_log.py --transcribe`(faster-whisper)로 받아쓴 걸 붙여넣는다. 후자가 훨씬 정확하다.

  > [!warning] 음성 파일은 앱에 저장하지 않는다
  > 앱의 파일 저장 한계는 4.5MB인데 2시간 음성은 8kbps로 눌러도 base64 9.6MB다.
  > 애초에 안 들어간다. 그리고 **음성은 이미 녹화 영상 안에 있다** —
  > `split_by_log.py --audio`가 학생별로 뽑아낸다. 브라우저 녹음은 중복이다.

  > [!warning] 마이크는 제안만 한다. 자동으로 바꾸지 않는다
  > `useLessonMic`이 Web Speech API(`ko-KR`)로 받아쓰고 `clDetect`가 이름·단원을 찾아
  > **"바꿀까요?"를 띄운다.** 자동 전환은 체크박스를 켜야만 동작하고 기본값은 꺼짐이다.
  > 자동자막은 이름을 자주 틀린다 — 지오→지옥, 승훈→성훈·승우, "세 개는"→세경에는.
  > 틀린 자동 전환은 영상을 다 자르고 나서야 발견되므로 오탐 하나가 오탭 하나보다 훨씬 비싸다.
  >
  > 이름은 **자모 분해 후 편집거리**로 본다(글자 단위로는 지옥≈지오가 안 잡힌다). 문턱 0.72.
  > 승훈↔승우는 0.667이라 안 잡히는데, 태경↔세경 0.600과 너무 가까워 **문턱을 못 내린다.**
  > 대신 `config/lessonLog.aliases`에 실제로 틀리게 들리는 말을 등록한다(UI: 마이크 줄 "이름 보정").
  > 단원 키워드는 이름보다 훨씬 잘 잡히지만 `units`를 채워둔 뒤에야 작동한다.
  >
  > 데스크톱 크롬에서 음성은 **구글 서버를 거친다.** 크롬 전용이고 iOS 사파리는 안 된다.
  > 조용하면 저 혼자 끊기므로 `onend`에서 되살린다.

- **점수 추이**(`ScoreChart`/`ScoreTrend`/`ScoreTrendBoard`): 학생이 점수 탭에서 낸 테스트를
  꺾은선으로 모아 본다. 학생은 자기 것, 선생님은 학생을 골라서(`c:scores`).
  점수는 `days/{date}/scores`에 흩어져 있어 `loadScoreHistory()`가 모은다 —
  **날짜 수만큼 읽기가 나가므로 최근 80일치만** 본다.
  **차트 라이브러리를 쓰지 않는다.** CDN을 하나 더 늘리면 그게 죽을 때 앱이 같이 죽는다
  (버전 고정 원칙과 같은 이유). 점 몇 개짜리 꺾은선은 SVG로 충분하다.

- **진도표 메뉴는 조건부**: 안내문이 생기면서 일반반은 대개 안 쓰게 됐다. 일반반은
  **올려둔 파일이 있을 때만** 메뉴를 띄우고, 새로 올리려면 안내문 화면의 링크로 간다.
  개별진도반은 **학생마다 진도계획표가 따로**라 반 하나짜리 안내문으로 대체되지 않는다 — 그대로 둔다.

- **내신 참여표**(`ExamForm`/`ExamBoard`): 구글시트로 쓰던 «클라이매쓰 내신관리»를 옮긴 것.
  내신기간에는 학생마다 안 오는 날이 달라서, **학생이 직접 내고 선생님이 한눈에 본다.**
  - 학생이 내는 것: 학교 · 학년(중3/고1/고2/고3) · 내신기간 · **수학시험일** ·
    **직보**(수학시험 전날, 자동으로 채우되 고칠 수 있음) · 비고
  - **복귀일은 선생님이 정한다.** 학생 화면에 입력칸이 없고 정해지면 안내만 뜬다.
    선생님은 참여표의 표에서 바로 넣는다. 학생이 다시 제출해도 `back`은 안 건드린다 —
    안 그러면 재제출 한 번에 선생님이 정한 값이 지워진다.
  - 학교 목록에 없으면 **기타 (직접 입력)** 으로 넣는다. 선생님은 그렇게 들어온 이름을
    참여표에서 **공용 목록(`appConfig/schools`)에 올려** 다음부터 고를 수 있게 한다.
    학생은 공용 목록에 못 쓴다 — 아무나 쓰면 오타가 목록으로 굳는다.
  - 선생님 화면: 학년 3분할 + **날짜 띠**(시트의 그 화면)와 표, 그리고 **아직 안 낸 학생**.
    띠에 찍는 표식은 `EXAM_MARKS` — `직` `수` `시` `첫`
  - 학교는 **고르게 한다**(`KNOWN_SCHOOLS`, 쓰던 시트에서 옮김 + 그 반에서 이미 쓴 학교).
    자유 입력이면 "중동고/중동고등학교/중동"이 섞여 **같은 학교인지 판별 자체가 안 되고**
    일정 어긋남도 못 잡는다. 목록에 없으면 직접 넣을 수 있고 그러면 목록에 더해진다.
  - 같은 학교·학년 친구가 이미 냈으면 학생에게 **"이대로 불러오기"** 를 띄운다.
  - **같은 학교·학년인데 일정이 다르면**(`examSig` = 시작·종료·수학시험) 선생님 화면 위에
    띄우고, 맞는 쪽을 눌러 나머지를 맞출 수 있다. 자동으로 고치지 않는다 —
    분반마다 진짜 다를 수 있고, 무엇이 맞는지는 선생님이 안다.
  - `classes/{cid}/exams/{회차}__{sid}` — **회차를 키에 넣어** 기말·다음 학기가 덮어쓰지 않게.
    회차는 **학원 전체로 하나**이고(`appConfig/examTerm`) 선생님이 연다.
    학생이 고르게 하면 엉뚱한 회차에 쌓인다. 열려 있는 동안에만 학생 화면에 `내신` 탭이 뜬다.
  - **선생님이 대신 넣을 수 있다**(`ExamEntry`). 전화로 받아적거나 학생이 안 낼 때.
    "아직 안 낸 학생" 이름을 누르면 열리고, 낸 것은 표에서 `고치기`.
    대신 넣은 것은 `byTeacher: true`로 표시된다. 학생이 나중에 내면 그 위에 덮인다.
    입력은 **날짜 칸이 아니라 달력에 칠하는 방식**이다(`PAINT_MODES`) —
    시험기간·수학시험·직보·복귀를 고르고 칸을 누른다. 시험기간은 시작·끝 두 번 누른다.
    **수업 요일을 고르면 달력의 수업일과 등원 회차가 즉시 따라간다.**
  - 제출에 **`days`(수업 요일)를 함께 저장**한다. 선생님이 달력에서 고른 값이고,
    나중에 반 요일이 바뀌어도 **그때 센 회차가 그대로 재현된다.**
    `isClassDay`는 `v.days`가 있으면 그걸 먼저 쓴다.
  - **명단에서 안 잡히는 제출**은 따로 드러낸다. 참여표는 `!r.teacher && !isEnded(r)`만
    보는데, 그러면 선생님 항목·수강종료·명단에서 빠진 학생의 제출이 **표에도
    "아직 안 낸 학생"에도 안 나오고 조용히 사라진다.** 이유를 붙여 보여준다.
  - 명단의 **선생님 항목은 반 설정에서 학생으로 바꿀 수 있다**(`toStudent`).
    `teacher: true`면 출석부·과제·점수·보고서·내신에서 전부 빠지는데,
    그 항목이 화면에 아예 안 보여서 왜 빠지는지 알 길이 없었다.
  - **등원 회차**(`attendCount`)를 그 달 기준으로 센다. **수강료에 쓰는 숫자다.**
    `그 달 수업일 − (직보 다음날 ~ 복귀 전날) + 직보·복귀`.

    > 안 오는 구간을 **내신기간(start~end)으로 재면 틀린다.** 직보가 마지막 수업이고
    > 그 다음 오는 날이 복귀이므로, **시험이 끝난 뒤라도 복귀 전이면 안 온다.**
    > 화목반이 9/23에 시험이 끝나고 9/29에 복귀하면 9/24(목)은 안 오는데,
    > 내신기간으로 재면 그 날이 등원으로 잡힌다. `outRange()`가 한 곳에서 정한다.

    직보·복귀는 수업 요일이 아니어도 센다(학생이 오니까). 이미 센 날이면 중복으로 안 센다.
    띠에 수업일을 옅게 칠해 셈을 눈으로 검증할 수 있게 했다.

    > [!warning] `attendsOn`을 수업일 판정에 쓰지 말 것
    > 그 함수는 **일반반이면 요일을 안 본다**(호출부가 `cls.classDays`로 따로 거르는 전제).
    > 그대로 쓰면 그 달 전체가 수업일이 되어 등원이 31회로 나온다. `isClassDay`를 쓴다.

  - 날짜 띠는 **시험이 있는 달 1일 ~ 가장 늦은 복귀일**. 달을 고르지 않고 데이터에서 뽑는다.
    복귀가 다음 달로 넘어가면 띠도 따라 넘어간다(1일 칸에는 `10/1`처럼 월을 같이 적는다).

    > [!warning] 띠 범위와 회차 세는 범위는 다르다
    > 띠는 복귀일에서 끝나지만 **등원 회차는 그 달 전체(`monthDays`)로 센다.**
    > 복귀가 25일이어도 그 달 26~31일 수업일은 수강료에 들어가야 한다.
    > 띠(`strip`)로 세면 그만큼 빠진다.
  - 선생님 화면은 **반 선택 전 전역 메뉴**다. 반별로 보면 "이번 주에 누가 빠지나"를 못 본다.
    담당 반을 가로질러 모으고, 충돌도 반이 달라도 잡는다.

  > 원본 시트에는 학교별 시험일정 마스터(`26학사일정`)도 있다. 옮기면 학교+학년만 골라
  > 날짜가 자동으로 채워지지만, 학교 100여 개를 매년 갱신해야 해서 1차에서는 뺐다.

- **위험신호**: 자동 집계 아님. 선생님이 상담에 표시한 `risk`(0~3) 기준 + "상담 공백"(마지막 상담 경과일) 두 축
- **학습관리 보고서**: 출결 / 수업기록(dailyNotes) / 상담 / 종합코멘트. A4 인쇄·PDF.
  미리보기에서 수업기록 클릭 시 인라인 수정 가능. 인쇄 시 `.rp-noprint` 요소는 숨김.
  교재별 진도는 **표시 제거됨**(집계 로직과 hwSnapshot 저장은 남아 있어 되살리기 가능)

### 수업기록 초안 (`api/note.js`)
`hint.js`와 같은 `GEMINI_API_KEY`·같은 모델을 쓰지만 **프롬프트가 정반대**다.
hint는 "답을 주지 마", note는 "일어난 일만 적어". 원문에 없는 내용을 지어내지 않도록,
수업 내용이 안 보이면 그렇다고 답하도록 못박아 뒀다.
학부모에게 나가는 글이라 **저장 전 사람이 읽고 고치는 것을 전제**로 한다.

### AI 힌트 (`api/hint.js`)
Google Gemini 무료 등급, 모델 `gemini-2.5-flash-lite`.
Vercel 환경변수 **`GEMINI_API_KEY`**. 답을 주지 않고 힌트만 주도록 시스템 프롬프트로 강제.
수식은 LaTeX로 답하게 하고 앱에서 KaTeX(`MathText`)로 렌더. 최근 12개 메시지만 전달.

---

## 과거에 겪은 버그와 원인

| 증상 | 원인 / 해결 |
|---|---|
| "불러오는 중…"에서 멈춤 | Firebase 승인된 도메인에 vercel 주소 누락 |
| `Cannot use import statement outside a module` | CDN latest 문제 → 버전 고정 + 수동 Babel 변환 |
| 고쳤는데 반영 안 됨 | GitHub Pages에서 테스트 중이었거나 Vercel CDN 캐시 |
| 출석 체크 눌러도 무반응 | 전역 함수와 state 세터 이름 충돌(`setAttendance`) |
| 화면 전환 시 모바일 햄버거 사라짐 | 새 Sidebar 마운트 → 옛 Sidebar cleanup 순서. `hasSide`를 **카운터**로 변경 |
| 날짜 선택 후 사이드바 사라짐 | 조건부 return이 사이드바 렌더보다 앞에 있었음 |
| 스와이프 뒤로가기 안 먹음 | `useEffect([])`는 리마운트 시 재등록 안 됨 → **ref callback**(`useSwipeBack`). `touch-action:pan-y` 필수, CSS 애니메이션이 인라인 transform을 덮으므로 `el.style.animation="none"` 필요 |
| 표 안에서 스와이프하면 뒤로가기 | 가로 스크롤 영역에 `data-no-swipe` 부여 |
| 출석 카드 글자가 세로로 쪼개짐 | 2열 그리드 폭 부족 → `min-height` 고정 + `white-space:nowrap` + 상태를 둘째 줄로 |
| 스와이프로 뒤로 가면 화면이 빈다 | 목록/상세가 같은 자리에 같은 `<div class="cm-stack cm-slide-in">`을 반환 → React가 **DOM 노드를 재사용**하는데 스와이프가 박아둔 `transform:translateX(화면폭)`이 남아 다음 화면이 화면 밖에 그려짐. `useSwipeBack` ref 부착 시 `transform`·`animation`·`transition`을 지우도록 수정 |

---

## 사용자(마왕님) 작업 선호

- 결과물은 **전체 파일**로 받기를 원함 (부분 조각 ✗)
- 모바일(iPhone) 위주로 테스트
- 새 기능은 **설계 방향을 먼저 짧게 제안**하고 선택지를 주면 좋아함
- 캐주얼한 톤, 빠른 실행 선호

---

## 남은 아이디어

- 후속 조치에 기한(마감일) 부여 → 지나면 강조
- 보강 처리: 개별진도반에서 다른 요일에 온 학생 "오늘만 추가"
- 성적 추이 그래프 / AI 질문 분석(많이 막힌 단원 집계)
- 일반반에도 수강 기간 적용 (현재 개별진도반 UI에만 노출)
