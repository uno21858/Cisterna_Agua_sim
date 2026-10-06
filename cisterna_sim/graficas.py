"""Gráficas: curvas de mezcla, campo de velocidades y animación del cloro."""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FuncAnimation, PillowWriter
from matplotlib.colors import LinearSegmentedColormap

# Paleta categórica validada (slots 1 a 3) y rampa secuencial azul.
SERIES = ("#2a78d6", "#eb6834", "#1baf7a")
TINTA = "#0b0b0b"
TINTA_2 = "#52514e"
TENUE = "#c3c2b7"
FONDO = "#fcfcfb"
BANDA = "#e4e3df"
AZUL = LinearSegmentedColormap.from_list(
    "azul", ["#f4f8fd", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"])

plt.rcParams.update({
    "figure.facecolor": FONDO, "axes.facecolor": FONDO, "savefig.facecolor": FONDO,
    "axes.edgecolor": TENUE, "axes.labelcolor": TINTA_2, "text.color": TINTA,
    "xtick.color": TINTA_2, "ytick.color": TINTA_2, "axes.grid": True, "grid.color": "#ecebe7",
    "grid.linewidth": 0.8, "axes.spines.top": False, "axes.spines.right": False, "font.size": 10,
})


def graficar_mezcla(serie, resumen, ruta):
    t = np.array(serie["t_min"])
    c_final = resumen["c_final_mg_l"]
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 7.5), sharex=True, gridspec_kw={"height_ratios": [3, 2]},
                                   layout="constrained")

    ax1.fill_between(t, serie["c_min"], serie["c_max"], color=BANDA, lw=0, label="rango en toda la cisterna")
    for color, nombre in zip(SERIES, resumen["sondas"]):
        ax1.plot(t, np.array(serie[nombre]) / c_final, color=color, lw=2, label=nombre)
    ax1.axhspan(0.95, 1.05, color="#1baf7a", alpha=0.08, lw=0)
    ax1.axhline(1.0, color=TINTA_2, lw=0.8)
    ax1.set_ylim(0, 2.5)
    ax1.set_ylabel(f"cloro / mezcla perfecta\n(1.0 = {c_final:.2f} mg/L)")
    fig.suptitle("Mezcla después de la dosis: lo que verían las tiras de la prueba 9c", x=0.01, ha="left", fontsize=12)
    ax1.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=4, frameon=False, fontsize=9)

    ax2.semilogy(t, np.maximum(serie["cov"], 1e-4), color=SERIES[0], lw=2)
    ax2.axhline(0.05, color=TINTA_2, lw=0.8, ls="--")
    ax2.text(t[-1], 0.055, "CoV 5 %", ha="right", va="bottom", color=TINTA_2)
    ax2.set_ylabel("coeficiente de variación\n(toda la cisterna)")
    ax2.set_xlabel("minutos desde la dosis")

    marcas = [(resumen["t_formula_min"], f"fórmula: {resumen['t_formula_min']:.0f} min "),
              (resumen["bomba_min"], f" bomba se apaga: {resumen['bomba_min']:.0f} min")]
    marcas = [m for m in marcas if m[0] < t[-1]]
    for ax in (ax1, ax2):
        for x, _ in marcas:
            ax.axvline(x, color=TINTA_2, lw=1, ls=":")
        for m in (15, 30, 45, 60):
            if m <= t[-1]:
                ax.axvline(m, color="#d9d8d3", lw=0.8, zorder=0)
    # una etiqueta a cada lado para que no se encimen cuando caen juntas
    for (x, txt), lado in zip(sorted(marcas), ("right", "left")):
        ax1.text(x, 2.45, txt, color=TINTA_2, va="top", ha=lado, fontsize=9,
                 bbox=dict(boxstyle="square,pad=0.15", fc=FONDO, ec="none"))
    ax2.set_xlim(0, t[-1])
    fig.savefig(ruta, dpi=130)
    plt.close(fig)


def _marca(ax, x, y, texto, color=TINTA):
    ax.plot(x, y, "o", ms=8, mfc=color, mec=FONDO, mew=2, zorder=5)
    ax.annotate(texto, (x, y), xytext=(6, 6), textcoords="offset points", fontsize=8, color=TINTA)


def graficar_flujo(sim, ruta):
    """Velocidad promedio de los últimos minutos con la bomba andando: corte y planta."""
    cfg = sim.cfg
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 4.6), gridspec_kw={"width_ratios": [1.45, 1]},
                                   layout="constrained")

    s, z, ua, wa = sim.seccion_chorro("vel")
    vel = np.hypot(ua, wa)
    vmax = max(np.percentile(vel, 99), 1e-4)
    im = ax1.pcolormesh(s, z, vel * 100, cmap=AZUL, vmin=0, vmax=vmax * 100, shading="auto")
    ax1.streamplot(s, z, ua, wa, color=TINTA_2, density=1.4, linewidth=0.7, arrowsize=0.8)
    arriba, punta = cfg.punto_tubo(cfg.nivel), cfg.punto_tubo(cfg.z_orp)
    ax1.plot([sim.s_de(arriba), sim.s_de(punta)], [arriba[2], punta[2]], color=TINTA, lw=3, label="mástil")
    _marca(ax1, 0, cfg.z_bomba, "bomba de mezcla", SERIES[1])
    _marca(ax1, sim.s_de(punta), cfg.z_orp, "sonda ORP", SERIES[2])
    ax1.set_xlim(s[0], s[-1])
    ax1.set_ylim(0, cfg.nivel)
    ax1.set_aspect("equal")
    ax1.set_xlabel("m a lo largo del chorro (en planta)")
    ax1.set_ylabel("altura sobre el fondo (m)")
    ax1.set_title("Corte vertical por el plano del chorro", loc="left")
    fig.colorbar(im, ax=ax1, label="velocidad (cm/s)", shrink=0.9, pad=0.01)

    uc, vc, wc = sim.velocidad_centros()
    k = sim.indice_z(cfg.pozo[2])
    x = (np.arange(sim.nx) + 0.5) * sim.dx
    y = (np.arange(sim.ny) + 0.5) * sim.dy
    U, V = uc[:, :, k].T, vc[:, :, k].T
    spd = np.hypot(U, V)
    im2 = ax2.pcolormesh(x, y, spd * 100, cmap=AZUL, vmin=0, vmax=max(np.percentile(spd, 99), 1e-4) * 100,
                         shading="auto")
    ax2.streamplot(x, y, U, V, color=TINTA_2, density=1.2, linewidth=0.7, arrowsize=0.8)
    bx, by, _ = cfg.punto_tubo(cfg.z_bomba)
    d = cfg.dir_chorro()
    ax2.annotate("", (bx + 0.5 * d[0] / np.hypot(d[0], d[1]), by + 0.5 * d[1] / np.hypot(d[0], d[1])), (bx, by),
                 arrowprops=dict(arrowstyle="-|>", color=SERIES[1], lw=2))
    _marca(ax2, bx, by, "bomba de mezcla", SERIES[1])
    _marca(ax2, cfg.pozo[0], cfg.pozo[1], "bomba de pozo", TINTA_2)
    _marca(ax2, cfg.punto_dosis()[0], cfg.punto_dosis()[1], "dosis", SERIES[0])
    ax2.set_xlim(0, cfg.largo)
    ax2.set_ylim(0, cfg.ancho)
    ax2.set_aspect("equal")
    ax2.set_xlabel("largo (m)")
    ax2.set_ylabel("ancho (m)")
    ax2.set_title(f"Planta a {(k + 0.5) * sim.dz:.2f} m (altura de la rejilla del pozo)", loc="left")
    fig.colorbar(im2, ax=ax2, label="velocidad horizontal (cm/s)", shrink=0.9, pad=0.01)
    fig.suptitle("Flujo promedio con la bomba andando", x=0.01, ha="left", fontsize=12)
    fig.savefig(ruta, dpi=130)
    plt.close(fig)


def animar(sim, cuadros, ruta, fps=6):
    cfg = sim.cfg
    s, z, _ = sim.seccion_chorro("c")
    x = (np.arange(sim.nx) + 0.5) * sim.dx
    y = (np.arange(sim.ny) + 0.5) * sim.dy
    vmax = 2.0 * sim.c_final
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.2), gridspec_kw={"width_ratios": [1.45, 1]},
                                   layout="constrained")
    im1 = ax1.pcolormesh(s, z, cuadros[0]["seccion"], cmap=AZUL, vmin=0, vmax=vmax, shading="auto")
    im2 = ax2.pcolormesh(x, y, cuadros[0]["planta"].T, cmap=AZUL, vmin=0, vmax=vmax, shading="auto")
    for ax in (ax1, ax2):
        ax.set_aspect("equal")
        ax.grid(False)
    ax1.set_xlabel("m a lo largo del chorro")
    ax1.set_ylabel("altura (m)")
    ax1.set_title("Corte por el chorro", loc="left")
    ax2.set_xlabel("largo (m)")
    ax2.set_ylabel("ancho (m)")
    ax2.set_title("Planta, promedio de toda la columna de agua", loc="left")
    _marca(ax1, 0, cfg.z_bomba, "bomba", SERIES[1])
    bx, by, _ = cfg.punto_tubo(cfg.z_bomba)
    _marca(ax2, bx, by, "bomba", SERIES[1])
    _marca(ax2, cfg.pozo[0], cfg.pozo[1], "pozo", TINTA_2)
    fig.colorbar(im2, ax=[ax1, ax2], label=f"cloro (mg/L); mezcla perfecta = {sim.c_final:.2f}", shrink=0.9,
                 pad=0.01)
    titulo = fig.suptitle(" ", x=0.01, ha="left", fontsize=12)

    def dibuja(i):
        q = cuadros[i]
        im1.set_array(q["seccion"].ravel())
        im2.set_array(q["planta"].T.ravel())
        titulo.set_text(f"t = {q['t_min']:4.0f} min   CoV = {q['cov']:.2f}")
        return im1, im2, titulo

    anim = FuncAnimation(fig, dibuja, frames=len(cuadros), blit=False)
    anim.save(ruta, writer=PillowWriter(fps=fps), dpi=85)
    plt.close(fig)
