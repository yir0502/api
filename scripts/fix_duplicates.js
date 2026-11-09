if (process.env.ALLOW_DESTRUCTIVE_OPS !== 'true') { console.error('Operacion destructiva bloqueada. Define ALLOW_DESTRUCTIVE_OPS=true para ejecutar.'); process.exit(1); }
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function normalizarTelefono(tel) {
  if (!tel) return '';
  let clean = tel.replace(/\D/g, '');
  if (clean.startsWith('52') && clean.length === 12) {
    clean = clean.substring(2);
  }
  if (clean.length === 11 && clean.startsWith('1')) {
    clean = clean.substring(1);
  }
  return clean;
}

async function run() {
  console.log('Fetching clients...');
  const { data: clientes, error } = await supabase.from('clientes').select('*');
  if (error) {
    console.error('Error fetching clients:', error);
    return;
  }

  // Group by normalized phone
  const groups = {};
  for (const c of clientes) {
    if (!c.telefono) continue;
    const norm = normalizarTelefono(c.telefono);
    if (norm.length === 10) {
      if (!groups[norm]) groups[norm] = [];
      groups[norm].push(c);
    }
  }

  let mergedCount = 0;

  for (const phone in groups) {
    const group = groups[phone];
    if (group.length > 1) {
      console.log(`\nFound duplicate for phone ${phone}: ${group.length} clients`);
      
      // Sort by most recent activity (ultima_visita)
      group.sort((a, b) => {
        const dateA = a.ultima_visita ? new Date(a.ultima_visita).getTime() : 0;
        const dateB = b.ultima_visita ? new Date(b.ultima_visita).getTime() : 0;
        return dateB - dateA; // Descending
      });

      const primary = group[0];
      const duplicates = group.slice(1);

      console.log(` Keeping primary: ${primary.nombre} (ID: ${primary.id}) - Monedero: ${primary.monedero}`);

      for (const dup of duplicates) {
        console.log(` Merging duplicate: ${dup.nombre} (ID: ${dup.id})`);
        
        // Update pedidos
        await supabase.from('pedidos').update({ cliente_id: primary.id }).eq('cliente_id', dup.id);
        // Update movimientos
        await supabase.from('movimientos').update({ cliente_id: primary.id }).eq('cliente_id', dup.id);
        
        // Delete duplicate
        await supabase.from('clientes').delete().eq('id', dup.id);
        mergedCount++;
      }
    }
    
    // Also ensure the primary (or single) has the normalized phone saved in DB
    const primaryToUpdate = group[0];
    if (primaryToUpdate.telefono !== phone) {
      await supabase.from('clientes').update({ telefono: phone }).eq('id', primaryToUpdate.id);
      console.log(` Normalized phone in DB for ${primaryToUpdate.nombre}`);
    }
  }

  console.log(`\nProcess completed. Merged ${mergedCount} duplicates.`);
}

run();
