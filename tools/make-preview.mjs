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
  function newId(){ return "x" + Math.random().toString(36).slice(2,8); }
  /* arrayUnion/arrayRemove 를 진짜로 적용한다.
     예전 스텁은 값을 그대로 돌려줘서 배열이 문자열로 들어갔다 — 앱은 멀쩡한데
     프리뷰만 틀리면 없는 버그를 쫓게 된다. */
  function applyOps(base, patch, deep){
    var out = Object.assign({}, base);
    Object.keys(patch||{}).forEach(function(k){
      var v = patch[k];
      if (v && v.__op === "union") {
        var cur = Array.isArray(out[k]) ? out[k].slice() : (out[k] == null ? [] : [out[k]]);
        v.vals.forEach(function(x){ if (cur.indexOf(x) < 0) cur.push(x); });
        out[k] = cur;
      } else if (v && v.__op === "remove") {
        var cur2 = Array.isArray(out[k]) ? out[k].slice() : [];
        out[k] = cur2.filter(function(x){ return v.vals.indexOf(x) < 0; });
      } else if (v === null && patch[k] === null) {
        delete out[k];
      } else if (deep && v && typeof v === "object" && !Array.isArray(v)
                 && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
        /* 진짜 Firestore의 set({merge:true})는 map 안까지 합친다.
           얕게 덮으면 { "학교|학년": {start} } 를 쓸 때 옆 칸(end/math)이 날아가서
           앱은 멀쩡한데 프리뷰만 틀린다 — 없는 버그를 쫓게 된다. */
        out[k] = applyOps(out[k], v, true);
      } else {
        out[k] = v;
      }
    });
    return out;
  }
  /* onSnapshot을 한 번만 쏘면, 저장한 값이 화면에 안 돌아온다.
     그러면 "저장은 됐는데 칸이 비어 보이는" 상태가 되어 앱 버그와 구별이 안 된다.
     쓰기가 일어날 때마다 듣고 있는 쪽에 다시 쏜다. */
  var _subs = [];
  var _pending = 0;
  function touch(){
    if (_pending) return;
    _pending = 1;
    Promise.resolve().then(function(){
      _pending = 0;
      _subs.slice().forEach(function(sb){ try { sb.fire(); } catch(e){} });
    });
  }
  function watch(fire){
    var sb = { fire: fire };
    _subs.push(sb);
    return function(){ var i = _subs.indexOf(sb); if (i >= 0) _subs.splice(i, 1); };
  }

  function snap(path){
    var d = store[path];
    // ref가 있어야 한다 — deleteFileDoc/deleteNoteUnit이 d.ref.delete()를 부른다
    return { exists: !!d, id: path.split("/").pop(), data: function(){ return d; },
             get ref(){ return docRef(path); } };
  }
  function docRef(path){
    return {
      _p: path,
      get: function(){ return Promise.resolve(snap(path)); },
      set: function(o, opt){
        var base = (opt && opt.merge) ? (store[path]||{}) : {};
        store[path] = applyOps(base, o, !!(opt && opt.merge));
        touch();
        return Promise.resolve();
      },
      update: function(o){ store[path] = applyOps(store[path]||{}, o); touch(); return Promise.resolve(); },
      delete: function(){ delete store[path]; touch(); return Promise.resolve(); },
      collection: function(n){ return colRef(path + "/" + n); },
      onSnapshot: function(cb){
        var fire = function(){ cb(snap(path)); };
        fire();
        return watch(fire);
      }
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
      onSnapshot: function(cb){
        var fire = function(){ var ds = docsUnder();
          cb({ docs: ds, forEach: function(f){ ds.forEach(f); }, size: ds.length }); };
        fire();
        return watch(fire);
      }
    };
    return Object.assign(q, {
      doc: function(id){ return docRef(path + "/" + (id === undefined ? newId() : id)); },
      add: function(o){ var id = newId(); store[path + "/" + id] = o; touch(); return Promise.resolve({ id: id }); }
    });
  }
  window.db = { collection: function(n){ return colRef(n); } };

  /* ---- 가짜 인증 ----
     실제 앱은 /api/auth 가 준 커스텀 토큰으로 로그인한다. 정적 서버에는 그게 없으므로
     토큰을 흉내 내고 claims를 그대로 돌려준다. 보안 규칙은 여기서 안 돈다 —
     규칙 검증은 프리뷰가 아니라 실제 배포본에서 해야 한다. */
  var _user = null, _watch = [];
  function fire(){ _watch.forEach(function(f){ try { f(_user); } catch(e){} }); }
  window.firebase = {
    firestore: Object.assign(function(){ return window.db; }, {
      FieldValue: {
        arrayUnion: function(){ return { __op: "union", vals: [].slice.call(arguments) }; },
        arrayRemove: function(){ return { __op: "remove", vals: [].slice.call(arguments) }; },
        serverTimestamp: function(){ return Date.now(); }, delete: function(){ return null; } }
    }),
    auth: function(){ return {
      get currentUser(){ return _user; },
      signInWithCustomToken: function(tok){
        var c = JSON.parse(atob(String(tok).split(".")[1]));
        _user = { uid: c.uid, isAnonymous: false,
                  getIdToken: function(){ return Promise.resolve(tok); },
                  getIdTokenResult: function(){ return Promise.resolve({ claims: c.claims }); } };
        fire(); return Promise.resolve({ user: _user });
      },
      signInAnonymously: function(){ return Promise.reject(new Error("preview: 익명 로그인 없음")); },
      signOut: function(){ _user = null; fire(); return Promise.resolve(); },
      onAuthStateChanged: function(cb){ _watch.push(cb); setTimeout(function(){ cb(_user); }, 0); return function(){}; }
    }; }
  };

  /* ---- 가짜 /api/auth ---- 실제 서버 로직을 아주 얇게 흉내 낸다 */
  /* 관리자 말고 보통 선생님도 하나 둔다 — 권한이 갈리는 길(반 만들기 등)을 눌러보려면 필요하다 */
  var TEACHERS = [{ tid: "t-owner", name: "한민수", role: "owner", status: "active", pin: "2030", classIds: [] },
                  { tid: "t-kim", name: "김선생", role: "teacher", status: "active", pin: "1111", classIds: [] }];
  var _fetch = window.fetch.bind(window);
  var mkTok = function(uid, claims){
    return "x." + btoa(unescape(encodeURIComponent(JSON.stringify({ uid: uid, claims: claims })))) + ".y"; };
  window.fetch = function(url, init){
    if (String(url).indexOf("/api/auth") < 0) return _fetch(url, init);
    var b = {}; try { b = JSON.parse((init && init.body) || "{}"); } catch(e){}
    var ok = function(o){ return Promise.resolve({ ok: true, status: 200, json: function(){ return Promise.resolve(o); } }); };
    var bad = function(m, c){ return Promise.resolve({ ok: false, status: c || 400, json: function(){ return Promise.resolve({ error: m }); } }); };
    if (b.action === "teachers")
      return ok({ teachers: TEACHERS.map(function(t){ return { tid: t.tid, name: t.name, role: t.role, status: t.status }; }) });
    if (b.action === "login" && b.kind === "teacher") {
      var t = TEACHERS.filter(function(x){ return x.tid === b.tid; })[0];
      if (!t || String(b.pin) !== t.pin) return bad("PIN이 올바르지 않습니다", 401);
      return ok({ token: mkTok("t_" + t.tid, { role: t.role, tid: t.tid }), tid: t.tid, name: t.name, role: t.role });
    }
    if (b.action === "login" && b.kind === "student") {
      var nm = String(b.name || "").replace(/\s+/g, ""), cids = [];
      Object.keys(store).forEach(function(k){
        if (k.indexOf("classes/") !== 0 || k.slice(8).indexOf("/") >= 0) return;
        var r = (store[k].roster || []).filter(function(x){ return String(x.name).replace(/\s+/g,"") === nm; });
        if (r.length) cids.push(k.split("/")[1]);
      });
      if (!cids.length) return bad("명단에 없는 이름이에요", 404);
      if (String(b.pin) !== "1234") return bad("PIN이 올바르지 않아요.", 401);
      return ok({ token: mkTok("s_" + nm, { role: "student", sname: nm, cids: cids }), name: nm, cids: cids, mustChangePin: true });
    }
    if (b.action === "defaultPinReport") return ok({ total: 0, groups: [] });
    /* 방금 만든 반을 만든 사람 담당으로. 실제 서버와 같은 검사(createdBy)를 한다 */
    if (b.action === "claimClass") {
      var cl = JSON.parse(atob(String(b.idToken).split(".")[1])).claims || {};
      var doc = store["classes/" + b.cid];
      if (!doc) return bad("없는 반입니다", 404);
      if (String(doc.createdBy || "") !== String(cl.tid || "")) return bad("본인이 만든 반이 아닙니다", 403);
      var tt = TEACHERS.filter(function(x){ return x.tid === cl.tid; })[0];
      if (!tt) return bad("없는 선생님입니다", 404);
      tt.classIds = tt.classIds || [];
      if (tt.classIds.indexOf(b.cid) < 0) tt.classIds.push(b.cid);
      store["teachers/" + cl.tid] = tt;
      return ok({ ok: true, classIds: tt.classIds });
    }
    return ok({ ok: true });
  };

  /* ---- 시험용 반 ---- 실제 시드 생성은 앱에서 없앴으므로 여기서 넣는다 */
  var t0 = Date.now();
  store["classes/c-reg"] = { name: "미리보기 일반반", classDays: [1,5], type: "regular", time: t0,
    books: [{ name: "교재A", total: 100 }, { name: "교재B", total: 50 }],
    roster: [{ id:"s1", name:"김서진" }, { id:"s2", name:"임서윤" }, { id:"t1", name:"한민수", teacher:true }] };
  store["classes/c-ind"] = { name: "미리보기 개진반", classDays: [], type: "individual", time: t0 + 1, books: [],
    roster: [{ id:"s1", name:"지승훈", days:[2,4], books:[{ name:"개별교재", total:80 }] },
             { id:"t1", name:"한민수", teacher:true }] };
  TEACHERS[0].classIds = ["c-reg", "c-ind"];
  store["teachers/t-owner"] = TEACHERS[0];
  store["teachers/t-kim"] = TEACHERS[1];

  console.log("[preview] 메모리 Firestore + 가짜 인증 사용 중 — 운영 DB에 쓰지 않습니다");
  console.log("[preview] 관리자 한민수 / PIN 2030,  선생님 김선생 / PIN 1111,  학생 PIN 1234");
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
