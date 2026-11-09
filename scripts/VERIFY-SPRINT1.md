# VERIFICACIÓN MANUAL — Sprint 1 (hardening multi-tenant / org guard)

> **Esto requiere TUS credenciales y TUS datos reales.** Nada de lo que sigue puede
> ejecutarse en el repositorio, en CI ni con credenciales de ejemplo.
>
> ⚠️ **NO pegues tokens, contraseñas ni `access_token` en este archivo, en un
> ticket, ni en un commit.** Define las variables en tu terminal local o en un
> archivo `.env` que ya esté en `.gitignore`. Si un token se filtra, revócalo
> desde el panel de Supabase.

---

## 0. Requisitos previos

- API levantada y **actualizada** con este código:
  ```bash
  npm install
  npm run build
  npm start:prod          # o: node dist/server.js
  ```
- El servidor debe tener el guard activo. Opcional pero recomendado para un
  entorno cerrado: `ALLOW_NO_ORIGIN=false`.
- Datos mínimos en Supabase:
  - 2 organizaciones: `ORG_A`, `ORG_B`.
  - `usuario_a` con fila en `organizacion_miembros` → **solo** `ORG_A`.
  - `usuario_ab` con filas en `organizacion_miembros` → `ORG_A` **y** `ORG_B`
    (para probar el caso multi-org).
  - Que `ORG_A` tenga al menos un movimiento o cliente, para que el 200 devuelva
    datos y no un `{"ok":true}` vacío.

---

## 1. Configura las variables (SOLO en tu terminal)

### PowerShell
```powershell
$API  = "http://localhost:3000"
$ORG_A = "<uuid-de-ORG_A>"
$ORG_B = "<uuid-de-ORG_B>"
$MAIL_A   = "usuario_a@tuempresa.com"
$PASS_A   = "<password-de-usuario_a>"
```

### Bash / macOS / Linux / Git Bash
```bash
export API="http://localhost:3000"
export ORG_A="<uuid-de-ORG_A>"
export ORG_B="<uuid-de-ORG_B>"
export MAIL_A="usuario_a@tuempresa.com"
export PASS_A="<password-de-usuario_a>"
```

---

## 2. Checklist de pruebas

Marca cada casilla. El resultado esperado está a la derecha.

### [ ] 2.1 — El servidor está vivo
```bash
curl -i "$API/health"
```
**Esperado:** `HTTP/1.1 200 OK` · `{"ok":true}`

---

### [ ] 2.2 — Login (guarda el token SOLO en tu sesión)
```bash
TOKEN=$(curl -s -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$MAIL_A\",\"password\":\"$PASS_A\"}" | jq -r '.access_token')
```
En PowerShell:
```powershell
$TOKEN = (Invoke-RestMethod -Uri "$API/auth/login" -Method Post `
  -ContentType 'application/json' `
  -Body (@{ email=$MAIL_A; password=$PASS_A } | ConvertTo-Json)).access_token
```

**Esperado:** `$TOKEN` no vacío (`eyJ...`). Si sale vacío, el login falló: revisa
correo/contraseña antes de seguir.

---

### [ ] 2.3 — ⛔ CROSS-ORG BLOQUEADO (caso crítico del Sprint 1)
`usuario_a` pide datos de `ORG_B`, a la que **no** pertenece.
```bash
curl -i -H "Authorization: Bearer $TOKEN" "$API/dashboard?org_id=$ORG_B"
```
**Esperado:** `HTTP/1.1 403 Forbidden`
```json
{ "error": "Sin membresía en la organización" }
```
> Si sale **200** con datos de `ORG_B`, el hardening NO está desplegado: es una
> fuga de datos entre tenants. Para en este punto y no sigas.

---

### [ ] 2.4 — ✅ ACCESO LEGÍTIMO A SU PROPIA ORG
```bash
curl -i -H "Authorization: Bearer $TOKEN" "$API/dashboard?org_id=$ORG_A"
```
**Esperado:** `HTTP/1.1 200 OK` con el JSON del dashboard (`totales`, `por_dia`, ...).

---

### [ ] 2.5 — ✅ SIN `org_id`, CON 1 SOLA MEMBRESÍA → usa esa automáticamente
```bash
curl -i -H "Authorization: Bearer $TOKEN" "$API/dashboard"
```
**Esperado:** `HTTP/1.1 200 OK` — idéntico a 2.4 (misma org, porque `usuario_a`
solo pertenece a `ORG_A`).

---

### [ ] 2.6 — 🔒 SIN TOKEN → 401
```bash
curl -i "$API/dashboard"
curl -i "$API/dashboard?org_id=$ORG_A"
```
**Esperado:** `HTTP/1.1 401 Unauthorized` · `{"error":"No token"}`

**Y con token basura:**
```bash
curl -i -H "Authorization: Bearer token_inventado" "$API/dashboard"
```
**Esperado:** `HTTP/1.1 401 Unauthorized` · `{"error":"Invalid token"}`

---

### [ ] 2.7 — ✅ SIN `org_id` PERO CON 2 MEMBRESÍAS → 400 (no adivina)
Repite el login como `usuario_ab` (el que pertenece a `ORG_A` y `ORG_B`) y luego:
```bash
curl -i -H "Authorization: Bearer $TOKEN_AB" "$API/dashboard"
```
**Esperado:** `HTTP/1.1 400 Bad Request`
```json
{ "error": "org_id requerido: el usuario pertenece a múltiples organizaciones" }
```

Y el mismo usuario indicando una org válida debe funcionar:
```bash
curl -i -H "Authorization: Bearer $TOKEN_AB" "$API/dashboard?org_id=$ORG_B"
```
**Esperado:** `HTTP/1.1 200 OK`

---

### [ ] 2.8 — ✅ Fuentes alternativas de `org_id` (body / header)
```bash
# Por header
curl -i -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_A" "$API/dashboard"
# Por body
curl -i -X POST "$API/movimientos" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"org_id\":\"$ORG_A\"}"
```
**Esperado:** header → `200`. El POST depende de tu esquema; lo relevante es que
**nunca** acepte una org que no sea membresía.

Repite ambos con `$ORG_B` usando el token de `usuario_a`:
**Esperado:** `403` en los dos casos.

---

### [ ] 2.9 — ⚠️ Usuario sin ninguna organización asignada
Con un usuario que no tenga filas en `organizacion_miembros`:
```bash
curl -i -H "Authorization: Bearer $TOKEN_SIN_ORG" "$API/dashboard?org_id=$ORG_A"
```
**Esperado:** `HTTP/1.1 403 Forbidden` · `{"error":"Usuario sin organización asignada"}`

---

### [ ] 2.10 — 🔒 CORS (si levantaste con `ALLOW_NO_ORIGIN=false`)
```bash
# Sin header Origin -> debe RECHAZARSE
curl -i "$API/health"
# Con Origin permitido -> 200
curl -i -H "Origin: http://localhost:4200" "$API/health"
# Con Origin malicioso -> RECHAZARSE
curl -i -H "Origin: https://evil.example" "$API/health"
```
**Esperado:** `500 {"error":"CORS: Origin header required"}` · `200` · `500` con
`"CORS: Origen 'https://evil.example' no permitido"`.

---

### [ ] 2.11 — 🚨 Hallazgo QA: `/rastreo` NO está(scopeado) por organización
`/rastreo` es **público** (sin token) y sus consultas **no filtran por `org_id`**.
Con un folio real de `ORG_B`:
```bash
curl -i "$API/rastreo/<FOLIO_DE_ORG_B>"
curl -i -X POST "$API/rastreo/<FOLIO_DE_ORG_B>/canjear" \
  -H "Content-Type: application/json" -d '{}'
```
**Esperado hoy (vulnerable):** devuelve `200` con datos de `ORG_B` para cualquiera
que conozca el folio, y `/canjear` **descuenta saldo real** del cliente de otra org.
Esto queda fuera del Sprint 1, pero anótalo como pendiente de Sprint 2.

---

## 3. Cómo reportar

Devuelve esta tabla rellenada. **Sin tokens ni contraseñas**, solo códigos HTTP:

| # | Prueba | Esperado | Obtenido | OK |
|---|--------|----------|----------|----|
| 2.1 | `/health` | 200 | | |
| 2.3 | org A pide org B | 403 | | |
| 2.4 | org A pide org A | 200 | | |
| 2.5 | org A sin `org_id` | 200 | | |
| 2.6 | sin token | 401 | | |
| 2.6b | token inválido | 401 | | |
| 2.7 | 2 orgs sin `org_id` | 400 | | |
| 2.9 | usuario sin org | 403 | | |
| 2.10 | CORS sin Origin | 500 | | |
| 2.11 | `/rastreo` cross-org | **falla** | | |

---

## 4. Lo que ya está automatizado (no hace falta que lo repitas)

```bash
npm run build                    # compila sin errores
node scripts/verify-org-guard.js # 11 casos del requireMembership v2
node scripts/verify-cors.js false  # CORS estricto
node scripts/verify-cors.js true   # CORS permisivo
```
Estos scripts no hacen red real ni leen `.env`.