import math
import warnings

import numpy as np
import pytest

import cisterna_sim.solver as solver
from cisterna_sim.config import Config
from cisterna_sim.solver import Cisterna, correr

D = 3.26


def _cfg(**kw):
    return Config(forma="redonda", diametro=D, dx=0.2, **kw)  # malla 16x16x6


def _corre(sim, pasos, con_cloro=True):
    for _ in range(pasos):
        sim.avanza(sim.dt_flujo(), con_cloro=con_cloro)


def _vmax(sim):
    return max(float(np.abs(a).max()) for a in (sim.u, sim.v, sim.w))


def test_largo_y_ancho_son_el_diametro():
    cfg = Config(forma="redonda", diametro=3.0, largo=9.0, ancho=1.0)
    assert cfg.largo == cfg.ancho == 3.0
    assert cfg.volumen_m3 == pytest.approx(math.pi * 1.5**2 * cfg.nivel)
    assert Config(forma="rectangular", diametro=5.0).largo == 3.40  # la rectangular ignora el diámetro


def test_defaults_son_la_cisterna_de_erick():
    cfg = Config()
    cfg.validar()
    assert cfg.forma == "redonda" and cfg.diametro == D and cfg.largo == cfg.ancho == D
    assert cfg.volumen_m3 == pytest.approx(10.0, abs=0.02)
    # tubo vertical bajo la boca: bomba a 50 cm y sonda ORP a 20 cm sobre el eje del tubo
    bx, by = cfg.boca
    assert np.allclose(cfg.pos_bomba_xyz(), (bx, by, 0.50), atol=1e-12)
    assert np.allclose(cfg.sondas()["sonda ORP"], (bx, by, 0.20), atol=1e-12)
    # chorro horizontal en la línea llenado -> tubo (regla de docs/propuesta.md), que también lo
    # aleja del pozo; pozo a 30 cm de la boca y el llenado junto al pozo
    d = np.array(cfg.dir_chorro())
    assert d[2] == 0
    linea = np.array(cfg.pos_bomba_xyz()[:2]) - np.array(cfg.llenado[:2])
    assert d[:2] @ linea / np.linalg.norm(linea) > math.cos(math.radians(2))
    pozo = np.array(cfg.pozo)
    assert d @ (pozo - np.array(cfg.pos_bomba_xyz())) < 0
    assert math.hypot(pozo[0] - bx, pozo[1] - by) == pytest.approx(0.30)
    assert math.hypot(cfg.llenado[0] - pozo[0], cfg.llenado[1] - pozo[1]) <= 0.30
    assert cfg.punto_dosis() == pytest.approx((cfg.llenado[0], cfg.llenado[1], cfg.nivel - 0.10))
    Config(dx=0.4).validar()  # cabe la malla más gruesa permitida (8.15 celdas)


def test_mascara_y_caras_abiertas():
    sim = Cisterna(_cfg())
    agua = sim.agua[:, :, 0] > 0
    assert (sim.agua == sim.agua[:, :, :1]).all()  # la columna entera
    assert np.array_equal(agua, agua.T) and np.array_equal(agua, agua[::-1])
    assert agua.sum() * sim.dx * sim.dy == pytest.approx(math.pi * (D / 2) ** 2, rel=0.05)
    assert sim.n_agua == agua.sum() * sim.nz
    au, av, aw = (m > 0 for m in sim.abierta)
    assert not au[0].any() and not au[-1].any() and not aw[:, :, 0].any() and not aw[:, :, -1].any()
    assert np.array_equal(au[1:-1, :, 0], agua[1:] & agua[:-1])
    assert np.array_equal(av[:, 1:-1, 0], agua[:, 1:] & agua[:, :-1])
    assert np.array_equal(aw[:, :, 1], agua)


def test_pared_escalonada_sin_deslizamiento():
    sim = Cisterna(_cfg())
    au = sim.abierta[0] > 0
    e = sim._extra[0]
    # cara u abierta con la cara de arriba (j + 1) cerrada: suma 1/dy^2; en el centro, nada
    i, j = np.argwhere(au[:, :-1, 0] & ~au[:, 1:, 0])[0]
    assert e[i, j, 0] >= 1 / sim.dy**2
    assert e[sim.nx // 2, sim.ny // 2, :].max() == 0
    assert (e[~au] == 0).all()


def test_flujo_sin_divergencia_y_cloro_conservado():
    sim = Cisterna(_cfg())
    sim.dosifica(7500.0, sim.cfg.punto_dosis())
    m0 = sim.masa_cloro_mg()
    _corre(sim, 60)
    div = sim.divergencia()[sim.agua > 0]
    assert float(np.abs(div).max()) * min(sim.dx, sim.dz) <= 1e-6 * _vmax(sim)
    assert sim.masa_cloro_mg() == pytest.approx(m0, rel=1e-10)
    assert m0 == pytest.approx(7500.0, rel=1e-12)
    assert sim.c.min() > -1e-9 * sim.c.max()
    assert (sim.c[sim.agua == 0] == 0).all()
    for a, m in zip((sim.u, sim.v, sim.w), sim.abierta):
        assert (a[m == 0] == 0).all()
    assert sim.energia_cinetica() > 0
    assert 0 < sim.iter_cg < solver.ITER_MAX_CG
    assert (sim.nu_c[sim.agua == 0] == solver.NU_AGUA).all()  # fuera del agua no limita el dt
    assert float(sim.nu_c.max()) > 10 * solver.NU_AGUA


def test_concentracion_uniforme_se_queda_uniforme():
    sim = Cisterna(_cfg())
    _corre(sim, 30, con_cloro=False)
    sim.c[:] = 0.75 * sim.agua
    _corre(sim, 30)
    assert np.allclose(sim.en_agua(sim.c), 0.75, rtol=0, atol=1e-6)
    assert (sim.c[sim.agua == 0] == 0).all()


@pytest.mark.parametrize("kw", [
    {},
    # bomba a 15 cm de la pared, chorro hacia la pared: la gaussiana cae en parte fuera del agua
    {"pos_bomba": (D / 2 + (D / 2 - 0.15) / math.sqrt(2),) * 2 + (0.5,), "azimut": 45.0, "elevacion": 10.0},
])
def test_fuerza_del_chorro_integra_su_flujo_de_momento(kw):
    sim = Cisterna(_cfg(**kw))
    total = [f.sum() * sim.vol_celda for f in (sim.f_u, sim.f_v, sim.f_w)]
    esperado = sim.bomba.m_m4s2 * np.array(sim.cfg.dir_chorro())
    assert np.allclose(total, esperado, rtol=1e-12, atol=1e-15)
    for f, m in zip((sim.f_u, sim.f_v, sim.f_w), sim.abierta):
        assert (f[m == 0] == 0).all()


def test_dosis_cerca_de_la_pared_conserva_la_masa():
    sim = Cisterna(_cfg())
    r = D / 2 - 0.12
    sim.dosifica(1000.0, (D / 2 + r, D / 2, 0.5))
    assert sim.masa_cloro_mg() == pytest.approx(1000.0, rel=1e-12)
    assert (sim.c[sim.agua == 0] == 0).all()


def test_chorro_empuja_en_su_direccion():
    sim = Cisterna(_cfg())
    _corre(sim, 40, con_cloro=False)
    d = np.array(sim.cfg.dir_chorro())
    p = np.array(sim.cfg.pos_bomba_xyz()) + 0.2 * d
    vel = np.array([float(c[0]) for c in sim.velocidad_en(*(np.array([q]) for q in p))])
    assert vel @ d > 0


def test_cloro_junto_a_la_pared_se_interpola_solo_con_agua():
    sim = Cisterna(_cfg())
    sim.c[:] = 0.75 * sim.agua
    r = D / 2 - 0.05
    for ang in np.linspace(0, 2 * math.pi, 17):
        assert sim.valor_sonda((D / 2 + r * math.cos(ang), D / 2 + r * math.sin(ang), 0.5)) == pytest.approx(0.75)
    assert np.allclose(sim.seccion_chorro("c")[2], 0.75)
    # lejos de la pared es la trilineal de siempre
    sim.c[:] = np.random.default_rng(1).random(sim.c.shape) * sim.agua
    pts = [np.array([1.37, 1.9]), np.array([1.71, 1.2]), np.array([0.33, 1.07])]
    plana = solver._trilineal(sim.c, pts[0] / sim.dx - 0.5, pts[1] / sim.dy - 0.5, pts[2] / sim.dz - 0.5)
    assert np.array_equal(sim.muestrea(sim.c, solver.OFF_C, *pts), plana)


def test_rumbo_hacia_el_centro():
    cfg = _cfg(boca=(1.20, 1.00))
    esperado = np.array([D / 2 - 1.20, D / 2 - 1.00])
    assert np.allclose(cfg.rumbo(), esperado / np.linalg.norm(esperado), atol=1e-14)
    x, y, _ = cfg.punto_tubo(cfg.z_bomba)
    assert (x - 1.20) * esperado[1] - (y - 1.00) * esperado[0] == pytest.approx(0, abs=1e-12)
    assert _cfg(boca=(D / 2 + 0.0004, D / 2)).rumbo() == (1.0, 0.0)
    assert _cfg(boca=(D / 2 + 0.3, D / 2)).rumbo() == pytest.approx((-1.0, 0.0))


@pytest.mark.parametrize("kw", [
    {"pozo": (0.25, 0.25, 0.45)},  # dentro de la caja, fuera del círculo
    {"pozo": (D / 2 + D / 2 - 0.4 * 0.2, D / 2, 0.45)},  # a menos de medio dx de la pared
    {"pos_bomba": (0.3, 0.3, 0.5)},
    {"llenado": (0.2, 0.4, 1.10)},  # la dosis cae en el llenado
    {"boca": (3.0, 3.0)},
    {"pozo": (1.5, 1.5, 1.25)},
    {"diametro": 1.5},  # 7.5 celdas a lo ancho
    {"diametro": -1.0},
    {"diametro": float("nan")},
])
def test_validar_rechaza_puntos_fuera_del_circulo(kw):
    base = {"forma": "redonda", "diametro": D, "dx": 0.2}
    base.update(kw)
    with pytest.raises(ValueError):
        Config(**base).validar()


def test_validar_acepta_puntos_junto_a_la_pared():
    Config(forma="redonda", diametro=D, dx=0.2, pozo=(D - 0.6 * 0.2, D / 2, 0.45)).validar()
    Config(forma="redonda", diametro=1.6, dx=0.2, boca=(0.8, 0.8), pozo=(0.6, 0.8, 0.45),
           llenado=(1.0, 0.8, 1.1)).validar()
    with pytest.raises(ValueError):
        Config(forma="cuadrada").validar()
    with pytest.raises(ValueError):
        Config(diametro=-1.0).validar()  # el diámetro se valida aunque la planta sea rectangular


def test_seccion_por_la_cuerda():
    sim = Cisterna(_cfg(pos_bomba=(1.0, 2.0, 0.5), azimut=0.0, elevacion=0.0))
    s, z, sec = sim.seccion_chorro("c")
    r, d = D / 2, 2.0 - D / 2
    assert s[0] == pytest.approx(D / 2 - 1.0 - math.sqrt(r**2 - d**2))
    assert s[-1] - s[0] == pytest.approx(2 * math.sqrt(r**2 - d**2))
    assert sec.shape == (sim.nz, len(s))


def test_correr_usa_solo_el_agua():
    cfg = _cfg(minutos=0.5, bomba_min=0.4, cuadro_s=60.0)
    sim, serie, cuadros = correr(cfg, progreso=None)
    masa = cfg.dosis_ml * cfg.cloralex_mg_ml
    assert sim.c_final == pytest.approx(masa / (sim.n_agua * sim.vol_celda * 1000.0), rel=1e-14)
    assert sim.volumen_m3 == pytest.approx(sim.n_agua * sim.vol_celda)
    rel = sim.c[sim.agua > 0] / sim.c_final
    assert serie["cov"][-1] == pytest.approx(float(rel.std()), rel=1e-12)
    assert serie["c_min"][-1] == pytest.approx(float(rel.min()), rel=1e-12)
    assert sim.masa_cloro_mg() == pytest.approx(masa, rel=1e-10)


def test_con_la_caja_llena_da_la_proyeccion_de_la_dct():
    sim = Cisterna(_cfg())
    sim._fija_mascara(np.ones((sim.nx, sim.ny), dtype=bool))
    sim.tol_cg = 1e-14
    rng = np.random.default_rng(3)
    campos = [rng.standard_normal(a.shape) * m for a, m in zip((sim.u, sim.v, sim.w), sim.abierta)]
    gc = [a.copy() for a in campos]
    sim._proyecta(*gc, 0.5)
    assert sim.iter_cg == 1  # con la caja llena el precondicionador es la inversa exacta
    sim.redonda = False
    dct = [a.copy() for a in campos]
    sim._proyecta(*dct, 0.5)
    for a, b in zip(gc, dct):
        assert np.abs(a - b).max() < 1e-14 * np.abs(b).max()


def test_tolerancia_estricta_para_la_paridad():
    sim = Cisterna(_cfg())
    sim.tol_cg = 1e-12
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        _corre(sim, 20, con_cloro=False)
    assert float(np.abs(sim.divergencia()[sim.agua > 0]).max()) * sim.dx <= 1e-10 * _vmax(sim)


def test_aviso_una_vez_si_la_presion_no_converge(monkeypatch):
    monkeypatch.setattr(solver, "ITER_MAX_CG", 1)
    sim = Cisterna(_cfg())
    with warnings.catch_warnings(record=True) as avisos:
        warnings.simplefilter("always")
        _corre(sim, 5, con_cloro=False)
    assert len([a for a in avisos if "presión" in str(a.message)]) == 1


def test_precision_simple_da_lo_mismo_y_no_sube_a_doble():
    sims = {}
    for f32 in (False, True):
        sim = Cisterna(_cfg(), f32=f32)
        sim.dosifica(7500.0, sim.cfg.punto_dosis())
        for _ in range(40):
            sim.avanza(0.5)
        sims[f32] = sim
    for campo in ("u", "v", "w", "c", "nu_c", "p"):
        assert getattr(sims[True], campo).dtype == np.float32, campo
    escala = float(np.abs(sims[False].c).max())
    assert float(np.abs(sims[True].c - sims[False].c).max()) < 1e-4 * escala
    assert float(np.abs(sims[True].u - sims[False].u).max()) < 1e-4 * _vmax(sims[False])
    assert sims[True].masa_cloro_mg() == pytest.approx(7500.0, rel=1e-5)
