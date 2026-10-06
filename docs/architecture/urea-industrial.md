# Urea industrial — inventario de bultos contados

- **Estado**: diseño aprobado, sin implementar. Reemplaza al panel mínimo que dejó la migración 0092.
- **Relacionado**: [control de combustible](control-de-combustible.md) (de donde sale casi todo el aparato que se reusa), [ADR-0002](../adr/0002-contrato-de-modulo.md) (contrato de módulo), migración `0092_combustible_urea.sql` (lo que ya existe).

---

## Por qué existe este documento

La urea entró al ERP en septiembre de 2026 como una pestaña mínima: cargar un vale, cargar una entrada, contar lo que queda. Sirvió para no quedarse sin registro, pero el cliente la miró en operación y pidió lo mismo que ya tiene el combustible — stock a la vista, kardex, umbrales que avisen, consumo por unidad. Al mismo tiempo apareció un dato que invalida una constante del código: **la caja no es de 16 L sino de 20**.

Las dos cosas juntas obligan a decidir de nuevo algo que en septiembre se resolvió por lo rápido: **cuánto de la urea es "combustible con otro nombre" y cuánto no**. Este documento fija esa línea, porque equivocarse para cualquiera de los dos lados sale caro: copiar el tanque entero mete conceptos que no existen (varilla, nivel, capacidad física), y no copiar nada obliga a reescribir ocho controles anti-robo que ya costaron cinco auditorías.

## La diferencia de fondo, en una línea

**El combustible es un líquido con nivel medible; la urea son bultos discretos que se cuentan.** Todo lo que sigue sale de ahí:

| | Combustible | Urea |
|---|---|---|
| Qué se mide | Nivel con varilla, en un tanque | Bultos contados en un almacén |
| Dónde está el stock | En un tanque identificable (`combustible_id`) | En la empresa, sin punto físico modelado |
| Contraparte física | La varilla, por tanque | El conteo físico, global |
| Unidad de captura | Galones/litros, directo | Bolsas/cajas/baldes → litros, por conversión |
| Costo | Promedio **ponderado** (se mezcla en el tanque) | Promedio **simple** (las cajas no se mezclan) |

---

## Decisiones

### 1. Los movimientos NO se mudan de tabla ni de ruta

Los vales y las entradas de urea siguen entrando por `POST /despachos` y `POST /recepciones` con `producto='urea'`, sobre `combustible_despachos` y `combustible_recepciones`.

Es tentador darle rutas propias ahora que tiene panel propio, y sería un error con tres consecuencias que no se ven hasta producción:

1. **Se pierde el offline.** `POST /despachos` está declarado en `offlineRegistry.ts`; un vale de urea cargado sin señal hoy se encola y sincroniza solo. Una ruta nueva no está declarada, y el grifero descubriría el problema cuando el vale ya se perdió.
2. **Se pierde el motor de talonario.** Hueco, vale fuera de orden, vale recargado y el 409 de duplicado los hereda la urea por compartir tabla y endpoint. Reimplementarlos es reabrir cinco auditorías.
3. **Se pierde el filtro por producto**, que ya costó un bug en producción y dos PRs (#172, #174).

Lo "propio" de urea son los endpoints **nuevos**: stock, kardex y configuración.

### 2. El conteo físico NO ajusta el inventario

Un conteo compara contra el stock teórico y levanta alerta si no cuadra. **No re-ancla el saldo.**

Es la misma regla que ya gobierna la varilla del tanque (ver "por qué el saldo teórico NO se re-ancla en cada varilla" en el kardex de combustible), y el motivo es el mismo: si la medición corrigiera el saldo, el faltante **desaparecería solo** y el conteo pasaría de ser un control a ser la herramienta perfecta para tapar un robo. El que se lleva 40 L cuenta 40 L de menos, el sistema "ajusta", y a fin de mes no falta nada.

El kardex muestra **las dos líneas** —saldo teórico y conteo físico— y la distancia entre ellas, que es lo que mira un auditor.

### 3. Los factores de conversión salen del código y pasan a ser datos

Hoy `FACTOR_LITROS_UREA` es una constante en `combustible.schema.ts` (bolsa 4, caja 16, balde 20). Pasa a una tabla por empresa, `combustible_urea_presentaciones`.

**Por qué tabla y no tres columnas en `combustible_config`**: en veinte días la caja pasó de 16 a 20 L, y el cliente ya mencionó un "galón" sin dato y antes un "bidón". Con tres columnas, cada presentación nueva es una migración y un deploy. Con tabla, el cliente la da de alta y sigue trabajando. El `CHECK` de la columna `presentacion` (hoy una lista fija de tres valores) se reemplaza por una **FK compuesta `(tenant_id, presentacion)`** — el mismo patrón que usó el rediseño de sedes/grifos, por el mismo motivo: *la verificación de FK no pasa por RLS, así que la clave tiene que llevar el tenant adentro o un tenant podría referenciar la fila de otro*.

**El factor se sigue congelando por fila.** Cambiar "caja" de 16 a 20 L afecta a los movimientos **nuevos**, nunca a los ya cargados: cada fila guarda el `factor_litros` que estaba vigente cuando se creó. Esa columna ya existe desde 0092 y es la razón por la que este cambio es seguro.

**Precisión que importa**: el factor vigente se lee **al crear el movimiento**, no a la fecha del movimiento. Un vale cargado hoy con fecha de la semana pasada usa el factor de hoy. Es una decisión consciente: el factor describe el envase que el operario tiene en la mano al cargar, no una línea de tiempo de precios. Queda documentado como riesgo aceptado (ver el checklist más abajo).

### 4. Los cuatro números, y su alcance

| Número | Alcance | Qué hace | Default |
|---|---|---|---|
| `tope_diario_urea_l` | **Por equipo**, ventana móvil de 24 h | Alerta si una unidad recibe más que eso en un día | NULL (ya existe) |
| `ratio_urea_diesel_max_pct` | Por equipo, ventana de 30 días | Alerta si la urea se dispara contra el diésel de la misma unidad | NULL (ya existe) |
| `stock_minimo_urea_l` | **Global, por empresa** | Alerta "queda poca urea, hay que reabastecer" | NULL (nuevo) |
| `stock_maximo_urea_l` | **Global, por empresa** | Alerta al registrar una entrada si el stock proyectado lo excede | NULL (nuevo) |

Los cuatro arrancan en **NULL = sin configurar = no alerta**, la regla del módulo desde 0075. No se inventa un número: un umbral inventado o alerta por trabajo normal —y entonces se ignora, como ya enseñó "marcar todas leídas"— o queda tan alto que no atrapa nada.

**Por qué el máximo es de stock y no de compra**: el cliente lo planteó como *"que la empresa no compre más de lo que consume"*. Modelarlo como "compra por período" obliga a definir el período, a decidir qué pasa con una compra grande y legítima antes de un pico de obra, y a mantener un acumulado nuevo. Un **techo de almacén** da la misma protección con un solo número y sin estado: al registrar una entrada se proyecta `stock actual + lo que entra`, y si pasa el techo, alerta. De paso cubre un caso que el tope por período no ve: comprar de a poco hasta llenar el depósito.

Y **alerta, no bloquea** — a diferencia del tope de capacidad del tanque, que sí bloquea porque es físicamente imposible meter más de lo que cabe. Acá no hay imposibilidad física: siempre se puede apilar una caja más en el depósito, y rechazar la entrada haría que no se registre, que es peor.

### 5. El stock se deriva, no se guarda

`stock = Σ entradas vigentes − Σ salidas vigentes`, calculado al leer (`findStockTeoricoUrea`, ya existe).

Mismo principio que el nivel del tanque desde 0059: **no se guarda lo que se puede calcular**. Un stock guardado en una columna es un número que hay que mantener sincronizado con cada alta, anulación y corrección — y el desfase falla en silencio, que es exactamente el bug que 0059 vino a cerrar.

### 6. El panel reemplaza a la pestaña actual

Misma ubicación en el submenú de Combustible, mismo componente (`UreaPanel.tsx` evoluciona). Sin migración de datos: el modelo de movimientos no cambia, cambia lo que se calcula y se muestra sobre él.

### 7. El visual es de inventario, no de tanque

Nada de cilindro con líquido. El stock se muestra como **barra contra el mínimo y el máximo**, más la traducción a bultos ("≈ 18 cajas") de la presentación de referencia. La urea no tiene un nivel continuo: tiene cajas enteras, y un gráfico que sugiera lo contrario miente sobre lo que se puede ir a contar.

---

## Modelo de datos (migración `0116_combustible_urea_panel.sql`)

```
combustible_urea_presentaciones          ← NUEVA
  id            SERIAL
  tenant_id     UUID NOT NULL REFERENCES tenants(id)
  codigo        VARCHAR(20) NOT NULL     -- 'bolsa' | 'caja' | 'balde' | lo que el cliente agregue
  nombre        VARCHAR(60) NOT NULL     -- "Caja (20 L)" -- lo que se ve en el desplegable
  litros        NUMERIC(8,2) NOT NULL CHECK (litros > 0)
  es_referencia BOOLEAN NOT NULL DEFAULT false  -- en cuál se expresa el stock en pantalla
  activa        BOOLEAN NOT NULL DEFAULT true
  UNIQUE (tenant_id, codigo)             -- la clave que usa la FK compuesta
  UNIQUE (tenant_id, id)                 -- requisito de la FK compuesta
  + RLS completo (ENABLE + FORCE + policy tenant_isolation)

combustible_config                       ← dos columnas nuevas
  stock_minimo_urea_l  NUMERIC(12,2)  CHECK (> 0)   -- NULL = no alerta
  stock_maximo_urea_l  NUMERIC(12,2)  CHECK (> 0)   -- NULL = no alerta
  + CHECK (minimo < maximo cuando los dos existen)

combustible_despachos / combustible_recepciones
  presentacion: el CHECK fijo de 3 valores se reemplaza por
  FOREIGN KEY (tenant_id, presentacion) REFERENCES combustible_urea_presentaciones (tenant_id, codigo)

combustible_alertas / combustible_anomalias
  tipo: + 'urea_stock_bajo', 'urea_stock_excedido', 'urea_conteo_recargado'
```

**Backfill y orden, en este orden exacto:**

1. Crear la tabla y sembrar las tres presentaciones actuales (bolsa 4, caja 16, balde 20) **para todos los tenants existentes**, con `caja` como referencia. Se siembran los valores de HOY, no los nuevos: cambiar el 16 por 20 es una decisión del cliente desde la pantalla, no un efecto colateral de un deploy. Si la migración cambiara el número sola, todos los litros que se carguen el día del deploy saldrían distintos sin que nadie lo haya decidido.
2. Recién después, soltar el CHECK y crear la FK compuesta — con las tablas en `NO FORCE ROW LEVEL SECURITY` durante la ventana, como hizo 0097: **la verificación de una FK nueva no pasa por RLS y falla contra una tabla con FORCE**.
3. `platform.service.ts` siembra las tres presentaciones al dar de alta un tenant, igual que ya crea la sede y el grifo "Principal".

---

## Flujo completo

```
ENTRADA (recepción, producto='urea')
  elige presentación + cuántos bultos
  → el servidor lee el factor VIGENTE y lo congela en la fila
  → cantidad (litros) = bultos × factor
  → proyecta stock + cantidad; si supera stock_maximo_urea_l → alerta urea_stock_excedido
          ↓
STOCK (derivado, nunca guardado)
  Σ entradas vigentes − Σ salidas vigentes
  si cae bajo stock_minimo_urea_l → alerta urea_stock_bajo (deduplicada)
          ↓
VALE (despacho, producto='urea')  → a una unidad, con talonario propio
  mismos controles heredados: hueco, duplicado, fuera de orden, recargado, anulación con motivo
  + propios: equipo no habilitado, ratio urea/diésel, tope diario
          ↓
CONTEO FÍSICO  → NO ajusta. Compara contra el stock teórico de ESE instante.
  si difiere → alerta urea_descuadre_conteo
          ↓
KARDEX  → las tres historias en una línea de tiempo, con saldo corriente
          y la distancia teórico-vs-contado donde haya conteo
```

---

## El kardex de urea

Se calca del kardex del tanque (`findKardex` + `armarKardex`), con una diferencia: donde el tanque pone la varilla, la urea pone el conteo.

| Columna | De dónde sale |
|---|---|
| Fecha | `recibido_en` / `despachado_en` / `contado_en` |
| Tipo | entrada / vale / conteo |
| Referencia | documento de la entrada, `serie-n_vale` del vale |
| Detalle | proveedor, o placa + conductor |
| Entrada / Salida | litros, y entre paréntesis los bultos con su factor congelado |
| Saldo teórico | corriente, acumulado |
| Contado | solo en las filas de conteo |
| Diferencia | contado − saldo teórico, solo en esas filas |

Exportable con el mecanismo que ya existe (SheetJS está instalado y en uso). **No se reimplementa un generador de xlsx.**

---

## El asistente de umbrales

Reusa `sugerirTopesDiarios`: promedio + 2 desvíos, mínimo de muestra, la muestra entera en la respuesta, y **nunca se aplica solo** — sugiere, una persona decide.

**Va a nacer sin nada que sugerir**, y eso no es un bug: el cliente arranca de cero, sin historial de urea. Se reusa el estado "muestra insuficiente" que el asistente de combustible ya resuelve, con el texto diciendo cuántos movimientos faltan. El día que haya operación real, el mismo botón empieza a dar números.

---

## Consumo por tanqueada

Promedio derivado: `litros despachados al equipo / cantidad de vales`, en el ranking por vehículo que la pestaña ya tiene. **Cero backend nuevo** — el endpoint ya devuelve los dos números, la división se hace en la pantalla.

**Suposición que queda documentada**: se asume *un vale = una tanqueada*. Es cierto en la operación real que describió el cliente (se le echa urea a la unidad y se emite el vale), pero si mañana aparece el caso de dos vales para una misma carga, el promedio queda bajo. Se revisa cuando haya historial.

---

## Permisos

Dos pestañas nuevas en el catálogo de `permisosPestanas.service.ts`:

- `urea:kardex` — consulta. Entra en los defaults de admin, operador, lectura y encargado de urea.
- `urea:configuracion` — editar factores y umbrales. **Solo admin por defecto.**

El rol `encargado_urea` (0105) **ya existe y está en uso** en `combustible.routes.ts` y en los defaults de perfil. No se toca: Noemi va como admin por decisión del cliente, y el perfil queda disponible para cuando se delegue.

---

## Checklist anti-fraude

| # | Vector | Estado |
|---|---|---|
| 1 | Cambiar el factor para inflar el stock | **Mitigado**: el factor se congela por fila, el histórico no se reinterpreta. El cambio exige motivo y queda en bitácora. |
| 2 | Cambiar el factor y cargar movimientos retroactivos con el factor nuevo | **Riesgo aceptado, documentado**: el factor se lee al crear, no a la fecha del vale. Visible en el kardex (la fila muestra su factor). Cerrarlo del todo exigiría versionar factores por fecha — complejidad que hoy no se justifica con un cliente que cambia el envase una vez al año. |
| 3 | Conteo físico declarado para tapar un faltante | **Mitigado parcialmente**: el conteo no ajusta, el descuadre queda como alerta. **Residual real**: la misma persona recibe, entrega y cuenta (confirmado por el cliente). Se expone como autorrevisión, no se bloquea. |
| 4 | Anular conteos hasta que uno cuadre | **Cerrado (0118)**: `urea_conteo_recargado`, calcado de `vale_recargado` — si un conteo anulado se vuelve a cargar con otro número, se alerta con los dos valores y el motivo de la anulación. |
| 5 | Comprar de a poco para esquivar el techo | **Mitigado**: el máximo mira el stock **proyectado**, no la entrada aislada. |
| 6 | Entrada con costo 0 para falsear el kardex valorizado | **Mitigado**: `costo_unitario > 0` ya es obligatorio en la recepción. |
| 7 | Vale de urea a una unidad que no usa urea | **Mitigado**: alerta `urea_equipo_no_habilitado` (0092). |
| 8 | Los conteos de urea no aparecen en el reporte de segregación | **Cerrado (entrega 4)**: "Quién hace y quién controla" cuenta vales, recepciones y varillas, pero no conteos de urea — justo el acto que el cliente confirmó que hace la misma persona que recibe y entrega. Se suma una columna. |

---

## Plan de entregas

| # | Qué entra | Riesgo |
|---|---|---|
| **1 ✅** | Presentaciones editables: tabla, FK compuesta, backfill, seed de tenant nuevo, service lee el factor vigente, pantalla de configuración | **Alto** — toca el CHECK de dos tablas con datos vivos |
| **2 ✅** | Stock y umbrales: dos columnas de config, endpoint de stock, alertas `urea_stock_bajo` / `urea_stock_excedido`, UI de los cuatro números + asistente | Medio |
| **3 ✅** | Kardex de urea + exportación | Bajo |
| **4 ✅** | Panel nuevo: barra de stock, franja de hallazgos, promedio por tanqueada, `urea_conteo_recargado`, conteos en el reporte de segregación | Medio |

Cada entrega va con sus tests y queda verde antes de la siguiente. La 1 es la que hay que mirar con lupa: si el backfill de presentaciones falla, los movimientos de urea dejan de poder cargarse.

### Entrega 1 — lo que quedó hecho

- `migrations/0116_combustible_urea_presentaciones.sql`: la tabla con RLS, las dos FK compuestas `(tenant_id, presentacion)`, el seed de los tres envases con los valores **vigentes** (caja = 16 L, no 20) para todos los tenants, y la baja del CHECK fijo. Idempotente y verificada contra la base local: 124 tenants sembrados, 0 movimientos huérfanos, RLS restaurado a `enable=true/force=true`.
- `GET/POST/PUT /api/erp/combustible/urea/presentaciones`. El GET lo lee cualquiera que tenga algo de Urea (los formularios de carga llenan su desplegable con esto); los dos write son `requireRole("admin")` + pestaña `urea:configuracion`.
- Pestaña `urea:configuracion` nueva. Nace **fuera** del perfil por defecto del `encargado_urea`: es la misma persona que recibe, reparte y cuenta, así que darle también el número contra el que se compara su propio conteo cerraría el círculo. El admin se lo puede habilitar a mano.
- Un cambio de litros se audita como `combustible.urea_presentacion_factor_cambiado` (acción propia, separada de una edición cualquiera) con los litros de antes, los de después, el motivo y **cuántos movimientos ya usan esa presentación** — el dato que distingue "lo corregimos antes de usarlo" de "lo movimos con 300 vales cargados encima".
- `platform.service.ts` siembra los tres envases al dar de alta un tenant, en la misma transacción que la sede y el grifo "Principal". Sin eso el primer vale de urea de una empresa nueva se rechazaría: la FK compuesta no tendría contra qué validar.
- `registry.ts`: la tabla entra en `tablas` **antes** de recepciones y despachos (el restore necesita padres antes que hijos) y en `raices` (cascadea desde `tenants`, no desde ninguna tabla del módulo, así que el wipe de un tenant no la alcanzaría sola).
- UI: el panel lee el catálogo del API en vez de la constante, el desplegable arranca en la unidad de referencia de la empresa (nunca en un código fijo), las tablas de historial muestran los litros **congelados en la fila** y no los del catálogo de hoy, y la pantalla de configuración explica en texto qué se mueve y qué no antes de pedir el motivo.
- `tests/combustible-urea-presentaciones.test.ts`, 15 casos. El que importa: cambiar la caja de 16 a 20 L no toca el vale ya cargado y sí el siguiente.

**Un defecto que salió en los tests y vale anotar:** `resolverFactorPresentacionUrea` lanzaba un `Error` pelado, y los tres handlers de carga mandan al 500 cualquier error que no reconozcan por `includes`. Una presentación desactivada devolvía 500 — y la cola offline reintenta los 5xx para siempre, con un dato que nunca iba a pasar. Ahora sale como `AppError(400)` y los tres catch lo respetan antes de la lista de strings. Lo nuevo del módulo debería salir siempre tipado.

### Entrega 2 — lo que quedó hecho

- `migrations/0117_combustible_urea_stock_umbrales.sql`: `stock_minimo_urea_l` y `stock_maximo_urea_l` en `combustible_config`, con tres CHECKs (cada uno > 0, y mínimo < máximo cuando los dos existen), los dos tipos de alerta nuevos y un índice parcial para la deduplicación. Aplicada, verificada contra la base e idempotente.
- **La decisión que más importa de esta entrega**: `urea_stock_bajo` es un ESTADO y `urea_stock_excedido` es un HALLAZGO, así que entran en CHECKs distintos. "Queda poca urea" deja de ser verdad cuando llega la compra — se auto-resuelve, no se duplica mientras está abierta, y **no se puede congelar como anomalía**. "Esta entrada dejó el depósito por encima del techo" sigue siendo cierto para siempre — se congela como cualquier hallazgo. Si se hubieran agregado los dos a `combustible_anomalias` "por simetría", el worker de congelado habría convertido en anomalía permanente cada vez que la empresa se queda corta antes de la compra del mes.
- **El máximo es un techo de ALMACÉN, no de compra**, y por eso mira el stock *proyectado*. Un tope por compra se esquiva comprando de a poco varias veces; el techo del depósito no. Hay un test que compra tres veces 160 L contra un techo de 500 y demuestra que la tercera alerta aunque ninguna sola lo pasara.
- **Ninguno de los dos bloquea.** A diferencia del sobrestock del tanque (0102), acá no hay imposibilidad física: siempre se puede apilar otra caja, y rechazar la entrada lograría que no se registre. Una compra de más registrada es mejor que una compra sin registrar.
- Aflojar en **direcciones opuestas**: bajar el mínimo afloja (el aviso llega tarde), subir el máximo afloja (se puede comprar más sin que nadie se entere). Son los dos únicos umbrales del módulo que no aflojan en la misma dirección, así que el mínimo tiene su propio bloque en `evaluarAflojamientoConfig` en vez de entrar en el loop de topes.
- `GET /urea/estado` ahora trae el stock derivado, los dos límites, la traducción a bultos de la unidad de referencia y el último conteo con su diferencia. **El stock negativo viaja con signo** y la barra lo dice con palabras en vez de dibujarlo en 0: tapar eso sería tapar el síntoma que el módulo existe para encontrar.
- `GET /urea/sugerencia-umbrales` (admin): los cuatro números desde 90 días de historial. Cada uno con su **fórmula distinta y dicha en texto**, porque no son cuatro variantes de la misma cuenta: el tope diario es promedio + 2σ por equipo tomando el que más consume; el ratio es promedio + 2σ *acumulado* por equipo (día por día daría 0% y 400% alternados); el mínimo es la **peor semana observada** (ventana móvil de 7 días calendario), porque un mínimo de stock no protege contra un día pico sino contra quedarse sin urea hasta la próxima compra; y el máximo es un mes de consumo al ritmo actual, **deliberadamente sin + 2σ**, porque ahí el desvío aflojaría el control que se está calibrando.
- UI: barra de inventario con las marcas de mínimo y máximo (nunca un cilindro con líquido — decisión 7), el formulario de los cuatro umbrales y el asistente que **rellena los inputs pero no guarda**.
- `tests/combustible-urea-stock.test.ts`, 18 casos.

**Lo que se cerró de paso, y era un hueco real:** los correos de urea. Desde 0092 las alertas de urea nacían, se guardaban y se publicaban por SSE, pero `procesarAlertasDespachoUrea` terminaba en un `void admins` con un comentario de "queda para una entrega posterior" — cuatro correos escritos y nunca enganchados, durante veinte días, sin que ningún test lo notara. Kenif lo daba por supuesto (2026-10-04: "al usuario que le dé check le llegarán las alertas de urea ya que está dentro de combustible"). Ahora los seis salen.

**Y el defecto de método que eso expone:** todo esto corre en `try/catch` best-effort, así que un correo llamado con la forma equivocada se loguea y la alerta igual queda creada — el test pasa sin que el correo funcione. Los primeros 17 tests de esta entrega pasaban **sin ejercitar una sola línea de correo**, porque un tenant nuevo no tiene destinatarios (0107) y el bloque entero se saltea. Se agregó un caso que marca un destinatario real y mockea `enviarCorreoAlerta` (el primitivo por donde pasan los veinte correos del módulo), y ahí sí se verifica la cadena completa. **Cualquier entrega futura que agregue un correo tiene que hacer lo mismo o no lo está probando.**

### Entrega 3 — lo que quedó hecho

- `GET /urea/kardex` y `/urea/kardex/xlsx`: entradas, vales y conteos en una línea de tiempo con saldo corriente desde el saldo inicial del período (todo lo vigente anterior a `desde`). Sin migración: solo la pestaña `urea:kardex`, que entra en los defaults de admin, operador, lectura y encargado de urea.
- **El conteo no corrige el saldo.** La fila de conteo muestra lo contado y la diferencia contra lo que los papeles decían a esa hora, pero el saldo sigue su curso (decisión 2). `diferencia_final` es `null` si no hubo conteo: decir 0 afirmaría que cuadra.
- **Lo anulado se ve, con su motivo, y no mueve el saldo.** Es evidencia, no cuenta.
- **Cada fila muestra "bultos × factor"** con el `factor_litros` congelado: es donde se hace visible el riesgo aceptado del vector 2 (factor cambiado y movimientos retroactivos).
- Orden dentro del mismo instante: entrada, vale, conteo — el conteo último, porque compara contra lo que ya está explicado.
- El xlsx sale del mismo `armarKardexUrea` que la pantalla, con totales como fórmula, y **exportar se audita antes de entregar** (`urea_kardex_exportar`). Ver exige `urea:kardex`; llevárselo exige además `urea:exportar`.
- No se reimplementó nada: se usó el `armarXlsx` propio del repo (el ADR decía SheetJS, pero el kardex del tanque ya usaba este generador).
- `tests/combustible-urea-kardex.test.ts`, 8 casos.

### Entrega 4 — lo que quedó hecho

- `migrations/0118_combustible_urea_conteo_recargado.sql`: el tipo `urea_conteo_recargado` en las dos listas (es hallazgo, se congela) y un índice parcial sobre los conteos anulados.
- **El conteo recargado no se calca literal de `vale_recargado`.** Aquel compara cantidades; un conteo no se puede comparar así, porque entre el anulado y el nuevo salen vales y dos cantidades distintas pueden ser las dos correctas. Se compara el **descuadre** de cada uno contra el stock teórico de su propia hora, y se alerta **solo si el nuevo queda más cerca de cuadrar** que el anulado (con medio litro de margen). Es el patrón exacto del vector 4. Un recuento que muestra *más* faltante admite una pérdida, no la esconde, y no alerta. Ventana: conteos anulados en las últimas 72 h con fecha de conteo a menos de 72 h del nuevo; se informa cuántas anulaciones hubo en esa ventana.
- **Un bug latente que salió de esto:** el bloque de alertas de `crearConteoUrea` cortaba con un `return` cuando el conteo nuevo no tenía descuadre. El caso que más importa —el recuento que cuadra después de anular uno que no— nunca habría llegado al detector. Ahora todos los controles del conteo corren siempre.
- `GET /urea/hallazgos` y la franja arriba del panel: lo de urea que sigue sin explicar, **solo lectura**. El cierre con motivo vive en Combustible → Alertas; duplicarlo acá serían dos lugares para cerrar una alerta, y uno terminaría sin la validación del otro. Pestaña `urea:hallazgos`, admin y operador, **no** encargado de urea ni lectura: son las alertas sobre el trabajo de la propia persona, mismo criterio que el grifero con las alertas de combustible.
- **Ni el panel de Alertas ni la campanita conocían ningún tipo de urea**, tampoco los tres de la 0092: donde se cierran los hallazgos se veían sin nombre. Se agregaron los seis con su frase de detalle.
- Reporte de segregación: columnas `conteos_urea` y `conteos_urea_sobre_lo_propio` (contó quien también registró vales o entradas de urea en el período), las anulaciones de conteo entran en "anulaciones" y "…propias", y los conteos cuentan como cargas para la concentración.
- Ranking por vehículo: **promedio por tanqueada** (litros / vales), con la suposición "un vale = una tanqueada" en el tooltip.
- `tests/combustible-urea-hallazgos.test.ts`, 9 casos, con el primitivo de correo mockeado y un destinatario real.

### Entrega 5 — compra de urea en ruta (migración 0119)

Pedido de Kenif (2026-10-05): las unidades también compran urea en ruta. Decisiones suyas: formulario aparte, el conductor la registra igual que en combustible, y la boleta o factura con su foto es obligatoria.

- **El problema de fondo era el stock, no la pestaña.** Hasta acá todo vale de urea bajaba el stock del almacén. Una compra en ruta nunca pasó por el depósito: si lo bajara, el primer conteo daría un sobrante falso que además taparía un faltante real del mismo tamaño.
- **Origen nuevo y explícito, `almacen`**, para el reparto desde el depósito (talonario propio, baja el stock). `compra_externa` pasa a significar lo mismo que en combustible (boleta o factura, no toca el almacén). Se descartó distinguirlas por "tiene vale o tiene comprobante": sería una regla implícita que cada consulta de stock tendría que recordar, y la primera que se olvide mezcla las dos cosas en silencio, que es exactamente el bug de los rankings de #174. Las filas existentes pasan a `almacen` (era lo único que se podía cargar); los vales viejos que traiga la cola offline se normalizan en el schema, una sola vez.

| | Almacén (vale) | Compra en ruta (boleta) |
|---|---|---|
| Stock, kardex, conteo, mín/máx, asistente de stock | sí | **no** |
| Tope diario, ratio urea/diésel, rankings, por tanqueada | sí | sí |
| Talonario (hueco, fuera de orden, recargado) | sí | no (no hay vale) |

- **La misma boleta puede traer diésel y urea.** El índice único del comprobante (0109) no tenía el producto, así que la urea comprada en el mismo PRIMAX y en el mismo ticket que el diésel rebotaba como duplicada. Se suma `producto` a la clave; la urea de una boleta sigue sin poder entrar dos veces.
- **La foto es obligatoria en el formulario, no en el servidor.** Viaja en una segunda petición, por el uuid de la compra, para que sin señal la compra y su foto queden juntas en la cola. El listado marca "sin foto" en rojo cuando falló.
- **Cada ruta de la foto toca solo su producto.** Las de urea se gatean con `urea:registrar_compra` / `urea:vista`, y el service verifica el producto de la fila (distinto = 404). Al pasar el producto al controller apareció una trampa: con `.bind(controller)` Express le habría pasado `next` como producto, y **toda subida de combustible habría dado 404**. TypeScript lo atajó; hay un test que lo ata.
- **El conductor** recibe por defecto `urea` + `urea:registrar_compra` y ve solo ese botón. La regla de origen por rol lo bloquea para el reparto del almacén.

**Tres bugs que salieron en esta entrega y venían de antes:**

1. **No había ninguna casilla "abastece urea" en la pantalla de Proveedores.** El rol existía en la base desde 0092, pero nadie podía marcar un proveedor para urea desde la interfaz: por eso el desplegable salía vacío. Se agregó la casilla al alta y a la edición de roles.
2. **El encargado de urea y el conductor recibían 403 al listar proveedores** (`GET /grifos` pide `tanques:proveedores`): aunque hubiera proveedores marcados, para ellos el desplegable salía vacío siempre. Endpoint propio `GET /urea/proveedores`, mismo patrón que `/config/formulario-despacho` (0113).
3. **El costo de la urea se guardaba por bulto y se usaba por litro.** Los formularios piden "costo por caja", pero `costo_total` es `litros × costo_unitario`: 10 cajas a S/ 40 se valorizaban en S/ 6.400 en vez de S/ 400 (×16). El vale heredaba el error del promedio de las entradas. Ahora se convierte con el factor congelado de la fila (`costoPorLitroUrea`). **Las filas ya cargadas con el costo por bulto no se corrigieron**: ver la nota de abajo.

**Pendiente de decisión — el costo histórico.** Las entradas de urea cargadas antes de este cambio tienen el costo por bulto en `costo_unitario`; corregirlas es dividir por su `factor_litros`, que está en la misma fila. Los vales que tomaron el promedio de esas entradas no se pueden reconstruir exacto (el promedio mezclaba envases). No se tocó: antes hay que mirar cuántas filas hay en producción.

- `tests/combustible-urea-compra-ruta.test.ts`, 16 casos.

### Entrega 6 — renglones en la compra, historial y conductor (migración 0120)

Pedido de Kenif (2026-10-05): un volquete consume "1 caja + 2 bolsas", y en la práctica eso pasa en la **compra en ruta** ("compran y envían hoy la foto de la factura y la cantidad de compra"). Por decisión suya, los renglones van **solo en la compra**: el vale del almacén y el conteo siguen con una presentación por fila.

- **Una compra es un registro con sus renglones adentro** (`combustible_despacho_urea_lineas`). Se descartó un despacho por presentación bajo la misma boleta: una compra es un papel con una foto, y "reemplazar comprobante" tiene que ser sobre la compra, no sobre pedazos de ella. El despacho guarda el total (litros y costo por litro del total) y cada renglón su factor congelado y su precio por bulto tal como figura en la boleta. En la compra, las columnas de presentación del despacho quedan en NULL: el detalle en un solo lugar. La forma de una sola presentación se sigue aceptando y el schema la convierte en un renglón; el servicio tiene un solo camino.
- **Todo o nada**: los renglones se insertan en la misma transacción que la compra. Si un renglón falla (por ejemplo, una presentación desactivada), no queda ni la compra a medias ni un renglón suelto. Hay un test que lo ata.
- **Historial de compras en ruta** (`GET /urea/compras`, vista propia en el panel), calcado del de combustible: comprobante con "Ver comprobante", proveedor, unidad y conductor, renglones, litros y total. "Adjuntar" (si no tenía foto) no pide motivo: es terminar de registrarla. "Reemplazar" sí, y queda en la bitácora. "Anular", solo admin y operador. La vista "Vales" pasó a mostrar solo el almacén.
- **Conductor**: el sistema ya lo copiaba de Equipos al registrar (0083), también para urea. Ahora el formulario lo muestra al elegir la unidad, y avisa si la unidad no tiene conductor cargado.
- El selector de archivo nativo se veía como texto plano en el tema oscuro y no parecía un botón: ahora es un botón.
- `tests/combustible-urea-compra-ruta.test.ts`, 23 casos.

### Entrega 7 — catálogo de precios de urea (migración 0121)

Pedido de Kenif (2026-10-05): "una pestaña donde se grabe el precio de la urea, marca, etc., y que al registrar jale automáticamente". Decisiones suyas: precio por proveedor y presentación, marca como referencia, alerta con 10 % de tolerancia.

- **Mismo modelo que el catálogo de combustible (0063).** El precio se apila con su `vigente_desde`, nunca se pisa; un precio mal cargado se anula con motivo. Se busca "el más reciente <= la fecha de la compra": una compra offline que llega tarde se compara contra el precio de su día.
- **Autocompleta en la compra en ruta y en la entrada**, renglón por renglón, y queda editable: manda la boleta. Tipear el precio lo saca del autocompletado, así que cambiar de proveedor después no pisa lo tipeado. El formulario muestra "Catálogo: S/ 50 (Green 32)" y, si el precio difiere, en cuánto.
- **No se usa en el vale del almacén.** El vale lleva el costo promedio de lo que la empresa efectivamente pagó por la urea del depósito; el catálogo es el precio de lista de hoy. Son números distintos a propósito.
- **`urea_precio_fuera_de_catalogo`**: una compra en ruta con algún renglón que se aparta del catálogo vigente de ese proveedor más que la tolerancia, **en las dos direcciones** (por arriba es el caso obvio; por abajo dice que el catálogo quedó viejo o que la boleta no es lo que dice). No bloquea. Es un hallazgo: se congela. Sin precio de catálogo para ese envase, no se compara. Correo con el detalle renglón por renglón.
- **La tolerancia es config** (`tolerancia_precio_urea_pct`), no código. Arranca en 10 porque Kenif lo aprobó; el default va del lado estricto (un llamador viejo que no mande el campo vuelve a 10, nunca apaga en silencio). NULL apaga. Subirla o apagarla afloja y pide motivo.
- **Permisos:** leer el catálogo, cualquiera con algo de Urea (lo necesitan los formularios). Cargar y anular, admin y operador con la pestaña `urea:precios`, mismo reparto que el catálogo de combustible. El encargado de urea **no** por defecto: el precio de catálogo es contra lo que se compara su propia boleta.
- `tests/combustible-urea-precios.test.ts`, 18 casos, incluido el correo con destinatario real.

## Preguntas abiertas

- ~~¿Adjuntar la factura o guía en las entradas al almacén?~~ **Resuelto (2026-10-05): no.** El cliente quiere un módulo de **órdenes de compra** propio, para repuestos, servicios, combustible y urea. El cruce OC ↔ guía ↔ factura, con sus archivos, va a vivir ahí, en un solo lugar para todos los productos. Adjuntarlo además en las recepciones dejaría el mismo papel en dos lugares. Lo que queda como está: las entradas siguen guardando tipo y número de documento, y cuando exista el módulo se les suma un vínculo a su OC. La compra en ruta conserva su boleta y su foto: es una compra de urgencia sin OC, y ahí la boleta es el único respaldo.
- **El costo histórico de urea** (ver la entrega 5): las entradas y vales cargados antes de la corrección tienen el costo por bulto en la columna de costo por litro.
