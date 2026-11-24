-- Perfiles de mantenimiento: «Mecánico» y «Operario» (el que maneja maquinaria pesada; distinto de los
-- conductores de ruta). Mismo molde que 0105 (encargado_urea). Nacen sin módulos asignados: los suma, uno a
-- uno, cada entrega que les abra una pantalla.
ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'mecanico';
ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'operario';
