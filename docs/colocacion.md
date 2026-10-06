# Dónde y cómo poner la mini bomba

Resultado de 166 simulaciones con el motor JS (`web/sweep.mjs`, datos crudos en `web/resultados_barrido/`): Mibee de 12 V a 800 L/h por su salida de 8 mm, cisterna de 10 m³ a 1.20 m, dosis de 150 mL de Cloralex por el llenado, bomba arrancando con la dosis y apagada a los 45 min como el firmware, 90 min simulados. **t95** es el minuto desde el cual el coeficiente de variación de toda la cisterna queda abajo de 5 %.

## Recomendación

1. **Chorro horizontal o un poco hacia arriba (0 a +15°). Nunca hacia el fondo.** El diseño del documento (chorro a lo largo del mástil, 60° hacia abajo) quedó en el lugar 78 de 89: el chorro pega en el piso a 47 cm de la bomba y gasta ahí su empuje.
2. **A media altura: 50 cm** (50 a 70 cm da lo mismo; a 20 y 30 cm mezcla peor y barre el fondo).
3. **Apuntado al recorrido libre más largo de la cisterna**, a lo largo, con el eje del chorro a **0.75 m o más de la rejilla de la bomba de pozo**.
4. **Si se puede, del lado por donde entra el cloro** (llenado, boca B), alrededor de 1 m al lado de la boca de la tapa.
5. **Montaje:** la salida de la Mibee es radial (sale perpendicular al cuerpo, del lado contrario a la base). Para que el chorro quede horizontal, la bomba va **acostada**: base plana vertical, atornillada a una placa o abrazadera en el mástil, con la salida de 8 mm hacia donde va el chorro y la entrada axial libre (no contra la placa). **Sin codos ni conexiones G1/2 después de la salida**: tienen 13 a 16 mm por dentro y bajan el empuje del chorro (M = Q²/A) a entre 25 y 40 %; si hace falta un codo, que termine en una boquilla de ~8 mm.

Dos niveles de cambio:

| Cambio | t95 | Toda la cisterna ±10 % | Fondo (m/s) | Pico en la rejilla del pozo |
|---|---|---|---|---|
| Diseño del doc: mástil, 50 cm, -60° | 66 ± 5 min | no llega en 90 min | 0.040 | 2.3 veces la meta |
| Mismo lugar, chorro a +15° alejándose del pozo | 30 min | 33 min | 0.005 | 1.1 veces |
| A 1 m de la boca del lado del llenado, horizontal a lo largo | **13.8 ± 0.1 min** | 16.4 min | 0.005 | 0.95 veces |

El primer cambio solo es girar la bomba en el mismo mástil. El segundo pide un mástil más inclinado (unos 40° sobre la horizontal en vez de 60°) o un brazo para alcanzar 1 m de la boca.

## Qué tan firme es

**Malla y puntería.** Cada caso top se repitió con celdas de 9 y 11 cm y con la puntería ±5°:

| Configuración | t95 media ± desv (5 corridas) | mín a máx |
|---|---|---|
| Diseño del doc (-60°) | 66.2 ± 4.7 min | 61 a 72 |
| Lateral, horizontal | 13.8 ± 0.1 min | 13.7 a 14.0 |
| Lateral, +15° | 13.8 ± 0.4 min | 13.2 a 14.0 |
| Lateral, -15° | 17.0 ± 0.3 min | 16.5 a 17.3 |

**Otras geometrías.** Como la planta y las posiciones de boca, pozo y llenado son supuestas, se repitió con plantas de 2.90×2.90 y 4.00×2.10 m, con el pozo y el llenado en otro lado y con la boca cerca de una esquina (t95 en min):

| Configuración | base | cuadrada | alargada | pozo al lado | boca en esquina |
|---|---|---|---|---|---|
| Diseño del doc (-60°) | 66 | 36 | >90 | 40 | 45 |
| Lateral, horizontal a lo largo | 14 | 33 | 14 | 17 | 25 |
| Lateral, horizontal en la diagonal del mástil | 18 | 21 | 18 | 21 | 26 |

El chorro horizontal le gana al de -60° en las cinco, de 1.1 a más de 6 veces. La dirección exacta en planta sí depende de la cisterna real (en la cuadrada conviene la diagonal del mástil): esa parte se decide con el visor y las medidas reales.

**Operación** (t95 / ±10 %, en min):

| Configuración | llenado | junto al mástil | llenado a 0.70 m | sin apagar a los 45 |
|---|---|---|---|---|
| Diseño del doc | 66 / >90 | 20 / 21 | 38 / 38 | 47 / 48 |
| Lateral, horizontal | 14 / 17 | 12 / 15 | 10 / 12 | 14 / 17 |

Echar el Cloralex junto al mástil ayuda a cualquier colocación; con la bomba bien puesta casi no importa dónde caiga.

## Por qué

- **Chorro al fondo.** A -60° el eje toca el piso a 0.47 m de la boquilla. Ahí lleva unos 0.47 m/s (estimado de chorro redondo libre, u = 6.2·u₀·d/x) y se vuelve un chorro de pared que pierde empuje contra el piso. La rapidez media en la capa del fondo sale 8 veces mayor que con el chorro horizontal (0.040 contra 0.005 m/s): eso levanta el lodo que haya.
- **Recorrido libre.** Un chorro jala agua a su alrededor mientras viaja; horizontal a lo largo recorre 2.8 m antes de la pared contra 0.6 m del diseño del doc, y mueve mucha más agua.
- **Cortocircuito.** Con el chorro cerca de la rejilla, el cloro recién echado llega a la llave de la casa a 2 o 3 veces la meta en los primeros 10 min.

## Límites

- La planta (3.40 × 2.45 m) y las posiciones de la boca, la bomba de pozo y el llenado son supuestas. Los minutos exactos cambian con la cisterna real; el orden (horizontal mucho mejor que -60°) se sostuvo en las cinco geometrías.
- Caudal de la ficha (800 L/h) sin medir. Con menos caudal todo se alarga más o menos en proporción a 1/Q.
- Modelo con celdas de 10 cm y turbulencia de fondo calibrada contra la correlación t = 10.2·V^⅔/√M. El estudio de convergencia de malla en GPU (`convergencia.py`) es el siguiente paso para quitar esa dependencia.
- La prueba 9c en la cisterna real es la que manda.
