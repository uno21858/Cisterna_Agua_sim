# Simulación de mezcla: cisterna de 10,000 L con la mini bomba Mibee

Simula cómo mueve el agua la mini bomba de mezcla (Mibee brushless de 12 V, 800 L/h y 5 m según la ficha, salida radial de 8 mm) dentro de la cisterna de 10 m³, y cuánto tarda en repartir una dosis de Cloralex. Sale del documento de proyecto *Cloración automática de la cisterna* (fase 1, prueba 9c).

Tres piezas que comparten la misma física:

| Pieza | Para qué | Dónde corre |
|---|---|---|
| **Visor en vivo** (`web/`) | Ver el flujo en planta y corte, mover la bomba y el chorro, echar cloro | Tu navegador (artifact de claude.ai, o local) |
| **Simulador Python** (`cisterna_sim/`, `simular.py`) | Corridas completas con gráficas, GIF y CSV; fuente de verdad de la física | CPU con numpy o GPU con CuPy |
| **Barrido** (`web/sweep.mjs`) | Cientos de casos para decidir dónde y con qué ángulo va la bomba | Node |

## Lo que salió

**Dónde y cómo poner la bomba** (detalle y tablas en [`docs/colocacion.md`](docs/colocacion.md)):

1. Chorro **horizontal o un poco hacia arriba**, nunca hacia el fondo. El diseño del documento (60° hacia abajo) tarda 66 ± 5 min y barre el piso; el mismo lugar con el chorro a +15° baja a 30 min.
2. A **50 cm** del fondo, apuntado **a lo largo** de la cisterna, con el eje del chorro a 0.75 m o más de la rejilla de la bomba de pozo.
3. Mejor aún a ~1 m de la boca, del lado por donde entra el cloro: **13.8 ± 0.1 min**.
4. La bomba va **acostada** para que su salida de 8 mm quede horizontal, sin codos G1/2 después de la salida (frenan el chorro).

El chorro horizontal le ganó al de -60° en las cinco geometrías que se probaron; los minutos exactos dependen de la cisterna real.

**La bomba** (`python formula.py`): con la salida de fábrica de 8 mm y los 800 L/h de la ficha, la fórmula da 25 min a tanque lleno. Una reducción a 6-7 mm casi no cambia nada y una manguera más ancha empeora (16 mm: 50 min). Lo que más importa es el caudal real: medirlo llenando una cubeta y meterlo con `--caudal-lh`.

## Visor en vivo

Publicado como artifact: https://claude.ai/artifact/JhRSrqH8qXQSp3DYJqTi9H (privado hasta que lo compartas). La simulación corre en tu dispositivo, en un Web Worker, a ~30 veces el tiempo real con celdas de 10 cm.

Local:

```bash
npx http-server web -p 8080 -c-1     # y abre http://localhost:8080/dev.html
node --test web/test/                # 30 pruebas del motor, incluida la paridad con Python
```

## Simulador Python

```bash
pip install -r requirements.txt

python simular.py --f32                                   # diseño del doc, dosis por el llenado, bomba 45 min
python simular.py --f32 --pos-bomba 0.65 1.835 0.5 --azimut 348.4 --elevacion 0   # la colocación recomendada
python simular.py --dosis mastil --precalentar 600 --bomba-min 60                 # protocolo de la prueba 9c
python formula.py --caudal-lh 550                         # con el caudal que midas
python -m pytest                                          # 25 pruebas
```

Salidas en `resultados/` (o `--salida`): `mezcla.png` (lo que verían las tiras de la prueba 9c), `flujo.png` (corte y planta del flujo promedio), `cloro.gif`, `serie.csv`, `resumen.json`. Corridas de referencia en [`ejemplos/`](ejemplos/).

### En GPU (server con las 3060)

```bash
pip install -r requirements.txt cupy-cuda13x
python convergencia.py --bench --gpu --f32                          # ms por paso y cuánto tardaría cada malla
CUDA_VISIBLE_DEVICES=0 python convergencia.py --gpu --f32 --dx 0.10 0.05 0.033
CUDA_VISIBLE_DEVICES=1 python convergencia.py --gpu --f32 --dx 0.025
python convergencia.py --reporte                                    # tabla y convergencia.png
```

`convergencia.py` repite la prueba 9c afinando la malla, con y sin la turbulencia de fondo calibrada. Si con `c_nu = 0` el tiempo converge cerca de la fórmula, el modelo deja de depender de la calibración. Se reanuda solo si se corta, y cada GPU puede correr su lista. `--f32` porque las GeForce son lentas en doble precisión; en CPU la precisión simple da el mismo resultado que la doble a 1e-4.

## ¿Por qué Python y JS, y no C++?

Medido aquí con celdas de 10 cm (10 mil celdas): Python con numpy tarda 16 ms por paso (10 ms en precisión simple), el motor JS 4.9 ms. A este tamaño numpy pierde contra un lenguaje compilado porque cada operación es una llamada corta desde Python; C++ quizá bajaría a ~1 ms, pero ya sobra: JS corre a 76 veces el tiempo real y además vive en el navegador, que es lo que permite el visor en vivo sin instalar nada.

Lo que sí limita el realismo es la resolución. Con celdas de 2 a 3 cm hay de 0.6 a 1.3 millones de celdas y ahí conviene la GPU: el mismo código Python con CuPy, sin reescribir nada en CUDA. Resolver de verdad la boquilla de 8 mm pediría celdas de 1 a 2 mm y un mallador tipo OpenFOAM: días de cómputo, y la duda más grande seguiría siendo la geometría real y el caudal real, no la malla.

## Cómo funciona

Malla MAC 3D de la cisterna. Cada paso:

1. Viscosidad turbulenta de Smagorinsky más una de fondo, ν = C·√M.
2. Advección semi-lagrangiana de la velocidad, difusión explícita y la fuerza del chorro.
3. Proyección de presión exacta con DCT: flujo sin divergencia a precisión de máquina.
4. Transporte del cloro en forma conservativa (MUSCL con limitador van Leer, SSP-RK2): la masa se conserva exacta.

La boquilla no cabe en una celda de 10 cm, así que el chorro entra como una fuerza igual a su flujo de momento **M = Q·u** repartida en unas celdas frente a la bomba. Lejos de la boquilla un chorro turbulento solo depende de M, la misma variable de la fórmula.

**Punto de operación.** La ficha (800 L/h a 0 m) se mide descargando libre por la salida de fábrica, así que con esa salida la bomba da su caudal máximo. Una reducción más chica agrega K·(u_b² − u_s²)/2g contra la curva lineal entre 800 L/h a 0 m y 0 L/h a 5 m.

**Consumo de la casa** (solo en el motor JS y el visor): sumidero en la rejilla de la bomba de pozo y fuente con chorro en el llenado, con balance de masa del cloro.

### Por qué C = 0.02

Una malla de 10 cm no resuelve la turbulencia del chorro. Solo con Smagorinsky (C = 0) la prueba 9c simulada tardaba 61 min, y con malla de 7 cm todavía más: la mezcla dependía de la malla y no de la física. √M es la única escala de viscosidad que respeta t ∝ V^⅔/√M, y dentro de un chorro redondo la viscosidad turbulenta es del orden de 0.017·√M. Barrido en el protocolo de la prueba 9c (hecho con la bomba del doc, 700 L/h por 12 mm; C no tiene unidades y no depende de la bomba):

| C | CoV < 5 % | Toda la cisterna ±10 % |
|---|---|---|
| 0 | 61 min | 71 min |
| 0.01 | 57 min | 64 min |
| 0.02 | 46 min | 45 min |
| 0.02, malla de 7 cm | 52 min | 50 min |

Fórmula: 44 min. Con 0.02 la simulación coincide y la diferencia entre mallas baja a ~12 %. Es una calibración contra la correlación, no contra la cisterna real: la prueba 9c manda y, si sale distinto, se ajusta `--c-nu`. Con consumo, el chorro del llenado también entra en esa viscosidad: C·√(M_bomba + M_llenado).

## Supuestos

Del documento: ~10 m³, nivel lleno 1.20 m, bomba a 50 cm del fondo en un mástil diagonal, sonda ORP a 20 cm, rejilla de la bomba de pozo a ~45 cm, Cloralex ~50 mg/mL.

Supuestos (cámbialos en `cisterna_sim/config.py` o en el modo "editar cisterna" del visor cuando tengas las medidas):

- Planta rectangular de 3.40 × 2.45 m.
- Boca de la tapa en (1.20, 1.00), bomba de pozo en (0.90, 1.00) y llenado en (0.25, 1.20) m.
- Mástil a 60° sobre la horizontal: el dibujo del doc no tiene lo horizontal a escala.
- Curva de la bomba lineal; 800 L/h de la ficha sin verificar.

## Qué no modela

- **La demanda de cloro.** El H2S y la materia orgánica se comen el cloro (el doc: 150 mL llegan a cero en 2 h). Aquí el cloro es un trazador pasivo: la simulación dice adónde llega, no cuánto sobrevive.
- **La superficie libre** (tapa rígida), la temperatura y la estratificación.
- **El nivel bajando a media mezcla** cuando trabaja la bomba de pozo.
- **La turbulencia después de apagar la bomba:** la viscosidad de fondo se corta de golpe; en la realidad decae en unos minutos.

## Estructura

```
cisterna_sim/      física de referencia en Python (CPU o GPU)
  config.py        parámetros, geometría del mástil, validación
  bomba.py         punto de operación y fórmula de mezcla
  solver.py        CFD 3D: flujo y cloro
  graficas.py      PNG y GIF
simular.py         CLI de la simulación
formula.py         CLI de la fórmula
convergencia.py    estudio de convergencia de malla (GPU)
web/
  solver.js        port del solver a JS, validado contra Python (error < 1e-15)
  worker.js        motor del visor en un Web Worker
  index.html, app.js   visor en vivo
  sweep.mjs        barrido de colocación
  resultados_barrido/  166 casos crudos
  test/            pruebas del motor y referencia de Python
docs/colocacion.md dónde y cómo poner la bomba
tests/             pruebas del simulador Python
ejemplos/          corridas de referencia: diseño del doc contra colocación recomendada
```
