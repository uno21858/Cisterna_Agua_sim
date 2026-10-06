"""Solver 3D de la cisterna: el chorro de la bomba de mezcla y el cloro.

Malla MAC: velocidades en las caras, presión y cloro en los centros.
Cada paso:
  1. viscosidad turbulenta de Smagorinsky
  2. advección semi-lagrangiana (RK2) de la velocidad
  3. difusión explícita y fuerza del chorro
  4. proyección de presión exacta con DCT (caja cerrada, flujo sin divergencia)
  5. transporte del cloro en forma conservativa (MUSCL + van Leer, SSP-RK2)

Paredes y fondo sin deslizamiento; la superficie es una tapa rígida que
desliza. Con celdas de 10 cm la boquilla de 12 mm no se resuelve: el chorro
entra como una fuerza igual a su flujo de momento M = Q * u repartida en unas
pocas celdas. Lejos de la boquilla un chorro turbulento solo depende de M,
que es justo lo que usa la correlación de mezcla. La turbulencia que la malla
no ve entra como viscosidad de fondo c_nu * sqrt(M) (ver config).

Corre en CPU con numpy o en GPU con CuPy (gpu=True); f32=True usa precisión
simple, que en tarjetas GeForce es mucho más rápida que la doble.
"""

from __future__ import annotations

import copy
import math

import numpy as np
from scipy import fft as fft_cpu

from .bomba import punto_operacion
from .config import Config

NU_AGUA = 1.0e-6  # m2/s, ~20 C
DT_MAX = 0.5  # s
CFL_FLUJO = 0.9
ARRANQUE_S = 300.0  # el flujo tarda unos minutos en desarrollarse

# Desfase del índice de cada arreglo respecto a la esquina de su celda.
OFF_U = (0.0, 0.5, 0.5)
OFF_V = (0.5, 0.0, 0.5)
OFF_W = (0.5, 0.5, 0.0)
OFF_C = (0.5, 0.5, 0.5)


def _xp(a):
    """Módulo de arreglos (numpy o cupy) al que pertenece a."""
    if type(a).__module__.startswith("cupy"):
        import cupy
        return cupy
    return np


def a_numpy(a):
    """Copia a numpy un arreglo de CPU o GPU (para graficar o guardar)."""
    return a.get() if type(a).__module__.startswith("cupy") else np.asarray(a)


def _sl(nd: int, axis: int, s: slice) -> tuple:
    idx = [slice(None)] * nd
    idx[axis] = s
    return tuple(idx)


def _d2(a: np.ndarray, axis: int, h: float, lo: float, hi: float) -> np.ndarray:
    """Segunda diferencia a lo largo de axis con celdas fantasma.

    lo/hi es el signo de la fantasma en cada pared para una componente
    tangencial: -1 sin deslizamiento (vale cero en la pared), +1 desliza.
    En el eje normal da igual porque esas caras se fuerzan a cero.
    """
    nd = a.ndim
    p = _xp(a).concatenate([lo * a[_sl(nd, axis, slice(0, 1))], a, hi * a[_sl(nd, axis, slice(-1, None))]],
                           axis=axis)
    return (p[_sl(nd, axis, slice(2, None))] - 2 * a + p[_sl(nd, axis, slice(None, -2))]) / h**2


def _a_caras(c: np.ndarray, axis: int) -> np.ndarray:
    """Centros -> todas las caras del eje (las de pared copian la celda vecina)."""
    nd = c.ndim
    p = _xp(c).concatenate([c[_sl(nd, axis, slice(0, 1))], c, c[_sl(nd, axis, slice(-1, None))]], axis=axis)
    return 0.5 * (p[_sl(nd, axis, slice(1, None))] + p[_sl(nd, axis, slice(None, -1))])


def _grad(a, h: float, axis: int):
    """Igual que np.gradient de primer orden en los bordes, sin subir a doble precisión."""
    nd = a.ndim
    cen = (a[_sl(nd, axis, slice(2, None))] - a[_sl(nd, axis, slice(None, -2))]) / (2 * h)
    ini = (a[_sl(nd, axis, slice(1, 2))] - a[_sl(nd, axis, slice(0, 1))]) / h
    fin = (a[_sl(nd, axis, slice(-1, None))] - a[_sl(nd, axis, slice(-2, -1))]) / h
    return _xp(a).concatenate([ini, cen, fin], axis=axis)


def _pendiente_van_leer(c: np.ndarray, axis: int) -> np.ndarray:
    xp = _xp(c)
    nd = c.ndim
    p = xp.concatenate([c[_sl(nd, axis, slice(0, 1))], c, c[_sl(nd, axis, slice(-1, None))]], axis=axis)
    a = c - p[_sl(nd, axis, slice(None, -2))]
    b = p[_sl(nd, axis, slice(2, None))] - c
    ab = a * b
    suma = a + b
    # con ab > 0 la suma nunca es cero; el 1 solo evita dividir entre cero en lo descartado
    return xp.where(ab > 0, 2 * ab / xp.where(suma == 0, 1, suma), 0)


def _trilineal(a: np.ndarray, fi, fj, fk) -> np.ndarray:
    """Interpolación trilineal en índices fraccionarios; fuera del arreglo
    toma el valor del borde (igual que map_coordinates con mode='nearest',
    pero ~2x más rápida para estos tamaños)."""
    xp = _xp(a)
    nx, ny, nz = a.shape
    fi = xp.clip(fi, 0, nx - 1)
    fj = xp.clip(fj, 0, ny - 1)
    fk = xp.clip(fk, 0, nz - 1)
    i0 = xp.minimum(fi.astype(np.intp), nx - 2)
    j0 = xp.minimum(fj.astype(np.intp), ny - 2)
    k0 = xp.minimum(fk.astype(np.intp), nz - 2)
    ti, tj, tk = fi - i0.astype(fi.dtype), fj - j0.astype(fj.dtype), fk - k0.astype(fk.dtype)
    f = a.ravel()
    sx, sy = ny * nz, nz
    b = i0 * sx + j0 * sy + k0
    c00 = f[b] * (1 - tk) + f[b + 1] * tk
    c01 = f[b + sy] * (1 - tk) + f[b + sy + 1] * tk
    c10 = f[b + sx] * (1 - tk) + f[b + sx + 1] * tk
    c11 = f[b + sx + sy] * (1 - tk) + f[b + sx + sy + 1] * tk
    return (c00 * (1 - tj) + c01 * tj) * (1 - ti) + (c10 * (1 - tj) + c11 * tj) * ti


def _gauss_normalizado(px, py, pz, centro, sigma, mascara=None) -> np.ndarray:
    r2 = (px - centro[0]) ** 2 + (py - centro[1]) ** 2 + (pz - centro[2]) ** 2
    w = _xp(px).exp(-r2 / (2 * sigma**2))
    if mascara is not None:
        w *= mascara
    return w / w.sum()


class Cisterna:
    def __init__(self, cfg: Config, gpu: bool = False, f32: bool = False):
        cfg.validar()
        self.cfg = cfg
        if gpu:
            import cupy
            from cupyx.scipy import fft as fft_gpu
            self.xp, self._fft = cupy, fft_gpu
        else:
            self.xp, self._fft = np, fft_cpu
        self.dtype = np.float32 if f32 else np.float64
        xp, dt = self.xp, self.dtype
        self.nx = max(4, round(cfg.largo / cfg.dx))
        self.ny = max(4, round(cfg.ancho / cfg.dx))
        self.nz = max(4, round(cfg.nivel / cfg.dx))
        self.dx = cfg.largo / self.nx
        self.dy = cfg.ancho / self.ny
        self.dz = cfg.nivel / self.nz
        self.vol_celda = self.dx * self.dy * self.dz
        self.delta = self.vol_celda ** (1 / 3)
        nx, ny, nz = self.nx, self.ny, self.nz

        self.u = xp.zeros((nx + 1, ny, nz), dtype=dt)
        self.v = xp.zeros((nx, ny + 1, nz), dtype=dt)
        self.w = xp.zeros((nx, ny, nz + 1), dtype=dt)
        self.c = xp.zeros((nx, ny, nz), dtype=dt)  # cloro, mg/L
        self.nu_c = xp.full((nx, ny, nz), NU_AGUA, dtype=dt)
        self.t = 0.0

        # Coordenadas físicas de cada arreglo, para la advección y los muestreos.
        self.p_u = self._coords(self.u.shape, OFF_U)
        self.p_v = self._coords(self.v.shape, OFF_V)
        self.p_w = self._coords(self.w.shape, OFF_W)
        self.p_c = self._coords(self.c.shape, OFF_C)

        # Bomba: punto de operación y fuerza del chorro.
        self.bomba = punto_operacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida)
        self.f_u, self.f_v, self.f_w = self._fuerza_chorro()
        # Turbulencia que la malla no resuelve: nu = C * sqrt(M) (ver config.c_nu).
        self.nu_fondo = cfg.c_nu * math.sqrt(self.bomba.m_m4s2)

        # Autovalores del laplaciano discreto con Neumann (base de la DCT-II).
        lx = (2 * np.cos(np.pi * np.arange(nx) / nx) - 2) / self.dx**2
        ly = (2 * np.cos(np.pi * np.arange(ny) / ny) - 2) / self.dy**2
        lz = (2 * np.cos(np.pi * np.arange(nz) / nz) - 2) / self.dz**2
        lam = lx[:, None, None] + ly[None, :, None] + lz[None, None, :]
        lam[0, 0, 0] = 1.0  # modo constante: presión definida salvo constante
        self.lam = xp.asarray(lam, dtype=dt)

        self.inv_h2 = 1 / self.dx**2 + 1 / self.dy**2 + 1 / self.dz**2

    # ---- geometría ----

    def _coords(self, shape, off):
        i, j, k = np.meshgrid(*(np.arange(n, dtype=float) for n in shape), indexing="ij")
        return tuple(self.xp.asarray(q, dtype=self.dtype)
                     for q in ((i + off[0]) * self.dx, (j + off[1]) * self.dy, (k + off[2]) * self.dz))

    def _fuerza_chorro(self):
        """Aceleración (m/s2) en cada cara; su integral en el volumen es M * dir."""
        cfg = self.cfg
        boq = np.array(cfg.pos_bomba_xyz())
        d = np.array(cfg.dir_chorro())
        centro = [float(q) for q in boq + d * self.delta]  # justo delante de la boquilla
        sigma = 0.6 * self.delta
        m = self.bomba.m_m4s2
        fuerzas = []
        for p, comp, eje in ((self.p_u, d[0], 0), (self.p_v, d[1], 1), (self.p_w, d[2], 2)):
            interior = self.xp.ones_like(p[0])
            interior[_sl(3, eje, slice(0, 1))] = 0
            interior[_sl(3, eje, slice(-1, None))] = 0
            w = _gauss_normalizado(*p, centro, sigma, interior)
            fuerzas.append((m * float(comp) * w / self.vol_celda).astype(self.dtype))
        return fuerzas

    def muestrea(self, a, off, x, y, z):
        """Interpolación trilineal de un arreglo en puntos físicos."""
        return _trilineal(a, x / self.dx - off[0], y / self.dy - off[1], z / self.dz - off[2])

    def velocidad_en(self, x, y, z):
        return (self.muestrea(self.u, OFF_U, x, y, z),
                self.muestrea(self.v, OFF_V, x, y, z),
                self.muestrea(self.w, OFF_W, x, y, z))

    def velocidad_centros(self):
        return (0.5 * (self.u[1:] + self.u[:-1]),
                0.5 * (self.v[:, 1:] + self.v[:, :-1]),
                0.5 * (self.w[:, :, 1:] + self.w[:, :, :-1]))

    # ---- flujo ----

    def _nu_turbulenta(self):
        u, v, w = self.u, self.v, self.w
        uc, vc, wc = self.velocidad_centros()
        dudx = (u[1:] - u[:-1]) / self.dx
        dvdy = (v[:, 1:] - v[:, :-1]) / self.dy
        dwdz = (w[:, :, 1:] - w[:, :, :-1]) / self.dz
        g = _grad
        dudy, dudz = g(uc, self.dy, axis=1), g(uc, self.dz, axis=2)
        dvdx, dvdz = g(vc, self.dx, axis=0), g(vc, self.dz, axis=2)
        dwdx, dwdy = g(wc, self.dx, axis=0), g(wc, self.dy, axis=1)
        s2 = (2 * (dudx**2 + dvdy**2 + dwdz**2)
              + (dudy + dvdx) ** 2 + (dudz + dwdx) ** 2 + (dvdz + dwdy) ** 2)
        return (self.cfg.cs * self.delta) ** 2 * self.xp.sqrt(s2)

    def _advecta(self, a, off, p, dt):
        x, y, z = p
        u, v, w = self.velocidad_en(x, y, z)
        u, v, w = self.velocidad_en(x - 0.5 * dt * u, y - 0.5 * dt * v, z - 0.5 * dt * w)
        return self.muestrea(a, off, x - dt * u, y - dt * v, z - dt * w).reshape(a.shape)

    def _proyecta(self, u, v, w, dt):
        div = ((u[1:] - u[:-1]) / self.dx + (v[:, 1:] - v[:, :-1]) / self.dy
               + (w[:, :, 1:] - w[:, :, :-1]) / self.dz)
        ph = self._fft.dctn(div / dt, type=2, norm="ortho") / self.lam
        ph[0, 0, 0] = 0.0
        p = self._fft.idctn(ph, type=2, norm="ortho")
        u[1:-1] -= dt * (p[1:] - p[:-1]) / self.dx
        v[:, 1:-1] -= dt * (p[:, 1:] - p[:, :-1]) / self.dy
        w[:, :, 1:-1] -= dt * (p[:, :, 1:] - p[:, :, :-1]) / self.dz

    def divergencia(self):
        return ((self.u[1:] - self.u[:-1]) / self.dx + (self.v[:, 1:] - self.v[:, :-1]) / self.dy
                + (self.w[:, :, 1:] - self.w[:, :, :-1]) / self.dz)

    def paso_flujo(self, dt, bomba_encendida=True):
        self.nu_c = NU_AGUA + self._nu_turbulenta() + (self.nu_fondo if bomba_encendida else 0.0)
        u, v, w = self.u, self.v, self.w
        lap_u = _d2(u, 0, self.dx, 0, 0) + _d2(u, 1, self.dy, -1, -1) + _d2(u, 2, self.dz, -1, 1)
        lap_v = _d2(v, 0, self.dx, -1, -1) + _d2(v, 1, self.dy, 0, 0) + _d2(v, 2, self.dz, -1, 1)
        lap_w = _d2(w, 0, self.dx, -1, -1) + _d2(w, 1, self.dy, -1, -1) + _d2(w, 2, self.dz, 0, 0)
        on = 1.0 if bomba_encendida else 0.0

        un = self._advecta(u, OFF_U, self.p_u, dt) + dt * (_a_caras(self.nu_c, 0) * lap_u + on * self.f_u)
        vn = self._advecta(v, OFF_V, self.p_v, dt) + dt * (_a_caras(self.nu_c, 1) * lap_v + on * self.f_v)
        wn = self._advecta(w, OFF_W, self.p_w, dt) + dt * (_a_caras(self.nu_c, 2) * lap_w + on * self.f_w)
        un[0] = un[-1] = 0.0
        vn[:, 0] = vn[:, -1] = 0.0
        wn[:, :, 0] = wn[:, :, -1] = 0.0
        self._proyecta(un, vn, wn, dt)
        self.u, self.v, self.w = un, vn, wn

    # ---- cloro ----

    def _dcdt(self, c, d):
        xp = self.xp
        out = xp.zeros_like(c)
        for eje, vel, h in ((0, self.u, self.dx), (1, self.v, self.dy), (2, self.w, self.dz)):
            n = c.shape[eje]
            s = _pendiente_van_leer(c, eje)
            izq = c[_sl(3, eje, slice(0, n - 1))]
            der = c[_sl(3, eje, slice(1, n))]
            c_izq = izq + 0.5 * s[_sl(3, eje, slice(0, n - 1))]
            c_der = der - 0.5 * s[_sl(3, eje, slice(1, n))]
            vf = vel[_sl(3, eje, slice(1, n))]  # caras interiores
            d_f = 0.5 * (d[_sl(3, eje, slice(0, n - 1))] + d[_sl(3, eje, slice(1, n))])
            flujo = vf * xp.where(vf > 0, c_izq, c_der) - d_f * (der - izq) / h
            cero = xp.zeros_like(c[_sl(3, eje, slice(0, 1))])  # paredes sin flujo
            flujo = xp.concatenate([cero, flujo, cero], axis=eje)
            out -= (flujo[_sl(3, eje, slice(1, None))] - flujo[_sl(3, eje, slice(None, -1))]) / h
        return out

    def paso_cloro(self, dt):
        d = self.nu_c / self.cfg.sc_t
        c1 = self.c + dt * self._dcdt(self.c, d)
        self.c = 0.5 * (self.c + c1 + dt * self._dcdt(c1, d))

    def dosifica(self, masa_mg, punto, sigma=None):
        """Suelta la dosis como una nube gaussiana alrededor de punto."""
        sigma = sigma or self.delta
        w = _gauss_normalizado(*self.p_c, punto, sigma)
        self.c += masa_mg * w / (self.vol_celda * 1000.0)  # mg / L

    # ---- control de paso ----

    def _courant_por_s(self):
        uc, vc, wc = self.velocidad_centros()
        return float((abs(uc) / self.dx + abs(vc) / self.dy + abs(wc) / self.dz).max())

    def dt_flujo(self):
        """La advección semi-lagrangiana aguanta Courant ~1; la difusión explícita no."""
        dt = min(DT_MAX, 0.4 / (float(self.nu_c.max()) * self.inv_h2))
        cou = self._courant_por_s()
        return min(dt, CFL_FLUJO / cou) if cou > 0 else dt

    def dt_cloro(self):
        """MUSCL explícito: Courant total <= cfl y difusión estable."""
        dt = 0.4 / (float(self.nu_c.max()) / self.cfg.sc_t * self.inv_h2)
        cou = self._courant_por_s()
        return min(dt, self.cfg.cfl / cou) if cou > 0 else dt

    def avanza(self, dt, con_cloro=True, bomba_encendida=True):
        self.paso_flujo(dt, bomba_encendida)
        if con_cloro:
            n = max(1, math.ceil(dt / self.dt_cloro()))
            for _ in range(n):
                self.paso_cloro(dt / n)
        self.t += dt

    def masa_cloro_mg(self):
        return float(self.c.sum(dtype=np.float64)) * self.vol_celda * 1000.0

    def energia_cinetica(self):
        """J por kg de agua, promedio en el volumen."""
        uc, vc, wc = self.velocidad_centros()
        return 0.5 * float((uc**2 + vc**2 + wc**2).mean(dtype=np.float64))

    def seccion_chorro(self, campo="c"):
        """Corte vertical por el plano del chorro: (s, z, valores[nz, ns])."""
        cfg = self.cfg
        hx, hy = cfg.plano_chorro()
        x0, y0, _ = cfg.pos_bomba_xyz()
        # tramo de la recta (x0, y0) + s (hx, hy) dentro de la planta
        lims = []
        for p0, h, L in ((x0, hx, cfg.largo), (y0, hy, cfg.ancho)):
            if abs(h) > 1e-12:
                a, b = (0 - p0) / h, (L - p0) / h
                lims.append((min(a, b), max(a, b)))
        s_min = max(l[0] for l in lims)
        s_max = min(l[1] for l in lims)
        ns = max(8, int((s_max - s_min) / min(self.dx, self.dy)) + 1)
        s = np.linspace(s_min, s_max, ns)
        z = (np.arange(self.nz) + 0.5) * self.dz
        S, Z = np.meshgrid(s, z)
        X, Y = x0 + S * hx, y0 + S * hy
        pts = [self.xp.asarray(q.ravel(), dtype=self.dtype) for q in (X, Y, Z)]
        if campo == "c":
            return s, z, a_numpy(self.muestrea(self.c, OFF_C, *pts)).reshape(S.shape)
        u, v, w = (a_numpy(q) for q in self.velocidad_en(*pts))
        return s, z, (u * hx + v * hy).reshape(S.shape), w.reshape(S.shape)

    def indice_z(self, z):
        return int(np.clip(round(z / self.dz - 0.5), 0, self.nz - 1))

    def valor_sonda(self, punto):
        x, y, z = (self.xp.asarray([q], dtype=self.dtype) for q in punto)
        return float(self.muestrea(self.c, OFF_C, x, y, z)[0])

    def con_velocidad(self, u, v, w):
        """Copia ligera con otro campo de velocidad (para graficar promedios)."""
        otra = copy.copy(self)
        otra.u, otra.v, otra.w = u, v, w
        return otra

    def s_de(self, punto):
        """Coordenada s de un punto proyectado sobre el plano del chorro."""
        hx, hy = self.cfg.plano_chorro()
        x0, y0, _ = self.cfg.pos_bomba_xyz()
        return (punto[0] - x0) * hx + (punto[1] - y0) * hy


def correr(cfg: Config, progreso=print, gpu=False, f32=False):
    """Corre la simulación completa. Regresa (cisterna, serie, cuadros)."""
    sim = Cisterna(cfg, gpu=gpu, f32=f32)
    xp = sim.xp
    masa = cfg.dosis_ml * cfg.cloralex_mg_ml
    c_final = masa / (sim.nx * sim.ny * sim.nz * sim.vol_celda * 1000.0)
    sondas = cfg.sondas()
    t_dosis = cfg.precalentar_s
    t_fin = t_dosis + cfg.minutos * 60
    t_apaga = t_dosis + cfg.bomba_min * 60

    serie = {"t_min": [], "cov": [], "c_min": [], "c_max": [], "ek": []}
    for nombre in sondas:
        serie[nombre] = []
    cuadros = []
    dosificado = False
    prox_muestra = t_dosis
    prox_cuadro = t_dosis
    prox_reporte = 0.0
    pasos = 0
    # Promedio temporal del flujo con la bomba andando, pasado el arranque.
    t_arranque = min(ARRANQUE_S, 0.5 * t_apaga)
    suma = [xp.zeros_like(sim.u), xp.zeros_like(sim.v), xp.zeros_like(sim.w)]
    t_suma = 0.0

    def registra():
        rel = sim.c / c_final if c_final > 0 else sim.c
        serie["t_min"].append((sim.t - t_dosis) / 60)
        serie["cov"].append(float(rel.std(dtype=np.float64)))
        serie["c_min"].append(float(rel.min()))
        serie["c_max"].append(float(rel.max()))
        serie["ek"].append(sim.energia_cinetica())
        for nombre, p in sondas.items():
            serie[nombre].append(sim.valor_sonda(p))

    while sim.t < t_fin - 1e-9:
        if not dosificado and sim.t >= t_dosis - 1e-9:
            sim.dosifica(masa, cfg.punto_dosis())
            dosificado = True
        if dosificado and sim.t >= prox_muestra - 1e-9:
            registra()
            prox_muestra += cfg.cada_s
        if dosificado and sim.t >= prox_cuadro - 1e-9:
            s, z, sec = sim.seccion_chorro("c")
            cuadros.append({"t_min": (sim.t - t_dosis) / 60, "seccion": sec, "planta": a_numpy(sim.c.mean(axis=2)),
                            "cov": serie["cov"][-1] if serie["cov"] else float("nan")})
            prox_cuadro += cfg.cuadro_s
        if sim.t >= prox_reporte:
            if progreso:
                progreso(f"  t = {(sim.t - t_dosis) / 60:6.1f} min   pasos {pasos:6d}   "
                         f"v_rms {np.sqrt(2 * sim.energia_cinetica()):.3f} m/s")
            prox_reporte += 300.0

        dt = sim.dt_flujo()
        if sim.t < t_apaga - 1e-9:
            dt = min(dt, t_apaga - sim.t)
        if not dosificado:
            dt = min(dt, t_dosis - sim.t)
        else:
            dt = min(dt, prox_muestra - sim.t, prox_cuadro - sim.t, t_fin - sim.t)
        encendida = sim.t < t_apaga - 1e-9
        sim.avanza(max(dt, 1e-6), con_cloro=dosificado, bomba_encendida=encendida)
        if encendida and sim.t > t_arranque:
            for acc, campo in zip(suma, (sim.u, sim.v, sim.w)):
                acc += dt * campo
            t_suma += dt
        pasos += 1

    registra()
    s, z, sec = sim.seccion_chorro("c")
    cuadros.append({"t_min": (sim.t - t_dosis) / 60, "seccion": sec, "planta": a_numpy(sim.c.mean(axis=2)),
                    "cov": serie["cov"][-1]})
    sim.c_final = c_final
    sim.flujo_promedio = sim.con_velocidad(*(a / t_suma for a in suma)) if t_suma > 0 else sim
    sim.pasos = pasos
    return sim, serie, cuadros
