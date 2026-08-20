# CLIMATH 수업관리 웹앱

CLIMATH 학원(한민수 선생님)의 수업관리 앱. **빌드 없는 단일 HTML 파일** + Vercel 서버리스 함수 1개.

```
repo/
├── index.html              # 앱 전체 (CSS + React, 4,786줄)
├── api/hint.js             # AI 힌트 중계 (Vercel serverless)
├── tools/check-jsx.mjs     # JSX 문법 검사 (배포 안 됨)
├── tools/test-detect.mjs   # 수업 로그 이름/단원 감지 테스트
├── tools/make-preview.mjs  # Firestore를 메모리 가짜로 바꾼 preview.html 생성
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
  name, classDays[], type("regular"|"individual"), books[], merge{partnerId,days[]}, order, time
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

### 인증
- 학생: 이름+PIN → 본인이 속한 반만 표시. **이름이 같으면 같은 사람**(`userPins`).
  검증 순서: 통합PIN → 반별 구PIN(성공 시 통합으로 자동 이전) → 기본값 1234
- 선생님: `?admin=1` → 목록에서 선택 → 개인 PIN, sessionStorage 유지.
  신규 등록은 `status:"pending"` → 관리자 승인 필요. owner=한민수(PIN 2030)

### 주요 도메인 로직
- **합반**(`merge`): 특정 요일에 두 반을 한 화면에서. 질문은 대표 반 한 곳에 통합 저장,
  출석/과제/점수는 각 반에 저장하고 화면만 병합(`반id:학생id` 복합키). 학생 화면엔 노출 안 함
- **개별진도반**(`type:"individual"`): 학생마다 `days`·`books`. 수강기간 `startDate`~`endDate`,
  종료일 지나면 자동으로 명단에서 빠짐(기록은 보존). 헬퍼: `isActiveOn` `isEnded` `attendsOn` `addMonths`
- **보강**(`makeups`): 결석 예정 / 동영상 보강 완료. 월간 출석부 칸 클릭 시
  O → 예(결석예정) → 영(동영상완료) → / 순환. 전역 "보강 관리"에서 미래 날짜 예약(학생→날짜→수업 3단계)
- **수업 로그**(`LessonLogger`, 사이드바 `c:live`): **개별진도반에서만** 보인다.
  개진반은 한 교실에서 학생마다 다른 단원을 하므로 녹화본을 학생별로 갈라야 하는데,
  "몇 분부터가 누구 것인지"는 수업이 끝나면 사라진다. 수업 중에 학생 카드를 눌러 그 자리에 적는다.
  종료하면 컷 리스트(.json)와 ffmpeg 명령이 나오고 `split_by_log.py`가 실제로 자른다.
  같이 나오는 것이 본체에 가깝다 — **학생별 배분 시간**(강의/질문 분리)과 **계획 대비 진도**.
  강의 구간이 20초 미만이면 오탭으로 보고 버린다(그래서 눌러보기만 하면 내보내기가 안 뜬다).

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

- **위험신호**: 자동 집계 아님. 선생님이 상담에 표시한 `risk`(0~3) 기준 + "상담 공백"(마지막 상담 경과일) 두 축
- **학습관리 보고서**: 출결 / 수업기록(dailyNotes) / 상담 / 종합코멘트. A4 인쇄·PDF.
  미리보기에서 수업기록 클릭 시 인라인 수정 가능. 인쇄 시 `.rp-noprint` 요소는 숨김.
  교재별 진도는 **표시 제거됨**(집계 로직과 hwSnapshot 저장은 남아 있어 되살리기 가능)

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
