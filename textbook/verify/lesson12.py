"""12회차 «미분의 활용» 전 문항 검산.  실행: python3 verify/lesson12.py  (sympy 필요)"""
import sympy as sp
x=sp.Symbol('x'); bad=[]
def chk(label, got, want):
    if sp.simplify(sp.sympify(got)-sp.sympify(want))!=0: bad.append((label,got,want))
def crit(f):
    fp=sp.diff(f,x); return fp, sp.solve(sp.Eq(fp,0),x)

f=x**3-6*x**2+9*x+3; fp,_=crit(f)
chk("f' 인수분해", sp.factor(fp), 3*(x-1)*(x-3))
chk("f'(4)", fp.subs(x,4), 9); chk("f(4)", f.subs(x,4), 7)
chk("극대 f(1)", f.subs(x,1), 7); chk("극소 f(3)", f.subs(x,3), 3)
chk("f(5)", f.subs(x,5), 23); chk("f(0)", f.subs(x,0), 3)

f1=x**3-3*x; fp1,_=crit(f1)
chk("예1 f'",sp.factor(fp1),3*(x-1)*(x+1)); chk("예1 극대",f1.subs(x,-1),2); chk("예1 극소",f1.subs(x,1),-2)
f2=-x**3+3*x**2+9*x; fp2,_=crit(f2)
chk("예2 f'",sp.factor(fp2),-3*(x-3)*(x+1)); chk("예2 극소",f2.subs(x,-1),-5); chk("예2 극대",f2.subs(x,3),27)

for lab,fn,pts in [
  ("연1-1",x**3-12*x,[(-2,16),(2,-16)]),
  ("연1-2",x**3-3*x**2+4,[(0,4),(2,0)]),
  ("연1-3",-x**3+3*x,[(-1,-2),(1,2)]),
  ("연1-4",2*x**3-3*x**2-12*x+5,[(-1,12),(2,-15)])]:
    fpn,_=crit(fn)
    for a,v in pts:
        chk(f"{lab} f'({a})=0", fpn.subs(x,a), 0); chk(f"{lab} f({a})", fn.subs(x,a), v)

for side,xopt,vol in [(12,2,128),(18,3,432),(30,5,2000),(24,4,1024)]:
    V=sp.expand(x*(side-2*x)**2)
    chk(f"상자{side} 임계", sp.diff(V,x).subs(x,xopt), 0); chk(f"상자{side} 부피", V.subs(x,xopt), vol)

for L,xo,S in [(40,20,200),(24,12,72),(36,18,162)]:
    Sx=sp.expand(x*(L-x)/2)
    chk(f"울{L} 임계", sp.diff(Sx,x).subs(x,xo),0); chk(f"울{L} 넓이", Sx.subs(x,xo), S)
chk("둘레60 정사각", sp.diff(sp.expand(x*(30-x)),x).subs(x,15), 0)

for lab,p0,d,q0,k,xo,price,qty,rev in [
  ("매출 예제",10000,100,300,5,20,8000,400,3200000),
  ("통합 B3",5000,100,400,20,15,3500,700,2450000),
  ("연습2-3",20000,500,200,10,10,15000,300,4500000),
  ("과제 B3",8000,200,400,20,10,6000,600,3600000)]:
    R=sp.expand((p0-d*x)*(q0+k*x))
    chk(f"{lab} 임계", sp.diff(R,x).subs(x,xo), 0)
    chk(f"{lab} 가격", p0-d*xo, price); chk(f"{lab} 수량", q0+k*xo, qty); chk(f"{lab} 매출", R.subs(x,xo), rev)

for lab,fn,pts in [
  ("통A-1",x**3-6*x**2+9*x-2,[(1,2),(3,-2)]),
  ("통A-2",x**3+3*x**2-9*x+1,[(-3,28),(1,-4)]),
  ("통A-3",-2*x**3+3*x**2+12*x,[(-1,-7),(2,20)])]:
    fpn,_=crit(fn)
    for a,v in pts: chk(f"{lab} f'({a})=0",fpn.subs(x,a),0); chk(f"{lab} f({a})",fn.subs(x,a),v)
g=x**3-3*x**2+2; chk("통A-4 f(1)",g.subs(x,1),0); chk("통A-4 기울기",sp.diff(g,x).subs(x,1),-3)

for lab,fn,pts in [
  ("과A-1",x**3-3*x**2-9*x+5,[(-1,10),(3,-22)]),
  ("과A-2",2*x**3-6*x+1,[(-1,5),(1,-3)]),
  ("과A-3",-x**3+6*x**2-9*x+2,[(1,-2),(3,2)]),
  ("과A-4",x**4-4*x,[(1,-3)])]:
    fpn,_=crit(fn)
    for a,v in pts: chk(f"{lab} f'({a})=0",fpn.subs(x,a),0); chk(f"{lab} f({a})",fn.subs(x,a),v)
chk("과A-4 x²+x+1 판별식", sp.discriminant(x**2+x+1,x), -3)
h=x**3-2*x; chk("과A-5 f(2)",h.subs(x,2),4); chk("과A-5 기울기",sp.diff(h,x).subs(x,2),10)
a=sp.Symbol('a'); chk("과A-6 a", sp.solve(sp.Eq(sp.diff(x**3+a*x**2+3,x).subs(x,2),0),a)[0], -3)
chk("과A-6 극값",(x**3-3*x**2+3).subs(x,2),-1)
chk("x³ 반례: f'(0)", sp.diff(x**3,x).subs(x,0), 0)

print("검산 완료 — 불일치", len(bad))
for b in bad: print("  X",b)
