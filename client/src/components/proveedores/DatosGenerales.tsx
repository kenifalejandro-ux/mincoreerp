// client/src/components/proveedores/DatosGenerales.tsx
//
// La pestaña «Datos generales» de la ficha: la identificación del proveedor (como la maqueta) y debajo sus datos
// y condiciones de pago, que se editan ahí mismo. La cuenta bancaria NO se muestra aquí: tiene su pestaña y su
// permiso aparte.
import DatosDeProveedor from "./DatosDeProveedor";
import { condicionDePago, textoAbastece } from "./fichaProveedor";
import { Info, Panel } from "./PanelesDeFicha";
import type { FichaProveedor, ProveedorBasico } from "./proveedoresApi";

export default function DatosGenerales({
  proveedor,
  ficha,
  onGuardado,
}: {
  proveedor: ProveedorBasico;
  ficha: FichaProveedor;
  onGuardado: () => void;
}) {
  return (
    <div className="space-y-4">
      <Panel kicker="Identificación" titulo="Datos generales">
        <Info
          datos={[
            ["Razón social", proveedor.nombre],
            ["RUC", proveedor.ruc],
            ["Código", proveedor.codigo],
            ["Tipo", proveedor.tipos.join(", ")],
            [
              "Abastece a",
              textoAbastece({
                interno: proveedor.combustible.interno || proveedor.urea.interno,
                externo: proveedor.combustible.externo || proveedor.urea.externo,
              }),
            ],
            ["Ciudad", ficha.datos.ciudad],
            ["Condición de pago", condicionDePago(ficha)],
          ]}
        />
      </Panel>
      <DatosDeProveedor proveedorId={proveedor.id} datos={ficha.datos} onGuardado={onGuardado} />
    </div>
  );
}
