"""Cálculo rápido (sin simular): tiempo de mezcla por nivel y por boquilla.

  python formula.py
  python formula.py --caudal-lh 350      # si la bomba resulta ser la de 350 L/h
"""

from __future__ import annotations

import argparse
import sys

from cisterna_sim.bomba import punto_operacion, tiempo_mezcla_s
from cisterna_sim.config import Config


def main():
    d = Config()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--caudal-lh", type=float, default=d.q_max_lh)
    p.add_argument("--hmax", type=float, default=d.h_max_m)
    p.add_argument("--largo", type=float, default=d.largo)
    p.add_argument("--ancho", type=float, default=d.ancho)
    p.add_argument("--boquillas", type=float, nargs="+", default=[4, 5, 6, 8, 10, 12])
    p.add_argument("--niveles", type=float, nargs="+", default=[1.2, 0.9, 0.6])
    a = p.parse_args()
    if a.largo <= 0 or a.ancho <= 0 or any(n <= 0 for n in a.niveles):
        sys.exit("largo, ancho y niveles deben ser > 0")

    try:
        puntos = [(b, punto_operacion(a.caudal_lh, a.hmax, b)) for b in a.boquillas]
    except ValueError as e:
        sys.exit(str(e))

    print(f"Bomba: {a.caudal_lh:.0f} L/h máx, {a.hmax:.1f} m máx, curva lineal supuesta")
    print(f"Planta {a.largo:.2f} x {a.ancho:.2f} m\n")
    cab = "".join(f"  nivel {n:.2f} m" for n in a.niveles)
    print(f"{'boquilla':>9} {'Q L/h':>7} {'u m/s':>6} {'M m4/s2':>9}  {'tiempo de mezcla (min)':^{len(cab)}}")
    print(f"{'':>9} {'':>7} {'':>6} {'':>9}{cab}")
    for b, op in puntos:
        ts = "".join(f"{tiempo_mezcla_s(a.largo * a.ancho * n, op.m_m4s2) / 60:>14.0f}" for n in a.niveles)
        print(f"{b:>7.0f}mm {op.q_lh:>7.0f} {op.u_ms:>6.2f} {op.m_m4s2:>9.2e}{ts}")
    print("\nM = Q*u. Boquilla más chica: menos caudal pero más velocidad; M (y la mezcla) mejora"
          "\nhasta que la curva de la bomba se cae. La curva real se confirma con la prueba 9c.")


if __name__ == "__main__":
    main()
