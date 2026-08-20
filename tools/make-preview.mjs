// index.html을 그대로 쓰되 Firestore만 메모리 가짜로 바꾼 preview.html을 만든다.
// 운영 DB(climath-class)에 시험용 문서를 쓰지 않기 위한 것. 배포와 무관(gitignore).
//   실행: node tools/make-preview.mjs  →  tools/preview.html
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let html = readFileSync(join(root, "index.html"), "utf8");

const STUB = `
<script>
/* ===== 메모리 Firestore (테스트 전용) ===== */
(function(){
  var store = {};                      // "경로/문서id" -> data
  window.__store = store;
  function snap(path){
    var d = store[path];
    return { exists: !!d, id: path.split("/").pop(), data: function(){ return d; } };
  }
  function docRef(path){
    return {
      _p: path,
      get: function(){ return Promise.resolve(snap(path)); },
      set: function(o, opt){
        store[path] = (opt && opt.merge) ? Object.assign({}, store[path]||{}, o) : o;
        return Promise.resolve();
      },
      update: function(o){ store[path] = Object.assign({}, store[path]||{}, o); return Promise.resolve(); },
      delete: function(){ delete store[path]; return Promise.resolve(); },
      collection: function(n){ return colRef(path + "/" + n); },
      onSnapshot: function(cb){ cb(snap(path)); return function(){}; }
    };
  }
  function colRef(path){
    function docsUnder(){
      var out = [];
      Object.keys(store).forEach(function(k){
        if (k.indexOf(path + "/") !== 0) return;
        if (k.slice(path.length + 1).indexOf("/") >= 0) return;   // 직계만
        out.push(snap(k));
      });
      return out;
    }
    var q = {
      get: function(){ var ds = docsUnder(); return Promise.resolve({ docs: ds, forEach: function(f){ ds.forEach(f); }, size: ds.length, empty: !ds.length }); },
      orderBy: function(){ return q; }, limit: function(){ return q; }, where: function(){ return q; },
      onSnapshot: function(cb){ var ds = docsUnder(); cb({ docs: ds, forEach: function(f){ ds.forEach(f); }, size: ds.length }); return function(){}; }
    };
    return Object.assign(q, {
      doc: function(id){ return docRef(path + "/" + id); },
      add: function(o){ var id = "x" + Math.random().toString(36).slice(2,8); store[path + "/" + id] = o; return Promise.resolve({ id: id }); }
    });
  }
  window.db = { collection: function(n){ return colRef(n); } };
  window.firebase = { firestore: Object.assign(function(){ return window.db; }, {
    FieldValue: { arrayUnion: function(){ return arguments[0]; }, arrayRemove: function(){ return arguments[0]; },
                  serverTimestamp: function(){ return Date.now(); }, delete: function(){ return null; } }
  }) };
  console.log("[preview] 메모리 Firestore 사용 중 — 운영 DB에 쓰지 않습니다");
})();
</script>`;

// 실제 firebase 설정 스크립트 블록을 통째로 스텁으로 교체
const mk = html.match(/<script>\s*\/\/ ===== Firebase 설정값 =====/);
if (!mk) { console.error("실패: Firebase 설정 블록을 찾지 못했습니다"); process.exit(1); }
const a = mk.index;
const b = html.indexOf("</script>", a) + "</script>".length;
html = html.slice(0, a) + STUB.trim() + html.slice(b);

// CDN firebase 로더도 뺀다 (스텁이 window.firebase를 차지해야 하므로)
html = html.replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+"><\/script>\s*/g, "");

// 마이크는 이 환경에서 못 켠다. 실제 인식 콜백을 밖으로 노출해 받아쓴 문장을 넣어볼 수 있게 한다.
// preview.html 에만 들어가고 index.html 은 손대지 않는다.
const hook = "useLessonMic(micOn && !!log, cbRef);";
if (html.indexOf(hook) < 0) { console.error("실패: 마이크 훅 지점을 찾지 못했습니다"); process.exit(1); }
html = html.replace(hook, hook + "\n  window.__mic = cbRef;   /* preview 전용 */");

writeFileSync(join(root, "tools", "preview.html"), html);
console.log("tools/preview.html 생성 완료 (" + html.length + "바이트)");
