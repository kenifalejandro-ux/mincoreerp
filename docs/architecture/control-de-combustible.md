# Control de combustible y anti-fuga de capital

- **Estado**: Fases A, B y C implementadas. Fase D (conciliación, anomalías, anulación de despachos, sobredespacho) pendiente — ver hoja de ruta al final.
- **Relacionado**: [ADR-0002](../adr/0002-contrato-de-modulo.md) (Combustible ya es un módulo con contrato; §8 documenta la cola offline de la que depende todo el punto 1).

---

## Por qué existe este documento

El análisis que sigue se armó en una sesión de chat, no en código. Ya se perdió una vez. Las fases B, C y D se van a construir semanas después de esta decisión, sobre supuestos que hoy solo viven acá — si este documento se pierde de nuevo, cualquiera (yo incluido, en otra sesión) va a reinventar peor lo que ya está resuelto.

El módulo resuelve un problema concreto: un grifero despacha combustible en campo, a veces sin señal, con papel (vale) como respaldo físico. El sistema tiene que detectar fuga de capital (combustible que sale sin quedar registrado, o que se registra distinto de lo que salió) sin generar tantas falsas alarmas que el control se vuelva ruido y nadie lo mire.

## Caso de referencia

Surtidor "Grifo Cantera", grifero Juan, equipos EX-04 (excavadora), VQ-12 (volquete), CG-02 (cargador). El contómetro se resetea a 0,0 antes de cada despacho. Juan tiene el block de vales serie A, numerados 00021 a 00050.

| Vale  | Equipo | Contómetro | Cantidad |
| ----- | ------ | ---------- | -------- |
| 00021 | EX-04  | 0,0 → 35,0 | 35 gal   |
| 00022 | VQ-12  | 0,0 → 28,0 | 28 gal   |
| 00023 | CG-02  | 0,0 → 35,0 | 35 gal   |
| 00024 | VQ-12  | 0,0 → 22,0 | 22 gal   |

Contómetro y Cantidad muestran el mismo número a propósito: como el aparato siempre arranca en 0,0, el cierre del contómetro y la cantidad declarada son el mismo dato, tipeado dos veces por la misma persona — de ahí sale el chequeo del punto 5.

Los cinco puntos de abajo se explican todos sobre este mismo caso.

---

## 1. Hueco de talonario — el único chequeo de continuidad entre despachos

Martes 08:15: Juan despacha 35 gal a EX-04 (vale 00021, serie A). La tablet está sin señal → el vale queda en cola en el dispositivo, todavía no llegó al servidor.

Martes 10:30: despacha 28 gal a VQ-12 (vale 00022, serie A). Acá sí hay señal → sincroniza al instante.

A las 11:00 el servidor solo tiene el vale 00022 de la serie A, y el preview de conciliación (ver punto 4) marca:

```
⚠ Hueco de talonario: falta el vale 00021 de la serie A
```

Es una falsa alarma: falta un registro que sí existe, pero todavía está en la tablet de Juan. A las 18:00, cuando vuelve la señal y el 00021 sincroniza, la alarma desaparece sola.

**Por qué ya no hay una segunda alarma acá**: el diseño original disparaba también "salto de contómetro", comparando el último cierre conocido contra la apertura del vale 00022 — razonando que el contómetro encadena un vale con el siguiente (el cierre de uno es la apertura del otro). Se confirmó con el cliente que el contómetro del surtidor se resetea a cero en cada despacho: esa cadena de cierre/apertura entre vales distintos no existe, así que ese cálculo no se puede hacer con el dato real (ver punto 2). El contómetro sigue vivo, pero acotado a la validación DENTRO de un mismo vale — que lo tipeado coincida con lo que el aparato marcó en esa transacción puntual (punto 5) — no a la continuidad entre transacciones.

**Implicación de diseño**: un solo motor de conciliación, un solo dato — la secuencia de N°VALE dentro de su serie de talonario (ver alcance del correlativo en el punto 2), no dos validadores independientes que puedan divergir entre sí. Igual que antes, esto nunca bloquea el registro en cancha: el hueco solo aparece en el preview/conciliación de período (punto 4); lo que sí bloquea en el momento es que el vale se contradiga a sí mismo (punto 5).

## 2. El N°VALE es el número de secuencia, no el contómetro ni el reloj

Para verificar continuidad hay que ordenar los vales. Ninguno de los dos relojes obvios sirve para eso.

**El contómetro no ordena nada.** Se le preguntó al cliente y confirmó: el contador del surtidor se resetea a cero en cada despacho — no es un acumulado que crece vale tras vale, es el instrumento que produce el número de GALONES de esa transacción puntual (0 → 35 en un vale, 0 → 28 en el siguiente). No hay lectura que encadene el cierre de un vale con la apertura del siguiente, que es justo lo que el diseño original de este punto asumía. Ese mecanismo (ordenar por `totalizador_inicio`/`totalizador_fin`) no se puede implementar con el dato real.

**El reloj del dispositivo tampoco**: se resetea, cambia de zona horaria, nadie lo nota. Ejemplo: la tablet de Juan tiene el reloj 4 horas adelantado.

| Vale  | Hora real | Hora que graba la tablet |
| ----- | --------- | ------------------------ |
| 00023 | 10:00     | 14:00 ❌                 |
| 00024 | 12:00     | 12:00 ✓                  |

Si se ordena por hora de despacho: 00024 (12:00) antes que 00023 (14:00) → el N°VALE retrocedió del 24 al 23. Imposible, el talonario se llena en orden a mano.

Si se ordena por N°VALE: 00023 antes que 00024, como corresponde — el reloj mal puesto no cambia nada.

**Regla**: el N°VALE — el correlativo escrito a mano en el talonario físico — ordena los vales, nunca el timestamp del dispositivo ni una lectura de contómetro. Es el único dato de campo que de verdad se llena siempre, sin excepción, en cada vale del tanque propio de Huamachuco (a diferencia de H.ABST y OROMETRO, que quedan en blanco en todos los cierres ahí).

**Consecuencia gratis** (se mantiene igual): si ordenar por N°VALE y ordenar por timestamp dan resultados distintos, eso en sí mismo es señal de un reloj mal puesto o una fecha falseada — sale de comparar los dos órdenes, no hay que diseñar un control aparte.

**Alcance del correlativo — reinicia por talonario**: el N°VALE no es una secuencia continua a lo largo del año, reinicia con cada talonario/serie nuevo (dos talonarios distintos pueden tener ambos un vale 00023). La continuidad se verifica DENTRO de la misma serie, nunca comparando números entre series distintas — `combustible_despachos` necesita un campo de serie/talonario además del número, o cualquier chequeo de hueco dispara falsos positivos apenas arranca un talonario nuevo.

**Reservado, no descartado**: `combustible.totalizador_actual` (columna de la Fase A) queda reservada por si el surtidor tiene, además del contador de venta que se resetea, un acumulado mecánico de por vida que nunca vuelve a cero — pregunta todavía sin responder por el cliente. Si existe, ese dato puede reforzar este punto y el punto 1 (detectar combustible que salió sin vale). Hasta tener la respuesta, el control real de este punto es el N°VALE.

## 3. Talonarios: hace falta una válvula de escape

Miércoles: a Juan se le vuelca diesel encima del vale 00025 y queda ilegible. Lo arranca, lo tira, usa el 00026.

**Sin mecanismo de anulación**, el sistema dispara:

```
⚠ Vale 00025 no registrado — posible despacho no declarado
   Responsable del block: Juan Pérez
```

La primera vez Juan explica que se mojó. La segunda, también. A la tercera su jefe ya lo mira raro. A la cuarta, Juan —que es honesto— carga un vale 00025 inventado (20 gal a un volquete cualquiera) solo para que la secuencia cierre y lo dejen en paz. Resultado: el control diseñado para detectar fraude acaba de fabricar un despacho falso, con la merma de ese volquete mal calculada de ahí en adelante.

**Con mecanismo de anulación**: Juan registra en segundos "vale 00025 anulado — se mojó con diesel, colilla guardada en el block". El número queda rendido, la colilla física es la prueba, no hay alarma.

**Por qué esto no debilita el control**: una vez que existe una salida legítima para un vale roto, un hueco de verdad (sin despacho y sin anulación) ya no tiene excusa. La válvula de escape es lo que le da filo al control — sin ella, el ruido de los vales rotos ahoga las señales reales.

## 4. Preview vivo en período abierto, hallazgo congelado en período cerrado

Mismo martes, tres momentos:

**14:00, período abierto**, el vale 00021 sigue en la tablet. La pantalla muestra el preview del período (hueco de talonario, punto 1), calculado al vuelo. **No se escribe ninguna fila en la base.**

**18:00**, sincroniza el 00021. El preview se recalcula solo, la alerta desaparece. No queda rastro, porque nunca se escribió nada.

**Miércoles 09:00**, el admin cierra el período del martes. Recién ahí lo que siga sin explicación se congela en `combustible_anomalias` como hallazgo permanente, y la conciliación del martes queda inmutable.

**Por qué importa**: si el preview escribiera filas a las 14:00, a fin de mes habría cientos de alertas de las cuales la mayoría se resolvieron solas y nadie las limpió. Al mes siguiente nadie abre esa pantalla — el control muere no por falso, sino por ruidoso. Con esta separación: si hay una fila en `combustible_anomalias`, es real; si el período no cerró, no hay fila.

**Bonus**: si el jueves aparece un vale del martes, no toca la conciliación ya cerrada — entra marcado como `despacho_tardio`. Que alguien "se acuerde" de un vale dos días después es justo lo que se quiere ver, no algo a corregir en silencio.

## 5. Qué bloquea el registro y qué no

**Bloquea — el vale se contradice a sí mismo**, sin necesitar ningún otro dato:

- Vale duplicado: Juan carga el 00022 dos veces sin darse cuenta → `409` — no hubo doble despacho, hubo doble tipeo, y la cola offline lo saca solo. El vale ya cargado se muestra en pantalla.
- Contómetro no coincide con la cantidad declarada: el aparato marcó 0,0 → 35,0 (35 gal) pero Juan escribió 53 (transpuso los dígitos) → `400`, se corrige ahí mismo con el papel en la mano — el mejor momento posible, mañana nadie se acuerda. Es control de calidad de dato, no anti-fraude: los dos números salen de la misma persona mirando el mismo aparato, así que esto agarra el error de tipeo, no a alguien que declara a propósito un número falso — eso lo detecta el hueco de talonario (punto 1), que no depende de lo que el operador escribe.

**No bloquea — la duda depende de otros vales o de otro dato**, se registra igual y se marca:

- Sobredespacho: EX-04 tiene tanque de 40 gal, Juan despacha 48. Sospechoso, pero puede haber llenado también un bidón para la motobomba, o la capacidad cargada en el sistema estar mal → `201 Creado` + anomalía marcada. Si bloqueara, la excavadora se queda sin combustible por una duda de dato — producción parada por algo que probablemente es un error de captura, no de fraude.
- Horómetro que no cierra con el último registro: puede ser adulteración, pero lo más probable es un vale de la mañana llegando tarde (el caso del punto 1) → `201 Creado`, se evalúa recién al conciliar el período.

**La regla en una línea**: el sistema bloquea cuando el vale se contradice a sí mismo. Nunca bloquea cuando la duda depende de otros vales — eso se resuelve al conciliar, no en el momento del despacho.

---

## Hoja de ruta

| Fase  | Qué entra                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A** | Fundación: tanques/puntos de abastecimiento como entidad completa (ABM real, hoy solo existe `PUT /:id/nivel`). Ver prompt de ejecución en la rama `feat/combustible-tanques-crud`.              |
| **B** | `combustible_despachos` + extensión de equipos + N°VALE (talonario) como secuencia + cola offline + validación síncrona del registro (puntos 1, 2 y 5 de este documento). El corazón del módulo. |
| **C** | `combustible_recepciones` + costo ponderado (`costo_promedio`, reservado desde la Fase A pero sin lógica hasta acá). Ver el detalle abajo.                                                       |
| **D** | Conciliación de período, `combustible_anomalias`, reportes, y talonarios con anulación (puntos 3 y 4) si se decide que entran.                                                                   |

Cada fase depende de que la anterior esté en `main` — en particular, B no arranca sin que el ABM de tanques (A) esté completo, porque el talonario (N°VALE, punto 2) se administra por punto de abastecimiento, no por despacho aislado.

---

## Fase C — recepciones y costo ponderado (migración 0064)

Las fases A y B cubren cuánto **hay** en el tanque (varilla) y cuánto **sale** (vales). Falta cuánto **entra** y a qué costo — sin ese dato, `combustible.costo_promedio` (reservado desde 0057) queda en 0 para siempre y el combustible parado en el tanque no se puede valorizar.

Una recepción es "llegó la cisterna y cargó el tanque X con Y galones a Z de costo". **Solo existe para tanque propio**: una compra en un grifo de la ruta ya es el evento completo en `combustible_despachos` con `origen='compra_externa'`.

### No hay talonario acá

El N°VALE (punto 2) existe para detectar combustible que _sale_ sin quedar declarado. Una recepción es el movimiento opuesto: la fuga sería combustible que entra y no se registra, y eso ninguna secuencia propia lo detecta — se detecta cruzando el nivel medido contra lo esperado, que es conciliación (Fase D).

### Una recepción no mueve el nivel

Igual que un despacho, y por el mismo motivo: si una declaración de papel moviera el nivel, el nivel dejaría de ser un dato medido y pasaría a ser "lo que alguien dijo" — y un tanque así nunca podría delatar una fuga real. Recepción y lectura de varilla son dos actos independientes.

### La primera recepción FIJA el promedio, no lo mezcla

El detalle sutil de toda la fase. La fórmula ponderada es:

```
nuevo_promedio = (nivel_antes × promedio_actual + cantidad × costo_unitario)
                 / (nivel_antes + cantidad)
```

donde `nivel_antes` es el nivel de la última lectura vigente **anterior a `recibido_en`** (no "el de hoy": una recepción cargada tarde se valoriza contra el nivel que el tanque tenía ese día).

Pero arrancar con `promedio_actual = 0` y aplicar esa fórmula da un número sin significado: si el tanque ya tenía 1.000 gal y entran 500 a S/18, el resultado es `(1000×0 + 500×18)/1500 = S/6` — el cero se mete en la mezcla como si el combustible que ya estaba hubiera salido gratis. Por eso **la primera recepción vigente fija el promedio en su propio costo unitario**. Equivale a asumir que lo que ya había costó lo mismo que la primera compra conocida: la única suposición honesta sin ningún dato de costo previo, y se autocorrige a medida que entran recepciones reales.

### Sin lectura vigente, la recepción se rechaza

Si el tanque no tiene lectura vigente anterior a `recibido_en`, el endpoint responde `400` en vez de asumir nivel 0. Es la coherencia con la migración 0059: un tanque sin lecturas tiene nivel **desconocido**, no cero — y valorizar sobre un cero inventado deja el inventario mal costeado sin que nadie se entere. Pedir la lectura primero cuesta 30 segundos.

### La anulación reproduce todo desde cero

El promedio ponderado es secuencial: cada recepción se apoya en el promedio que dejó la anterior, así que **no existe la operación inversa de una mezcla**. Anular una recepción vieja invalida la base de todas las posteriores. Por eso al crear o anular se recalcula reproduciendo en orden cronológico todas las recepciones vigentes del tanque — misma lección que 0059 (no guardes estado mutable que podés derivar). El volumen lo permite: las recepciones son semanales o mensuales, no una por despacho.

### Dos cosas configurables por tanque

| Columna                    | Qué hace                                                                                                                                                                                                                                                                                      | Default        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `tolerancia_capacidad_pct` | Margen sobre `capacidad_total` antes de rechazar la recepción. Porcentaje y no litros fijos porque escala solo con el tamaño del tanque. Va por tanque porque el error de la varilla es una propiedad física de _ese_ tanque.                                                                 | `0` (estricto) |
| `requiere_documento`       | Si exige factura/guía de remisión. En Perú el consumo de combustible casi siempre se sustenta con factura, pero el papel no siempre está a mano al descargar. Por eso `tipo_documento`/`numero_documento` son **nullable en la base**: un `NOT NULL` haría imposible desactivar la exigencia. | `true`         |

Las dos las administra el cliente desde el ABM de tanques, sin tocar código. El bloqueo por capacidad sí es duro (`400`): a diferencia del sobredespacho, no hay forma física de que entre más combustible del que cabe — el dato se contradice a sí mismo, como el punto 5.

---

## La 5ª auditoría (2026-09-14): los controles sobre lo que el tanque NO puede ver

Las cuatro rondas anteriores endurecieron el balance del tanque (varilla contra papeles). La quinta atacó por fuera de ese balance y encontró que **los cuatro umbrales son la misma cuenta**:

```
medido − (varilla anterior + recepciones declaradas − despachos declarados)
```

Quien controla uno de los términos declarados, o la propia medición, los esquiva a los cuatro a la vez. Por eso los controles nuevos no son un quinto umbral: son **testigos independientes** de cada término.

| Vector verificado                                                           | Por qué el tanque no lo veía                                                                                               | Control nuevo                                                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El grifero registra 9.000 de una entrega de 10.000 y se lleva la diferencia | `cantidad` era a la vez "lo que dice la guía" y "lo que entró", y lo escribía una sola persona. La varilla cuadra perfecto | **Validación de la recepción** (0088): administración escribe la cantidad de la guía sin ver la registrada. `recepcion_discrepante` / `recepcion_sin_validar`                 |
| Se declaran 400 L y el volquete recibe 380                                  | El combustible SÍ salió del tanque: el balance cierra. Lo que no cierra es el trabajo hecho con ese combustible            | **Consumo por hora de motor o por km** (0088). El vale del tanque propio ahora acepta horómetro; `consumo_excedido`                                                           |
| El que despacha anota como varilla el nivel que el sistema espera           | La medición deja de ser independiente del papel: el descuadre da cero para siempre                                         | `varilla_exacta` (cuatro mediciones seguidas exactas al litro no pasan midiendo) y `varilla_sin_control` (N días medido solo por quien despacha)                              |
| Una alerta sin revisar rompía la conciliación de todos los tenants          | El CHECK de anomalías se quedó con seis tipos mientras el worker congelaba nueve                                           | Las listas de tipos viven en el código (`TIPOS_ALERTA`, `TIPOS_CONGELABLES`) y un test las compara contra los CHECK reales. Cada paso del worker corre en su propio SAVEPOINT |

### Los tres caminos que se saltaban los controles

1. **`PUT /:id/nivel`** (eliminado). Registraba la varilla sin evaluar ningún descuadre. Hoy una varilla entra por un solo camino, y ese camino corre todos los controles (`procesarLecturaRegistrada`).
2. **La carga masiva de tanques**. Hacía UPSERT: cambiaba unidad, capacidad, tolerancia y umbrales de un tanque con historial, sin motivo ni aviso. Ahora **solo da de alta**; los códigos que ya existen se omiten y se informan.
3. **Fechar hacia atrás**. El tope diario miraba solo las 24 h anteriores al vale, así que fechar cada vale una hora antes del anterior lo dejaba solo en su ventana. Ahora se evalúa **la peor ventana de 24 h que contiene al vale**.

### El límite, que hay que decirlo

Ninguno de estos controles resuelve que **una sola persona haga las dos puntas**. La validación de la recepción sirve si la hace alguien distinto del que recibió; la varilla de control, si mide alguien que no despacha. Cuando no hay segunda persona, el sistema no previene: **deja constancia** (autorrevisión, autovalidación, bitácora, reporte de segregación). Esa constancia es lo que sirve ante un socio, un auditor o un juez — no es lo mismo que prevención, y presentarlo como tal sería mentir.
