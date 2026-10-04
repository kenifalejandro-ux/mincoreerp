/** Reduce la foto de una boleta antes de subirla.
 *
 *  La sube un conductor en ruta, muchas veces con señal mala: una foto de
 *  celular sin tocar pesa 3-8 MB y en esa red es una subida que no termina.
 *  A ~1600 px de lado mayor y JPEG 0,8 una boleta sigue siendo legible y baja
 *  a 150-300 kB. El servidor igual acepta hasta 6 MB (ver combustible.upload.ts)
 *  por si llega un archivo sin comprimir.
 *
 *  Los PDF se devuelven tal cual. Si el navegador no puede decodificar la
 *  imagen, también: mejor subir el original que perder la foto. */
const LADO_MAXIMO_PX = 1600;
const CALIDAD_JPEG = 0.8;

export async function comprimirImagen(archivo: File): Promise<File> {
  if (!archivo.type.startsWith("image/")) return archivo;

  try {
    const bitmap = await createImageBitmap(archivo);
    const escala = Math.min(1, LADO_MAXIMO_PX / Math.max(bitmap.width, bitmap.height));
    const ancho = Math.round(bitmap.width * escala);
    const alto = Math.round(bitmap.height * escala);

    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const contexto = canvas.getContext("2d");
    if (!contexto) return archivo;
    contexto.drawImage(bitmap, 0, 0, ancho, alto);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolver) =>
      canvas.toBlob(resolver, "image/jpeg", CALIDAD_JPEG)
    );
    // Si "comprimir" dejó un archivo más grande (una captura chica y ya
    // optimizada), se conserva el original.
    if (!blob || blob.size >= archivo.size) return archivo;

    const nombre = archivo.name.replace(/\.[^.]+$/, "") || "comprobante";
    return new File([blob], `${nombre}.jpg`, { type: "image/jpeg" });
  } catch {
    return archivo;
  }
}
