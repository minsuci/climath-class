import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

NAVY="#1B3A5C"; ACC="#C2410C"; GREY="#B6C2D2"

def f(x): return 0.12*x**3 - 0.9*x**2 + 1.2*x + 6
def fp(x): return 0.36*x**2 - 1.8*x + 1.2

fig, ax = plt.subplots(figsize=(6.6, 3.0), dpi=220)
x = np.linspace(-0.35, 6.35, 500)
ax.plot(x, f(x), color=NAVY, lw=2.6, zorder=3, solid_capstyle="round")

a = 4.4
ta = np.array([a-2.4, a+2.0])
ax.plot(ta, f(a)+fp(a)*(ta-a), color=ACC, lw=2.0, zorder=4, solid_capstyle="round")
ax.plot([a],[f(a)], "o", ms=8.5, color=ACC, mec="white", mew=1.8, zorder=5)
ax.annotate("P", (a, f(a)), textcoords="offset points", xytext=(4,11),
            fontsize=13, color=ACC, weight="bold")
ax.annotate("?", (a+2.05, f(a)+fp(a)*2.05+0.12), fontsize=16, color=ACC, weight="bold")

ax.set_xlim(-0.7, 7.0); ax.set_ylim(3.2, 8.9)
ax.set_xticks([]); ax.set_yticks([])
for s in ax.spines.values(): s.set_visible(False)
fig.tight_layout(pad=0.05)
fig.savefig("tangent.png", facecolor="white")
print("saved")
