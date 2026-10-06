"""Punto de operación de la bomba de mezcla y tiempo de mezcla por chorro.

Sumergida y descargando a la misma agua, la bomba no sube columna. La ficha
(Qmax a 0 m) se mide descargando libre por su propia salida, así que esa
carga de velocidad ya está dentro de la curva: con la salida de fábrica la
bomba da Qmax. Una reducción más chica agrega K * (u_b^2 - u_s^2) / (2 g).
Con la curva lineal H = Hmax * (1 - Q / Qmax) queda una cuadrática en Q.
Una manguera más ancha que la salida no agrega carga pero frena el chorro.

El tiempo de mezcla es la correlación empírica del doc (EPA, Rossman y
Grayman 1999; constante de Process Online): t = 10.2 * V^(2/3) / sqrt(M),
con M = Q * u el flujo de momento del chorro (m4/s2).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

G = 9.81
K_MEZCLA = 10.2


@dataclass(frozen=True)
class PuntoOperacion:
    q_m3s: float
    u_ms: float  # velocidad en la boquilla
    m_m4s2: float  # flujo de momento Q * u
    h_m: float  # carga a la que trabaja

    @property
    def q_lh(self) -> float:
        return self.q_m3s * 3.6e6


def punto_operacion(q_max_lh: float, h_max_m: float, boquilla_mm: float, salida_mm: float | None = None,
                    k_salida: float = 1.0) -> PuntoOperacion:
    """salida_mm: diámetro de la salida con la que se midió la ficha (None = igual a la boquilla)."""
    salida_mm = boquilla_mm if salida_mm is None else salida_mm
    if q_max_lh <= 0 or h_max_m <= 0 or boquilla_mm <= 0 or salida_mm <= 0 or k_salida < 0:
        raise ValueError("q_max_lh, h_max_m, boquilla_mm y salida_mm deben ser > 0, k_salida >= 0")
    q_max = q_max_lh / 3.6e6
    area = math.pi * (boquilla_mm / 1000) ** 2 / 4
    area_s = math.pi * (salida_mm / 1000) ** 2 / 4
    # h_max * (1 - Q/q_max) = k * Q^2 / (2 g) * (1/A^2 - 1/A_s^2)  ->  a Q^2 + b Q - h_max = 0
    a = max(0.0, k_salida / (2 * G) * (1 / area**2 - 1 / area_s**2))
    b = h_max_m / q_max
    q = q_max if a == 0 else (-b + math.sqrt(b * b + 4 * a * h_max_m)) / (2 * a)
    u = q / area
    return PuntoOperacion(q, u, q * u, h_max_m * (1 - q / q_max))


def tiempo_mezcla_s(volumen_m3: float, m_m4s2: float) -> float:
    if volumen_m3 <= 0 or m_m4s2 <= 0:
        raise ValueError("volumen y flujo de momento deben ser > 0")
    return K_MEZCLA * volumen_m3 ** (2 / 3) / math.sqrt(m_m4s2)
