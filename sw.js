// 클래스앱 서비스 워커 — 바탕화면 · 홈 화면에 «앱으로 설치» 되게 하는 것뿐이다 (2026-10-10, 팀체크와 같은 꼴).
//
// ⚠ 뿌리(/sw.js)에 있어야 한다. 서비스 워커는 자기가 놓인 자리 아래만 맡는다.
// ⚠ 캐시는 하지 않는다. 앱이 60만 자짜리 한 파일이라 옛 판을 물고 있으면 고친 것이 안 보인다.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
// ⚠ 아무 것도 안 하는 fetch 처리를 **일부러** 둔다 — 크롬은 «fetch 를 맡는 워커가 있어야» 설치를 물어본다.
//   respondWith 를 부르지 않으므로 브라우저가 평소대로 가져온다. 여기서 캐시하면 안 된다.
self.addEventListener("fetch", function () {});
