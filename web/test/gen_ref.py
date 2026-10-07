"""Casos de referencia del solver Python para validar el port a JavaScript (web/solver.js).

  python3 web/test/gen_ref.py      # escribe web/test/ref_py.json

Cada caso corre con dt fijo llamando avanza(dt) a mano, con la dosis al inicio en
cfg.punto_dosis(), y guarda los campos finales u, v, w, c (aplanados en orden C) y las
estadísticas. También guarda geometría, puntos de operación y configuraciones inválidas.
Todos los casos fijan su geometría (RECT o RED), así no cambian si cambian los defaults.
"""

from __future__ import annotations

import dataclasses
import json
import math
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
PASOS_RED = 80
TOL_ESTRICTA = 1e-12  # presión de la redonda en la paridad (sim.tol_cg / sim.tolPresion)

# Geometría rectangular de antes de la cisterna redonda: mástil diagonal a 60 grados y chorro por el tubo.
RECT = {"forma": "rectangular", "largo": 3.40, "ancho": 2.45, "nivel": 1.20, "boca": [1.20, 1.00],
        "angulo_tubo": 60.0, "z_bomba": 0.50, "z_orp": 0.20, "azimut": None, "elevacion": None,
        "pozo": [0.90, 1.00, 0.45], "llenado": [0.25, 1.20, 1.10]}
# La cisterna de Erick: boca al centro, tubo vertical, pozo a 30 cm y llenado junto al pozo.
D = 3.26
RED = {"forma": "redonda", "diametro": D, "nivel": 1.20, "boca": [1.63, 1.63], "angulo_tubo": 90.0,
       "z_bomba": 0.50, "z_orp": 0.20, "azimut": 0.0, "elevacion": 0.0,
       "pozo": [1.33, 1.63, 0.45], "llenado": [1.33, 1.88, 1.10]}

MUESTRAS_RECT = ((0.33, 1.71, 0.12), (3.39, 0.01, 1.19), (-1.0, 5.0, 0.5))
# centro, junto a la pared (adentro y a menos de una celda), esquina de la caja (seca) y fuera de la caja
MUESTRAS_RED = ((1.63, 1.63, 0.6), (D / 2 + 1.55 * math.cos(0.5), D / 2 + 1.55 * math.sin(0.5), 0.3),
                (3.2, 1.63, 1.15), (1.70, 0.04, 0.5), (0.05, 0.05, 0.5), (-1.0, 5.0, 0.5))

CASOS = {
    "rectangular": {"cfg": {**RECT, "dx": 0.2}, "apaga_en": None},
    "chorro": {
        "cfg": {**RECT, "dx": 0.2, "nivel": 1.0, "pos_bomba": [2.3, 0.7, 0.35], "azimut": 140.0, "elevacion": -25.0,
                "boquilla_mm": 6.0, "lugar_dosis": "mastil"},
        "apaga_en": PASOS // 2,
    },
    # bomba amarrada al tubo vertical, 6 cm del eje, chorro horizontal casi hacia +x (lejos del pozo)
    "redonda": {
        "cfg": {**RED, "dx": 0.2, "pos_bomba": [1.69, 1.64, 0.50], "azimut": 10.0, "elevacion": 0.0,
                "lugar_dosis": "llenado"},
        "apaga_en": 60, "pasos": PASOS_RED, "tol_presion": TOL_ESTRICTA, "muestras": MUESTRAS_RED,
    },
}

# Los mismos de tests/test_solver.py::test_configuracion_invalida (planta rectangular) y de
# tests/test_redonda.py::test_validar_rechaza_puntos_fuera_del_circulo (redonda, dx 0.2).
_INV_RECT = [
    {"nivel": 0.55},
    {"lugar_dosis": "tinaco"},
    {"dx": 0.7},
    {"angulo_tubo": 0},
    {"boca": [5.0, 1.0]},
    {"boca": [3.45, 1.0]},
    {"cfl": 0.9},
    {"c_nu": -0.01},
    {"sc_t": 0},
    {"dosis_ml": 0},
    {"elevacion": 120},
    {"pos_bomba": [1.0, 1.0, 1.15]},
]
_INV_RED = [
    {"pozo": [0.25, 0.25, 0.45]},  # dentro de la caja, fuera del círculo
    {"pozo": [D - 0.4 * 0.2, D / 2, 0.45]},  # a menos de medio dx de la pared
    {"pos_bomba": [0.3, 0.3, 0.5]},
    {"llenado": [0.2, 0.4, 1.10]},  # la dosis cae en el llenado
    {"boca": [3.0, 3.0]},
    {"boca": [0.03, D / 2]},
    {"boca": [1.0, D / 2], "angulo_tubo": 20.0, "pos_bomba": [1.6, 1.6, 0.5]},  # la punta (sonda ORP) sale
    {"pozo": [1.5, 1.5, 1.25]},
    {"nivel": 0.55},
    {"dx": 0.45},  # 7.2 celdas a lo ancho del diámetro
    {"diametro": 1.5},
    {"diametro": -1.0},
    {"forma": "cuadrada"},
]
# Justo en la frontera R - dx/2 (al último bit): con hypot, Python y JS daban veredictos distintos.
_D2 = {"diametro": 2.0, "dx": 0.1, "boca": [1.0, 1.0], "pozo": [0.8, 1.0, 0.45], "llenado": [0.8, 1.15, 1.1]}
_BORDE_FUERA = [
    {**_D2, "llenado": [1.384770208172431, 0.1314081010607201, 0.45]},
    {"dx": 0.1, "pos_bomba": [1.9411474085938847, 0.08093986878323212, 0.45]},
    {"dx": 0.1, "pozo": [2.981802000829309, 0.8120566336512801, 0.45]},
]
_BORDE_DENTRO = [
    {**_D2, "pos_bomba": [1.4817082620726778, 0.18118552146965528, 0.45]},
    {"dx": 0.1, "llenado": [0.30112948308136533, 0.7753052303515596, 0.45]},
    {"dx": 0.1, "pozo": [2.1303357326282266, 3.1286874773131905, 0.45]},
]
INVALIDOS = ([{**RECT, **kw} for kw in _INV_RECT] + [{**RED, "dx": 0.2, **kw} for kw in _INV_RED]
             + [{**RED, **kw} for kw in _BORDE_FUERA])

# Válidos en los dos (junto a los límites de los de arriba).
VALIDOS = [
    {**RECT, "z_bomba": 1.10},
    {**RECT, "dx": 0.2, "nivel": 0.65, "z_bomba": 0.40, "pozo": [0.9, 1.0, 0.30]},
    {**RED, "dx": 0.2, "pozo": [D - 0.6 * 0.2, D / 2, 0.45]},
    {**RED, "dx": 0.4},  # 8.15 celdas
    {**RED, "dx": 0.2, "diametro": 1.6, "boca": [0.8, 0.8], "pozo": [0.6, 0.8, 0.45], "llenado": [1.0, 0.8, 1.1]},
    {**RED, "dx": 0.2, "lugar_dosis": "mastil", "llenado": [0.2, 0.2, 1.1]},  # el llenado no es la dosis
    {**RED, "dx": 0.1, "boca": [0.06, D / 2], "pos_bomba": [1.6, 1.6, 0.5]},
] + [{**RED, **kw} for kw in _BORDE_DENTRO]

GEOMETRIAS = [
    RECT,
    {**RECT, "boca": [2.6, 1.9], "angulo_tubo": 45.0, "z_bomba": 0.6, "lugar_dosis": "mastil"},
    {**RECT, "nivel": 1.0, "pos_bomba": [2.3, 0.7, 0.35], "azimut": 140.0, "elevacion": -25.0},
    {**RECT, "azimut": 30.0, "elevacion": -88.0, "nivel": 0.9},
    RED,
    # mástil inclinado con el chorro por el tubo: hacia el centro (el lado opuesto)
    {**RED, "boca": [1.20, 1.00], "angulo_tubo": 60.0, "azimut": None, "elevacion": None},
    {**RED, "boca": [2.4, 2.0], "angulo_tubo": 45.0, "z_bomba": 0.6, "lugar_dosis": "mastil", "azimut": None,
     "elevacion": None},
    {**RED, "boca": [D / 2 + 0.0005, D / 2], "angulo_tubo": 70.0, "azimut": None, "elevacion": None},  # a < 1 mm del centro
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
    rel = sim.en_agua(sim.c) / c_final
    uc, vc, wc = sim.velocidad_centros()
    return {
        "cov": float(np.std(rel)),
        "cmin": float(rel.min()),
        "cmax": float(rel.max()),
        "masa_mg": sim.masa_cloro_mg(),
        "ek": sim.energia_cinetica(),
        "vmax": float(np.sqrt(sim.en_agua(uc**2 + vc**2 + wc**2)).max()),
    }


def corre_caso(caso):
    kw, apaga_en = caso["cfg"], caso["apaga_en"]
    pasos, tol = caso.get("pasos", PASOS), caso.get("tol_presion")
    cfg = _cfg(kw)
    sim = Cisterna(cfg)
    if tol is not None:
        sim.tol_cg = tol
    masa = cfg.dosis_ml * cfg.cloralex_mg_ml
    sim.dosifica(masa, cfg.punto_dosis())
    c_final = masa / (sim.volumen_m3 * 1000.0)
    iteraciones = []
    for paso in range(pasos):
        sim.avanza(DT, bomba_encendida=apaga_en is None or paso < apaga_en)
        if sim.redonda:
            iteraciones.append(sim.iter_cg)
    s, z, sec = sim.seccion_chorro("c")
    ref = {
        "cfg": kw,
        "dt": DT,
        "pasos": pasos,
        "apaga_en": apaga_en,
        "tol_presion": tol,
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
                       for x, y, zz in caso.get("muestras", MUESTRAS_RECT)],
    }
    if sim.redonda:
        ref["n_agua"] = sim.n_agua
        ref["iteraciones_presion"] = iteraciones
    return ref


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
    for kw in VALIDOS + GEOMETRIAS + [c["cfg"] for c in CASOS.values()]:
        _cfg(kw).validar()
    bombas = []
    for q, h, b, s, k in BOMBAS:
        op = punto_operacion(q, h, b, s, k)
        bombas.append({"args": [q, h, b, s, k], "q_m3s": op.q_m3s, "q_lh": op.q_lh, "u_ms": op.u_ms,
                       "m_m4s2": op.m_m4s2, "h_m": op.h_m, "t_mezcla_10m3_s": tiempo_mezcla_s(10.0, op.m_m4s2)})
    ref = {
        "casos": {nombre: corre_caso(c) for nombre, c in CASOS.items()},
        "invalidos": INVALIDOS,
        "validos": VALIDOS,
        "geometrias": [geometria(kw) for kw in GEOMETRIAS],
        "bombas": bombas,
        # valores por defecto de los campos (sin __post_init__): DEFAULTS de solver.js debe dar lo mismo
        "defaults": {f.name: list(f.default) if isinstance(f.default, tuple) else f.default
                     for f in dataclasses.fields(Config)},
    }
    ruta = Path(__file__).with_name("ref_py.json")
    ruta.write_text(json.dumps(ref))
    print(f"{ruta} ({ruta.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
