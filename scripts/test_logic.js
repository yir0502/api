if (process.env.ALLOW_DESTRUCTIVE_OPS !== 'true') { console.error('Operacion destructiva bloqueada. Define ALLOW_DESTRUCTIVE_OPS=true para ejecutar.'); process.exit(1); }
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: pedidos } = await supabase.from('pedidos').select('id, folio, estado, monto_total, saldo_pendiente, promo_canjeada, cliente_id').gt('monto_total', 0).neq('estado', 'entregado');
  
  for(let pedido of pedidos) {
      const { data: cliente } = await supabase.from('clientes').select('monedero, apto_promociones').eq('id', pedido.cliente_id).single();
      if(!cliente || cliente.monedero <= 0 || !cliente.apto_promociones) continue;
      
      const ESTADOS_ACTIVOS = ['recibido', 'lavando', 'secando', 'doblando', 'listo'];
      const puede = cliente.monedero > 0 && ESTADOS_ACTIVOS.includes(pedido.estado) && !pedido.promo_canjeada && (Number(pedido.monto_total) === 0 || Number(pedido.saldo_pendiente) > 0);
      
      console.log(`Folio: ${pedido.folio}, Estado: ${pedido.estado}, Total: ${pedido.monto_total}, Pendiente: ${pedido.saldo_pendiente}, Monedero: ${cliente.monedero}, Puede: ${puede}`);
  }
}
run();
