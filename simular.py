"""Simula cómo mueve el agua la bomba de mezcla en la cisterna y cuánto tarda en repartir el cloro.

Ejemplos:
  python simular.py                          # cisterna llena, dosis por la boca B, bomba 45 min
  python simular.py --nivel 0.7              # cisterna a medias
  python simular.py --elevacion 0 --azimut 0 # chorro horizontal a lo largo
  python simular.py --dosis mastil --precalentar 600   # protocolo de la prueba 9c
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import numpy as np

from cisterna_sim.bomba import tiempo_mezcla_s
from cisterna_sim.config import LUGARES_DOSIS, Config
from cisterna_sim.graficas import animar, graficar_flujo, graficar_mezcla
from cisterna_sim.solver import correr

MINUTOS_9C = (15, 30, 45, 60)


def _args():
    d = Config()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--minutos", type=float, default=d.minutos, help="tiempo simulado después de la dosis")
    p.add_argument("--bomba-min", type=float, default=d.bomba_min, help="minutos que corre la bomba tras la dosis")
    p.add_argument("--dx", type=float, default=d.dx, help="tamaño de celda en m (0.07 tarda ~3x más)")
    p.add_argument("--largo", type=float, default=d.largo)
    p.add_argument("--ancho", type=float, default=d.ancho)
    p.add_argument("--nivel", type=float, default=d.nivel, help="nivel del agua en m")
    p.add_argument("--caudal-lh", type=float, default=d.q_max_lh, help="caudal máximo de la bomba (ficha)")
    p.add_argument("--hmax", type=float, default=d.h_max_m, help="columna máxima de la bomba en m (ficha)")
    p.add_argument("--salida-mm", type=float, default=d.salida_mm, help="salida de fábrica de la bomba")
    p.add_argument("--boquilla-mm", type=float, default=d.boquilla_mm, help="por donde sale el chorro")
    p.add_argument("--angulo", type=float, default=d.angulo_tubo, help="inclinación del mástil sobre la horizontal")
    p.add_argument("--pos-bomba", type=float, nargs=3, metavar=("X", "Y", "Z"), help="bomba fuera del mástil (m)")
    p.add_argument("--azimut", type=float, help="dirección del chorro en planta, grados desde +x hacia +y")
    p.add_argument("--elevacion", type=float, help="grados sobre la horizontal (negativo = hacia abajo)")
    p.add_argument("--dosis", choices=LUGARES_DOSIS, default=d.lugar_dosis)
    p.add_argument("--dosis-ml", type=float, default=d.dosis_ml, help="mL de Cloralex")
    p.add_argument("--precalentar", type=float, default=d.precalentar_s, help="s de bomba andando antes de la dosis")
    p.add_argument("--c-nu", type=float, default=d.c_nu, help="viscosidad turbulenta de fondo / sqrt(M)")
    p.add_argument("--salida", type=Path, default=Path("resultados"))
    p.add_argument("--sin-gif", action="store_true", help="no generar la animación")
    a = p.parse_args()
    return a, Config(minutos=a.minutos, bomba_min=a.bomba_min, dx=a.dx, largo=a.largo, ancho=a.ancho,
                     nivel=a.nivel, q_max_lh=a.caudal_lh, h_max_m=a.hmax, salida_mm=a.salida_mm,
                     boquilla_mm=a.boquilla_mm, angulo_tubo=a.angulo,
                     pos_bomba=tuple(a.pos_bomba) if a.pos_bomba else None, azimut=a.azimut, elevacion=a.elevacion, lugar_dosis=a.dosis, dosis_ml=a.dosis_ml, precalentar_s=a.precalentar,
                     c_nu=a.c_nu)


def _desde(t, falla):
    """Minuto desde el cual el criterio se cumple hasta el final (None si nunca)."""
    falla = np.asarray(falla)
    if falla[-1]:
        return None
    idx = np.flatnonzero(falla)
    return 0.0 if idx.size == 0 else float(t[idx[-1] + 1])


def resumir(cfg, sim, serie):
    t = np.array(serie["t_min"])
    lo, hi, cov = (np.array(serie[k]) for k in ("c_min", "c_max", "cov"))
    nombres = list(cfg.sondas())
    sup, casa = (np.array(serie[n]) / sim.c_final for n in nombres[:2])
    vol = sim.nx * sim.ny * sim.nz * sim.vol_celda
    r = {
        "volumen_m3": vol,
        "malla": [sim.nx, sim.ny, sim.nz],
        "celda_m": [sim.dx, sim.dy, sim.dz],
        "q_lh": sim.bomba.q_lh,
        "u_boquilla_ms": sim.bomba.u_ms,
        "m_m4s2": sim.bomba.m_m4s2,
        "c_final_mg_l": sim.c_final,
        "t_formula_min": tiempo_mezcla_s(vol, sim.bomba.m_m4s2) / 60,
        "bomba_min": cfg.bomba_min,
        "sondas": nombres,
        "t_cov_5pct_min": _desde(t, cov > 0.05),
        "t_todo_10pct_min": _desde(t, (hi > 1.10) | (lo < 0.90)),
        "t_todo_5pct_min": _desde(t, (hi > 1.05) | (lo < 0.95)),
        "t_arriba_abajo_10pct_min": _desde(t, (np.abs(sup - 1) > 0.10) | (np.abs(casa - 1) > 0.10)),
        "tiras_9c_mg_l": {},
        "pasos": sim.pasos,
    }
    for m in MINUTOS_9C:
        if m <= t[-1] + 1e-9:
            i = int(np.argmin(np.abs(t - m)))
            r["tiras_9c_mg_l"][str(m)] = {n: round(serie[n][i], 3) for n in nombres}
    return r


def _fmt_t(x, fin):
    return f"{x:5.1f} min" if x is not None else f" > {fin:.0f} min (no llega)"


def imprimir(cfg, r):
    print()
    print(f"Cisterna {cfg.largo:.2f} x {cfg.ancho:.2f} x {cfg.nivel:.2f} m = {r['volumen_m3']:.2f} m3"
          f"   malla {r['malla'][0]}x{r['malla'][1]}x{r['malla'][2]}")
    print(f"Bomba: {r['q_lh']:.0f} L/h por boquilla de {cfg.boquilla_mm:.0f} mm, u = {r['u_boquilla_ms']:.2f} m/s,"
          f" M = {r['m_m4s2']:.2e} m4/s2")
    print(f"Dosis: {cfg.dosis_ml:.0f} mL de Cloralex en '{cfg.lugar_dosis}' -> {r['c_final_mg_l']:.2f} mg/L "
          "si se mezcla perfecto (sin demanda de cloro)")
    print()
    print(f"  Fórmula 10.2 V^(2/3)/sqrt(M) ........... {r['t_formula_min']:5.1f} min")
    print(f"  Simulación, CoV < 5 % .................. {_fmt_t(r['t_cov_5pct_min'], cfg.minutos)}")
    print(f"  Simulación, toda la cisterna +-10 % ...... {_fmt_t(r['t_todo_10pct_min'], cfg.minutos)}")
    print(f"  Simulación, toda la cisterna +-5 % ....... {_fmt_t(r['t_todo_5pct_min'], cfg.minutos)}")
    print(f"  Superficie y llave de la casa +-10 % ..... {_fmt_t(r['t_arriba_abajo_10pct_min'], cfg.minutos)}")
    print()
    print("  Lo que marcarían las tiras (mg/L), prueba 9c:")
    print("    min  " + "  ".join(f"{n:>24}" for n in r["sondas"]))
    for m, vals in r["tiras_9c_mg_l"].items():
        print(f"    {m:>3}  " + "  ".join(f"{vals[n]:>24.2f}" for n in r["sondas"]))
    print()


def guardar_serie(serie, ruta):
    claves = list(serie)
    with open(ruta, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(claves)
        for fila in zip(*(serie[k] for k in claves)):
            w.writerow(f"{v:.6g}" for v in fila)


def main():
    args, cfg = _args()
    try:
        cfg.validar()
    except ValueError as e:
        sys.exit(f"Configuración inválida: {e}")
    args.salida.mkdir(parents=True, exist_ok=True)

    print(f"Simulando {cfg.minutos:.0f} min (más {cfg.precalentar_s:.0f} s de precalentado)...")
    t0 = time.time()
    sim, serie, cuadros = correr(cfg)
    print(f"Listo en {time.time() - t0:.0f} s, {sim.pasos} pasos.")

    r = resumir(cfg, sim, serie)
    imprimir(cfg, r)
    (args.salida / "resumen.json").write_text(json.dumps(r, indent=2, ensure_ascii=False))
    guardar_serie(serie, args.salida / "serie.csv")
    graficar_mezcla(serie, r, args.salida / "mezcla.png")
    graficar_flujo(sim.flujo_promedio, args.salida / "flujo.png")
    if not args.sin_gif:
        animar(sim, cuadros, args.salida / "cloro.gif")
    print(f"Resultados en {args.salida}/: mezcla.png, flujo.png, serie.csv, resumen.json"
          + ("" if args.sin_gif else ", cloro.gif"))


if __name__ == "__main__":
    main()
