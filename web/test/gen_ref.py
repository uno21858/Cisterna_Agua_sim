"""Casos de referencia del solver Python para validar el port a JavaScript (web/solver.js).

  python3 web/test/gen_ref.py      # escribe web/test/ref_py.json

Cada caso corre con dt fijo llamando avanza(dt) a mano, con la dosis al inicio en
cfg.punto_dosis(), y guarda los campos finales u, v, w, c (aplanados en orden C) y las
estadísticas. También guarda geometría, puntos de operación y configuraciones inválidas.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ))

from cisterna_sim.bomba import punto_operacion, tiempo_mezcla_s  # noqa: E402
from cisterna_sim.config import Config  # noqa: E402
from cisterna_sim.solver import OFF_C, Cisterna  # noqa: E402

DT = 0.5
PASOS = 120

CASOS = {
    "defaults": {"cfg": {"dx": 0.2}, "apaga_en": None},
    "chorro": {
        "cfg": {"dx": 0.2, "nivel": 1.0, "pos_bomba": [2.3, 0.7, 0.35], "azimut": 140.0, "elevacion": -25.0,
                "boquilla_mm": 6.0, "lugar_dosis": "mastil"},
        "apaga_en": PASOS // 2,
    },
}

# Los mismos de tests/test_solver.py::test_configuracion_invalida.
INVALIDOS = [
    {"nivel": 0.55},
    {"lugar_dosis": "tinaco"},
    {"dx": 0.7},
    {"angulo_tubo": 0},
    {"boca": [5.0, 1.0]},
    {"cfl": 0.9},
    {"c_nu": -0.01},
    {"dosis_ml": 0},
    {"elevacion": 120},
    {"pos_bomba": [1.0, 1.0, 1.15]},
]

GEOMETRIAS = [
    {},
    {"boca": [2.6, 1.9], "angulo_tubo": 45.0, "z_bomba": 0.6, "lugar_dosis": "mastil"},
    {"nivel": 1.0, "pos_bomba": [2.3, 0.7, 0.35], "azimut": 140.0, "elevacion": -25.0},
    {"azimut": 30.0, "elevacion": -88.0, "nivel": 0.9},
]

BOMBAS = [
    (800, 5, 8, 8, 1.0),
    (800, 5, 6, 8, 1.0),
    (700, 5, 12, 12, 1.0),
    (350, 0.8, 12, None, 1.0),
    (800, 5, 12, 8, 1.0),
    (800, 5, 3, 8, 0.5),
]


def _cfg(kw):
    return Config(**{k: tuple(v) if isinstance(v, list) else v for k, v in kw.items()})


def _plano(a):
    return a.ravel().tolist()


def _stats(sim, c_final):
    rel = sim.c / c_final
    uc, vc, wc = sim.velocidad_centros()
    return {
        "cov": float(np.std(rel)),
        "cmin": float(rel.min()),
        "cmax": float(rel.max()),
        "masa_mg": sim.masa_cloro_mg(),
        "ek": sim.energia_cinetica(),
        "vmax": float(np.sqrt(uc**2 + vc**2 + wc**2).max()),
    }


def corre_caso(kw, apaga_en):
    cfg = _cfg(kw)
    sim = Cisterna(cfg)
    masa = cfg.dosis_ml * cfg.cloralex_mg_ml
    sim.dosifica(masa, cfg.punto_dosis())
    c_final = masa / (sim.nx * sim.ny * sim.nz * sim.vol_celda * 1000.0)
    for paso in range(PASOS):
        sim.avanza(DT, bomba_encendida=apaga_en is None or paso < apaga_en)
    s, z, sec = sim.seccion_chorro("c")
    return {
        "cfg": kw,
        "dt": DT,
        "pasos": PASOS,
        "apaga_en": apaga_en,
        "masa_dosis_mg": masa,
        "malla": [sim.nx, sim.ny, sim.nz],
        "u": _plano(sim.u),
        "v": _plano(sim.v),
        "w": _plano(sim.w),
        "c": _plano(sim.c),
        "stats": _stats(sim, c_final),
        "c_final": c_final,
        "dt_flujo": float(sim.dt_flujo()),
        "dt_cloro": float(sim.dt_cloro()),
        "sondas": {n: sim.valor_sonda(p) for n, p in cfg.sondas().items()},
        "seccion": {"s": s.tolist(), "z": z.tolist(), "c": _plano(sec)},
        "f_total": [float(f.sum() * sim.vol_celda) for f in (sim.f_u, sim.f_v, sim.f_w)],
        "muestras_c": [[x, y, zz, float(sim.muestrea(sim.c, OFF_C, np.array([x]), np.array([y]),
                                                     np.array([zz]))[0])]
                       for x, y, zz in ((0.33, 1.71, 0.12), (3.39, 0.01, 1.19), (-1.0, 5.0, 0.5))],
    }


def geometria(kw):
    cfg = _cfg(kw)
    return {
        "cfg": kw,
        "rumbo": list(cfg.rumbo()),
        "punto_tubo_bomba": list(cfg.punto_tubo(cfg.z_bomba)),
        "pos_bomba": list(cfg.pos_bomba_xyz()),
        "dir_chorro": list(cfg.dir_chorro()),
        "plano_chorro": list(cfg.plano_chorro()),
        "punto_dosis": list(cfg.punto_dosis()),
        "sondas": {n: list(p) for n, p in cfg.sondas().items()},
    }


def main():
    for kw in INVALIDOS:
        try:
            _cfg(kw).validar()
        except ValueError:
            continue
        raise SystemExit(f"Python acepta una configuración que debería rechazar: {kw}")
    bombas = []
    for q, h, b, s, k in BOMBAS:
        op = punto_operacion(q, h, b, s, k)
        bombas.append({"args": [q, h, b, s, k], "q_m3s": op.q_m3s, "q_lh": op.q_lh, "u_ms": op.u_ms,
                       "m_m4s2": op.m_m4s2, "h_m": op.h_m, "t_mezcla_10m3_s": tiempo_mezcla_s(10.0, op.m_m4s2)})
    ref = {
        "casos": {nombre: corre_caso(c["cfg"], c["apaga_en"]) for nombre, c in CASOS.items()},
        "invalidos": INVALIDOS,
        "geometrias": [geometria(kw) for kw in GEOMETRIAS],
        "bombas": bombas,
    }
    ruta = Path(__file__).with_name("ref_py.json")
    ruta.write_text(json.dumps(ref))
    print(f"{ruta} ({ruta.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
