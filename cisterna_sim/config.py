"""Parámetros de la cisterna, la bomba de mezcla y la dosis.

Lo que sale del documento de proyecto (pág. 9, 12, 30 y 31):
  - cisterna de ~10 m3, nivel lleno ~1.20 m (flotador), la bomba de pozo
    baja el nivel hasta ~30 cm y su rejilla está a ~45 cm
  - bomba de mezcla amarrada al mástil a ~50 cm del fondo, chorro en la
    diagonal del tubo hacia la esquina opuesta (diseño del doc)
  - sonda ORP en la punta del tubo a ~20 cm
  - Cloralex ~50 mg/mL, dosis de 150 a 200 mL

Bomba comprada: Mibee 12 V brushless, 800 L/h y 5 m según la ficha, entrada
axial G1/2 (Ø13 interior), salida radial G1/2 con Ø8 interior, cuerpo de
~61 x 46 x 49 mm.

Supuestos (el doc no los da; cámbialos aquí o por CLI):
  - planta rectangular de 3.40 x 2.45 m (3.40 x 2.45 x 1.20 = 10.0 m3)
  - posición de la boca de la tapa, de la bomba de pozo y del llenado
  - inclinación del mástil: el dibujo no tiene lo horizontal a escala
  - curva de la bomba lineal entre (0, Hmax) y (Qmax, 0), medida con su
    propia salida de 8 mm (los 800 L/h de la ficha están sin verificar)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

LUGARES_DOSIS = ("llenado", "mastil")


@dataclass
class Config:
    # Geometría (m). x a lo largo, y a lo ancho, z hacia arriba desde el fondo.
    largo: float = 3.40
    ancho: float = 2.45
    nivel: float = 1.20
    z_tapa: float = 1.35  # travesaño del que cuelga el mástil
    dx: float = 0.10  # tamaño objetivo de celda

    # Bomba de mezcla Mibee 12 V (ficha: 800 L/h, 5 m).
    q_max_lh: float = 800.0
    h_max_m: float = 5.0
    salida_mm: float = 8.0  # diámetro interior de la salida de fábrica
    boquilla_mm: float = 8.0  # diámetro por el que sale el chorro (reducción o manguera)
    k_salida: float = 1.0  # pérdidas en una reducción, en cargas de velocidad

    # Mástil y puntos de interés.
    boca: tuple[float, float] = (1.20, 1.00)  # centro de la boca de la tapa (x, y)
    angulo_tubo: float = 60.0  # grados sobre la horizontal
    z_bomba: float = 0.50
    z_orp: float = 0.20
    # Posición y dirección de la bomba. None = sobre el mástil a z_bomba, chorro a lo
    # largo del tubo (el diseño del doc). azimut en planta, grados desde +x hacia +y;
    # elevacion en grados, positiva hacia arriba.
    pos_bomba: Optional[tuple[float, float, float]] = None
    azimut: Optional[float] = None
    elevacion: Optional[float] = None
    pozo: tuple[float, float, float] = (0.90, 1.00, 0.45)  # rejilla de la bomba de pozo
    llenado: tuple[float, float, float] = (0.25, 1.20, 1.10)  # donde cae el agua del flotador (boca B)

    # Dosis.
    dosis_ml: float = 150.0
    cloralex_mg_ml: float = 50.0
    lugar_dosis: str = "llenado"

    # Simulación.
    minutos: float = 60.0  # tiempo simulado después de la dosis
    bomba_min: float = 45.0  # el firmware la apaga a los ~45 min de la dosis
    precalentar_s: float = 0.0  # bomba andando antes de la dosis (prueba 9c: 600)
    cfl: float = 0.4
    cs: float = 0.17  # constante de Smagorinsky
    # Turbulencia que una malla de 10 cm no resuelve: nu = c_nu * sqrt(M) mientras la bomba
    # anda. sqrt(M) es la única escala de viscosidad que respeta t ~ V^(2/3)/sqrt(M); dentro
    # de un chorro redondo nu_t ~ 0.017 sqrt(M). Con 0.02 la prueba 9c simulada da lo mismo
    # que la fórmula (ver README). Con 0 la mezcla depende de la malla.
    c_nu: float = 0.02
    sc_t: float = 0.7  # Schmidt turbulento
    cada_s: float = 10.0  # muestreo de la serie de tiempo
    cuadro_s: float = 60.0  # cuadros de la animación

    # ---- geometría derivada ----

    @property
    def volumen_m3(self) -> float:
        return self.largo * self.ancho * self.nivel

    def rumbo(self) -> tuple[float, float]:
        """Dirección en planta del mástil: de la boca hacia la esquina opuesta."""
        bx, by = self.boca
        ex = self.largo if bx < self.largo / 2 else 0.0
        ey = self.ancho if by < self.ancho / 2 else 0.0
        hx, hy = ex - bx, ey - by
        n = math.hypot(hx, hy)
        return hx / n, hy / n

    def punto_tubo(self, z: float) -> tuple[float, float, float]:
        """Punto del mástil diagonal a la altura z."""
        a = math.radians(self.angulo_tubo)
        hx, hy = self.rumbo()
        s = (self.z_tapa - z) / math.tan(a)
        return self.boca[0] + s * hx, self.boca[1] + s * hy, z

    def plano_chorro(self) -> tuple[float, float]:
        """Dirección en planta del chorro (si es casi vertical, la del mástil)."""
        dx, dy, _ = self.dir_chorro()
        n = math.hypot(dx, dy)
        return (dx / n, dy / n) if n > 0.1 else self.rumbo()

    def pos_bomba_xyz(self) -> tuple[float, float, float]:
        return tuple(self.pos_bomba) if self.pos_bomba is not None else self.punto_tubo(self.z_bomba)

    def dir_chorro(self) -> tuple[float, float, float]:
        """Por defecto el chorro sigue la diagonal del tubo, hacia abajo."""
        hx, hy = self.rumbo()
        az = math.atan2(hy, hx) if self.azimut is None else math.radians(self.azimut)
        el = -math.radians(self.angulo_tubo) if self.elevacion is None else math.radians(self.elevacion)
        return math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)

    def punto_dosis(self) -> tuple[float, float, float]:
        if self.lugar_dosis == "mastil":
            x, y = self.boca
            z = self.nivel - 0.10
        else:
            x, y, z = self.llenado
        return x, y, min(z, self.nivel - 0.10)

    def sondas(self) -> dict[str, tuple[float, float, float]]:
        """Puntos de la prueba 9c más la sonda ORP."""
        return {
            "superficie (tapa)": (self.boca[0], self.boca[1], self.nivel - 0.10),
            "llave de la casa (pozo)": self.pozo,
            "sonda ORP": self.punto_tubo(self.z_orp),
        }

    def validar(self) -> None:
        errores = []
        for nombre in ("largo", "ancho", "nivel", "dx", "q_max_lh", "h_max_m", "salida_mm", "boquilla_mm",
                       "minutos", "dosis_ml"):
            if not getattr(self, nombre) > 0:
                errores.append(f"{nombre} debe ser > 0")
        # en forma negada para que NaN también falle
        if not (self.k_salida >= 0 and self.precalentar_s >= 0 and self.bomba_min >= 0 and self.c_nu >= 0
                and self.cs >= 0 and self.cloralex_mg_ml > 0 and self.sc_t > 0):
            errores.append("k_salida, precalentar_s, bomba_min, c_nu y cs deben ser >= 0; cloralex_mg_ml y sc_t > 0")
        if not 5 <= self.angulo_tubo <= 90:
            errores.append("angulo_tubo debe estar entre 5 y 90 grados")
        if self.elevacion is not None and not -90 <= self.elevacion <= 90:
            errores.append("elevacion debe estar entre -90 y 90 grados")
        if self.lugar_dosis not in LUGARES_DOSIS:
            errores.append(f"lugar_dosis debe ser uno de {LUGARES_DOSIS}")
        if not 0 < self.cfl <= 0.5:
            errores.append("cfl debe estar en (0, 0.5]")
        if errores:
            raise ValueError("; ".join(errores))

        # en z la malla usa max(4, ...) por sí sola, así que la regla solo aplica en planta
        if min(self.largo, self.ancho) / self.dx < 4:
            errores.append("dx muy grande: se necesitan al menos 4 celdas a lo largo y a lo ancho")
        zb = self.pos_bomba_xyz()[2]
        if self.nivel < zb + 0.10 - 1e-9:
            errores.append(
                f"nivel {self.nivel:.2f} m deja la bomba (a {zb:.2f} m) casi en seco; "
                "en la vida real el INA219 la apagaría"
            )
        if self.z_tapa <= self.nivel:
            errores.append("z_tapa debe estar arriba del nivel del agua")
        puntos = {"bomba": self.pos_bomba_xyz(), "sonda ORP": self.punto_tubo(self.z_orp),
                  "pozo": self.pozo, "dosis": self.punto_dosis(),
                  "boca (sonda de superficie)": (self.boca[0], self.boca[1], self.nivel - 0.10)}
        for nombre, (x, y, z) in puntos.items():
            if not (0 < x < self.largo and 0 < y < self.ancho and 0 < z < self.nivel):
                errores.append(f"{nombre} ({x:.2f}, {y:.2f}, {z:.2f}) queda fuera del agua o de la cisterna")
        if errores:
            raise ValueError("; ".join(errores))
