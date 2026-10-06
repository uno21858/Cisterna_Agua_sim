import math

import numpy as np
import pytest

from cisterna_sim.bomba import G, punto_operacion, tiempo_mezcla_s
from cisterna_sim.config import Config
from cisterna_sim.solver import Cisterna


def _sim(**kw):
    return Cisterna(Config(dx=0.2, **kw))  # malla 17x12x6: rápida


def _corre(sim, pasos, con_cloro=True):
    for _ in range(pasos):
        sim.avanza(sim.dt_flujo(), con_cloro=con_cloro)


def test_flujo_sin_divergencia_y_cloro_conservado():
    sim = _sim()
    sim.dosifica(7500.0, sim.cfg.punto_dosis())
    m0 = sim.masa_cloro_mg()
    _corre(sim, 60)
    assert np.abs(sim.divergencia()).max() < 1e-10
    assert sim.masa_cloro_mg() == pytest.approx(m0, rel=1e-10)
    assert sim.c.min() > -1e-9 * sim.c.max()
    assert sim.energia_cinetica() > 0


def test_concentracion_uniforme_se_queda_uniforme():
    sim = _sim()
    _corre(sim, 30, con_cloro=False)
    sim.c[:] = 0.75
    _corre(sim, 30)
    assert np.allclose(sim.c, 0.75, atol=1e-12)


def test_fuerza_del_chorro_integra_su_flujo_de_momento():
    sim = _sim()
    total = [f.sum() * sim.vol_celda for f in (sim.f_u, sim.f_v, sim.f_w)]
    esperado = sim.bomba.m_m4s2 * np.array(sim.cfg.dir_chorro())
    assert np.allclose(total, esperado, rtol=1e-12, atol=1e-15)


def test_chorro_empuja_en_su_direccion():
    sim = _sim()
    _corre(sim, 40, con_cloro=False)
    d = np.array(sim.cfg.dir_chorro())
    p = np.array(sim.cfg.punto_tubo(sim.cfg.z_bomba)) + 0.2 * d
    vel = np.array([float(c[0]) for c in sim.velocidad_en(*(np.array([q]) for q in p))])
    assert vel @ d > 0


def test_salida_de_fabrica_da_el_caudal_de_la_ficha():
    op = punto_operacion(800, 5, 8, salida_mm=8)
    assert op.q_lh == pytest.approx(800)
    assert op.u_ms == pytest.approx(800 / 3.6e6 / (math.pi * 0.004**2))


def test_reduccion_cierra_el_balance_de_carga():
    op = punto_operacion(800, 5, 6, salida_mm=8, k_salida=1.0)
    h_bomba = 5 * (1 - op.q_lh / 800)
    u_s = op.q_m3s / (math.pi * 0.004**2)
    h_reduccion = (op.u_ms**2 - u_s**2) / (2 * G)
    assert h_bomba == pytest.approx(h_reduccion, rel=1e-9)
    assert 0 < op.q_lh < 800


def test_formula_da_los_45_min_del_documento_con_la_jt750():
    op = punto_operacion(700, 5, 12, salida_mm=12)
    assert 40 < tiempo_mezcla_s(10.0, op.m_m4s2) / 60 < 47


def test_formula_con_la_mibee():
    op = punto_operacion(800, 5, 8, salida_mm=8)
    assert 23 < tiempo_mezcla_s(10.0, op.m_m4s2) / 60 < 27


def test_reduccion_casi_no_ayuda_y_manguera_ancha_empeora():
    t = {b: tiempo_mezcla_s(10.0, punto_operacion(800, 5, b, salida_mm=8).m_m4s2) for b in (3, 6, 8, 12)}
    assert t[8] < t[3] and t[8] < t[12]
    assert abs(t[6] - t[8]) / t[8] < 0.05


def test_chorro_configurable():
    cfg = Config(azimut=90.0, elevacion=0.0, pos_bomba=(1.0, 1.0, 0.6))
    assert np.allclose(cfg.dir_chorro(), (0.0, 1.0, 0.0), atol=1e-12)
    sim = Cisterna(Config(dx=0.2, azimut=90.0, elevacion=0.0, pos_bomba=(1.0, 1.0, 0.6)))
    assert sim.f_v.sum() > 0 and abs(sim.f_u.sum()) < 1e-12 and abs(sim.f_w.sum()) < 1e-12


@pytest.mark.parametrize("kw", [
    {"nivel": 0.55},  # bomba casi en seco
    {"lugar_dosis": "tinaco"},
    {"dx": 0.5},
    {"angulo_tubo": 0},
    {"boca": (5.0, 1.0)},
    {"cfl": 0.9},
    {"c_nu": -0.01},
    {"dosis_ml": 0},
    {"elevacion": 120},
    {"pos_bomba": (1.0, 1.0, 1.15)},
])
def test_configuracion_invalida(kw):
    with pytest.raises(ValueError):
        Config(**kw).validar()


def test_geometria_del_mastil():
    cfg = Config()
    x, y, z = cfg.punto_tubo(cfg.z_bomba)
    bx, by = cfg.boca
    horizontal = math.hypot(x - bx, y - by)
    assert horizontal == pytest.approx((cfg.z_tapa - cfg.z_bomba) / math.tan(math.radians(cfg.angulo_tubo)))
    assert np.linalg.norm(cfg.dir_chorro()) == pytest.approx(1.0)
