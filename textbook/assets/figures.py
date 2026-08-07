import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
fm._load_fontmanager(try_read_cache=False)
matplotlib.rcParams["font.family"]="NanumGothic"
matplotlib.rcParams["axes.unicode_minus"]=False
import numpy as np

NAVY="#1B3A5C"; ACC="#C2410C"; GREY="#94A3B8"; MUTE="#B6C2D2"
f  = lambda x: x**3 - 6*x**2 + 9*x + 3
fp = lambda x: 3*x**2 - 12*x + 9

def frame(ax, xlim, ylim):
    ax.set_xlim(*xlim); ax.set_ylim(*ylim)
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values(): s.set_visible(False)

# ── ① 1회차 훅: 정체를 숨긴 곡선 + 접선 ─────────────────
fig, ax = plt.subplots(figsize=(6.6, 3.0), dpi=220)
xs = np.linspace(0.05, 4.55, 500)
ax.plot(xs, f(xs), color=NAVY, lw=2.6, solid_capstyle="round", zorder=3)
a = 4.0
t = np.array([a-1.5, a+0.55])
ax.plot(t, f(a)+fp(a)*(t-a), color=ACC, lw=2.0, solid_capstyle="round", zorder=4)
ax.plot([a],[f(a)], "o", ms=8.5, color=ACC, mec="white", mew=1.8, zorder=5)
ax.annotate("P", (a, f(a)), textcoords="offset points", xytext=(-16,4),
            fontsize=13, color=ACC, weight="bold")
ax.annotate("?", (a+0.62, f(a)+fp(a)*0.62), textcoords="offset points", xytext=(2,-4),
            fontsize=16, color=ACC, weight="bold")
frame(ax, (-0.35, 5.0), (1.2, 13.5))
fig.tight_layout(pad=0.05); fig.savefig("tangent.png", facecolor="white")

# ── ② 12회차 회수: 같은 곡선, 전부 밝힌 판 ───────────────
fig, ax = plt.subplots(figsize=(6.6, 3.6), dpi=220)
xs = np.linspace(-0.35, 4.75, 600)
ax.plot(xs, f(xs), color=NAVY, lw=2.6, solid_capstyle="round", zorder=3)

t = np.array([a-0.98, a+0.5])
ax.plot(t, f(a)+fp(a)*(t-a), color=ACC, lw=2.0, ls=(0,(6,3)), zorder=4)
for px, py, lab, dx, dy, col in [
    (1, f(1), "극대  (1, 7)", -6, 12, NAVY),
    (3, f(3), "극소  (3, 3)", -34, -26, NAVY),
    (4, f(4), "P (4, 7)\n기울기 9", 13, 2, ACC)]:
    ax.plot([px],[py], "o", ms=8, color=col, mec="white", mew=1.8, zorder=5)
    ax.annotate(lab, (px,py), textcoords="offset points", xytext=(dx,dy),
                fontsize=11, color=col, weight="bold", linespacing=1.5)

# 증가·감소 구간 표시
ybase = -1.0
for x0, x1, lab, col in [(0.05,1,"증가","#15803D"), (1,3,"감소","#B91C1C"), (3,4.7,"증가","#15803D")]:
    ax.annotate("", xy=(x1,ybase), xytext=(x0,ybase),
                arrowprops=dict(arrowstyle="->", color=col, lw=2.4, mutation_scale=16))
    ax.text((x0+x1)/2, ybase-1.15, lab, ha="center", fontsize=11, color=col, weight="bold")
for xv in (1,3):
    ax.plot([xv,xv],[ybase, f(xv)], color=MUTE, lw=1.0, ls=":", zorder=1)
    ax.text(xv, ybase+0.85, f"x = {xv}", ha="center", fontsize=10, color=GREY,
            bbox=dict(fc="white", ec="none", pad=1.5))

frame(ax, (-0.6, 5.9), (-2.6, 14.2))
fig.tight_layout(pad=0.05); fig.savefig("shape.png", facecolor="white")

# ── ③ 상자 만들기 전개도 ───────────────────────────────
fig, ax = plt.subplots(figsize=(6.4, 3.0), dpi=220)
S, c = 12, 2.4
ax.add_patch(plt.Rectangle((0,0), S, S, fill=False, ec=NAVY, lw=2.2))
for cx, cy in [(0,0),(S-c,0),(0,S-c),(S-c,S-c)]:
    ax.add_patch(plt.Rectangle((cx,cy), c, c, fc="#FCE7DC", ec=ACC, lw=1.8, hatch="///"))
ax.add_patch(plt.Rectangle((c,c), S-2*c, S-2*c, fc="#EAF0F6", ec=NAVY, lw=1.4, ls="--", alpha=.85))
ax.annotate("", xy=(c,-0.9), xytext=(0,-0.9), arrowprops=dict(arrowstyle="<->", color=ACC, lw=1.5))
ax.text(c/2, -2.0, "x", ha="center", fontsize=13, color=ACC, style="italic", weight="bold")
ax.annotate("", xy=(S-c,-0.9), xytext=(c,-0.9), arrowprops=dict(arrowstyle="<->", color=NAVY, lw=1.5))
ax.text(S/2, -2.2, "12 − 2x", ha="center", fontsize=12, color=NAVY, weight="bold", fontname="DejaVu Sans")
ax.annotate("", xy=(-0.9,S), xytext=(-0.9,0), arrowprops=dict(arrowstyle="<->", color=NAVY, lw=1.5))
ax.text(-1.6, S/2, "12", va="center", ha="right", fontsize=12, color=NAVY, weight="bold")
ax.set_aspect("equal"); frame(ax, (-3.4, S+1.0), (-3.0, S+0.8))
fig.tight_layout(pad=0.05); fig.savefig("box.png", facecolor="white")
print("saved: tangent.png, shape.png, box.png")
