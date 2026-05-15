-- migrations/013_create_niko_conversaciones.sql
-- Tabla para persistir el historial de conversaciones del chat de Niko.
-- Una fila por mensaje individual (user o assistant).
-- Reemplaza el modelo actual donde el historial vive solo en el frontend.

CREATE TABLE IF NOT EXISTS niko_conversaciones (
  id              uuid           DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id      uuid           NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  user_id         uuid           NOT NULL,
  rol             text           NOT NULL CHECK (rol IN ('user', 'assistant')),
  mensaje         text           NOT NULL,
  tools_invocadas jsonb          NOT NULL DEFAULT '[]'::jsonb,
  tokens_usados   integer,
  modelo_usado    text,
  latencia_ms     integer,
  created_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_niko_conversaciones_empresa_id
  ON niko_conversaciones (empresa_id);

CREATE INDEX IF NOT EXISTS idx_niko_conversaciones_empresa_created
  ON niko_conversaciones (empresa_id, created_at DESC);

ALTER TABLE niko_conversaciones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read niko_conversaciones of their empresas"
  ON niko_conversaciones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM empresas
      WHERE empresas.id = niko_conversaciones.empresa_id
        AND empresas.owner_id = auth.uid()
    )
  );

COMMENT ON TABLE niko_conversaciones IS 'Historial persistente de conversaciones del chat de Niko. Una fila por mensaje (user o assistant).';
