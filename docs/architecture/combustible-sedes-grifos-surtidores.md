# Sedes, grifos internos y surtidores

Estado: **diseño aprobado en sus decisiones, sin código**. Las entregas están al final.

## 1. Por qué

Hasta hoy el ERP asume que un tanque **es** el punto de abastecimiento completo: un tanque, un surtidor, un totalizador, y nada que agrupe los tanques de una planta. Eso alcanza para un cliente con un solo grifo. No alcanza para lo que pasa en la realidad y para lo que el producto tiene que soportar desde ahora, sin esperar a que cada cliente lo pida:

- una empresa con **varias plantas**, cada una con su **grifo interno** (Cushuro tiene 2 sedes hoy);
- un grifo con **más de un surtidor**, y un mismo surtidor conectado a **dos tanques**;
- personas que deben ver **solo su grifo** (o su surtidor), y gerentes que ven **todas las sedes** sin operar nada.

Lo que hoy falla, en concreto:

| Hoy | Consecuencia |
|---|---|
| No existe sede, planta ni grifo interno | Ningún reporte, permiso ni filtro puede separar una planta de otra |
| La cadena del totalizador filtra solo por tanque | Un tanque con 2 surtidores, o un surtidor sobre 2 tanques, da alertas falsas de salto y de retroceso |
| Los permisos son por empresa | Un grifero de una planta ve y carga vales de todas |
| Los equipos no pertenecen a ningún lado | El reporte de consumo compara como pares equipos de plantas distintas |

**Vocabulario.** En el código, `combustible_grifos` son los **proveedores externos** (PRIMAX, Velásquez). Los grifos internos de este documento son otra cosa y viven en otra tabla. Decisión: en pantalla los externos pasan a llamarse **"Proveedores"** y la palabra "grifo" queda solo para los internos. La tabla no se renombra: es un cambio de textos, no de datos.

## 2. Principios

1. **Cubrirlo todo desde ahora.** Se diseña para 4 plantas con varios grifos y varios surtidores cada uno, aunque el primer cliente tenga menos.
2. **Cero fricción para el caso simple.** Una empresa con una sola sede, un solo grifo y un surtidor por tanque no ve ningún selector nuevo.
3. **El alcance filtra lo que se MUESTRA, nunca lo que se CALCULA.** Las alertas, el consumo por equipo y las cadenas de totalizador se calculan siempre con todos los datos. Si dependieran de lo que ve cada usuario, el mismo equipo tendría dos consumos distintos.
4. **Los datos actuales no cambian de significado.** Toda empresa existente se migra sola a una sede y un grifo "Principal", y nadie pierde acceso.
5. **Un control de acceso no puede depender de que cada consulta se acuerde de filtrar.** Se aplica en un solo punto y se prueba atacando la API.
6. **Quién y por qué.** Todo cambio de alcance, de asignación de un tanque o un equipo a un grifo, y toda baja, queda en la bitácora con motivo.
7. **Cada hecho guarda dónde ocurrió.** Un vale, una varilla o una recepción copian su grifo al registrarse, y esa copia no se recalcula nunca. Mover un tanque o un equipo no reescribe el pasado (sección 7).

## 3. Modelo de datos

```
Empresa (tenant)
 └─ Sede
     └─ Grifo interno
         ├─ Tanques
         ├─ Surtidores  ── conectados a uno o más tanques del mismo grifo
         └─ Equipos
Compras externas: sin grifo y sin sede.
```

### Tablas nuevas

Convenciones del proyecto: `SERIAL`, `creado_en`, RLS con `FORCE` y la política `tenant_isolation`. Los nombres son únicos sin distinguir mayúsculas ni espacios (`lower(trim(nombre))`), como los puntos de precinto.

- **`sedes`** (entrega 1): `id`, `tenant_id`, `nombre`, `activo`, `motivo_baja`, `creado_por`, `creado_en`. Es una entidad de la empresa y no de Combustible: los otros módulos podrán colgarse de ella más adelante sin rehacer nada. Esta entrega solo la conecta con Combustible.
- **`grifos_internos`** (entrega 1): `id`, `tenant_id`, `sede_id`, `nombre`, `activo`, `motivo_baja`, `creado_por`, `creado_en`.
- **`asignaciones_grifo`** (entrega 1): el historial de pertenencia de tanques, surtidores y equipos. Ver 7.2.
- **`surtidores`** (entrega 2): `id`, `tenant_id`, `grifo_interno_id`, `nombre`, `activo`, `usa_totalizador`, `totalizador_tolerancia`. **La casilla y la tolerancia pasan del tanque al surtidor**: un grifo puede tener un surtidor con totalizador y otro sin, y cada aparato tiene su propia resolución.
- **`surtidor_tanques`** (entrega 2): `surtidor_id`, `combustible_id`. El servidor valida que el tanque y el surtidor sean del **mismo grifo**.
- **`combustible_lectura_totalizadores`** (entrega 2): `lectura_id`, `surtidor_id`, `valor`. Reemplaza a `combustible_lecturas.totalizador_lectura` (migración 0096): la varilla de un tanque lee el totalizador de **cada** surtidor conectado a él.
- **`usuario_accesos_combustible`** (entrega 3): `usuario_id` más exactamente uno de `sede_id`, `grifo_interno_id`, `surtidor_id` (ver sección 5).

### Columnas nuevas

- `combustible.grifo_interno_id` (entrega 1): cada tanque pertenece a un grifo. NOT NULL después del backfill.
- `equipos.grifo_interno_id` (entrega 1): cada equipo pertenece a un grifo. Nullable: una empresa sin el módulo Combustible no lo usa, y en la entrega 3 un equipo sin grifo solo lo ve quien tiene alcance "todo".
- `combustible_despachos.surtidor_id` (entrega 2): obligatorio en los vales del tanque propio; nulo en las compras externas y en la urea. Un CHECK por forma, igual que el resto del vale.
- `grifo_interno_id` **copiado en cada hecho** al registrarse (entrega 1): vales, varillas, recepciones, colocaciones de precinto, alertas y anomalías. La sección 7 dice de dónde sale en cada caso.
- `combustible_despachos.equipo_grifo_interno_id` (entrega 1; la alerta que la usa es de la entrega 4): copia del grifo **del equipo** al momento del vale. Es la que dispara la alerta de equipo de otro grifo y la que ubica una compra externa.
- `usuario_modulos.alcance` (entrega 3, junto con su lógica): `todo` (por defecto) o `asignado`.

### Integridad entre empresas

Toda referencia a una sede o a un grifo es una clave foránea **compuesta** `(tenant_id, x_id) REFERENCES tabla(tenant_id, id)`. Una clave simple dejaría que un tanque de la empresa A apunte a un grifo de la empresa B: en Postgres la verificación de claves foráneas no pasa por RLS.

### El surtidor y el tanque en el vale

El vale guarda el surtidor **y** el tanque. Con un solo tanque por surtidor, el tanque se deduce solo y el formulario no lo pregunta. Con un surtidor sobre dos tanques hay que elegir de cuál salió, porque el inventario se lleva por tanque.

## 4. El totalizador por surtidor

La cadena de comparación de #180 y #183 (por valor, con las varillas como puntos de 0 litros) **se arma por surtidor** y no por tanque. Lo que cambia:

- Cada vale y cada varilla aportan un punto **a la cadena del surtidor** que leyeron.
- La varilla de un tanque con dos surtidores exige el totalizador de **los dos**.
- Un surtidor sin totalizador (`usa_totalizador = false`) no participa y no se pide.
- **El desglose del descuadre** ("por la manguera sin vale" y "fuera del surtidor") se calcula por tanque **solo si todos los surtidores del tanque tienen totalizador y ninguno está compartido con otro tanque**. Con un surtidor compartido el avance no se puede repartir entre los tanques, y el desglose se omite. La alerta de combustible sin vale sigue funcionando: se compara contra todos los vales de ese surtidor.
- La tolerancia es del surtidor.

## 5. Quién ve qué

### Alcance

Cada usuario con el módulo Combustible tiene un **alcance**, ortogonal a su rol y a su nivel (operar o consultas):

- **`todo`**: ve todas las sedes. Es el valor de todos los usuarios actuales, así que ningún acceso existente cambia. Un **gerente** que consulta todas las plantas es `todo` con nivel `consultas`. No hace falta un rol nuevo.
- **`asignado`**: ve solo lo que el administrador marcó en `usuario_accesos_combustible`. Cada fila es una de estas tres cosas:
  - una **sede**: todos sus grifos, **los actuales y los que se creen después**;
  - un **grifo**: todos sus tanques y surtidores;
  - un **surtidor**: solo los vales de ese surtidor.

El **administrador** de la empresa ve todo siempre, sin importar el alcance.

### Reglas de un usuario asignado

- **Regla general:** cada hecho es visible para quien tiene **el grifo donde ocurrió** (su copia, sección 7), no el grifo actual del tanque o del equipo.
- **Vales:** carga y ve los de los surtidores que tiene.
- **Varilla y recepción:** exigen alcance sobre **el grifo entero**. La varilla lee el totalizador de todos los surtidores del tanque, y la recepción abre puntos del tanque.
- **Alertas:** ve las de sus tanques y sus surtidores. Una alerta que cruza dos grifos (ver más abajo) se ve si tiene alguno de los dos.
- **Compras externas:** se ven por el **grifo que tenía el equipo al cargar** (su copia). Quien registró una compra externa siempre la ve. La alerta de consumo excedido de un equipo la ve quien tiene el grifo del equipo.
- **Urea:** el inventario es **por empresa** y el alcance por grifo no lo filtra. Lo ve quien tiene el módulo y un rol que opera urea, como hoy.

### Un vale a un equipo de otro grifo

**Solo alerta, no bloquea.** Los equipos se mueven entre plantas. Alerta nueva `equipo_de_otro_grifo`, visible para los dos grifos involucrados.

## 6. Cómo se aplica

- **En un solo punto del servidor.** El alcance del usuario se resuelve una vez por pedido y se pasa a las consultas como una condición sobre el `grifo_interno_id` **copiado en cada hecho**. Que sea siempre la misma columna es lo que permite aplicarla en un solo lugar. No se repite endpoint por endpoint.
- **Cubre:** tanques, vales, varillas, recepciones, precintos, alertas, kardex, todos los reportes y sus exportaciones, la sugerencia de umbrales, y los **eventos en tiempo real**. Los eventos llevan el grifo y el canal filtra por usuario.
- **Se prueba atacando la API**, con el método de las auditorías anteriores: para cada endpoint, un usuario asignado a otro grifo intenta leer y escribir, y el gemelo de control con el grifo correcto pasa.
- **Caché offline.** La lista de puntos de precinto queda en el caché del navegador hasta 30 días. Un cambio de alcance a mitad de sesión no debe dejar ver datos viejos: al cambiar el alcance de un usuario se invalida la sesión de caché en su próximo ingreso.
- **RLS.** El aislamiento entre empresas sigue siendo RLS. El alcance por grifo se aplica en la aplicación. Una política adicional en la base con una variable de sesión sería una defensa extra, pero cuesta mucho en cada tabla; se evalúa al llegar a la entrega 3, con los tests de ataque ya escritos.

## 7. Mover tanques, surtidores y equipos entre grifos

Para Cushuro puede no pasar pronto, pero pasa: una cisterna que se lleva a otra planta, un grifo que se divide en dos, un volquete que se asigna a otra sede por una obra. El riesgo de hacerlo mal es silencioso: si mover un equipo cambiara a qué grifo pertenecen sus vales viejos, el consumo del grifo Norte de agosto cambiaría en septiembre y nadie lo notaría.

### 7.1 Cada hecho guarda su grifo

Es el mismo criterio que ya usa el conductor del vale (migración 0083): el dato histórico se **copia** al registrarse y no depende de una ficha que se edita.

| Hecho | Grifo que se copia |
|---|---|
| Vale del tanque propio | El del **surtidor** del que salió el combustible |
| Vale del tanque propio (segunda copia) | El del **equipo** en ese momento, para la alerta de equipo de otro grifo |
| Compra externa | El del **equipo** en ese momento |
| Varilla, recepción, colocación de precinto | El del **tanque** en ese momento |
| Alerta | El del hecho que la disparó |

Un vale cargado sin red que llega tarde copia el grifo **vigente a su fecha** (`despachado_en`), no el de hoy. Por eso hace falta el historial de 7.2.

Conviene llenar las copias con **triggers BEFORE INSERT**: cubren todos los caminos de inserción (la API, la cola offline, los scripts y los tests que insertan por SQL) sin tocar cada llamador. Si al diseñar la entrega 1 se elige hacerlo en el servicio, hay que justificar cómo quedan cubiertos los inserts directos.

### 7.2 Historial de pertenencia

Tabla append-only `asignaciones_grifo`: `tipo` (tanque, surtidor o equipo), `entidad_id`, `grifo_interno_id`, `desde`, `hasta`, `motivo`, `usuario_id`. La pertenencia vigente es la fila con `hasta` nulo, y un índice único parcial impide que haya dos.

La columna `grifo_interno_id` de la ficha sigue existiendo, para que las consultas no tengan que buscar en el historial. Para que las dos no se desalineen (la lección de 0059 con el nivel del tanque), **la base no deja cambiar esa columna sin dejar la fila de historial**: un trigger la escribe en la misma transacción, toma el motivo de una variable de sesión y rechaza el cambio si no viene. Así ni un script ni un UPDATE a mano pueden mover algo sin rastro. Al dar de alta un tanque o un equipo, otro trigger abre su primera fila (motivo "Alta").

La fila de la migración inicial arranca en `desde = '-infinity'`: así un hecho viejo que llega tarde también encuentra su grifo.

### 7.3 Reglas del movimiento

- **Solo el administrador**, con **motivo obligatorio**, por un **endpoint dedicado** (el PUT del tanque y el del equipo no aceptan `grifo_interno_id`), y queda en la bitácora. La ficha del tanque y la del equipo muestran su historial de ubicación.
- **No es retroactivo.** Un movimiento rige desde que se registra. Hacerlo retroactivo obligaría a reescribir las copias de los hechos, que es justo lo que este diseño prohíbe. Si se registra tarde, el motivo lo explica y los hechos intermedios quedan donde se registraron.
- **Un surtidor y sus tanques siempre están en el mismo grifo.** Mover un tanque arrastra los surtidores que lo alimentan solo a él. Si un surtidor también alimenta a otro tanque que se queda, el movimiento se rechaza hasta desconectarlo. Nunca queda un surtidor en un grifo con su tanque en otro.
- **No se bloquea por alertas abiertas.** Cada alerta ya guarda su grifo. Bloquear por alertas dejaría un tanque con "sin medir" o "nivel bajo" abierta sin poder moverse nunca.
- **Una sede o un grifo no se dan de baja con cosas activas adentro.** Primero se mueven los tanques, surtidores y equipos. No hay huérfanos. La baja es lógica (`activo = false`), con motivo y en la bitácora; nunca se borra la fila.
- **Lo que se calcula no se entera del movimiento.** El descuadre de tramo, ciclo y ventana es del tanque; la cadena del totalizador es del surtidor; el consumo es del equipo. Ninguno se corta ni se reinicia por un cambio de grifo.

### 7.4 Qué ve cada uno después de un movimiento

Cada hecho es de su grifo (7.1). El usuario del grifo viejo sigue viendo los vales de antes del movimiento; el del grifo nuevo, los de después. El kardex del tanque le muestra a cada uno los movimientos de su grifo, y quien tiene alcance sobre los dos (o "todo") lo ve completo. La ficha actual del tanque la ve el grifo al que pertenece hoy.

### 7.5 Tanques y equipos nuevos

Si la empresa tiene un solo grifo, el tanque o el equipo se asigna solo: un trigger BEFORE INSERT toma el único grifo activo. Con más de uno, el grifo es obligatorio al dar de alta un tanque (el trigger rechaza el alta sin grifo y el servicio lo traduce a 400) y un equipo de una empresa con Combustible. Una empresa sin el módulo Combustible no ve el campo. La carga masiva de tanques sigue la misma regla.

## 8. Reportes y conciliación

- **Los reportes que importan son el consumo por conductor y por vehículo.** Ya existen (Histórico → Consumo por conductor, por vehículo y por grifo). Se miran para **toda la empresa** por defecto, con filtro por **sede** y por **grifo** para las conciliaciones. El filtro usa la copia del hecho (7.1), así que un equipo que se movió en el período aporta a cada grifo lo que cargó en él.
- **El reporte "por grifo" existente** separa hoy interno de externo, y lo interno es un solo bloque. Pasa a desglosar por **grifo interno** y por **proveedor**, y sigue sirviendo para conciliar interno contra externo.
- **Los pares del consumo por equipo** (el reporte que compara contra pares y contra su pasado) comparan en **toda la empresa**: el mismo modelo consume parecido en cualquier planta, y achicar la muestra a un grifo la deja sin pares. El filtro por sede o grifo acota qué equipos se **listan**, no contra quiénes se comparan.
- **Antes de la entrega 4 hay que arreglar las unidades.** Los reportes por conductor y por vehículo suman la cantidad **tal como está**, sin convertir galones a litros. Con una sola sede no se nota; con varias es fácil que un tanque esté en galones y otro en litros, y el total mezclaría las dos.

## 9. Migración de lo existente

Por cada empresa, en la **entrega 1**:

1. Crear la sede "Principal" y el grifo "Principal".
2. Asignar todos los tanques y **todos los equipos** a ese grifo (no en NULL: en la entrega 3 un equipo sin grifo desaparecería para los usuarios asignados).
3. Abrir la primera fila de historial de cada tanque y equipo, con `desde = '-infinity'` y motivo "Migración inicial".
4. Copiar el grifo "Principal" en todos los hechos existentes.
5. Recién después, `combustible.grifo_interno_id` pasa a NOT NULL.

El backfill recorre todas las empresas con RLS activo: usa el mecanismo de la migración 0057.

**Las empresas creadas después de la migración** también necesitan su "Principal": se crea en el alta de empresa (`tenantOnboardingService.ts` y el alta desde plataforma). Sin eso, la primera empresa nueva no podría crear un tanque.

En la **entrega 2**: crear un surtidor por tanque que hoy tenga `usa_totalizador`, con la tolerancia del tanque, conectarlo, y pasar a él los vales y las varillas ya cargados con totalizador.

En la **entrega 3**: `usuario_modulos.alcance` nace con `todo` para todos los usuarios.

Se hace en dos pasos (expandir y contraer, como en la migración de cuentas): primero se agregan las estructuras y se llenan; recién después, cuando el código nuevo ya se despliega, se retiran las columnas del tanque (`usa_totalizador`, `totalizador_tolerancia`) y de la varilla (`totalizador_lectura`).

### Backup, restore y borrado de empresa

`sedes`, `grifos_internos` y `asignaciones_grifo` son de la empresa, no de un módulo: van en `src/server/services/platformBackup.service.ts` junto a `usuarios` y `ordenes_admin`, **antes de todos los módulos** (Equipos es el primero y las referencia), y **al final del orden de borrado**. En `registry.ts` se declaran las claves foráneas nuevas de tanques, equipos y de cada copia en los hechos: sin eso, al clonar un backup los ids quedan apuntando a la empresa de origen, el mismo error que la 5ª auditoría encontró en las alertas.

## 10. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Un vale a un equipo de otro grifo | Solo alerta |
| El gerente que ve todo | `todo` con nivel `consultas`, sin rol nuevo |
| El administrador | Ve todo siempre |
| Urea | Inventario por empresa |
| Compras externas | Se ven por el grifo del equipo, y quien las registró las ve siempre |
| Equipos | Pertenecen a un grifo |
| Sede | Entidad de la empresa, no de Combustible |
| Totalizador | Por surtidor |
| Nombre de los grifos externos | "Proveedores" en pantalla; la tabla no se renombra |
| Reportes | Por conductor y por vehículo, de toda la empresa, con filtro por sede y grifo |
| Pares del consumo | Toda la empresa; el filtro solo acota el listado |
| Mover entre grifos | Cada hecho copia su grifo; historial append-only garantizado por la base; solo admin, con motivo, por endpoint dedicado, no retroactivo, sin bloquear por alertas |
| Integridad entre empresas | Claves foráneas compuestas `(tenant_id, id)` |
| Bajas de sede y grifo | Lógicas, con motivo, rechazadas si quedan cosas activas adentro |

## 11. Entregas

| # | Qué | Riesgo |
|---|---|---|
| 1 | Sedes y grifos internos: tablas, administración, tanques y equipos asignados, historial de pertenencia, copia del grifo en cada hecho, migración a "Principal", alta de empresas nuevas, backup, renombrar "Proveedores" | Alto: migra todas las empresas, agrega triggers y toca el backup |
| 2 | Surtidores: entidad, vale por surtidor, totalizador por surtidor y en la varilla, migración de #180 y #183 | Alto: toca el cálculo |
| 3 | Alcance por usuario aplicado en todo el módulo, con tests de ataque y eventos filtrados | **El más alto**: un hueco filtra datos de otra planta |
| 4 | Unidades en los reportes, filtro por sede y grifo, "por grifo" desglosado, alerta de equipo de otro grifo | Bajo |

Las cuatro con Opus y esfuerzo alto. Cada entrega pide su diseño detallado en texto antes de tocar código.

## 12. Preguntas abiertas

Ninguna que bloquee la entrega 1. Las tres de la primera versión quedaron decididas (secciones 1, 7 y 8).
