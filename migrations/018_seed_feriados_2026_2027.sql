-- ============================================================
-- UTZ Finance — Migración 018
-- Seed: feriados nacionales de Chile 2026 y 2027
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Requisito: haber ejecutado 017_create_feriados.sql primero.
--
-- Qué hace esta migración:
--   Inserta los 16 feriados nacionales de 2026 y los 16 de 2027.
--   Usa ON CONFLICT (fecha, nombre) DO NOTHING para ser
--   idempotente (se puede ejecutar múltiples veces sin duplicar).
--
-- Fuente:
--   Ley 2.977 y modificaciones. Feriados irrenunciables según
--   Código del Trabajo Art. 169.
--
-- Impacto en código existente:
--   Ninguno. Solo inserta datos en la tabla creada en 017.
-- ============================================================


-- ── FERIADOS NACIONALES 2026 ────────────────────────────────

INSERT INTO feriados (fecha, nombre, tipo, irrenunciable, anio) VALUES
  ('2026-01-01', 'Año Nuevo',                                    'nacional', true,  2026),
  ('2026-04-03', 'Viernes Santo',                                'nacional', false, 2026),
  ('2026-04-04', 'Sábado Santo',                                 'nacional', false, 2026),
  ('2026-05-01', 'Día del Trabajo',                              'nacional', true,  2026),
  ('2026-05-21', 'Día de las Glorias Navales',                   'nacional', false, 2026),
  ('2026-06-20', 'Día Nacional de los Pueblos Indígenas',        'nacional', false, 2026),
  ('2026-06-29', 'San Pedro y San Pablo',                        'nacional', false, 2026),
  ('2026-07-16', 'Virgen del Carmen',                            'nacional', false, 2026),
  ('2026-08-15', 'Asunción de la Virgen',                        'nacional', false, 2026),
  ('2026-09-18', 'Fiestas Patrias',                              'nacional', true,  2026),
  ('2026-09-19', 'Día de las Glorias del Ejército',              'nacional', true,  2026),
  ('2026-10-12', 'Encuentro de Dos Mundos',                      'nacional', false, 2026),
  ('2026-10-31', 'Día de las Iglesias Evangélicas y Protestantes', 'nacional', false, 2026),
  ('2026-11-01', 'Día de Todos los Santos',                      'nacional', false, 2026),
  ('2026-12-08', 'Inmaculada Concepción',                        'nacional', false, 2026),
  ('2026-12-25', 'Navidad',                                      'nacional', true,  2026)
ON CONFLICT (fecha, nombre) DO NOTHING;


-- ── FERIADOS NACIONALES 2027 ────────────────────────────────

INSERT INTO feriados (fecha, nombre, tipo, irrenunciable, anio) VALUES
  ('2027-01-01', 'Año Nuevo',                                    'nacional', true,  2027),
  ('2027-03-26', 'Viernes Santo',                                'nacional', false, 2027),
  ('2027-03-27', 'Sábado Santo',                                 'nacional', false, 2027),
  ('2027-05-01', 'Día del Trabajo',                              'nacional', true,  2027),
  ('2027-05-21', 'Día de las Glorias Navales',                   'nacional', false, 2027),
  ('2027-06-20', 'Día Nacional de los Pueblos Indígenas',        'nacional', false, 2027),
  ('2027-06-28', 'San Pedro y San Pablo',                        'nacional', false, 2027),
  ('2027-07-16', 'Virgen del Carmen',                            'nacional', false, 2027),
  ('2027-08-15', 'Asunción de la Virgen',                        'nacional', false, 2027),
  ('2027-09-18', 'Fiestas Patrias',                              'nacional', true,  2027),
  ('2027-09-19', 'Día de las Glorias del Ejército',              'nacional', true,  2027),
  ('2027-10-11', 'Encuentro de Dos Mundos',                      'nacional', false, 2027),
  ('2027-10-31', 'Día de las Iglesias Evangélicas y Protestantes', 'nacional', false, 2027),
  ('2027-11-01', 'Día de Todos los Santos',                      'nacional', false, 2027),
  ('2027-12-08', 'Inmaculada Concepción',                        'nacional', false, 2027),
  ('2027-12-25', 'Navidad',                                      'nacional', true,  2027)
ON CONFLICT (fecha, nombre) DO NOTHING;


-- ── VERIFICACIÓN POST-SEED ──────────────────────────────────
--
-- Confirmar que se insertaron 32 filas:
--
--   SELECT anio, count(*) FROM feriados GROUP BY anio ORDER BY anio;
--
-- Resultado esperado:
--   anio | count
--   2026 | 16
--   2027 | 16
