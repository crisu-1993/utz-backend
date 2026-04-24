/**
 * seed_test_data.js
 * Inserta 20 transacciones de prueba en Supabase.
 * Ejecutar DESPUÉS de crear las tablas con migrations/001_create_tables.sql
 *
 * Uso: node scripts/seed_test_data.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { procesarExcel } = require('../src/services/documentProcessor/excelProcessor');
const { categorizarTransacciones } = require('../src/services/documentProcessor/aiCategorizer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// UUID fijo de empresa de prueba
const EMPRESA_ID = '00000000-0000-0000-0000-000000000001';

async function verificarTablas() {
  const { error } = await supabase
    .from('transacciones_historicas')
    .select('id')
    .limit(1);

  if (error && error.message.includes('not find the table')) {
    console.error('\n❌ Las tablas no existen aún en Supabase.');
    console.error('\nPor favor ejecuta el siguiente SQL en el editor de Supabase:');
    console.error('👉 https://supabase.com/dashboard/project/gogcmpgflhcewtwmbden/sql/new\n');
    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/001_create_tables.sql'), 'utf8'
    );
    console.error('─── SQL A EJECUTAR ───────────────────────────────────────');
    console.error(sql);
    console.error('──────────────────────────────────────────────────────────\n');
    process.exit(1);
  }
}

async function limpiarDatosPrueba() {
  const { error } = await supabase
    .from('transacciones_historicas')
    .delete()
    .eq('empresa_id', EMPRESA_ID);
  if (error) console.warn('Advertencia al limpiar datos previos:', error.message);
}

async function main() {
  console.log('🔍 Verificando tablas en Supabase...');
  await verificarTablas();
  console.log('✓ Tablas encontradas\n');

  console.log('🧹 Limpiando datos de prueba previos...');
  await limpiarDatosPrueba();

  console.log('📊 Procesando cartola_prueba.xlsx...');
  const excelPath = path.join(__dirname, '../cartola_prueba.xlsx');
  if (!fs.existsSync(excelPath)) {
    console.error('❌ No se encuentra cartola_prueba.xlsx. Ejecuta primero el servidor.');
    process.exit(1);
  }
  const buffer = fs.readFileSync(excelPath);
  const transacciones = procesarExcel(buffer, 'cartola_prueba.xlsx');
  console.log(`   Extraídas: ${transacciones.length} transacciones`);

  console.log('🤖 Categorizando con Claude...');
  const categorizadas = await categorizarTransacciones(transacciones);
  console.log('   Categorización completada\n');

  const registros = categorizadas.map(t => ({
    empresa_id:              EMPRESA_ID,
    fecha_transaccion:       t.fecha_transaccion,
    descripcion_original:    t.descripcion_original,
    descripcion_normalizada: t.descripcion_normalizada,
    tipo:                    t.tipo,
    monto_original:          t.monto_original,
    moneda_original:         'CLP',
    categoria_sugerida_ia:   t.categoria_sugerida_ia,
    confianza_deteccion:     t.confianza_deteccion,
    estado:                  'pendiente_revision',
    fuente:                  'cartola_banco',
    archivo_origen:          'cartola_prueba.xlsx',
  }));

  console.log('💾 Guardando en Supabase...');
  const { data, error } = await supabase
    .from('transacciones_historicas')
    .insert(registros)
    .select('id');

  if (error) {
    console.error('❌ Error al insertar:', error.message);
    process.exit(1);
  }

  const totalIngresos = registros.filter(r => r.tipo === 'ingreso')
    .reduce((s, r) => s + r.monto_original, 0);
  const totalEgresos = registros.filter(r => r.tipo === 'egreso')
    .reduce((s, r) => s + r.monto_original, 0);

  console.log(`\n✅ ${data.length} transacciones guardadas exitosamente`);
  console.log(`   Empresa ID de prueba: ${EMPRESA_ID}`);
  console.log(`   Ingresos:  $${totalIngresos.toLocaleString('es-CL')}`);
  console.log(`   Egresos:   $${totalEgresos.toLocaleString('es-CL')}`);
  console.log(`   Resultado: $${(totalIngresos - totalEgresos).toLocaleString('es-CL')}`);
  console.log(`\n🔗 Probar endpoint:`);
  console.log(`   curl http://localhost:3001/api/documents/results/${EMPRESA_ID}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
