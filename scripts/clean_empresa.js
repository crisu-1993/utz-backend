// scripts/clean_empresa.js
// Elimina todas las transacciones e importaciones de una empresa.
// Uso: node scripts/clean_empresa.js <empresa_id>
// Ejemplo: node scripts/clean_empresa.js 1c749792-3add-4cb5-929f-9bd5837bf1f5

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const empresaId = process.argv[2];
if (!empresaId) {
  console.error('Uso: node scripts/clean_empresa.js <empresa_id>');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  console.log(`Limpiando datos de empresa: ${empresaId}`);

  const { error: e1, count: c1 } = await supabase
    .from('transacciones_historicas')
    .delete({ count: 'exact' })
    .eq('empresa_id', empresaId);

  if (e1) { console.error('Error al borrar transacciones:', e1.message); process.exit(1); }
  console.log(`  ✓ ${c1 ?? '?'} transacciones eliminadas`);

  const { error: e2, count: c2 } = await supabase
    .from('importaciones_historicas')
    .delete({ count: 'exact' })
    .eq('empresa_id', empresaId);

  if (e2) { console.error('Error al borrar importaciones:', e2.message); process.exit(1); }
  console.log(`  ✓ ${c2 ?? '?'} importaciones eliminadas`);

  console.log('Listo. Puedes subir la cartola para probar.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
