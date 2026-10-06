"""Punto de operación de la bomba de mezcla y tiempo de mezcla por chorro.

Sumergida y descargando a la misma agua, la bomba no sube columna: la única
carga que vence es la velocidad de salida por la boquilla, K * u^2 / (2 g).
Con la curva lineal H = Hmax * (1 - Q / Qmax) queda una cuadrática en Q.

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


def punto_operacion(q_max_lh: float, h_max_m: float, boquilla_mm: float, k_salida: float = 1.0) -> PuntoOperacion:
    if q_max_lh <= 0 or h_max_m <= 0 or boquilla_mm <= 0 or k_salida < 0:
        raise ValueError("q_max_lh, h_max_m y boquilla_mm deben ser > 0, k_salida >= 0")
    q_max = q_max_lh / 3.6e6
    area = math.pi * (boquilla_mm / 1000) ** 2 / 4
    # h_max * (1 - Q/q_max) = k * Q^2 / (2 g A^2)  ->  a Q^2 + b Q - h_max = 0
    a = k_salida / (2 * G * area**2)
    b = h_max_m / q_max
    q = h_max_m / b if a == 0 else (-b + math.sqrt(b * b + 4 * a * h_max_m)) / (2 * a)
    u = q / area
    return PuntoOperacion(q, u, q * u, h_max_m * (1 - q / q_max))


def tiempo_mezcla_s(volumen_m3: float, m_m4s2: float) -> float:
    if volumen_m3 <= 0 or m_m4s2 <= 0:
        raise ValueError("volumen y flujo de momento deben ser > 0")
    return K_MEZCLA * volumen_m3 ** (2 / 3) / math.sqrt(m_m4s2)
