-- ============================================================
-- UTZ Finance -- Migracion 024
-- Crear tabla notificaciones_config
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Fecha: 2026-06-16
--
-- Que hace esta migracion:
--   Crea la tabla notificaciones_config para almacenar la
--   configuracion de notificaciones automaticas por empresa.
--   Una fila por (empresa, tipo). Por ahora solo 'resumen_semanal';
--   'informe_mensual' se agregara en el futuro.
--
--   Convencion dia_envio: ISO weekday (smallint)
--     1 = lunes, 2 = martes, ..., 7 = domingo
--
-- Por que:
--   El motor de resumen semanal necesita saber a que empresa
--   enviar, que dia, a que hora y por que canal. Esta tabla
--   es la fuente de verdad para el cron de notificaciones.
--
-- Idempotente:
--   Si. CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--   Seguro de ejecutar multiples veces.
--
-- Impacto en codigo existente:
--   Ninguno. Tabla nueva; no afecta endpoints ni servicios
--   existentes. El cron de resumen semanal la consumira una
--   vez implementado.
-- ============================================================


-- -- 1. CREATE TABLE ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS notificaciones_config (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id  uuid        NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo        text        NOT NULL,              -- 'resumen_semanal' | 'informe_mensual' (futuro)
  activo      boolean     NOT NULL DEFAULT true,
  dia_envio   smallint    NOT NULL,              -- ISO: 1=lunes .. 7=domingo
  hora_envio  time        NOT NULL,              -- hora local Chile (America/Santiago)
  canal       text        NOT NULL DEFAULT 'app', -- 'app' ahora; 'whatsapp' en el futuro
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notificaciones_config_empresa_tipo_key UNIQUE (empresa_id, tipo),
  CONSTRAINT notificaciones_config_dia_envio_check  CHECK (dia_envio BETWEEN 1 AND 7),
  CONSTRAINT notificaciones_config_tipo_check       CHECK (tipo IN ('resumen_semanal', 'informe_mensual'))
);

COMMENT ON TABLE notificaciones_config IS
  'Configuracion de notificaciones automaticas por empresa. Una fila por (empresa, tipo). dia_envio sigue la convencion ISO: 1=lunes, 7=domingo.';

COMMENT ON COLUMN notificaciones_config.dia_envio IS
  'Dia de envio en convencion ISO weekday: 1=lunes, 2=martes, 3=miercoles, 4=jueves, 5=viernes, 6=sabado, 7=domingo.';

COMMENT ON COLUMN notificaciones_config.hora_envio IS
  'Hora de envio en hora local Chile (America/Santiago). Almacenada como TIME; el cron interpreta en esa timezone.';


-- -- 2. INDICES ---------------------------------------------------------------

-- Indice principal para el cron: filtra activos por dia
CREATE INDEX IF NOT EXISTS idx_notif_config_activo_dia
  ON notificaciones_config (activo, dia_envio);

-- Indice de apoyo para lookups por empresa
CREATE INDEX IF NOT EXISTS idx_notif_config_empresa_id
  ON notificaciones_config (empresa_id);


-- -- 3. VERIFICACION POST-MIGRACION (ejecutar despues) ------------------------
--
-- Confirmar que la tabla existe con las columnas correctas:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'notificaciones_config'
--   ORDER BY ordinal_position;
--
-- Resultado esperado (10 columnas):
--   id         | uuid                     | NO  | gen_random_uuid()
--   empresa_id | uuid                     | NO  |
--   tipo       | text                     | NO  |
--   activo     | boolean                  | NO  | true
--   dia_envio  | smallint                 | NO  |
--   hora_envio | time without time zone   | NO  |
--   canal      | text                     | NO  | 'app'
--   created_at | timestamp with time zone | NO  | now()
--   updated_at | timestamp with time zone | NO  | now()
--
-- Confirmar UNIQUE constraint:
--
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'notificaciones_config';
--
-- Insertar fila de prueba:
--
--   INSERT INTO notificaciones_config (empresa_id, tipo, dia_envio, hora_envio)
--   VALUES ('<uuid-real>', 'resumen_semanal', 1, '08:00')
--   ON CONFLICT (empresa_id, tipo) DO UPDATE SET updated_at = now();
