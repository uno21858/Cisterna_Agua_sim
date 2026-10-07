# La propuesta de Erick en su cisterna redonda

Estudio vigente (7 oct) de dónde y cómo poner la Mibee. Sustituye a [`colocacion.md`](colocacion.md), que se hizo con planta rectangular y el mástil diagonal del documento.

## Qué se simuló

105 simulaciones con el motor JS: `web/propuesta.mjs` (datos crudos en `web/resultados_propuesta/casos.jsonl`; `node web/propuesta.mjs --reporte` regenera las tablas en `web/resultados_propuesta/reporte.md`).

- **Cisterna**: redonda, 3.26 m de diámetro con 1.20 m de agua (10.0 m³), malla de 33 × 33 × 12 celdas de unos 10 cm. El diámetro es **supuesto**: el cilindro que da 10 m³ a 1.20 m.
- **Boca y tubo**: boca de la tapa al centro (**supuesto**) y el tubo vertical parado en el piso bajo ella. La Mibee va amarrada al tubo con el cuerpo vertical (toma arriba) y la boquilla a 6 cm del eje, del lado hacia donde escupe.
- **Bomba de pozo**: rejilla a 45 cm del fondo (documento) y a 30 cm de la boca (**supuesto**).
- **Flotador** (boca B, por donde se echa el cloro): a 25 cm de la bomba de pozo (**supuesto**). Erick dijo que está junto a la bomba de pozo, pero no de qué lado, así que se probaron dos: **F1, a un lado** y **F2, entre el pozo y la pared** (ver dibujo).
- **Mibee**: 800 L/h por su salida de 8 mm (ficha, **sin medir**): chorro de 4.4 m/s y flujo de momento M = 9.8·10⁻⁴ m⁴/s².
- **Dosis**: 150 mL de Cloralex (7.5 g de cloro) por el flotador. La bomba arranca con la dosis y se apaga a los 45 min, como el firmware; 90 min simulados. La **meta** es la concentración con mezcla perfecta: 0.74 mg/L con esta dosis.
- **t95**: minuto desde el cual el coeficiente de variación de toda la cisterna queda abajo de 5 %. **±10 %**: minuto desde el cual toda la cisterna queda entre 90 y 110 % de la meta. **Pico en la rejilla**: lo más alto que llega el cloro a la rejilla del pozo en los primeros 10 min, en veces la meta.

Planta vista desde arriba. El azimut del chorro se mide en grados desde la boca, positivo en contra de las manecillas:

```
                          90
                          ^
               F1         |
                          |
   pared   F2      P -----B----->  0        pared a 1.63 m de B en toda dirección
                 (pozo) (tubo)
                          |
                         -90

   B  boca y tubo, al centro de la cisterna
   P  rejilla de la bomba de pozo, 30 cm de B hacia 180
   F1 flotador "a un lado": 25 cm de P hacia 90 (visto desde B, hacia 140)
   F2 flotador "entre el pozo y la pared": 25 cm de P hacia 180
```

Etapas: (1) 8 direcciones (0, ±45, ±90, ±135 y 180) × 3 inclinaciones (-15, 0 y +15°) a 50 cm con cada flotador, más dos referencias; (2) alturas de 35, 65 y 80 cm para las 2 direcciones que mezclan más rápido con cada flotador; (3) la casa usando 15 L/min desde que se echa el cloro; (4) firmeza: celdas de 9 y 11 cm y la puntería ±5°; (5) cloro echado junto al tubo en vez del flotador.

## Recomendación

1. **Tubo vertical bajo la boca y la bomba a 50 cm del piso** (al centro de la boquilla), con el cuerpo vertical y la toma arriba, como la propuso Erick. De las alturas probadas (35 a 80 cm), 50 cm es la que va bien con el flotador de cualquiera de los dos lados.
2. **Chorro horizontal, apuntado al lado contrario del flotador.** Desde la boca, ubica el flotador y apunta el chorro justo al revés, siguiendo la línea flotador → tubo. Así también se aleja de la bomba de pozo. t95 de **14.3 min** con F1 (azimut -45) y **14.7 min** con F2 (azimut 0); errar la puntería 5° no cambia nada (el contrario exacto de F1 es -40, el caso +5° de la tabla de firmeza: 14.2 min).
3. **Inclinación: horizontal, o hasta 15° hacia arriba**, que da igual o mejor (15.3 min con F1, 11.0 con F2). **Nunca hacia el fondo**: a -15° no se gana (empate con F1, 1 min peor con F2) y se barre más el piso; el -60° del documento tarda 23 a 29 min y barre el fondo 4 a 7 veces más rápido.
4. **El cloro, por el flotador (boca B), como ya se piensa hacer.** Echarlo junto al tubo baja a la mitad el pico en la rejilla, pero la mezcla tarda 21 min en vez de 14 a 15.
5. **Echarlo cuando nadie esté usando agua, y no abrir llaves en los 10 min siguientes.** El flotador queda a 25 cm de la succión de la casa. Sin consumo, la rejilla queda abajo de 2 veces la meta a los 3 a 4 min y dentro de +10 % a los 6 a 10 min. Si la casa está jalando agua al echarlo, a la llave le llega un golpe de hasta 14 a 16 veces la meta (unos 10 a 12 mg/L) y pasa 1.7 min arriba de 2 veces, aunque solo se va el 3 % del cloro (ver "Con la casa usando agua").
6. **Si no se puede evitar que la casa use agua al echar el cloro**: chorro hacia el flotador y 15° arriba (azimut 135 con F1, 180 con F2). Aleja la nube de la rejilla: el pico en la llave baja a 3.7 veces (F1) o a 1.0 (F2) y se va a la casa 2.1 % o 1.4 % del cloro en 10 min, a cambio de 20 min de t95 en vez de 14 a 15.
7. **Montaje**: sin codos ni conexiones G1/2 después de la salida de 8 mm; tienen 13 a 16 mm por dentro y bajan el empuje del chorro (ver [`colocacion.md`](colocacion.md)).

| Configuración, a 50 cm | t95 con F1 | t95 con F2 | ±10 % (F1 / F2) | Pico en la rejilla (F1 / F2) | Fondo, m/s (F1 / F2) |
|---|---|---|---|---|---|
| **Recomendada: horizontal, contrario al flotador** (F1: -45; F2: 0) | **14.3** | **14.7** | 15.7 / 17.3 | 3.73 / 4.90 | 0.007 / 0.013 |
| La misma, 15° hacia arriba | 15.3 | 11.0 | 18.2 / 12.5 | 3.40 / 4.53 | 0.005 / 0.007 |
| La misma, 15° hacia abajo | 13.7 | 15.8 | 15.2 / 18.8 | 3.92 / 5.07 | 0.010 / 0.016 |
| Horizontal alejándose del pozo (0; con F2 es la recomendada) | 16.3 | 14.7 | 18.8 / 17.3 | 4.05 / 4.90 | 0.013 / 0.013 |
| Horizontal de lado (90 y -90) | 22.2 y 17.5 | 22.0 | 24.7 y 20.0 / 23.8 | 3.40 y 3.38 / 4.96 | 0.013 / 0.013 |
| Hacia el flotador, 15° arriba (F1: 135; F2: 180) | 20.0 | 20.0 | 23.0 / 22.8 | 1.28 / 0.98 | 0.005 / 0.007 |
| Horizontal hacia el pozo (180) | 22.3 | 22.7 | 25.0 / 25.3 | 2.36 / 1.53 | 0.013 / 0.013 |
| Referencia: tangencial junto a la pared | 15.8 | 18.2 | 17.3 / 20.3 | 3.74 / 3.09 | 0.012 / 0.012 |
| Referencia: diseño del documento (mástil a 60°, chorro -60°) | 22.8 | 29.2 | 23.3 / 30.2 | 3.42 / 3.62 | 0.051 / 0.051 |

"Fondo" es la rapidez máxima en la capa de agua pegada al piso, promediada mientras la bomba anda: lo que puede levantar lodo.

## Todas las direcciones a 50 cm

t95 en min y, entre paréntesis, el pico en la rejilla en veces la meta.

Con F1 (flotador a un lado):

| azimut | -15° | 0° | +15° |
|---|---|---|---|
| 0 | 16.7 (4.25) | 16.3 (4.05) | 16.7 (3.65) |
| 45 | 22.2 (4.20) | 20.7 (4.00) | 19.5 (3.63) |
| **-45** | **13.7 (3.92)** | **14.3 (3.73)** | 15.3 (3.40) |
| 90 | 22.8 (3.72) | 22.2 (3.40) | 20.2 (2.86) |
| -90 | 18.3 (3.65) | 17.5 (3.38) | 17.3 (2.96) |
| 135 | 23.3 (3.34) | 22.0 (2.20) | 20.0 (1.28) |
| -135 | 22.7 (5.71) | 21.0 (4.54) | 19.8 (3.22) |
| 180 | 22.8 (5.61) | 22.3 (2.36) | 20.2 (1.02) |

Con F2 (flotador entre el pozo y la pared; todo es simétrico, así que 45 y -45 dan lo mismo):

| azimut | -15° | 0° | +15° |
|---|---|---|---|
| **0** | 15.8 (5.07) | **14.7 (4.90)** | **11.0 (4.53)** |
| 45 y -45 | 19.8 (5.08) | 17.3 (4.93) | 16.2 (4.55) |
| 90 y -90 | 23.8 (5.24) | 22.0 (4.96) | 19.2 (4.37) |
| 135 y -135 | 24.5 (5.76) | 22.7 (4.36) | 21.2 (3.03) |
| 180 | 23.0 (3.94) | 22.7 (1.53) | 20.0 (0.98) |

Con F2 se corrieron también los azimuts negativos: los 9 pares en espejo dieron cifras idénticas, una prueba de que el motor no mete asimetrías propias.

## Altura

t95 en min con el chorro en la dirección recomendada:

| Altura de la boquilla | 35 cm | **50 cm** | 65 cm | 80 cm |
|---|---|---|---|---|
| F1, -45, horizontal | 12.3 | 14.3 | 17.8 | 20.2 |
| F1, -45, 15° abajo | 13.0 | 13.7 | 18.7 | 20.2 |
| F2, 0, horizontal | 19.3 | 14.7 | 12.7 | 16.7 |
| F2, 0, 15° arriba | 15.0 | 11.0 | 13.3 | 18.2 |
| **Peor de los dos flotadores, horizontal** | 19.3 | **14.7** | 17.8 | 20.2 |

Con F1 conviene bajar y con F2 subir; sin saber de qué lado está el flotador, 50 cm es la que menos arriesga. Más arriba baja el pico en la rejilla (1.2 a 2.1 veces a 80 cm) pero la mezcla se alarga a 17 a 20 min.

## Qué tan firme es

Cada candidata se repitió con celdas de 9 y 11 cm y con la puntería ±5° (t95 en min):

| Configuración | nominal | celdas de 9 cm | celdas de 11 cm | -5° | +5° | media ± desv |
|---|---|---|---|---|---|---|
| F1, -45, horizontal | 14.3 | 13.8 | 14.7 | 14.5 | 14.2 | 14.3 ± 0.3 |
| F1, -45, 15° abajo | 13.7 | 13.3 | 14.0 | 13.8 | 13.5 | 13.7 ± 0.3 |
| F2, 0, horizontal | 14.7 | 15.2 | 13.8 | 14.3 | 14.3 | 14.5 ± 0.5 |
| F2, 0, 15° arriba | 11.0 | 11.0 | 11.0 | 11.2 | 11.2 | 11.1 ± 0.1 |

Las diferencias de 1 min o más entre configuraciones son reales; las de medio minuto, no (por eso -15° y horizontal con F1 cuentan como empate).

## Dónde echar el cloro

Con la recomendada (F1: -45, F2: 0, horizontal, 50 cm). "Junto al tubo" es en la boca, 10 cm bajo el nivel del agua:

| Cloro | t95 (F1 / F2) | ±10 % (F1 / F2) | Pico en la rejilla (F1 / F2) | Rejilla abajo de 2 veces la meta desde (F1 / F2) | Rejilla dentro de +10 % desde (F1 / F2) |
|---|---|---|---|---|---|
| **Por el flotador** | **14.3 / 14.7** | 15.7 / 17.3 | 3.73 / 4.90 | 3.2 / 4.3 min | 5.7 / 9.7 min |
| Junto al tubo | 20.8 / 21.0 | 23.7 / 23.5 | 2.10 / 2.33 | 1.7 / 2.2 min | 3.3 / 4.3 min |

Por el flotador mezcla 6 min más rápido. Junto al tubo solo convendría si no se puede controlar el uso de agua al echarlo (ver la tabla siguiente), y aun así el chorro hacia el flotador protege más la llave.

## Con la casa usando agua

La casa jala 15 L/min por la rejilla del pozo desde el momento de la dosis, y el flotador repone lo mismo en el mismo lugar donde cayó el cloro, con su propio chorro hacia abajo. Fracción de los 7.5 g que se va a la casa:

| Caso | a la casa en 10 min (F1 / F2) | en 45 min (F1 / F2) | Pico en la llave, veces la meta (F1 / F2) | Minutos arriba de 2 veces la meta (F1 / F2) |
|---|---|---|---|---|
| **Recomendada, cloro por el flotador** | **2.9 / 3.2 %** | **7.8 / 8.0 %** | 13.8 / 16.4 | 1.7 / 1.7 |
| Recomendada, cloro junto al tubo | 2.5 / 2.8 % | 7.4 / 7.7 % | 9.6 / 9.9 | 1.5 / 1.8 |
| Hacia el flotador, 15° arriba (F1: 135; F2: 180) | 2.1 / 1.4 % | 7.1 / 6.5 % | 3.7 / 1.0 | 1.2 / 0.0 |
| Hacia el pozo, 15° arriba (180), solo F1 | 2.3 % | 7.2 % | 5.4 | 1.5 |
| La de mezcla más rápida (F1: -45 a -15°; F2: 0 a +15°) | 2.9 / 3.2 % | 7.8 / 8.0 % | 13.7 / 16.2 | 1.7 / 1.7 |
| Tangencial junto a la pared | 3.4 / 3.1 % | 8.2 / 7.9 % | 15.3 / 14.1 | 2.2 / 2.2 |
| Diseño del documento | 3.3 / 3.5 % | 8.1 / 8.3 % | 14.1 / 14.5 | 2.3 / 2.3 |
| Sin bomba de mezcla, cloro por el flotador | 4.1 / 4.1 % | 8.9 / 9.0 % | 19.5 / 19.5 | 2.5 / 2.5 |
| Sin bomba de mezcla, cloro junto al tubo | 4.4 / 4.8 % | 9.2 / 9.7 % | 16.5 / 12.6 | 3.2 / 4.3 |
| Mezcla perfecta e instantánea (cuenta, no simulación) | 1.5 % | 6.5 % | 1 | 0 |

"Pico en la llave" es el promedio de 10 s de lo que sale por la rejilla. Con esta dosis la meta es 0.74 mg/L, así que 14 veces son unos 10 mg/L.

- **Cuánto se va**: con la recomendada, 2.9 a 3.2 % del cloro en los primeros 10 min y 7.8 a 8.0 % en 45 min. Con mezcla perfecta se irían 1.5 y 6.5 % de todos modos (es el agua que sale); lo que se pierde de más por echarlo junto a la succión es 1.4 a 1.7 puntos, unos 0.1 g. Sin bomba de mezcla se pierde 2.6 puntos de más.
- **Lo que se nota** no es la cantidad sino el golpe en la llave: hasta 14 a 16 veces la meta y 1.7 min arriba de 2 veces con la recomendada; hasta 20 veces y 2.5 min sin bomba. Por eso la regla de no usar agua los primeros 10 min (punto 5), o el chorro hacia el flotador si eso no se puede (punto 6).
- Con consumo el t95 sale más corto (9.8 a 11.3 min con la recomendada) porque el chorro del flotador también mezcla: con 15 L/min por un chorro de 13 mm tiene la mitad del momento de la Mibee. La columna ±10 % pierde sentido con consumo (entra agua sin cloro y la media baja), por eso no aparece.

## La referencia tangencial

Bomba a 30 cm de la pared del lado contrario al pozo, chorro horizontal tangente a la pared. Sí hace girar toda la cisterna: el agua gira en promedio a 0.47 cm/s de los 0.62 cm/s de rapidez media (76 %), contra prácticamente 0 con el chorro desde el centro. Pero no mezcla mejor: t95 de 15.8 min con F1 y 18.2 con F2, contra 14.3 y 14.7 de la recomendada; barre el fondo igual o un poco más (0.012 m/s contra 0.007 a 0.013) y pide la bomba a 1.33 m del centro (un brazo o un tubo inclinado unos 33° desde la boca). Al girar como un bloque, el agua lleva la nube de cloro alrededor, pero el intercambio entre el centro y la orilla es lento. No conviene cambiar la propuesta por esto.

## Por qué (interpretación de las simulaciones)

- **Desde el centro todas las direcciones tienen el mismo recorrido libre** (1.6 m hasta la pared), a diferencia de la planta rectangular. Lo que cambia es dónde queda la nube de cloro respecto al chorro. El chorro jala el agua de alrededor del tubo, también la de atrás; apuntado al lado contrario del flotador, toma la nube que cayó a 40 o 55 cm del tubo y la lleva de una pasada a toda la cisterna. Apuntado hacia el flotador o el pozo, la empuja hacia la pared de ese lado y la reparte desde ahí, lo que tarda más (20 a 23 min), aunque la aleja de la rejilla.
- **La inclinación** ayuda o estorba poco según el lado del flotador (con F2, +15° baja a 11 min; con F1, -15° gana medio minuto). Horizontal es la que nunca sale mal.
- **El diseño del documento** desperdicia el chorro: a -60° pega en el piso a 29 cm de la boquilla. La rapidez media del agua queda en 0.29 cm/s contra 0.55 a 0.60 con los chorros horizontales desde el tubo, y la máxima del fondo en 5.1 cm/s contra 0.7 a 1.3: mezcla peor y levanta más lodo.
- **El pico en la rejilla** sale de 3 a 5 veces la meta con casi cualquier chorro porque el cloro cae a 25 cm de la succión. Solo los chorros hacia el flotador o el pozo con 15° arriba barren la nube lejos de la rejilla (1.0 a 1.3 veces).

## Límites

- **Geometría supuesta**: el diámetro (3.26 m), la boca al centro, la bomba de pozo a 30 cm de la boca y el flotador a 25 cm del pozo. La regla "contrario al flotador" salió igual con los dos lados probados, pero solo con la boca al centro; si la boca está cargada hacia una pared, un chorro horizontal desde ahí puede hacer girar la cisterna y las direcciones cambian. Con las medidas reales se revisa en el visor o relanzando este barrido.
- **Caudal sin medir**: 800 L/h es la ficha. Con la boquilla fija, el momento va con Q², así que con menos caudal los tiempos crecen más o menos como 1/Q.
- **Modelo**: celdas de 10 cm y turbulencia de fondo calibrada contra la correlación t = 10.2·V^⅔/√M (25 min para esta bomba y este volumen). Con celdas de 9 y 11 cm el t95 se movió 0.9 min o menos, pero eso no sustituye el estudio de convergencia en GPU. El tubo, la bomba de pozo y la Mibee no son obstáculos en el modelo.
- **El cloro es un trazador pasivo**: no se hunde por ser más denso que el agua ni se consume.
- **Consumo**: 15 L/min constantes desde el momento de la dosis es el peor caso; el uso real es a ratos. El chorro del flotador se modeló de 13 mm (supuesto).
- La prueba en la cisterna real es la que manda.
