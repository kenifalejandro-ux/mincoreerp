# IPERC — hallazgos de campo y alcance real del módulo

- **Estado**: existe un módulo de primera pasada en main (migraciones [0006](../../migrations/0006_equipos_checklist_iperc.sql) y [0007](../../migrations/0007_iperc_linea_base.sql)). El rediseño está **bloqueado** por cinco decisiones de esquema que solo el supervisor SSOMA puede responder — ver "Lo que sigue abierto".
- **Relacionado**: [ADR-0002](../adr/0002-contrato-de-modulo.md) (§8, cola offline), [matriz-permisos.md](matriz-permisos.md), [control-de-combustible.md](control-de-combustible.md) (mismo cliente, misma operación: Santa Isabel).

---

## Por qué existe este documento

Mismo motivo que el de combustible: lo que sigue salió de una llamada con el cliente, no de código. Si se pierde, el módulo se va a rediseñar sobre supuestos inventados — y varios de los supuestos que el código YA tiene hoy nadie los confirmó nunca con nadie de SSOMA.

## Decisión: un solo formato, el de la mina (2026-09-11)

**Santa Isabel usa el formato de la mina en su IPERC. El módulo se construye sobre ese formato y solo ese.**

Lo dicho por Kenif corrige un supuesto que este documento traía: no hay —ni va a haber por ahora— un formato propio de Santa Isabel al que haya que dar soporte. Es uno solo, el FOR-SIG-SIC-013 de MBM Lagunas Norte, para todo el personal, vaya a la unidad o a Cajamarca.

**Qué simplifica:**

- Una sola **matriz de riesgo**: la 5×5 de Barrick, con sus bandas y plazos. Ya está completamente definida, así que **las decisiones de esquema quedan desbloqueadas**.
- Un solo **layout de PDF**, un solo **banco de preguntas**, una sola estructura de ítems.
- No hace falta pantalla de administración de formatos ni lógica que elija formato según el destino.

**Qué NO se puede simplificar: el versionado.** El formato es de la mina, tiene versión ("2.0, 10/01/2025") y ella puede cambiarlo. Un IPERC firmado con la v2.0 tiene que **reimprimirse con la v2.0** tres años después, o deja de servir como prueba. Así que sigue habiendo una tabla de formatos con sus versiones — solo que con una fila en vez de varias, y sin la maquinaria de selección.

**Observación registrada, ya decidida en contra:** el formato lleva el nombre, el código SIG y la versión de Barrick, así que un IPERC de un trabajo en Cajamarca sale con membrete "MBM Lagunas Norte". Se planteó, Kenif decidió usarlo igual, y así se construye. Si algún día una fiscalización lo observa, el camino de salida ya está: se clona el formato, se le quita lo de la mina y pasa a ser una fila más.


## El formato real: FOR-SIG-SIC-013 v2.0

Archivo: `FOR-SIG-FMS-013_IPERC Continuo 2024_SANTA ISABEL.xlsx` (el nombre dice FMS, el contenido dice **SIC** — vale confirmar cuál es el código bueno). Cuatro hojas: CARA 1 y CARA 2 son el formato impreso a doble cara; Hoja1 es la matriz de riesgo; Hoja2 son cálculos sueltos sin valor.

**Es el formato de la mina, no uno propio.** Encabezado: "IPERC CONTINUO - **MBM Lagunas Norte**", Código FOR-SIG-SIC-013, **Versión 2.0**, fecha de versión 10/01/2025, "Página 1 de 2". Es un documento controlado del sistema de gestión de la minera. Consecuencia directa: **el formato tiene versión y la mina la puede cambiar**, así que el layout del PDF no se hardcodea — se versiona, y el IPERC guarda con qué versión del formato se emitió.

### Cabecera (CARA 1)

`ORDEN DE TRABAJO` · `NOMBRE DE LA TAREA O TRABAJO` · `SUPERVISOR QUE AUTORIZA LA TAREA` (+ observación/recomendación + firma) · `LUGAR` · `ÁREA` · `FECHA` · `CLASIFICAR LA TAREA: RUTINARIA / NO RUTINARIA / CRÍTICA` · `Indicar el PETS` · `Además del PETS requiere PETAR: SI/NO` · `¿SE REVISÓ LA MATRIZ IPERC DE LINEA BASE? SI/NO` · `EQUIPOS` · `HERRAMIENTAS MANUALES/ELÉCTRICAS` · `MATERIALES/PRODUCTOS QUÍMICOS`.

### Tabla de ítems (filas 20-61, ~40 líneas)

| Columna | Pregunta que trae impresa |
|---|---|
| N° | |
| SECUENCIA DE PASOS DE LA TAREA | ¿Qué vamos a hacer? Indicando paso por paso |
| DESCRIPCIÓN DEL PELIGRO | ¿Qué nos podría causar daño? |
| RIESGO | ¿Qué cosa podría ir mal? ¿Cómo nos podría dañar el peligro? |
| **EVALUACIÓN IPERC (Riesgo Inicial)** | tres casillas: **A / M / B** |
| MEDIDAS DE CONTROL A IMPLEMENTAR | ¿Qué podemos hacer para controlar el riesgo? — implementar antes del inicio de la tarea. Verificar si requiere un **CRSV** ("Controles de Riesgos Críticos que Salvan Vidas") |
| **Riesgo Residual** | tres casillas: **A / M / B** |

El riesgo **no se escribe como número**: se marca la banda. Y al pie, "SECUENCIA PARA CONTROLAR EL PELIGRO Y REDUCIR EL NIVEL DE RIESGO", con 8 renglones numerados.

### La matriz de riesgo (Hoja1) — 5×5, y no es un producto

Probabilidad en letras, severidad en números, y el cruce da un **ranking del 1 al 25** que hay que resolver **por tabla de consulta**, no por fórmula:

| Severidad \ Probabilidad | A Común | B Ha sucedido | C Podría suceder | D Raro que suceda | E Prácticamente imposible |
|---|---|---|---|---|---|
| **1 Catastrófico** | 1 | 2 | 4 | 7 | 11 |
| **2 Fatalidad** | 3 | 5 | 8 | 12 | 16 |
| **3 Permanente** | 6 | 9 | 13 | 17 | 20 |
| **4 Temporal** | 10 | 14 | 18 | 21 | 23 |
| **5 Menor** | 15 | 19 | 22 | 24 | 25 |

Las bandas salen de los colores de esas celdas en el propio Excel, sin ambigüedad:

| Banda | Rango | Color | Descripción del formato | Plazo de medida correctiva |
|---|---|---|---|---|
| **A** ALTO | **1-8** | rojo | Riesgo Intolerable, requiere controles inmediatos. **Si no se puede controlar el PELIGRO se paraliza los trabajos.** | 0-24 horas |
| **M** MEDIO | **9-15** | amarillo | Riesgo Tolerable; iniciar medidas para eliminar o reducir el riesgo, evaluar si la acción se puede ejecutar de manera inmediata. | 0-72 horas |
| **B** BAJO | **16-25** | verde | Riesgo Tolerable | 1 mes |

**Tres trampas que hay que respetar al programar esto:**

1. **La severidad está invertida**: 1 es Catastrófico y 5 es Menor. Lo peor es el número más chico.
2. **El nivel de riesgo también**: 1 es lo más grave y 25 lo más leve. Cualquier orden, semáforo o "mayor es peor" queda al revés si se copia la intuición.
3. **La letra A significa dos cosas distintas**: en probabilidad, A = "Común"; en banda de riesgo, A = "Alto". No mezclarlas en un mismo enum.

### CARA 2 — contenido fijo pre-impreso, más las firmas

Casi toda la cara 2 es material de referencia que se imprime igual siempre, y encabeza con la declaración que le da su valor probatorio: **"Comprendo la instrucción y soy responsable de cumplir con lo indicado para esta actividad."**

- **9 Reglas de Oro** (texto completo, incluida la obligación de detener trabajos inseguros).
- **16 Riesgos Críticos** (equipos móviles pesados y livianos, grúas e izaje, eléctricos, altura, incendios, materiales peligrosos, energía almacenada, guardas y barras, caída/desprendimiento de terreno, espacios confinados, aviación, rayos, excavaciones, explosivos, colapso de infraestructura).
- **PETAR** con Sí/No: caliente, altura, espacio confinado, bloqueo y señalización, excavaciones/zanjas, izaje, ingreso a espejo de agua, tarea crítica del área, otros.
- **Orden y limpieza**, **Verificación del EPP** (15 ítems), **Herramientas y equipos** — todos Sí/No.
- **Ejemplos de peligros** (10) y **ejemplos de riesgos** (10) — la semilla del banco de preguntas.
- **Jerarquía de controles**: 1 Eliminación, 2 Sustitución, 3 Ingeniería, 4 Administrativo, 5 EPP, "de mayor a menor eficacia". Está como referencia, **no como columna que se marque**.
- **Emergencias**: Centro de Control, (044) 60-4300 anexo 0, cel. 949356609, radio canal 7, con el guion de qué decir.
- **Datos de los trabajadores que ejecutan la tarea**: hasta **20 personas**, cada una con Nombres y Apellidos, **Cargo**, **Firma** y **Hora**.
- **Datos de los supervisores**: Hora, Nombre, **Medida Correctiva**, Firma.

### Qué contradice del código actual

| El código hace | El formato exige |
|---|---|
| `probabilidad SMALLINT CHECK BETWEEN 1 AND 4` | probabilidad cualitativa **A-E** (5 niveles) |
| `severidad SMALLINT CHECK BETWEEN 1 AND 4` | severidad **1-5**, invertida (1 = Catastrófico) |
| `nivel_riesgo GENERATED AS (probabilidad * severidad)` | **tabla de consulta 5×5 → 1-25**; el producto da otro número |
| nivel numérico suelto | **banda A/M/B** + plazo de corrección |
| una sola evaluación por ítem | **riesgo inicial y riesgo residual**, ambos con banda |
| firman creador y aprobador | **hasta 20 trabajadores** con cargo, firma y hora, más supervisores |
| — | ORDEN DE TRABAJO, PETS, PETAR, CRSV, clasificación de tarea, equipos/herramientas/materiales |

La columna `nivel_riesgo` es generada por la base: cambiarla exige recrear la columna, no un `UPDATE`.

## Hallazgos de campo (llamada del 2026-09-08)

Estos sí son datos del cliente:

- **Volumen**: ~11 conductores en total, de los cuales **~8 ingresan a mina**. Es una operación chica: cualquier diseño que asuma cientos de registros diarios está sobredimensionado.
- **Tiempo actual**: **30 a 40 minutos por día**, todos los días, llenando todos los formatos a mano. Esa es la vara contra la que van a medir el módulo.
- **Dispositivos**: todos tienen celular. Algunos son de **gama media o baja** — no son tablets modernas.
- **Conectividad**: hay red en general, pero **se cae 2 o 3 horas** seguidas. Offline no es una comodidad, es condición de uso.
- **El papel no muere**: se sigue exigiendo **IPERC físico y checklist en papel para Santa Isabel**.

## Alcance: qué es de la mina y qué es nuestro

Distinción que hubo que corregir sobre la marcha, porque al principio quedó mal entendida:

**Lo que es de la mina y no tocamos: el control de acceso del personal.** Barrick tiene su propia aplicación en línea; hacen una verificación y en *su* sistema figura el nombre de la persona. No aceptan que el contratista digitalice ese circuito. El módulo no intenta ser el pase de ingreso, ni sincronizar con el sistema de la mina.

**Lo que sí es nuestro: el IPERC.** Aunque el formato sea de Barrick, **quien lo llena es el personal del contratista, todos los días**, y quien tiene el problema de los 30-40 minutos y de la falta de evidencia es el contratista. Ese documento entra de lleno al módulo — se llena en el sistema y se le entrega impreso a la mina.

**Dos poblaciones distintas:** de ~11 conductores, **~8 van a la mina** y llenan el formato de Barrick. El resto va a otros destinos — Cajamarca, Bambamarca.

**Dato que cierra la pregunta del segundo formato (2026-09-09): Santa Isabel no tiene IPERC propio ni checklist propio. Lo único que existe es el de Barrick.** No hay un segundo formato esperando a ser cargado: hay uno solo. Eso simplifica el arranque y deja dos cosas a la vista:

- **El personal que no va a mina probablemente trabaja sin IPERC.** Si el único formato es el de la mina, quienes van a Cajamarca o Bambamarca o llenan un documento que no corresponde a ese trabajo, o no llenan nada. Si es lo segundo, ahí no hay evidencia de nada — exactamente el problema que los dejó sin defensa en el accidente, pero para la otra mitad del personal. *Falta confirmar qué llenan hoy, si es que llenan algo.*
- **El formato de la mina se usa también fuera de la mina.** Confirmado el 2026-09-11: Santa Isabel llena el formato de Barrick para su IPERC, punto. Ver "Decisión: un solo formato" al principio del documento — ahí queda registrada la observación sobre el membrete y por qué no bloquea nada.

**Consecuencias de diseño:**

1. **El PDF que replica el formato es el eje del módulo, no un extra** — ver "El doble llenado". `pdfkit` ya es dependencia del proyecto (se usa en facturación), así que no hay que sumar librería nueva.
2. **Offline obligatorio**, con la infraestructura que ya existe (`client/src/offline/`, `cliente_uuid`, `idempotentInsert`) — el módulo IPERC ya la usa, hay que conservarla.
3. **La UI tiene que correr en gama baja.** La vista actual ([IpercView.tsx](../../client/src/components/iperc/IpercView.tsx), 787 líneas, con una tabla de N ítems editables en pantalla) hay que medirla en un celular real antes de agregarle campos — y el formato real trae bastantes más campos que los de hoy.
4. **El objetivo medible es bajar los 30-40 minutos diarios**, sin que aparezca un doble llenado que los vuelva 60.

## Cómo se llena y cómo sale: cuestionario adentro, formato de siempre afuera

Decisión de Kenif (2026-09-08), y es el corazón del módulo:

**Adentro (lo que ve el conductor):** no un IPERC en blanco para redactar, sino **preguntas cerradas** — marcar opciones, verdadero/falso, elegir de una lista. Texto libre solo donde realmente amerite. Las preguntas apuntan a la incidencia real del día a día, no a llenar campos.

**Afuera (lo que sale del sistema):** el **formato de siempre**, como si lo hubieran llenado a mano en papel. El reporte NO se ve como una lista de verdadero/falso: se ve como el IPERC físico completo. La captura cambia; el entregable no.

**En el medio (lo que hace que funcione):** un **banco de preguntas** donde cada pregunta ya trae cargado el ítem IPERC que produce — peligro, riesgo, probabilidad, severidad y medidas de control. El conductor marca "sí, hay tránsito de volquetes en el frente" y el sistema arma la línea completa del IPERC con su nivel de riesgo y sus controles. Sin ese banco precargado, las preguntas cerradas no pueden generar el documento.

**Y encima:** Kenif aplica un algoritmo de priorización sobre el banco, usando el historial de anomalías recurrentes de la operación, para que al personal le lleguen las preguntas que de verdad ocurren y no un cuestionario eterno. El sistema guarda el banco, las respuestas y el historial; el algoritmo decide qué preguntar.

**Requisito explícito: no quedan huecos.** No se puede enviar un IPERC con nada suelto ni en blanco — la validación de completitud es parte del diseño, no un extra. Es una de las razones de ser del formato cerrado: en papel la gente deja campos vacíos, acá no se puede.

**Riesgo a vigilar (una sola vez y sigo):** un IPERC que se llena marcando casillas se puede convertir en firmar sin mirar, y eso es justamente lo que la fiscalización castiga cuando encuentra IPERC calcados. Lo que lo evita es lo que ya está en el plan — que el algoritmo varíe las preguntas según lo que pasa en la operación — más registrar quién respondió qué y cuándo, que el sistema ya sabe hacer.

### Qué hay que pedirle al supervisor ahora

El pedido cambia de forma. Ya no es "contestame 35 preguntas", es **conseguir las dos materias primas del banco**:

1. **El IPERC físico completo** — la línea base aprobada y continuos ya llenos de varios días distintos. De ahí sale el catálogo de peligros, riesgos y controles que ellos realmente usan, y el layout exacto que tiene que reproducir el PDF.
2. **El historial de anomalías / incidencias recurrentes** de la operación. Es el insumo del algoritmo de priorización: sin él, todas las preguntas pesan igual y el cuestionario vuelve a ser largo.\n3. **La lista de rutas posibles** — ver "La ruta se marca en el IPERC".

Las cinco preguntas de esquema de más abajo **siguen bloqueando igual**, y una de ellas cambia de tono: si el sistema deriva probabilidad y severidad desde las respuestas, la matriz deja de ser un detalle de pantalla y pasa a ser la fórmula que corre por dentro. Hay que saber cuál es.


## La ruta se marca en el IPERC

Dato del supervisor de SSOMA: a veces —**no de forma recurrente**— les cambian la ruta de mina a otra ruta, y **esa ruta hay que marcarla en el IPERC**. Es un campo del IPERC. No existe hoy en el sistema.

1. **Lista de opciones precargadas, no texto libre.** Las rutas posibles se conocen de antemano: se dejan cargadas y el conductor marca la que corresponde. Si se escribe libre, en tres meses hay cinco variantes del mismo destino y ningún reporte agrupa.
2. **El cambio ocurre estando en mina** — que es justo donde la red se cae 2-3 horas. Consecuencia técnica: el catálogo de rutas se sincroniza y queda **guardado en el dispositivo**; no se consulta al servidor en el momento de usarlo, porque fallaría exactamente cuando hace falta.
3. **Que la ruta marcada sea la real importa por lo mismo que todo el resto del módulo**: si el IPERC dice una ruta y el trabajo se hizo en otra, el documento no prueba lo que tiene que probar (ver "es prueba judicial").

**Materia prima 3 para pedirle al cliente: la lista completa de rutas posibles**, para dejarlas cargadas.

## Para qué sirve realmente el IPERC: es prueba judicial

Explicado por Kenif (2026-09-08). Es el "por qué" que ordena todo lo demás, y hay que tenerlo escrito porque cambia decisiones técnicas que de otro modo parecerían detalles.

Cuando hay un accidente, la familia del trabajador va a proceso —civil y, si corresponde, penal— y quienes responden son el **supervisor de trabajo y el supervisor de seguridad**. La defensa de la empresa se sostiene, o se cae, en un punto: poder demostrar que **ese trabajador conocía los peligros y los controles**. El IPERC continuo, identificando peligros y replicando controles con el trabajador mismo, es justamente el documento que lo prueba. Si el trabajador alega que no sabía, que nadie le informó, que no era su función — el IPERC firmado por él es la respuesta.

**Entonces este módulo no produce un formulario. Produce prueba.** De ahí salen cuatro reglas que no son negociables por comodidad:

1. **La respuesta la pone el trabajador, nunca el sistema.** El cuestionario puede *preguntar* con opciones cerradas, pero no puede venir con la respuesta ya marcada. El algoritmo de priorización decide **qué se pregunta**; jamás **qué se responde**. Esa es la línea exacta que conserva el valor probatorio sin perder la velocidad que buscamos: el sistema estructura, el trabajador decide.
2. **La firma del propio trabajador es el dato central, no un adorno.** Sube de prioridad sobre todo lo demás en la lista de decisiones abiertas: si el valor legal depende de que él firme, hay que resolver si vale la firma en pantalla o hace falta la hoja de puño y letra. Con ~11 personas, darle usuario a cada conductor es viable.
3. **Hay que poder demostrar que lo llenó de verdad.** Quién respondió, cuándo, desde qué dispositivo, y cuánto tardó. Un IPERC completado en ocho segundos no defiende a nadie; es peor que no tenerlo.
4. **Dos IPERC calcados destruyen la defensa.** La variación entre días y entre personas —que es justo lo que busca el algoritmo de priorización— deja de ser una mejora de UX y pasa a ser un requisito legal. Conviene que el sistema registre por qué preguntó lo que preguntó.

### Problema abierto en el código actual: la prueba se puede borrar

`DELETE /api/erp/iperc/:id` hace un **borrado físico**, sin mirar el estado:

```sql
DELETE FROM ipercs WHERE id = $1 AND tenant_id = $2
```

(`iperc.repository.ts`, y los ítems se van detrás por `ON DELETE CASCADE`.)

Un IPERC **aprobado y firmado** se puede borrar y desaparece de la base. La auditoría deja rastro de la acción, pero solo guarda el identificador —`detalle: { ipercId: id }`— no el contenido: queda constancia de que alguien borró el IPERC 47, y nada de qué decía, qué peligros identificaba ni quién lo había firmado. En un proceso judicial, eso es exactamente la prueba que no se va a poder presentar.

**Lo que corresponde**: un IPERC aprobado no se borra nunca. Se anula, con motivo obligatorio y autor registrado, y el documento queda. Borrado físico, como mucho, para un borrador que nunca se aprobó. Esto es la aplicación directa del principio de auditar quién **y por qué** que ya rige en el resto de la plataforma para acciones correctivas.

Pregunta que abre, para el supervisor: **¿cuántos años hay que conservar los IPERC?** Si el horizonte es la prescripción de un proceso penal, la retención y los backups del módulo se diseñan con ese número, no con el de un documento operativo cualquiera.
## CRSV — "Controles de Riesgos Críticos que Salvan Vidas"

El formato lo menciona **una sola vez**, dentro del encabezado de la columna de medidas de control: *"Verifique si se requiere un CRSV"*. **No hay casilla donde marcarlo.** En papel es un recordatorio: te dice "verifique" y no te pide constancia de que verificaste — así que hoy no queda registro de si se hizo esa verificación ni de cuál fue el resultado.

**En digital eso se cierra sin tocar el formato impreso**: el sistema pregunta, guarda la respuesta y el PDF sale exactamente igual que siempre. Es de las mejoras que el cuestionario permite y el papel no.

**Hipótesis a confirmar, derivada del propio documento:** la cara 2 lista **16 Riesgos Críticos** numerados (equipos móviles, izaje, eléctricos, altura, caída de terreno, espacios confinados, explosivos…). Lo más probable es que un control sea CRSV cuando el peligro identificado cae dentro de uno de esos 16. Si se confirma, **el sistema lo puede derivar solo**: cada pregunta del banco se etiqueta con el riesgo crítico al que pertenece —o con ninguno—, y cuando el trabajador la marca, el sistema ya sabe que ese ítem exige CRSV y lo pide. Eso en papel es imposible.

**Candidato a regla dura:** si el ítem cae en un riesgo crítico y no hay control declarado, el IPERC no se envía. Misma familia que "no quedan huecos".

**No confundir CRSV con la banda ALTO.** Son ejes distintos: la banda mide la magnitud del riesgo *de ese ítem*; el CRSV dice que el peligro pertenece a la familia de los que matan. Un ítem puede quedar en banda BAJA después de los controles y seguir siendo crítico — de hecho, ese es el caso normal cuando el control funciona.

**Ojo con la palabra "crítico": el formato la usa para cuatro cosas distintas** y no hay que mezclarlas en el modelo:

| Dónde aparece | Qué significa |
|---|---|
| `CLASIFICAR LA TAREA: … CRÍTICA` (cabecera) | tipo de tarea |
| `RIESGOS CRÍTICOS` (cara 2, 16 ítems) | catálogo de familias de peligro |
| `Tarea crítica del área` (bloque PETAR) | disparador de permiso escrito |
| `CRSV` (columna de controles) | el control que evita la fatalidad |

**Falta preguntar:** ¿Barrick tiene una lista definida de CRSV, o el supervisor lo determina caso por caso? ¿Y qué pasa si se requiere uno y no está disponible — se paraliza, como con la banda ALTO?


## El doble llenado: el riesgo que puede matar el proyecto

Lo planteó el cliente y es la objeción más seria que tiene el módulo.

El formato es de Barrick, y **ese formato se le reporta a Barrick, en papel, todos los días**. Si además hay que llenarlo en el sistema, el conductor hace el mismo trabajo dos veces: 30-40 minutos de papel **más** el digital. Un módulo que suma trabajo no se usa, por bueno que sea.

**La única salida que lo resuelve: se llena una sola vez, en el celular, y el sistema imprime el formato de Barrick.** Una entrada, dos salidas — el PDF para entregar y el registro digital para defenderse. El papel deja de ser una segunda captura y pasa a ser una impresión. Por eso el PDF idéntico al formato no es un lujo del módulo: es la condición para que el módulo se use.

### Pero la firma tiene dos destinatarios, y solo uno lo controla el cliente

Acá hay que separar dos cosas que se confunden fácil:

**1. La protección de la empresa.** El caso que contó el cliente: hubo un accidente y **no tenían evidencia de que esa persona hubiera registrado nada**. Eso lo resuelve el sistema, y depende solo de nosotros: usuario propio, firma capturada en pantalla, hora, dispositivo y rastro de auditoría. Con eso, ante un accidente hay prueba de que ese trabajador leyó, identificó y firmó.

**2. El entregable a Barrick.** Eso lo decide Barrick, no nosotros. **Hay que preguntarle a la mina si acepta su FOR-SIG-SIC-013 impreso desde un sistema, con las firmas ya adentro, o si exige firma de puño y letra sobre el papel.**

La buena noticia: **no hace falta esperar esa respuesta para construir**. Aun en el peor caso —que Barrick exija tinta— el flujo es llenar en el celular, imprimir y firmar encima: el ahorro de tiempo se mantiene casi entero, porque lo que consume los 30-40 minutos es **escribir**, no firmar. Y la evidencia interna queda igual de sólida en los dos escenarios.

## Identidad del trabajador: DNI, contraseña y firma

Propuesta de Kenif al cliente: cada trabajador entra con **usuario propio (DNI + contraseña)** y firma en una **pantalla digital**, para que al llenar el IPERC quede constancia de que fue consciente del riesgo.

**Por qué el DNI es la elección correcta, y no un detalle de comodidad:** ante un juez, el DNI identifica a una persona de forma unívoca. Un correo no — un correo lo puede tener cualquiera y no prueba quién es su dueño. Si el objetivo del módulo es producir prueba, el identificador tiene que ser el mismo con el que la persona existe legalmente.

**Lo que hoy no está:** la tabla `usuarios` tiene `email` (validado como correo real, único por tenant) y **la palabra DNI no aparece en ninguna parte del sistema**. Entonces hace falta:

- Columna `dni` en `usuarios`, única por tenant.
- Que el login acepte DNI además de correo. Un conductor no tiene por qué tener email, y exigirle uno es fricción pura.
- **Consecuencia mecánica:** sin correo no hay recuperación de contraseña por autoservicio — el enlace de reseteo viaja por mail. Para estos usuarios, la contraseña la repone el admin con la clave temporal + cambio obligatorio que ya existe en el sistema.

**El punto débil a cubrir: la contraseña prestada.** Si los conductores se comparten la clave, la defensa se debilita — la otra parte dirá que cualquiera pudo firmar por él. Lo que sostiene la prueba no es la contraseña sola, sino la combinación: DNI + contraseña personal + **el trazo de la firma hecho en ese momento** + la hora + el dispositivo. Las tres últimas son las que hacen difícil sostener que firmó otro.
## "Si ya lo reportan a Barrick, ¿para qué digitalizarlo?"

La pregunta es válida y hay que dejarla contestada, porque va a volver.

**El IPERC que se le entrega a Barrick defiende a Barrick. El que queda en el sistema defiende a Santa Isabel.** Es el mismo documento cumpliendo dos funciones para dos empresas distintas.

Cuando hay un accidente, cada empresa responde por lo suyo: la mina tiene que mostrar que exigió y controló, y el contratista tiene que mostrar que capacitó, identificó los peligros y que **ese trabajador** los conocía. No son adversarios, pero tampoco tienen el mismo interés — y depender del archivo del cliente para defenderse en un proceso donde el cliente también está respondiendo es una posición mala.

**Y esto ya se probó en la práctica, no es teoría:** hubo un accidente y **no había evidencia de que esa persona hubiera registrado**. El circuito de reportar a Barrick estaba funcionando, y aun así la empresa se quedó sin su prueba. Ese solo hecho contesta la pregunta.

**Lo que hay que confirmar** (define cuánto vale, y es rápido de averiguar):

- Cuando se llena el IPERC, ¿el original se lo queda Barrick? ¿Queda copia en Santa Isabel, dónde, y se puede encontrar una de hace dos años en menos de una hora?
- En el accidente, cuando pidieron la evidencia, ¿a quién se la pidieron y qué pasó?

Si la copia existe y está ordenada, el valor baja a tiempo y reportes. Si no existe, o está en cajas, el valor es toda la defensa de la empresa.

### Las otras tres razones, que valen aunque Barrick siga pidiendo papel

1. **El tiempo.** Son 30-40 minutos diarios escribiendo a mano. Con el formato impreso ya lleno, el conductor marca y firma. Ese ahorro no depende de Barrick.
2. **Lo que el papel no da: agregación.** Ocho conductores por trescientos días son unos 2.400 IPERC al año. En papel, nadie sabe qué peligro se repite, qué control nunca se implementa, ni que un riesgo alto apareció tres veces esta semana. Digitalizado es una consulta — y es justo el insumo del algoritmo de priorización de preguntas.
3. **El papel prueba que firmó, no cuándo.** Un IPERC de papel se puede llenar después del hecho, y eso es lo primero que va a alegar la otra parte. Hora, dispositivo y rastro de auditoría cierran esa puerta.

### Y hay una razón de orden práctico

El formato de Barrick es **el único que existe hoy**. Todo lo que se construya para digitalizarlo —el formato como dato, el banco de preguntas, la firma, el PDF, el offline— es exactamente lo mismo que va a necesitar el IPERC propio de Santa Isabel, que es donde hoy no hay nada y por lo tanto donde el retorno es mayor.

O sea: aunque el beneficio en mina fuera moderado, digitalizar el de mina es el camino más corto para construir la máquina que después sirve para todo lo demás. No es "mina o no mina" — es empezar por el único formato que se puede cargar hoy.


## La decisión de arranque: el formato es un dato, no dos módulos

Pregunta de Kenif: ¿hacemos dos tipos de IPERC —uno para el personal de mina y otro para el que no—, y conviene digitalizar un formato que es de la mina y no de Santa Isabel?

**Respuesta corta: sí se arranca con el formato de Barrick, y no se modela como "dos tipos". El eje correcto es el formato, guardado como dato.**

### Por qué sí digitalizar el formato de la mina

1. **Es el que se llena todos los días.** Ahí están los 30-40 minutos y ahí está el dolor real. Un IPERC propio de Santa Isabel que nadie llena a diario no resuelve nada.
2. **Es el que faltó cuando hubo el accidente.** La evidencia que no existía era de este documento, no de otro.
3. **Digitalizarlo no cambia el documento.** La salida es el mismo FOR-SIG-SIC-013 impreso. No se está inventando un formato ajeno: se está produciendo mejor el que ya se entrega. Que un contratista llene el formato del sistema de gestión de su cliente es lo normal.

El único riesgo real es que Barrick publique una versión nueva — y eso se resuelve con lo de abajo, no evitando el formato.

### Por qué NO modelarlo como "tipo: mina / no mina"

La tabla `ipercs` ya tiene una columna `tipo` con valores `continuo` / `especifico`. Meterle ahí "mina" y "no mina" mezcla **dos ejes distintos** en una sola columna, y encima el eje elegido sería el equivocado.

Lo que cambia entre el IPERC de Barrick y cualquier otro **no es la población** — es el documento entero:

- La **matriz de riesgo**: la de Barrick es 5×5 con ranking 1-25 por tabla de consulta; otro formato podría usar la del DS 024, con índices sumados y cinco bandas distintas.
- Las **columnas de la tabla de ítems** y qué se marca en cada una.
- La **cara 2 completa**: reglas de oro, riesgos críticos, EPP, teléfonos de emergencia — todo eso es contenido de Barrick.
- El **layout del PDF**.

Si el eje es la población, cuando Barrick saque la v3.0 hay que tocar código. Si el eje es el formato, es una fila nueva.

**Alcance real de esto, tras la decisión del 2026-09-11:** como hay un solo formato, lo que queda en pie de esta sección es el **versionado** —una tabla de formatos con una fila y sus versiones— y no la maquinaria multi-formato. El argumento de "el segundo formato viene pronto" ya no aplica. El de "la mina puede publicar la v3.0" sí, y es el que obliga a guardar con qué versión se emitió cada IPERC.

### Cómo se modela

**Un formato es una plantilla**, igual que las plantillas de checklist que el sistema ya tiene (`checklist_plantillas` → `checklists`). El patrón plantilla→instancia no es nuevo acá, ya está probado en el ERP.

Un formato guarda:

- Identidad: código (`FOR-SIG-SIC-013`), nombre, **versión** y fecha de versión, y de quién es (Barrick / Santa Isabel).
- Su **matriz**: escalas de probabilidad y severidad, la tabla de consulta y las bandas con sus plazos.
- Las **columnas de ítems** que exige.
- El **contenido fijo** de la cara 2.
- El **layout del PDF**.

Y cada IPERC llenado apunta a un formato **y congela su versión**. Eso último no es un adorno: un IPERC de hace tres años tiene que poder reimprimirse **idéntico a como se firmó**, aunque el formato haya cambiado dos veces. Es lo mismo que se exige de la línea base, y por la misma razón — es prueba.

### Qué queda para después, sin bloquear nada

- Si el personal que va a Cajamarca o Bambamarca usa **otro formato**, se carga como una fila más cuando aparezca. No es desarrollo nuevo.
- Si Santa Isabel necesita un IPERC propio, igual: es un formato más.
- Y si resulta que **no existe** otro formato y todos llenan el de Barrick, no se hizo trabajo de más: se cargó uno solo.

**Con un formato cargado se arranca** — y hoy hay exactamente uno, porque Santa Isabel no tiene el suyo.

Eso agrega un argumento que no estaba: **el formato propio de Santa Isabel, cuando exista, va a nacer del de Barrick.** Nadie escribe un IPERC desde cero teniendo uno bueno delante; se copia la estructura y se le quita lo que es de la mina (membrete, código SIG, riesgos críticos propios de la operación minera) . Si el formato es una fila, eso es **clonar y editar**. Si está escrito en el código, es escribir el módulo de nuevo.

El costo de modelarlo como dato desde el principio es una tabla; el costo de no hacerlo es reescribir el módulo la primera vez que aparezca el segundo formato — que en este caso no es una hipótesis lejana, es el paso siguiente.


## Estado de las cinco decisiones que bloqueaban el esquema

El formato real resolvió cuatro de las cinco:

1. **Matriz** — ✅ **resuelta**. Es la 5×5 de la mina (A-E × 1-5 → 1-25 por tabla de consulta, bandas A/M/B con plazos de 24 h / 72 h / 1 mes). No es la 4×4 que el código asume ni la del DS 024 con índices sumados.
2. **Riesgo residual** — ✅ **resuelta**. Sí existe, es columna propia, se marca como banda A/M/B igual que el riesgo inicial.
3. **Jerarquía de controles** — ⚠️ **parcial**. Los 5 niveles están impresos en la cara 2 como referencia, pero **no hay columna donde marcarla** en la tabla de ítems. *Falta preguntar*: ¿el supervisor exige indicar la jerarquía de cada control, o alcanza con describirlo? Tampoco hay columna de responsable ni de plazo por control — el plazo sale de la banda de riesgo.
4. **Quiénes firman** — ✅ **resuelta**: hasta 20 trabajadores con nombre, cargo, firma y hora, más los supervisores con hora, nombre, medida correctiva y firma. **Decisión tomada**: cada trabajador entra con DNI + contraseña y firma en pantalla (ver "Identidad del trabajador"). Lo único que queda es de Barrick, no nuestro: si acepta el formato impreso con firmas digitales o exige tinta — y en cualquiera de los dos casos se construye igual.
5. **Versionado y vigencia de la línea base** — ❌ **sigue abierta**. El formato solo tiene la casilla "¿SE REVISÓ LA MATRIZ IPERC DE LÍNEA BASE? SI/NO", que confirma que la línea base existe y se consulta, pero no dice nada de su ciclo de vida.

## Preguntas que quedan para el supervisor

**Sobre el formato:**
- ¿El código es FOR-SIG-**FMS**-013 (nombre del archivo) o FOR-SIG-**SIC**-013 (contenido)? Va impreso en el PDF.
- ¿La versión 2.0 del 10/01/2025 es la vigente? ¿Cómo se enteran cuando la mina publica una nueva?
- ¿Dónde se marca la ruta: en `LUGAR` o en `ÁREA`?
- ¿Barrick tiene una **lista definida de CRSV**, o se determina caso por caso? ¿Y qué pasa si se requiere uno y no está? (ver la sección de CRSV)
- ¿Se exige indicar la jerarquía de cada control (punto 3 de arriba)?

**Sobre lo legal y operativo:**
- **¿Firma en pantalla o puño y letra?** (la que más pesa)
- ¿Cuántos años hay que conservar los IPERC? Si el horizonte es la prescripción penal, retención y backups se diseñan con ese número.
- ¿La línea base versiona y vence?

**Sobre el uso diario:**
- Los 30-40 minutos, ¿son de **un** conductor llenando lo suyo, o del supervisor consolidando los 8?
- ¿Es un IPERC por conductor, o uno por tarea que firman los 20 que aparecen en el formato?\n- **¿Qué llena hoy el personal que no va a mina (Cajamarca, Bambamarca)?** Ya sabemos que no hay un formato propio de Santa Isabel — así que o usan el de Barrick donde no corresponde, o no llenan nada. Las dos respuestas importan.\n- **¿Y el checklist de pre-uso?** Tampoco hay uno propio. ¿Usan el de la mina, o directamente no hay? El ERP ya tiene el módulo de checklist con plantillas, así que ahí el trabajo sería cargar contenido, no construir.\n- **A Barrick:** ¿acepta el FOR-SIG-SIC-013 impreso desde un sistema con las firmas ya incorporadas, o exige firma manuscrita sobre el papel?
- ¿Quién exige el físico: la mina, la fiscalización, o es política interna? Define si el PDF puede reemplazar al papel algún día.

## Cómo se diferencia el IPERC de mina del de fuera de mina

**No por la persona — por el trabajo.** Es la trampa a evitar: si se etiqueta al *personal* como "de mina" y "de no mina", el modelo se rompe el primer día que un conductor vaya a la unidad el lunes y a Bambamarca el martes. Y va a pasar.

Lo que determina qué IPERC corresponde es **dónde se hace la tarea**.

### La cadena de decisión

El trabajador abre un IPERC y lo primero que declara es **el destino u operación**, elegido de una lista precargada: unidad Barrick Lagunas Norte, Cajamarca, Bambamarca, planta Santa Isabel. Esa única elección determina todo lo demás:

| Lo que se deriva | De dónde sale |
|---|---|
| Qué **matriz de línea base** está disponible para tomar peligros | del destino |
| Qué **preguntas del banco** aplican | del destino |
| El **formato**, las escalas y bandas, y el PDF | siempre el mismo (uno solo) |

**Actualización 2026-09-11:** el destino ya **no** elige formato — hay uno solo. Lo que el destino sigue determinando es **qué peligros y controles corresponden**: los de un viaje a Bambamarca no son los de la unidad minera. Es decir, el destino cuelga de la línea base, no del formato.

### Cómo se ve para el conductor

No elige "formato Barrick" — eso sería pedirle que entienda la configuración del sistema. Elige **a dónde va**, y el sistema hace el resto. Es el mismo principio que rige todo el módulo: **el trabajador declara el hecho, el sistema deriva la configuración.**

### Coincide con el campo de la ruta

El destino que discrimina el formato y la ruta que hay que marcar en el IPERC son el mismo dato, o parientes muy cercanos. Conviene no duplicarlos: un solo catálogo de destinos/rutas, usado para las dos cosas.

### El caso borde que sí va a pasar

Le cambian la ruta al conductor estando en mina (ver "La ruta se marca en el IPERC"). Dos situaciones distintas:

- **El destino nuevo usa el mismo formato**: se corrige el campo y queda el rastro del cambio.
- **El destino nuevo cambia la naturaleza de la tarea** (de la unidad minera a carretera, o al revés): **es otro IPERC, no una edición del anterior.** El formato es el mismo, pero los peligros y la evaluación no — y en términos de SSOMA es lo correcto: si cambian las condiciones de la tarea, se vuelve a evaluar. Editar el viejo sería alterar la evaluación que ya se firmó.

### Lo que falta en el modelo actual

`iperc_lineas_base` tiene `proceso_actividad` y `area_frente`, pero **no tiene a qué operación o formato pertenece**. Ese vínculo hay que agregarlo: sin él, el sistema no sabe qué matriz ofrecerle a un IPERC de Bambamarca y cuál a uno de la unidad.

### Beneficio lateral

Con esa división, la métrica que le interesa a gerencia sale sola: cuántos IPERC se llenan en mina, cuántos fuera, y dónde está el hueco de cobertura.


## La decisión de alcance: los dos, en este orden

Carlos fue quien planteó el IPERC, y en la conversación devolvió la pregunta: *"si es factible hacer un IPERC para mina, o lo dejamos así nada más y solo hacemos el IPERC para el personal que no está en mina"* — textual, *"eso creo que va a depender de usted"*. La decisión es técnica y quedó de este lado.

**Recomendación: los dos. Y no es un "por qué no las dos" de compromiso — elegir uno solo deja un agujero en cada caso.**

- **Solo nómina** deja sin resolver el problema que **ya causó daño**: el accidente sin evidencia fue con personal de mina.
- **Solo mina** deja sin cubrir a quienes hoy **no llenan ningún documento** — ni IPERC ni checklist ni parte. Esa es la exposición más grande que tiene la empresa.

**Y no cuesta el doble.** El grueso del trabajo es el motor: formato como dato, banco de preguntas, firma, PDF, offline. Sirve igual para los dos. Y como el formato es uno solo, lo que falta para cubrir a la nómina no es un formato nuevo sino **su matriz de línea base** — contenido, no desarrollo.

### El orden es al revés de lo que parece

La intuición dice empezar por nómina: cero fricción externa, ningún formato ajeno, nadie a quien pedirle permiso. Pero:

- **El de nómina está bloqueado por contenido.** No existe la matriz IPERC de línea base para esas actividades, y **la tiene que diseñar SSOMA de Santa Isabel** — no el software, no la mina. Eso lleva su tiempo.
- **El de mina está listo para construir.** El formato existe, está en la mano y ya quedó analizado entero: matriz, bandas, columnas, cara 2, firmas.

Entonces: **se arranca por el de mina mientras SSOMA elabora la matriz de nómina.** Los dos avanzan en paralelo y nadie espera a nadie. Cuando la matriz esté lista, el motor ya va a estar hecho y cargarla es contenido, no desarrollo.

Eso además le da a Carlos una tarea concreta que empieza el mismo día, en vez de una fecha de entrega para dentro de dos meses.

### Qué contestarle

Sí es factible. **El ERP no reemplaza el papel de la mina: lo llena.** El trabajador contesta el cuestionario en el celular y el sistema emite el PDF en el formato de ellos, para imprimir y firmar. El trámite con Barrick no cambia.

Y el argumento que cierra: **no gana el papel, gana el historial.** Un IPERC archivado no se puede buscar. Nadie puede preguntarle a un archivador *"¿cuántas veces se reportó este peligro en esta tarea?"* ni *"¿qué IPERC había firmado el día del incidente?"*.

## Quién avisa cuando la mina cambia la versión del formato

Quedó sin preguntar, pero tiene respuesta de diseño: **no hay que depender de que alguien avise.**

- Cada PDF sale con el código y la versión impresos, y cada IPERC guarda con qué versión se emitió.
- Se nombra un responsable —el supervisor SSOMA— que verifica contra la mina cada cierto tiempo.
- **Si nadie avisa, no se rompe nada**: se sigue emitiendo la versión vigente cargada, y como está impresa en el propio documento, la diferencia es visible apenas alguien compare con el formato de la mina.
- Cuando llega una versión nueva, se carga como un formato más. Los IPERC viejos conservan la suya y se reimprimen igual que como se firmaron.


## ¿Quién diseña la matriz IPERC del personal que no va a mina?

**Santa Isabel.** No es una opción organizativa: la obligación de identificar peligros y evaluar riesgos es **del empleador**, y el empleador de esos conductores es Santa Isabel, no Barrick.

Barrick exige el IPERC de sus contratistas **dentro de su unidad**. Un viaje a Cajamarca o a Bambamarca es actividad propia de Santa Isabel, fuera del alcance de la mina — ahí no hay nadie más a quien le corresponda. (Marco general de la Ley 29783; el detalle normativo conviene confirmarlo con el supervisor SSOMA o el asesor legal.)

**Quién hace qué:**

- **Responde legalmente**: la empresa, a través de su gerencia.
- **La elabora materialmente**: el área SSOMA de Santa Isabel — el supervisor con el que se viene conversando.
- **Participan**: los trabajadores que hacen la tarea. Los conductores conocen los peligros reales de esa ruta mejor que nadie, y su participación no es un gesto: es parte de lo que hace válida la evaluación.
- **La aprueba**: la gerencia o el representante legal.
- Según cuántos trabajadores tenga la empresa en total, la participación se canaliza por **Comité de SST** o por **Supervisor de SST** — el corte está en 20 trabajadores. A confirmar con el supervisor, porque depende del total de la planilla, no de los ~11 conductores.

**Quién NO la diseña: ni Barrick, ni el ERP, ni quien lo programa.** Esto es la misma regla que ya rige el cuestionario, un nivel más arriba: **el sistema registra la evaluación, no la hace**. Si el software trajera peligros y valoraciones inventadas por él y ocurre un accidente, es peor que no tener nada — queda documentado que la evaluación no la hizo quien debía.

### Lo práctico: el de Barrick sirve de molde

El formato de la mina es un buen punto de partida. Muchos peligros del transporte se repiten fuera de la unidad: tránsito, fatiga y somnolencia, terceros en la vía, condiciones climáticas, carga mal asegurada, maniobras de carga y descarga. Lo que se saca es lo específicamente minero (voladura, taludes, espacios confinados de mina) y lo que se agrega es lo de carretera, planta y tercero.

### Lo que ya está construido en el ERP

El módulo de **línea base ya existe** en el código: `iperc_lineas_base` + `iperc_linea_base_items`, con su flujo de aprobación. La herramienta para cargar y aprobar la matriz está hecha — lo que falta es el contenido y ajustar la escala a la matriz de riesgo que se decida.

### Una secuencia que conviene respetar

Para el personal que no va a mina, **el primer entregable es la línea base, no el continuo**. El IPERC continuo se alimenta de la matriz: el propio formato de Barrick pregunta *"¿SE REVISÓ LA MATRIZ IPERC DE LÍNEA BASE?"*. Sin línea base no hay de dónde sacar los peligros y controles del continuo — quedaría texto libre inventado en cada viaje, que es justo lo que no sirve como prueba.

En mina el orden se puede invertir, porque ahí la matriz de línea base ya existe del lado de Barrick y el continuo se llena todos los días. Fuera de mina no hay nada, así que hay que empezar por el principio.


## La decisión que va a gerencia

Kenif lleva a gerencia la definición de si se digitaliza en el ERP el IPERC del personal de mina — el que hoy se llena en papel y se le rinde a Barrick — para que Santa Isabel de Cushuro tenga su propio respaldo ante futuros accidentes. Lo que sigue es el argumento en los términos en que gerencia decide, no en términos técnicos.

### El problema, en una frase

**La empresa entrega su evidencia y no se queda con ella.** El IPERC se llena todos los días, se le rinde a Barrick, y cuando hubo un accidente **no había cómo probar que ese trabajador conocía el riesgo**. En un proceso por accidente, quienes responden son el supervisor de trabajo y el supervisor de seguridad — personas concretas, no la empresa en abstracto.

### Qué cambia si se digitaliza

La empresa pasa a tener **su propio archivo**, con quién llenó cada IPERC, cuándo, desde qué dispositivo y con su firma, sin depender de pedirle nada al cliente. Ante un accidente, la prueba está del lado de Santa Isabel.

### Qué NO cambia (esto suele ser la objeción)

- **No cambia el trámite con Barrick.** Se le sigue entregando el mismo formato, impreso e idéntico — el sistema lo genera.
- **No suma trabajo al conductor.** Al revés: el objetivo es que los 30-40 minutos diarios de escritura pasen a marcar y firmar. Si el módulo terminara agregando un segundo llenado, estaría mal hecho.
- **No hay que comprar equipos.** Todos tienen celular.

### Lo que sí hay que autorizar

1. Digitalizar el IPERC de mina en el ERP.
2. Que **cada trabajador tenga usuario propio (DNI + contraseña) y firme en pantalla**. Sin esto no hay evidencia individual, que es todo el punto.
3. Que alguien le pregunte a Barrick si acepta su formato impreso desde un sistema con las firmas incorporadas, o exige firma manuscrita. **No bloquea el proyecto** — en el peor caso se imprime y se firma a mano, y el ahorro de tiempo se mantiene casi entero.
4. **Cuántos años conservar los IPERC.** Si el horizonte es la prescripción de un proceso penal, lo define el asesor legal, no el área de sistemas.

### Los riesgos, dichos de frente

- Si Barrick exige tinta, el ahorro es de escritura, no del proceso completo.
- Si el personal se presta las contraseñas, la evidencia se debilita. Lo compensa la firma trazada en el momento, con hora y dispositivo.
- El modo de fracaso conocido es el **doble llenado**: si se llena en papel y además en el sistema, nadie lo usa. Por eso el diseño es una sola carga y dos salidas.

### El punto que gerencia probablemente no sabe

**El personal que no va a mina hoy no tiene IPERC.** Santa Isabel no tiene formato propio: el único que existe es el de Barrick, y ese no aplica a un trabajo en Cajamarca o Bambamarca — lleva el nombre, el código y la versión de la mina. O esa gente llena un documento que no corresponde, o no llena nada. En cualquiera de los dos casos, ahí la empresa está más expuesta que en mina, no menos.

Digitalizar el de Barrick es además el camino para cubrir eso: el formato propio de Santa Isabel va a nacer clonando el de la mina y quitándole lo que es de ella.

### Lo que no hace falta que gerencia decida

La matriz de riesgo, el banco de preguntas, el esquema de base de datos y el algoritmo de priorización son decisiones técnicas y de SSOMA. No van a esa reunión.


## Hoja de ruta (condicionada)

**Se puede hacer ya, sin respuestas:**
- Medir la vista actual en un celular de gama baja.

**Necesita el formato físico en la mano (materia prima 1):**
- El esquema del banco de preguntas: pregunta → ítem IPERC que genera.
- El PDF que replica el formato de siempre.
- La pantalla de cuestionario con validación de completitud.

**Necesita el historial de anomalías (materia prima 2):**
- La priorización de preguntas.

**Requiere las respuestas 1-3:** cualquier migración sobre `iperc_items`.

**Requiere la respuesta 4:** firmas y participantes — y si firman personas sin login, aparece una entidad "personal" que hoy no existe en la base (solo hay `usuarios`).

**Requiere la respuesta 5:** versionado de línea base.
