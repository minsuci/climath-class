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
  /* 새로고침해도 로그인이 남게(실제 firebase 처럼) — 탭 전환(?admin=1 ↔ /) 확인용 */
  setTimeout(function(){ try { var tk = sessionStorage.getItem("__pvTok"); if (tk && !_user) window.firebase.auth().signInWithCustomToken(tk); } catch(e){} }, 0);
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
        try { sessionStorage.setItem("__pvTok", tok); } catch(e){}
        var c = JSON.parse(decodeURIComponent(escape(atob(String(tok).split(".")[1]))));
        _user = { uid: c.uid, isAnonymous: false,
                  getIdToken: function(){ return Promise.resolve(tok); },
                  getIdTokenResult: function(){ return Promise.resolve({ claims: c.claims }); } };
        fire(); return Promise.resolve({ user: _user });
      },
      signInAnonymously: function(){ return Promise.reject(new Error("preview: 익명 로그인 없음")); },
      signOut: function(){ _user = null; try { sessionStorage.removeItem("__pvTok"); } catch(e){} fire(); return Promise.resolve(); },
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
      var cl = JSON.parse(decodeURIComponent(escape(atob(String(b.idToken).split(".")[1])))).claims || {};
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

  /* ---- 가짜 /api/exam — 과제 채점 · 조각 (2026-10-12) ----
     실제 서버(api/exam.js)를 얇게 흉내 낸다. 미리보기 교재의 정답은 «객관식 ①, 단답 1». 조각 규칙은 서버 PC 와 같게 */
  var _fetch2 = window.fetch;
  var PCF = { cost: 20, streak: 5, awayMin: 5, awayEvery: 3, awayPen: 10 };
  var kstDay = function(){ return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); };
  var claimsOf = function(tok){ try { return JSON.parse(decodeURIComponent(escape(atob(String(tok).split(".")[1])))).claims || {}; } catch(e){ return {}; } };
  var ledger = function(cid, sid){ var k = "classes/" + cid + "/pieces/" + sid; return store[k] || (store[k] = { bal: 0, earned: 0, opened: 0, prizes: [], aways: [], log: [] }); };
  var todayAw = function(d){ return d.awayDay === kstDay() ? { n: d.awayN || 0, tot: d.awayTot || 0 } : { n: 0, tot: 0 }; };
  var hwOk = function(q, a){ return a == null ? false : q.type === "mc" ? Number(a) === 1 : q.type === "short" ? String(a).trim() === "1" : null; };
  var pcHandle = function(url, init){
    if (String(url).indexOf("/api/exam") < 0) return _fetch2(url, init);
    var b = {}; try { b = JSON.parse((init && init.body) || "{}"); } catch(e){}
    var ok = function(o){ return Promise.resolve({ ok: true, status: 200, json: function(){ return Promise.resolve(o); } }); };
    var bad = function(m, c){ return Promise.resolve({ ok: false, status: c || 400, json: function(){ return Promise.resolve({ error: m }); } }); };
    var c = claimsOf(b.idToken), tch = c.role === "teacher" || c.role === "owner";
    var cfg = store["appConfig/pieces"] || { cids: [], items: [] }, on = (cfg.cids || []).indexOf(b.cid) >= 0;
    var cls = store["classes/" + b.cid] || {};
    var rowOf = function(sid){ return (cls.roster || []).filter(function(r){ return r.id === sid; })[0] || {}; };
    var rules = function(){ return { cost: PCF.cost, streak: PCF.streak, awayMin: PCF.awayMin, awayEvery: PCF.awayEvery, awayPen: PCF.awayPen }; };
    var add = function(sid, n, k){ if (!n) return; var d = ledger(b.cid, sid); d.name = rowOf(sid).name; d.bal += n; d.earned += n; d.log.push({ t: Date.now(), k: k, d: n }); };
    var book = ((store["appConfig/examList"] || {}).exams || []).filter(function(e){ return e.id === b.bookId; })[0];
    if (book && book.qc) book = Object.assign({}, book, { questions: Array.from(book.qc.t, function(c, i){ return { n: i + 1, type: c === "m" ? "mc" : c === "s" ? "short" : "essay" }; }) });   // 창고 교재 — 목록엔 짧게(qc)
    var evNow = cfg.event && cfg.event.day === kstDay() && (cfg.event.items || []).length ? cfg.event : null;
    var evWon = function(d){ return evNow && d.evDay === evNow.day ? d.evWins || 0 : 0; };
    var itemOf = function(p){ var l = p.ev ? ((cfg.event || {}).items || []) : (cfg.items || []); return l.filter(function(y){ return y.id === p.id; })[0]; };
    var lectOf = function(cid){ var d = store["hwLect/" + cid] || {}; return { b: d.b || {}, odd: !!d.odd, rel: d.rel || {} }; };
    var lHas = function(L, bid, n){ return (L.b[bid] || []).indexOf(n) >= 0 || (L.odd && n % 2 === 1 && (L.rel[bid] || []).indexOf(n) < 0); };
    /* 학원 교재 고르기(10/24) — 서버 shelfAct 를 얇게. 창고는 PV_SHELF 네 권, 목록엔 서버처럼 짧게(qc) 싣는다 */
    if (b.action === "shelfList") return ok({ ok: true, books: PV_SHELF.map(function(x){ return { key: x.key, title: x.title, subj: x.subj, series: x.series, seriesName: x.seriesName, vol: x.vol, order: x.order,
      n: x.qs.length, auto: x.qs.filter(function(q){ return q.type !== "essay"; }).length }; }) });
    if (b.action === "shelfHang" || b.action === "shelfDrop") {
      var sb = PV_SHELF.filter(function(x){ return x.key === b.key; })[0];
      if (!sb) return bad("창고에 없는 교재예요", 404);
      var L5 = store["appConfig/examList"] || { exams: [] }, id5 = "과제-" + b.key, c5 = b.cid;
      var e5 = L5.exams.filter(function(e){ return e.id === id5; })[0];
      if (!e5) {
        if (b.action === "shelfDrop") return ok({ ok: true });
        e5 = { id: id5, kind: "hw", shelf: b.key, title: sb.title, units: sb.units, link: b.key.replace("-", " "), cids: [], allc: [], sids: [], questions: [], order: 0,
               qc: { t: sb.qs.map(function(q){ return q.type === "mc" ? "m" : q.type === "short" ? "s" : "e"; }).join(""), u: sb.u, l: sb.l } };
        L5.exams.push(e5);
      }
      e5.cids = e5.cids.filter(function(x){ return x !== c5; }); e5.allc = e5.allc.filter(function(x){ return x !== c5; });
      e5.sids = e5.sids.filter(function(x){ return x.indexOf(c5 + "/") !== 0; });
      var books5 = null;
      if (b.action === "shelfHang") {
        e5.cids.push(c5);
        if ((b.sids || []).length) e5.sids = e5.sids.concat(b.sids.map(function(x){ return c5 + "/" + x; })); else e5.allc.push(c5);
        var nm5 = b.key.replace("-", " ");
        if (b.board && cls.type !== "individual" && !(cls.books || []).some(function(x){ return x.name === nm5; })) { books5 = (cls.books || []).concat({ name: nm5, total: sb.qs.length }); cls.books = books5; }
      }
      e5.test = !e5.cids.length;
      store["appConfig/examList"] = L5; touch();
      return ok(Object.assign({ ok: true, id: id5, cids: e5.cids }, books5 ? { books: books5 } : {}));
    }
    if (b.action === "hwLectGet") return ok({ ok: true, lect: lectOf(b.cid) });
    if (b.action === "hwLectSet") {   // 미리보기 — 지급(hwLectPay)은 안 흉내 냄
      var L0 = lectOf(b.cid);
      if (typeof b.odd === "boolean") L0.odd = b.odd;
      else (b.nums || []).forEach(function(n){
        var cur = L0.b[b.bookId] || (L0.b[b.bookId] = []), rel = L0.rel[b.bookId] || (L0.rel[b.bookId] = []), od = L0.odd && n % 2 === 1;
        if (b.on !== false) { if (rel.indexOf(n) >= 0) rel.splice(rel.indexOf(n), 1); if (!od && cur.indexOf(n) < 0) cur.push(n); }
        else { if (cur.indexOf(n) >= 0) cur.splice(cur.indexOf(n), 1); if (od && rel.indexOf(n) < 0) rel.push(n); }
      });
      store["hwLect/" + b.cid] = L0; return ok({ ok: true, lect: L0, paid: [] });
    }
    if (b.action === "hwSubmit") {
      var LL = lectOf(b.cid), lset = (book.questions || []).map(function(q){ return q.n; }).filter(function(n){ return lHas(LL, b.bookId, n); });
      var asT = tch || !!rowOf(b.sid).teacher, byN = {}; (book.questions || []).forEach(function(q){ byN[q.n] = q; });
      var qs = (b.nums || []).map(function(n){ var q = byN[n], a = b.answers[n]; a = a == null || a === "" ? null : a;
        return { n: n, type: q.type, u: q.u, answer: a, auto: a == null ? false : book.free ? true : hwOk(q, a), sec: 20 + (n % 7) * 9, lect: lset.indexOf(n) >= 0 || undefined }; });
      var date = kstDay();
      var log = { rid: b.rid, cid: b.cid, sid: b.sid, name: rowOf(b.sid).name, bookId: b.bookId, title: book.title, date: date, startedAt: b.startedAt, endT: b.endT,
        pausedSec: b.pausedSec || 0, nums: b.nums, questions: qs, ev: b.ev, n: qs.length, correct: qs.filter(function(q){ return q.auto === true; }).length,
        blank: qs.filter(function(q){ return q.answer == null; }).length, pending: qs.filter(function(q){ return q.auto === null; }).length, teacher: asT, time: Date.now() };
      if (!asT && on) {
        var first = 0, st = 0, run = 0;
        qs.slice().sort(function(x, y){ return x.n - y.n; }).forEach(function(q){ if (q.answer == null || q.auto === null || q.lect) return; if (q.auto) { first++; if (++run >= PCF.streak) { st++; run = 0; } } else run = 0; });
        add(b.sid, first + st, "hw"); log.pieces = { first: first, streaks: st, pts: first + st };
      }
      if (!asT && book.link) { var hk = "classes/" + b.cid + "/homework/" + b.sid, hd = store[hk] || { books: {} }; hd.books = hd.books || {};
        var had = hd.books[book.link] || []; hd.books[book.link] = had.concat(qs.filter(function(q){ return q.answer != null && had.indexOf(q.n) < 0; }).map(function(q){ return q.n; })); store[hk] = hd; }
      store["classes/" + b.cid + "/days/" + date] = store["classes/" + b.cid + "/days/" + date] || { updated: Date.now() };
      store["classes/" + b.cid + "/days/" + date + "/hwLogs/" + b.rid] = log;
      return ok({ ok: true, log: log });
    }
    if (b.action === "hwRetry" || b.action === "hwSelf") {
      var p = "classes/" + b.cid + "/days/" + b.date + "/hwLogs/" + b.rid, L = store[p]; if (!L) return bad("그 기록이 없어요", 404);
      var bk = ((store["appConfig/examList"] || {}).exams || []).filter(function(e){ return e.id === L.bookId; })[0], bn = {}; (bk.questions || []).forEach(function(q){ bn[q.n] = q; });
      var gain = 0, nowR = Date.now();
      L.questions = L.questions.map(function(r){
        if (b.action === "hwSelf") { if (!(String(r.n) in (b.marks || {})) || r.auto !== null) return r; if (b.marks[r.n] === true) gain++; return Object.assign({}, r, { auto: b.marks[r.n] === true, self: true }); }
        if (!(r.n in (b.answers || {})) || r.auto !== false || r.fin) return r;
        var okk = hwOk(bn[r.n], b.answers[r.n]); if (okk) gain++;
        return Object.assign({}, r, { tries: (r.tries || []).concat([{ a: b.answers[r.n], ok: okk, sec: 15, at: nowR }]), fin: okk });
      });
      if (b.action === "hwRetry") L.retried = nowR;   // 서버와 같게 — 화면이 «방금 맞힌 것» 을 이 값으로 고른다
      L.correct = L.questions.filter(function(q){ return q.auto === true; }).length; L.pending = L.questions.filter(function(q){ return q.auto === null; }).length;
      L.fixed = L.questions.filter(function(q){ return q.auto === false && q.fin; }).length;
      if (!L.teacher && on) add(L.sid, gain, b.action === "hwSelf" ? "self" : "retry");
      return ok({ ok: true, log: L });
    }
    if (b.action === "pcMe") {
      if (!on) return ok({ ok: true, on: false });
      var d = ledger(b.cid, b.sid), ta = todayAw(d), sum = 0; (cfg.items || []).forEach(function(x){ sum += x.pct; });
      return ok({ ok: true, on: true, bal: d.bal, earned: d.earned, opened: d.opened, awayN: ta.n, awayTot: ta.tot, rules: rules(), lect: lectOf(b.cid),
        prizes: d.prizes.map(function(p){ var it = p.voucher && !p.given ? itemOf(p) : null; return p.voucher && !p.given ? Object.assign({}, p, { canSwap: !!it && (it.stock == null || it.stock > 0) }) : p; }),
        hasItems: (cfg.items || []).length > 0 || !!evNow,
        event: evNow ? { title: evNow.title, cap: evNow.cap, won: evWon(d), names: evNow.items.map(function(x){ return x.name; }),
                         sure: evNow.items.reduce(function(s, x){ return s + x.pct; }, 0) >= 99.99 } : null });
    }
    if (b.action === "hwAway") {
      if (!on || tch || rowOf(b.sid).teacher) return ok({ ok: true, on: on });
      if ((b.s || 0) <= PCF.awayMin) return ok({ ok: true, skipped: true });
      var d2 = ledger(b.cid, b.sid);
      if ((d2.aways || []).some(function(a){ return a.aid === b.aid; })) { var t2 = todayAw(d2); return ok({ ok: true, dup: true, n: t2.n, tot: t2.tot, bal: d2.bal }); }
      var ta2 = todayAw(d2), n2 = ta2.n + 1, hit = n2 >= PCF.awayEvery, lost = 0;
      if (hit) { lost = Math.min(d2.bal, PCF.awayPen); d2.bal -= lost; n2 = 0; }
      d2.name = rowOf(b.sid).name; d2.awayDay = kstDay(); d2.awayN = n2; d2.awayTot = ta2.tot + 1;
      d2.aways.push({ aid: b.aid, t: Date.now(), s: b.s, q: b.q, k: d2.awayTot, pen: hit ? lost : undefined });
      return ok({ ok: true, hit: hit, lost: lost, n: n2, tot: d2.awayTot, bal: d2.bal, rules: rules() });
    }
    if (b.action === "pcOpen") {
      var d3 = ledger(b.cid, b.sid);
      if (d3.bal < PCF.cost) return bad("조각이 " + PCF.cost + "개 있어야 구슬을 열 수 있어요");
      var w3 = evWon(d3);
      if (evNow && w3 >= evNow.cap) return bad("오늘은 한 사람에 " + evNow.cap + "개까지예요 — 남은 구슬은 내일 열 수 있어요");
      var r = Math.random() * 100, pick = null; ((evNow ? evNow.items : cfg.items) || []).some(function(x){ r -= x.pct; if (r < 0) { pick = x; return true; } return false; });
      var vo = !!(pick && pick.stock != null && pick.stock <= 0);
      if (pick && pick.stock != null && !vo) pick.stock--;
      var tag = evNow ? { ev: evNow.day } : {};
      var prize = vo ? Object.assign({ pid: "v" + Date.now(), id: pick.id, name: (Number(pick.price) > 0 ? Number(pick.price).toLocaleString("ko-KR") + "원" : pick.name) + " 교환권", of: pick.name, price: pick.price, voucher: true, at: Date.now(), given: false }, tag)
        : pick ? Object.assign({ pid: "p" + Date.now(), id: pick.id, name: pick.name, at: Date.now(), given: false }, tag) : { pid: "b" + Date.now(), id: "blank", name: "꽝", blank: true };
      d3.bal -= PCF.cost; d3.opened++; if (pick) d3.prizes.push(prize);
      if (evNow && pick) { d3.evDay = evNow.day; d3.evWins = w3 + 1; }
      return ok({ ok: true, prize: prize, bal: d3.bal });
    }
    if (b.action === "pcBoard") {
      var rows = Object.keys(store).filter(function(k){ return k.indexOf("classes/" + b.cid + "/pieces/") === 0; }).map(function(k){ var d = store[k], ta = todayAw(d);
        return { sid: k.split("/").pop(), name: d.name, bal: d.bal, earned: d.earned, opened: d.opened, awayN: ta.n, awayTot: ta.tot, aways: d.aways, prizes: d.prizes }; });
      return ok({ ok: true, on: on, rules: rules(), rows: rows, event: cfg.event || null, items: cfg.items || [], today: kstDay(),
        coupons: ((store["appConfig/pieceCouponIdx"] || { list: [] }).list).map(function(x){ return { id: x.id, item: x.item, used: x.used }; }) });
    }
    if (b.action === "pcGive") { var d4 = ledger(b.cid, b.sid); d4.prizes = d4.prizes.map(function(x){ return x.pid === b.pid ? Object.assign({}, x, { given: true }) : x; }); return ok({ ok: true }); }
    if (b.action === "pcAdjust") { var d5 = ledger(b.cid, b.sid); d5.bal = Math.max(0, d5.bal + Number(b.delta)); return ok({ ok: true, bal: d5.bal }); }
    if (b.action === "pcItemsGet") return ok({ ok: true, items: cfg.items || [], cids: cfg.cids, rules: rules(), event: cfg.event || null, today: kstDay() });
    if (b.action === "pcEventSet") {
      if (b.off) { cfg.event = null; return ok({ ok: true, event: null }); }
      var eits = (b.items || []).map(function(x, i){ return { id: x.id || "e" + Date.now() + i, name: x.name, pct: Number(x.pct) || 0, price: Number(x.price) || 0, stock: x.stock == null || x.stock === "" ? null : Number(x.stock) }; });
      cfg.event = { day: kstDay(), title: b.title || "", cap: Math.max(1, Number(b.cap) || 1), items: eits }; store["appConfig/pieces"] = cfg;
      return ok({ ok: true, event: cfg.event });
    }
    if (b.action === "pcCouponAdd") {
      var cl = store["appConfig/pieceCouponIdx"] || (store["appConfig/pieceCouponIdx"] = { list: [] });
      if (cl.list.some(function(x){ return x.img === b.img; })) return bad("같은 쿠폰 사진이 이미 들어 있어요", 409);
      cl.list.push({ id: "c" + Date.now() + cl.list.length, item: b.item, img: b.img, at: Date.now(), used: null });
      var si = (cfg.items || []).filter(function(x){ return x.id === b.item; })[0] || ((cfg.event || {}).items || []).filter(function(x){ return x.id === b.item; })[0];
      if (si && si.stock != null) si.stock++;
      return ok({ ok: true, stocked: !!si });
    }
    if (b.action === "pcCoupon") {
      var d7 = ledger(b.cid, b.sid), p7 = d7.prizes.filter(function(x){ return x.pid === b.pid; })[0], cl7 = (store["appConfig/pieceCouponIdx"] || { list: [] }).list;
      if (!p7 || p7.voucher) return bad("볼 수 있는 상품이 없어요");
      if (p7.coupon) { var c7 = cl7.filter(function(x){ return x.id === p7.coupon; })[0]; return ok({ ok: true, img: c7.img, name: p7.name }); }
      var f7 = cl7.filter(function(x){ return x.item === p7.id && !x.used; })[0];
      if (!f7) return bad("아직 쿠폰 사진이 안 들어왔어요 — 선생님께 말해 주세요", 404);
      f7.used = { name: rowOf(b.sid).name, at: Date.now() }; p7.coupon = f7.id; p7.given = true; p7.givenBy = "app";
      return ok({ ok: true, img: f7.img, name: p7.name, first: true });
    }
    if (b.action === "pcSwap") {
      var d6 = ledger(b.cid, b.sid), pz = d6.prizes.filter(function(x){ return x.pid === b.pid; })[0];
      if (!pz || !pz.voucher || pz.given) return bad("바꿀 교환권이 없어요");
      var it6 = itemOf(pz);
      if (!it6) return bad("그 상품이 상품표에서 빠졌어요 — 선생님께 말해 주세요");
      if (it6.stock != null && it6.stock <= 0) return bad("아직 재고가 없어요 — 채워지면 바꿀 수 있어요");
      if (it6.stock != null) it6.stock--;
      var np = Object.assign({}, pz, { name: pz.of || pz.name, voucher: false, swappedAt: Date.now() });
      d6.prizes = d6.prizes.map(function(x){ return x.pid === b.pid ? np : x; });
      return ok({ ok: true, prize: np });
    }
    /* 실전 시험 — 제출 · 끝난 뒤 다시 풀기(10/26) · «왜 틀렸어». 정답은 «객관식 ①, 단답 1» */
    if (String(url).indexOf("/api/examimg") >= 0) {
      var cv = document.createElement("canvas"); cv.width = 520; cv.height = 150; var g = cv.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, 520, 150); g.fillStyle = "#222"; g.font = "bold 22px sans-serif";
      g.fillText((b.kind === "sol" ? "해설 " : "문제 ") + b.n + "번 (미리보기)", 20, 50); g.font = "17px sans-serif";
      g.fillText(b.kind === "sol" ? "정답은 ① 또는 1 이에요." : "다음 중 옳은 것은? (정답 ① · 단답은 1)", 20, 95);
      return ok({ png: cv.toDataURL("image/png").split(",")[1] });
    }
    if (b.action === "submit") {
      var ex = ((store["appConfig/examList"] || {}).exams || []).filter(function(e){ return e.id === b.examId; })[0];
      if (!ex) return bad("그 시험지가 없어요", 404);
      var asT2 = tch || !!rowOf(b.sid).teacher, dt = kstDay();
      var qx = ex.questions.map(function(q){ var a = b.answers[q.n]; a = a == null || a === "" ? null : q.type === "mc" ? Number(a) : String(a);
        return { n: q.n, type: q.type, key: q.type === "mc" ? 1 : "1", answer: a, auto: hwOk(q, a) }; });
      var cr = qx.filter(function(q){ return q.auto === true; }).length;
      var lg = { rid: b.rid, cid: b.cid, sid: b.sid, name: rowOf(b.sid).name, examId: ex.id, title: ex.title, minutes: ex.minutes, limitSec: b.limitSec || ex.minutes * 60,
        endT: b.endT, startedAt: b.startedAt, reason: b.reason || "submit", date: dt, questions: qx, ev: b.ev || [], override: {},
        score: Math.round(cr / qx.length * 100), got: cr, totalPt: qx.length, correct: cr, n: qx.length, pending: 0, teacher: asT2, time: Date.now() };
      store["classes/" + b.cid + "/days/" + dt] = store["classes/" + b.cid + "/days/" + dt] || { updated: Date.now() };
      store["classes/" + b.cid + "/days/" + dt + "/examLogs/" + b.rid] = lg; touch();
      return ok({ ok: true, log: lg });
    }
    if (b.action === "examRetry") {
      var px = "classes/" + b.cid + "/days/" + b.date + "/examLogs/" + b.rid, LX = store[px]; if (!LX) return bad("그 기록이 없어요", 404);
      var rx = LX.questions.filter(function(q){ return q.n === b.n; })[0];
      if (!rx || rx.auto !== false || rx.fin) return bad("틀린 문제만 다시 풀어요");
      var okx = hwOk(rx, b.answer);
      rx.tries = (rx.tries || []).concat([{ a: b.answer, ok: okx, sec: Math.round(b.sec || 0), at: Date.now(), seen: b.seen || undefined }]); rx.fin = okx;
      LX.retried = Date.now(); touch();
      return ok({ ok: true, right: okx, log: JSON.parse(JSON.stringify(LX)) });
    }
    if (b.action === "whyMark") {
      var pw = "classes/" + b.cid + "/days/" + b.date + "/" + (b.kind === "exam" ? "examLogs/" : "hwLogs/") + b.rid, LW = store[pw]; if (!LW) return bad("그 기록이 없어요", 404);
      var rw = LW.questions.filter(function(q){ return q.n === b.n; })[0];
      if (!rw || rw.auto !== false || rw.fin !== true) return bad("다시 풀어 맞힌 문제에만 적어요");
      if ("why" in b) rw.why = b.why; if (b.kind === "exam" && "rushed" in b) rw.rushed = !!b.rushed;
      touch(); return ok({ ok: true, log: JSON.parse(JSON.stringify(LW)) });
    }
    /* 실시간 O/X (10/26) — 서버 liveMark · liveMarks 흉내. 정답은 미리보기 시험지대로 ①·1 */
    if (b.action === "liveMark") {
      var mx = ((store["appConfig/examList"] || {}).exams || []).filter(function(e){ return e.id === b.examId; })[0];
      if (!mx) return bad("그 시험지가 없어요", 404);
      var mm = {}; mx.questions.forEach(function(q){ var v = (b.answers || {})[q.n]; if (v == null || v === "") return; mm[q.n] = q.type === "essay" ? "p" : hwOk(q, v) ? "o" : "x"; });
      store["examLiveMarks/" + b.cid + "__" + b.date + "__" + b.sid] = { rid: b.rid, m: mm }; return ok({ ok: true });
    }
    /* 서술형 정답 글 (10/26) — 서버 essaySol 흉내. 미리보기 시험지 10번 */
    if (b.action === "essaySol") return ok({ ok: true, sols: { 10: "(1) $\\\\dfrac{3}{4}<k\\\\le\\\\dfrac{7}{4}$  (2) $a=b=2$" } });
    if (b.action === "liveMarks") {
      if (!tch) return bad("선생님만 볼 수 있어요", 403);
      var out = {}; (b.sids || []).forEach(function(sid){ var d = store["examLiveMarks/" + b.cid + "__" + b.date + "__" + sid]; if (d) out[sid] = d; });
      return ok({ ok: true, marks: out });
    }
    if (b.action === "pcItemsSet") { cfg.items = (b.items || []).map(function(x, i){ return Object.assign({}, x, { id: x.id || "n" + Date.now() + i }); }); store["appConfig/pieces"] = cfg; return ok({ ok: true, items: cfg.items }); }
    return ok({ ok: true });
  };
  var PC_KEEP = { test: function(k){ return k === "appConfig/pieces" || k === "appConfig/pieceCouponIdx" || k.indexOf("hwLect/") === 0 || k.indexOf("examLiveMarks/") === 0 || ["pieces", "days", "homework"].some(function(c){ return k.indexOf("classes/c-reg/" + c + "/") === 0; }); } };
  var pcSave = function(){ try { var o = {}; Object.keys(store).forEach(function(k){ if (PC_KEEP.test(k)) o[k] = store[k]; }); sessionStorage.setItem("__pvPc", JSON.stringify(o)); } catch(e){} };
  window.fetch = function(url, init){
    if (String(url).indexOf("/api/exam") < 0) return _fetch2(url, init);
    var out = pcHandle(url, init); pcSave(); return out;
  };
  /* 미리보기 과제 교재 — 일반반의 «교재A» 와 잇는다(정답: 객관식 ①, 단답 1, 25번은 스스로 채점) */
  store["appConfig/examList"] = { exams: [{ id: "pv-hw", kind: "hw", title: "교재A (미리보기 · 정답 ①)", link: "교재A", units: ["1단원", "2단원"], cids: ["c-reg"],
    questions: Array.from({ length: 100 }, function(_, i){ var n = i + 1; return { n: n, type: n === 25 ? "essay" : n % 10 === 0 ? "short" : "mc", u: n <= 50 ? 0 : 1 }; }) },
    { id: "pv-mx", title: "실전 미리보기 (정답 ① · 단답 1)", minutes: 20, cids: ["c-reg"],
      questions: Array.from({ length: 10 }, function(_, i){ return { n: i + 1, type: i === 9 ? "essay" : i >= 8 ? "short" : "mc" }; }) },   // 10번 서술형(10/26 정답 글 보기)
    { id: "pc-test", kind: "hw", free: true, title: "조각 시험 (아무 답이나 정답)", link: "", units: [], cids: ["c-reg"],
      questions: Array.from({ length: 20 }, function(_, i){ return { n: i + 1, type: "mc" }; }) },
    /* 오답 과제(10/26) — 임서윤 한 명에게. 정답은 교재A 처럼 ①·1 */
    { id: "과제-오답-임서윤-pv", kind: "hw", wb: true, title: "임서윤 기말 오답 모음 (미리보기)", link: "", units: [], cids: ["c-reg"], sids: ["c-reg/s2"],
      questions: [["퀀텀 3번 원본","mc"],["퀀텀 3번 숫자","mc"],["퀀텀 3번 묻는 말","mc"],["퀀텀 6번 원본","short"],["기출01 15번 원본","mc"],["기출01 20번 원본","short"]]
        .map(function(x, i){ return { n: i + 1, type: x[1], label: x[0] }; }) }] };
  store["appConfig/pieces"] = { cids: ["c-reg"], items: [
    { id: "g1", name: "1,000원 기프티콘", price: 1000, pct: 30, stock: 95 }, { id: "g2", name: "2,000원 기프티콘", price: 2000, pct: 6, stock: 20 },
    { id: "g3", name: "3,000원 기프티콘", price: 3000, pct: 3, stock: 10 }, { id: "g4", name: "4,500원 기프티콘", price: 4500, pct: 1.2, stock: 4 },
    { id: "g5", name: "6,000원 기프티콘", price: 6000, pct: 0.8, stock: 2 }] };

  /* 미리보기 창고 — 단원 둘, 단원마다 1번부터(«01단원 n번»). 정답은 위 교재A 와 같게 ①·1 */
  var pvBook = function(key, title, subj, series, seriesName, vol, order, n){
    var h = Math.ceil(n / 2), qs = Array.from({ length: n }, function(_, i){ var k = i + 1; return { n: k, type: k % 7 === 0 ? "essay" : k % 5 === 0 ? "short" : "mc" }; });
    return { key: key, title: title, subj: subj, series: series, seriesName: seriesName, vol: vol, order: order, qs: qs, units: ["01 다항식", "02 방정식"],
             u: [[0, 0], [h, 1]], l: [[0, "01단원 ", 1], [h, "02단원 ", 1]] };
  };
  var PV_SHELF = [pvBook("코어-공수1-1", "Unlimited Core 공통수학1 1권", "공통수학1", "코어", "Unlimited Core", "1권", 1, 120),
    pvBook("코어-공수1-2", "Unlimited Core 공통수학1 2권", "공통수학1", "코어", "Unlimited Core", "2권", 2, 90),
    pvBook("베켐-공수1-1", "내신 Basecamp 공통수학1 1권", "공통수학1", "베이스캠프", "내신 Basecamp", "1권", 301, 80),
    pvBook("챌린지-대수1", "Unlimited Challenge 대수 1권", "대수", "챌린지", "Unlimited Challenge", "1권", 101, 60)];

  /* ---- 시험용 반 ---- 실제 시드 생성은 앱에서 없앴으므로 여기서 넣는다 */
  var t0 = Date.now();
  store["classes/c-reg"] = { name: "미리보기 일반반", classDays: [1,5], type: "regular", time: t0,
    books: [{ name: "교재A", total: 100 }, { name: "교재B", total: 50 }],
    roster: [{ id:"s1", name:"김서진" }, { id:"s2", name:"임서윤" }, { id:"s3", name:"김태윤" }, { id:"t1", name:"한민수", teacher:true }] };
  try { var kept = JSON.parse(sessionStorage.getItem("__pvPc") || "null"); if (kept) Object.keys(kept).forEach(function(k){ store[k] = kept[k]; }); } catch(e){}
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
