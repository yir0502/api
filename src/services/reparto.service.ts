import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SOCIOS = 20;
const MAX_NOMBRE_SOCIO_LEN = 60;
const MAX_ID_SOCIO_LEN = 64;
const TOTAL_PCT_ESPERADO = 100;
const TOTAL_PCT_TOLERANCIA = 0.01;

export interface RepartoSocioConfig {
  id: string;
  nombre: string;
  pct: number;
}

export interface SucursalRepartoConfig {
  sucursal_id: string;
  capital_pct: number;
  socios: RepartoSocioConfig[];
  updated_at: string | null;
  configurado: boolean;
}

export interface GuardarRepartoInput {
  capital_pct?: unknown;
  socios?: unknown;
}

export class RepartoValidationError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = 'RepartoValidationError';
    this.status = status;
  }
}

interface SucursalIdRow {
  id: string;
}

interface SucursalRepartoRow {
  sucursal_id: string;
  capital_pct: number | string | null;
  socios: unknown;
  updated_at: string | null;
}

function round2(valor: number): number {
  const redondeado = Math.round(valor * 100) / 100;
  return redondeado === 0 ? 0 : redondeado;
}

function esObjetoRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function normalizarNumeroBD(valor: number | string | null | undefined): number {
  if (valor === null || valor === undefined || valor === '') return 0;
  const num = Number(valor);
  return Number.isFinite(num) ? round2(num) : 0;
}

function normalizarSociosBD(raw: unknown): RepartoSocioConfig[] {
  if (!Array.isArray(raw)) return [];

  const socios: RepartoSocioConfig[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!esObjetoRegistro(item)) continue;

    const nombre = typeof item.nombre === 'string' ? item.nombre.trim() : '';
    if (!nombre) continue;

    const pctRaw = item.pct;
    const pctNum =
      typeof pctRaw === 'number' || typeof pctRaw === 'string' ? Number(pctRaw) : Number.NaN;
    if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) continue;

    const idRaw = typeof item.id === 'string' ? item.id.trim() : '';
    const id = idRaw.length > 0 ? idRaw.slice(0, MAX_ID_SOCIO_LEN) : `socio-${i + 1}`;

    socios.push({
      id,
      nombre: nombre.slice(0, MAX_NOMBRE_SOCIO_LEN),
      pct: round2(pctNum),
    });
  }

  return socios;
}

function normalizarRowReparto(
  sucursalCanonico: string,
  row: SucursalRepartoRow
): SucursalRepartoConfig {
  return {
    sucursal_id: sucursalCanonico,
    capital_pct: normalizarNumeroBD(row.capital_pct),
    socios: normalizarSociosBD(row.socios),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
    configurado: true,
  };
}

async function validarYResolverSucursal(orgId: string, sucursalId: string): Promise<string> {
  if (typeof orgId !== 'string' || !orgId.trim()) {
    throw new RepartoValidationError('La organización es requerida', 400);
  }

  const sucursalLimpia = typeof sucursalId === 'string' ? sucursalId.trim() : '';
  if (!UUID_RE.test(sucursalLimpia)) {
    throw new RepartoValidationError('El identificador de sucursal debe ser un UUID válido', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('sucursales')
    .select('id')
    .eq('id', sucursalLimpia)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) throw error;

  const sucursalRow = data as SucursalIdRow | null;
  if (!sucursalRow || typeof sucursalRow.id !== 'string') {
    throw new RepartoValidationError('Sucursal no encontrada', 404);
  }

  return sucursalRow.id;
}

export async function obtenerRepartoPorSucursal(
  orgId: string,
  sucursalId: string
): Promise<SucursalRepartoConfig> {
  const sucursalCanonico = await validarYResolverSucursal(orgId, sucursalId);

  const { data, error } = await supabaseAdmin
    .from('sucursal_reparto_config')
    .select('sucursal_id, capital_pct, socios, updated_at')
    .eq('org_id', orgId)
    .eq('sucursal_id', sucursalCanonico)
    .maybeSingle();

  if (error) throw error;

  const row = data as SucursalRepartoRow | null;
  if (!row) {
    return {
      sucursal_id: sucursalCanonico,
      capital_pct: 0,
      socios: [],
      updated_at: null,
      configurado: false,
    };
  }

  return normalizarRowReparto(sucursalCanonico, row);
}

export async function guardarRepartoPorSucursal(
  orgId: string,
  sucursalId: string,
  input: GuardarRepartoInput
): Promise<SucursalRepartoConfig> {
  const sucursalCanonico = await validarYResolverSucursal(orgId, sucursalId);

  if (!esObjetoRegistro(input)) {
    throw new RepartoValidationError('El cuerpo de la configuración de reparto es inválido', 400);
  }

  if (typeof input.capital_pct !== 'number' || !Number.isFinite(input.capital_pct)) {
    throw new RepartoValidationError(
      'El porcentaje de capital debe ser un número válido entre 0 y 100',
      400
    );
  }

  if (input.capital_pct < 0 || input.capital_pct > 100) {
    throw new RepartoValidationError('El porcentaje de capital debe estar entre 0 y 100', 400);
  }

  const capitalPct = round2(input.capital_pct);

  if (!Array.isArray(input.socios)) {
    throw new RepartoValidationError('El campo socios debe ser una lista', 400);
  }

  if (input.socios.length > MAX_SOCIOS) {
    throw new RepartoValidationError('No se permiten más de 20 socios por sucursal', 400);
  }

  const sociosNormalizados: RepartoSocioConfig[] = [];
  const idsUsados = new Set<string>();

  for (let i = 0; i < input.socios.length; i += 1) {
    const item: unknown = input.socios[i];
    if (!esObjetoRegistro(item)) {
      throw new RepartoValidationError(`El socio en la posición ${i + 1} es inválido`, 400);
    }

    if (typeof item.nombre !== 'string') {
      throw new RepartoValidationError(
        `El nombre del socio en la posición ${i + 1} es requerido`,
        400
      );
    }

    const nombre = item.nombre.trim();
    if (nombre.length < 1 || nombre.length > MAX_NOMBRE_SOCIO_LEN) {
      throw new RepartoValidationError(
        `El nombre del socio en la posición ${i + 1} debe tener entre 1 y 60 caracteres`,
        400
      );
    }

    if (
      typeof item.pct !== 'number' ||
      !Number.isFinite(item.pct) ||
      item.pct < 0 ||
      item.pct > 100
    ) {
      throw new RepartoValidationError(
        `El porcentaje del socio "${nombre}" debe ser un número entre 0 y 100`,
        400
      );
    }

    const pct = round2(item.pct);
    const idCandidato = typeof item.id === 'string' ? item.id.trim() : '';
    const id =
      idCandidato.length > 0 &&
      idCandidato.length <= MAX_ID_SOCIO_LEN &&
      !idsUsados.has(idCandidato)
        ? idCandidato
        : randomUUID();
    idsUsados.add(id);

    sociosNormalizados.push({ id, nombre, pct });
  }

  const totalPct = round2(
    capitalPct + sociosNormalizados.reduce((acc, socio) => acc + socio.pct, 0)
  );
  if (Math.abs(totalPct - TOTAL_PCT_ESPERADO) > TOTAL_PCT_TOLERANCIA) {
    throw new RepartoValidationError(
      'La suma del capital del negocio y los socios debe ser exactamente 100%',
      400
    );
  }

  const { data, error } = await supabaseAdmin
    .from('sucursal_reparto_config')
    .upsert(
      {
        org_id: orgId,
        sucursal_id: sucursalCanonico,
        capital_pct: capitalPct,
        socios: sociosNormalizados,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,sucursal_id' }
    )
    .select('sucursal_id, capital_pct, socios, updated_at')
    .single();

  if (error) throw error;

  const row = data as SucursalRepartoRow | null;
  if (!row) {
    return {
      sucursal_id: sucursalCanonico,
      capital_pct: capitalPct,
      socios: sociosNormalizados,
      updated_at: null,
      configurado: true,
    };
  }

  return normalizarRowReparto(sucursalCanonico, row);
}

export const RepartoService = {
  obtenerRepartoPorSucursal,
  guardarRepartoPorSucursal,
};
