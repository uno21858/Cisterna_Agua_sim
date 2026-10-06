"""Estudio de convergencia de malla: ¿el tiempo de mezcla deja de cambiar al afinar las celdas?

Con celdas de 10 cm la mezcla depende de la turbulencia que la malla no ve (c_nu). Afinando a
2-3 cm el LES resuelve más del chorro; si con c_nu = 0 el tiempo converge cerca de la fórmula,
el modelo ya no depende de la calibración. Pensado para GPU (CuPy); en CPU sirve para mallas
gruesas.

  python convergencia.py --bench --gpu --f32                  # ms por paso y cuánto tardaría cada malla
  CUDA_VISIBLE_DEVICES=0 python convergencia.py --gpu --f32 --dx 0.10 0.05 0.033
  CUDA_VISIBLE_DEVICES=1 python convergencia.py --gpu --f32 --dx 0.025
  python convergencia.py --reporte                            # tabla y gráfica con lo ya corrido

Cada caso se agrega a resultados_convergencia/casos.jsonl al terminar; al relanzar se salta lo
ya hecho, así dos procesos (uno por GPU) pueden escribir al mismo archivo.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

from cisterna_sim.bomba import tiempo_mezcla_s
from cisterna_sim.config import Config
from cisterna_sim.solver import Cisterna, correr

SALIDA = Path("resultados_convergencia")
MINUTOS_REPORTE = (15, 30, 45, 60)


def config_caso(dx, c_nu, elevacion, minutos):
    """Protocolo de la prueba 9c: bomba andando 5 min antes, dosis junto al mástil, bomba sin apagar."""
    return Config(dx=dx, c_nu=c_nu, elevacion=elevacion, lugar_dosis="mastil", precalentar_s=300.0,
                  minutos=minutos, bomba_min=minutos + 10, cuadro_s=1e9)


def clave(dx, c_nu, elevacion, f32, minutos):
    return f"dx{dx:.3f}_cnu{c_nu:.3f}_el{elevacion:+.0f}_{'f32' if f32 else 'f64'}_{minutos:.0f}min"


def desde(t, falla):
    """Minuto desde el cual el criterio se cumple hasta el final (None si nunca)."""
    falla = np.asarray(falla)
    if falla[-1]:
        return None
    idx = np.flatnonzero(falla)
    return 0.0 if idx.size == 0 else float(t[idx[-1] + 1])


def hechos():
    archivo = SALIDA / "casos.jsonl"
    if not archivo.exists():
        return {}
    casos = {}
    for linea in archivo.read_text().splitlines():
        if linea.strip():
            r = json.loads(linea)
            casos[r["clave"]] = r
    return casos


def corre_caso(dx, c_nu, elevacion, gpu, f32, minutos):
    cfg = config_caso(dx, c_nu, elevacion, minutos)
    cfg.validar()
    t0 = time.time()
    sim, serie, _ = correr(cfg, progreso=lambda m: print(m, flush=True), gpu=gpu, f32=f32)
    seg = time.time() - t0
    t = np.array(serie["t_min"])
    cov, lo, hi = (np.array(serie[k]) for k in ("cov", "c_min", "c_max"))
    vol = sim.nx * sim.ny * sim.nz * sim.vol_celda
    masa_esperada = cfg.dosis_ml * cfg.cloralex_mg_ml
    r = {
        "clave": clave(dx, c_nu, elevacion, f32, minutos),
        "dx": dx, "c_nu": c_nu, "elevacion": elevacion, "f32": f32, "gpu": gpu, "minutos": minutos,
        "malla": [sim.nx, sim.ny, sim.nz], "celdas": sim.nx * sim.ny * sim.nz,
        "t95": desde(t, cov > 0.05), "t10": desde(t, (hi > 1.10) | (lo < 0.90)),
        "t_formula": tiempo_mezcla_s(vol, sim.bomba.m_m4s2) / 60,
        "cov": {str(m): float(cov[np.argmin(np.abs(t - m))]) for m in MINUTOS_REPORTE if m <= t[-1] + 1e-9},
        "masa_rel": sim.masa_cloro_mg() / masa_esperada - 1,
        "pasos": sim.pasos, "seg": seg, "ms_por_paso": 1000 * seg / sim.pasos,
    }
    return r


def bench(dxs, gpu, f32, minutos, pasos=150):
    """Mide ms por paso con el flujo ya andando y estima cuánto tardaría cada malla."""
    print(f"{'dx':>6} {'malla':>14} {'celdas':>9} {'ms/paso':>8} {'dt s':>6} {'estimado':>10}")
    for dx in dxs:
        sim = Cisterna(config_caso(dx, 0.0, 0.0, minutos), gpu=gpu, f32=f32)
        sim.dosifica(7500.0, sim.cfg.punto_dosis())
        for _ in range(20):  # calienta: compila kernels y arranca el chorro
            sim.avanza(sim.dt_flujo())
        if gpu:
            sim.xp.cuda.Stream.null.synchronize()
        t0, s0 = time.time(), sim.t
        for _ in range(pasos):
            sim.avanza(sim.dt_flujo())
        if gpu:
            sim.xp.cuda.Stream.null.synchronize()
        ms = 1000 * (time.time() - t0) / pasos
        dt = (sim.t - s0) / pasos
        # el chorro todavía acelera: el dt real baja algo más, el estimado es optimista
        horas = (300 + minutos * 60) / dt * ms / 3.6e6
        est = f"{horas:.1f} h" if horas >= 1 else f"{horas * 60:.0f} min"
        print(f"{dx:>6.3f} {f'{sim.nx}x{sim.ny}x{sim.nz}':>14} {sim.nx * sim.ny * sim.nz:>9} {ms:>8.1f} "
              f"{dt:>6.3f} {est:>10}", flush=True)


def reporte():
    casos = sorted(hechos().values(), key=lambda r: (r["elevacion"], r["c_nu"], -r["dx"]))
    if not casos:
        sys.exit("Todavía no hay casos en resultados_convergencia/casos.jsonl")
    fmt = lambda x: f"{x:5.1f}" if x is not None else "  >" + f"{casos[0]['minutos']:.0f}"
    print(f"{'elev':>5} {'c_nu':>5} {'dx':>6} {'celdas':>9} {'t95':>6} {'t10':>6} {'fórmula':>8} "
          f"{'CoV 45':>7} {'masa':>9} {'ms/paso':>8} {'horas':>6}")
    for r in casos:
        print(f"{r['elevacion']:>5.0f} {r['c_nu']:>5.3f} {r['dx']:>6.3f} {r['celdas']:>9} {fmt(r['t95']):>6} "
              f"{fmt(r['t10']):>6} {r['t_formula']:>8.1f} {r['cov'].get('45', float('nan')):>7.3f} "
              f"{r['masa_rel']:>9.1e} {r['ms_por_paso']:>8.1f} {r['seg'] / 3600:>6.1f}")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return
    fig, ax = plt.subplots(figsize=(7, 4.5), layout="constrained")
    grupos = {}
    for r in casos:
        grupos.setdefault((r["elevacion"], r["c_nu"]), []).append(r)
    for (el, cnu), rs in grupos.items():
        rs = sorted(rs, key=lambda r: r["dx"])
        x = [100 * r["dx"] for r in rs]
        y = [r["t95"] if r["t95"] is not None else r["minutos"] for r in rs]
        ax.plot(x, y, "o-", lw=2, ms=7, label=f"c_nu {cnu:g}, chorro {el:+.0f}°")
    ax.axhline(casos[0]["t_formula"], color="#52514e", ls="--", lw=1)
    ax.text(ax.get_xlim()[1], casos[0]["t_formula"], " fórmula", va="bottom", ha="right", color="#52514e")
    ax.set_xlabel("tamaño de celda (cm)")
    ax.set_ylabel("t95: CoV < 5 % (min)")
    ax.invert_xaxis()
    ax.set_title("Convergencia de malla, protocolo de la prueba 9c", loc="left")
    ax.legend(frameon=False)
    fig.savefig(SALIDA / "convergencia.png", dpi=130)
    print(f"\nGráfica en {SALIDA / 'convergencia.png'}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dx", type=float, nargs="+", default=[0.10, 0.05, 0.033, 0.025])
    p.add_argument("--c-nu", type=float, nargs="+", default=[0.0, 0.02])
    p.add_argument("--elevacion", type=float, nargs="+", default=[0.0], help="grados del chorro (doc: -60)")
    p.add_argument("--minutos", type=float, default=60.0)
    p.add_argument("--gpu", action="store_true")
    p.add_argument("--f32", action="store_true")
    p.add_argument("--bench", action="store_true", help="solo medir velocidad y estimar tiempos")
    p.add_argument("--reporte", action="store_true", help="tabla y gráfica con lo ya corrido")
    a = p.parse_args()
    if any(d <= 0 for d in a.dx) or any(c < 0 for c in a.c_nu) or a.minutos <= 0:
        sys.exit("dx y minutos deben ser > 0 y c_nu >= 0")
    if a.gpu:
        try:
            import cupy
            cupy.cuda.runtime.getDeviceCount()
        except Exception as e:  # noqa: BLE001 - se reporta tal cual
            sys.exit(f"No pude usar la GPU con CuPy: {e}\nInstala con: pip install cupy-cuda13x")
    if a.reporte:
        reporte()
        return
    if a.bench:
        bench(a.dx, a.gpu, a.f32, a.minutos)
        return

    SALIDA.mkdir(exist_ok=True)
    pendientes = [(dx, c, el) for el in a.elevacion for c in a.c_nu for dx in a.dx
                  if clave(dx, c, el, a.f32, a.minutos) not in hechos()]
    print(f"{len(pendientes)} casos por correr", flush=True)
    for i, (dx, c, el) in enumerate(pendientes, 1):
        k = clave(dx, c, el, a.f32, a.minutos)
        if k in hechos():  # otro proceso ya lo corrió
            continue
        print(f"\n[{i}/{len(pendientes)}] {k}", flush=True)
        r = corre_caso(dx, c, el, a.gpu, a.f32, a.minutos)
        with open(SALIDA / "casos.jsonl", "a") as f:
            f.write(json.dumps(r) + "\n")
        print(f"  t95 {r['t95']} min, t10 {r['t10']} min, fórmula {r['t_formula']:.1f} min, "
              f"{r['ms_por_paso']:.1f} ms/paso, {r['seg'] / 60:.0f} min de cómputo", flush=True)
    reporte()


if __name__ == "__main__":
    main()
