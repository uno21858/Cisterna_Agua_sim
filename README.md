# Simulación de mezcla: cisterna de 10,000 L con la bomba JT-750

Simula cómo mueve el agua la bomba de mezcla sumergible (12 V, 350 a 700 L/h, salida de 12 mm) colgada del mástil diagonal de la cisterna, y cuánto tarda en repartir una dosis de Cloralex en los 10 m³. Sale del documento de proyecto *Cloración automática de la cisterna* (fase 1, prueba 9c).

Dos herramientas:

- `simular.py`: CFD 3D del chorro y del cloro (~2 min de cómputo por cada 60 min simulados).
- `formula.py`: la correlación empírica t = 10.2·V^⅔/√M del doc, al instante, por nivel y por boquilla.

## Correr

```bash
pip install -r requirements.txt

python simular.py                                      # dosis por la boca B / llenado, bomba 45 min
python simular.py --dosis mastil                       # dosis junto al mástil
python simular.py --dosis mastil --precalentar 600 --bomba-min 60   # protocolo de la prueba 9c
python simular.py --nivel 0.7 --boquilla-mm 6          # cisterna a medias, con reducción en la salida
python formula.py                                      # tabla rápida
python -m pytest                                       # pruebas
```

Salidas en `resultados/` (o `--salida`):

| Archivo | Qué es |
|---|---|
| `mezcla.png` | cloro en la superficie, en la toma de la casa y en la sonda ORP contra el tiempo, rango de toda la cisterna y CoV |
| `flujo.png` | flujo promedio con la bomba andando: corte por el plano del chorro y planta |
| `cloro.gif` | el cloro moviéndose, minuto a minuto |
| `serie.csv`, `resumen.json` | los números |

## Resultados

Cisterna llena (10 m³), JT-750 a 12 V con boquilla de 12 mm, 150 mL de Cloralex (0.75 mg/L si se mezcla perfecto). Fórmula: **44 min**. Simulación, malla de 10 cm, 90 min:

| Caso | CoV < 5 % | Toda la cisterna ±10 % |
|---|---|---|
| Dosis junto al mástil, la bomba arranca con la dosis | 36 min | 38 min |
| Prueba 9c: dosis junto al mástil con la bomba ya andando | 45 a 46 min | 44 a 45 min |
| Dosis por el llenado (esquina lejos del chorro) | 83 min | 84 min |
| Llenado + boquilla de 6 mm | 54 min | 55 min |
| Nivel 0.70 m, dosis junto al mástil | 35 min | 40 min |
| Nivel 0.70 m, dosis por el llenado | 68 min | 67 min |

Lo que dice:

1. **Dónde se vierte el cloro pesa más que cualquier otra cosa.** Junto al mástil, la bomba lo jala y en ~40 min la cisterna queda pareja, como dice la fórmula. Por el llenado, en la esquina contraria al chorro, tarda el doble: con los 45 min del firmware la bomba se apaga con la cisterna a CoV 0.25 (zonas entre 0.6 y 1.5 veces la meta) y sin bomba ya casi no mejora.
2. **Dos tiras iguales no prueban que todo esté mezclado.** En el caso del llenado, la superficie y la sonda ORP marcan ~1.0 desde el minuto 20 mientras otras zonas siguen lejos. La prueba 9c dice cuándo se mezcló lo que mide, no la cisterna entera.
3. **Una boquilla más chica mezcla más rápido.** Con la curva lineal supuesta, 6 mm baja la fórmula de 44 a 29 min y la simulación de 83 a 54 min (la misma razón, 0.65). Por abajo de ~5 mm el caudal se cae y vuelve a empeorar. Ojo: cambia la corriente de la bomba, así que los umbrales del INA219 (prueba 9b) se vuelven a medir.
4. **Si la bomba resulta ser la de 350 L/h**, la fórmula da 87 min con 12 mm (`python formula.py --caudal-lh 350`): los 45 min no alcanzan.

Ejemplos completos (gráficas, GIF, CSV) en [`ejemplos/`](ejemplos/).

## Cómo funciona

Malla MAC 3D de la cisterna (34×24×12 celdas de 10 cm). Cada paso:

1. Viscosidad turbulenta de Smagorinsky más una de fondo, ν = C·√M.
2. Advección semi-lagrangiana de la velocidad, difusión explícita y la fuerza del chorro.
3. Proyección de presión exacta con DCT: flujo sin divergencia a precisión de máquina.
4. Transporte del cloro en forma conservativa (MUSCL con limitador van Leer, SSP-RK2): la masa de cloro se conserva exacta.

La boquilla de 12 mm no cabe en una celda de 10 cm, así que el chorro entra como una fuerza igual a su flujo de momento **M = Q·u** repartida en unas celdas frente a la bomba. Lejos de la boquilla un chorro turbulento solo depende de M, que es la misma variable de la fórmula.

El punto de operación de la bomba sale de cruzar su curva (lineal entre 700 L/h a 0 m y 0 L/h a 5 m) con la única carga que vence sumergida: la velocidad de salida u²/2g. A 12 mm da 680 L/h, 1.67 m/s.

### Por qué C = 0.02

Una malla de 10 cm no resuelve la turbulencia del chorro. Solo con Smagorinsky (C = 0) la prueba 9c simulada tarda 61 min y con malla de 7 cm todavía más: señal de que la mezcla dependía de la malla y no de la física. √M es la única escala de viscosidad que respeta t ∝ V^⅔/√M, y dentro de un chorro redondo la viscosidad turbulenta es del orden de 0.017·√M. Barrido en el protocolo de la prueba 9c:

| C | CoV < 5 % | Toda la cisterna ±10 % |
|---|---|---|
| 0 | 61 min | 71 min |
| 0.01 | 57 min | 64 min |
| 0.02 | 46 min | 45 min |
| 0.02, malla de 7 cm | 52 min | 50 min |

Con 0.02 la simulación coincide con la fórmula y la diferencia entre mallas baja a ~12 %. Es una calibración contra la correlación, no contra la cisterna real: la prueba 9c es la que manda y, si sale distinto, se ajusta `--c-nu`.

## Supuestos

Del documento: ~10 m³, nivel lleno 1.20 m, bomba a 50 cm del fondo con el chorro en la diagonal del mástil hacia la esquina opuesta, sonda ORP a 20 cm, rejilla de la bomba de pozo a ~45 cm, Cloralex ~50 mg/mL.

Inventados (cámbialos en `cisterna_sim/config.py` cuando tengas las medidas):

- Planta rectangular de 3.40 × 2.45 m.
- Posición de la boca de la tapa (1.20, 1.00), de la bomba de pozo (0.90, 1.00) y del llenado (0.25, 1.20).
- Mástil a 60° sobre la horizontal: el dibujo del doc no tiene lo horizontal a escala.
- Curva de la bomba lineal.

La posición de la dosis respecto al chorro cambia el resultado al doble, así que vale la pena medir dónde caen el llenado, la boca y la bomba de pozo y meterlos.

## Qué no modela

- **La demanda de cloro.** El H2S y la materia orgánica se comen el cloro (el doc: 150 mL llegan a cero en 2 h). Aquí el cloro es un trazador pasivo: la simulación dice adónde llega, no cuánto sobrevive.
- **El chorro del llenado.** Cuando el flotador abre, el agua que entra también mezcla. El caso "llenado" es el peor: Cloralex que cae ahí sin flujo de entrada.
- **El consumo de la casa** (la bomba de pozo succionando) ni el nivel bajando a media mezcla.
- **La superficie libre** (tapa rígida), la temperatura y la estratificación.
- **La turbulencia después de apagar la bomba:** la viscosidad de fondo se corta de golpe; en la realidad decae en unos minutos.

## Estructura

```
cisterna_sim/
  config.py    parámetros, geometría del mástil, validación
  bomba.py     punto de operación y fórmula de mezcla
  solver.py    CFD 3D: flujo y cloro
  graficas.py  PNG y GIF
simular.py     CLI de la simulación
formula.py     CLI de la fórmula
tests/         conservación de masa, divergencia, fuerza del chorro, bomba, validación
ejemplos/      corridas de referencia
```
