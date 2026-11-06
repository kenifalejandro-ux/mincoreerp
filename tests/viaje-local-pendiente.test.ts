/** tests/viaje-local-pendiente.test.ts
 *
 * El viaje que el conductor creó SIN señal (0179), tal como se ve en «Mi viaje» mientras la cola no lo
 * envía: en curso, con su salida marcada y sus paradas, para que pueda marcar llegadas y descansos.
 * Lógica pura del cliente (creacionPendiente.ts, paradasViaje.ts).
 */
import { describe, it, expect } from "vitest";

import {
  PREFIJO_VIAJE_LOCAL,
  esViajeLocal,
  filaDePendiente,
  type CreacionPendiente,
} from "../client/src/components/combustible/creacionPendiente";
import {
  estadoDelViaje,
  paradasDelViaje,
  proximaMarca,
} from "../client/src/components/combustible/paradasViaje";

const pendiente: CreacionPendiente = {
  idCliente: "11111111-1111-4111-8111-111111111111",
  unidad: "ABC-123 (unidad nueva)",
  ruta: "Trujillo → Picota → Trujillo",
  marcadoEn: "2026-11-06T15:00:00.000Z",
  odometro: 1000,
  unidadNueva: true,
  paradas: [
    { id: 1, nombre: "Trujillo" },
    { id: null, nombre: "Picota" },
    { id: 1, nombre: "Trujillo" },
  ],
  placa: "ABC-123",
  tipoUnidad: "Por completar",
  tipoMedidor: null,
  conductorNombre: "Juan Constante",
  conductorDni: "70000001",
  relevoNombre: "Pedro Soto",
};

describe("viaje creado sin señal: cómo se ve en el celular", () => {
  it("se identifica por su id_cliente y se distingue de uno del servidor", () => {
    const f = filaDePendiente(pendiente);
    expect(f.id).toBe(`${PREFIJO_VIAJE_LOCAL}${pendiente.idCliente}`);
    expect(esViajeLocal(f.id)).toBe(true);
    expect(esViajeLocal("123")).toBe(false);
  });

  it("está en curso, con la salida del primer lugar marcada con el odómetro y la hora del celular", () => {
    const f = filaDePendiente(pendiente);
    expect(f.estado).toBe("en_curso");
    expect(f.inicio_en).toBe(pendiente.marcadoEn);
    expect(f.pendiente).toBe(true);
    const p = paradasDelViaje(f);
    expect(p.map((x) => x.lugar)).toEqual(["Trujillo", "Picota", "Trujillo"]);
    expect(p[0]).toMatchObject({ salida_en: pendiente.marcadoEn, salida_medidor: 1000 });
    expect(p[1].llegada_en).toBeNull();
  });

  it("lo siguiente que puede marcar es la llegada a la primera parada, sin menos que su odómetro de salida", () => {
    const m = proximaMarca(paradasDelViaje(filaDePendiente(pendiente)));
    expect(m).toMatchObject({ accion: "llegada-mia", orden: 1, cierra: false, minimo: 1000 });
    expect(estadoDelViaje(paradasDelViaje(filaDePendiente(pendiente)), [])?.detenido).toBeFalsy();
  });

  it("el relevo anotado sin cuenta no activa el mando: no hay DNI de relevo", () => {
    const f = filaDePendiente(pendiente);
    expect(f.relevo_dni).toBeNull();
    expect(f.relevo_nombre).toBe("Pedro Soto");
    expect(f.volante_dni).toBe("70000001");
  });
});
