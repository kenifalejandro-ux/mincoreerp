/** tests/checklists-formatos-cliente.test.ts
 *
 * La lógica del cliente de los formatos de checklist (E5-1): qué se manda al guardar, cuándo no se puede y qué
 * formatos se ofrecen para llenar.
 */
import { describe, it, expect } from "vitest";

import {
  cuerpoDelFormato,
  formatosParaLlenar,
  formularioDe,
  problemaDelFormato,
} from "../client/src/components/checklists/formatos";

const formulario = {
  nombre: " Volquete ",
  tipo_equipo: "",
  cambio: " Se agrega la bocina ",
  items: [
    { descripcion: " Frenos ", critica: true },
    { descripcion: "   ", critica: false },
    { descripcion: "Bocina", critica: false },
  ],
};

describe("formatos de checklist en el cliente", () => {
  it("un formato nuevo manda las preguntas limpias, en orden y sin las vacías", () => {
    expect(cuerpoDelFormato(formulario, null)).toEqual({
      nombre: "Volquete",
      tipo_equipo: undefined,
      items: [
        { descripcion: "Frenos", critica: true, orden: 0 },
        { descripcion: "Bocina", critica: false, orden: 1 },
      ],
    });
  });

  it("una edición manda además la versión sobre la que se trabajó y qué cambió", () => {
    expect(cuerpoDelFormato(formulario, 3)).toMatchObject({
      version_base: 3,
      cambio: "Se agrega la bocina",
    });
  });

  it("dice por qué no se puede guardar", () => {
    expect(problemaDelFormato(formulario, true)).toBeNull();
    expect(problemaDelFormato({ ...formulario, nombre: " " }, false)).toMatch(/nombre/);
    expect(
      problemaDelFormato({ ...formulario, items: [{ descripcion: "", critica: true }] }, false)
    ).toMatch(/al menos un ítem/);
    expect(problemaDelFormato({ ...formulario, cambio: "ok" }, true)).toMatch(/qué cambió/);
    expect(problemaDelFormato({ ...formulario, cambio: "" }, false)).toBeNull();
  });

  it("al llenar no se ofrecen los desactivados; una lista guardada sin ese dato sí se ofrece", () => {
    const base = { nombre: "x", tipo_equipo: null, creado_en: "" };
    expect(
      formatosParaLlenar([
        { ...base, id: 1, activa: true },
        { ...base, id: 2, activa: false },
        { ...base, id: 3 },
      ]).map((p) => p.id)
    ).toEqual([1, 3]);
  });

  it("al editar parte del formato vigente, con el cambio en blanco", () => {
    expect(
      formularioDe({
        id: 1,
        nombre: "Volquete",
        tipo_equipo: null,
        creado_en: "",
        items: [{ id: 9, descripcion: "Frenos", orden: 0 }],
      })
    ).toEqual({
      nombre: "Volquete",
      tipo_equipo: "",
      cambio: "",
      items: [{ descripcion: "Frenos", critica: false }],
    });
  });
});
