const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const {
  db,
  DB_PATH,
  BASE_CATALOG_CAMPOS,
  computeEventStatus,
  parseEventStartDate,
  parseUnidadesInvitadas,
  getAllConfigs,
  updateConfigs,
  getCamposCatalogo,
  addCampoCatalogo,
  deleteCampoCatalogo,
  getCatalogos,
  syncClientDataToDb,
  resolveLogoForDireccion,
  normalizeSexo,
  formatHoraAmPm,
  getNowISO,
} = require('./lib/db');
const { generateQRSVG, generateQRMatrix } = require('./lib/qrcode');

const PORT = Number(process.env.PORT || 3050);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = process.env.VERCEL
  ? path.join('/tmp', 'sistema-asistencias-uploads')
  : path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const sseClients = new Set();

function broadcastSSE(eventType, payload) {
  const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, netList] of Object.entries(interfaces)) {
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, address: net.address });
      }
    }
  }
  return ips;
}

function getEffectiveBaseUrl(req) {
  const configs = getAllConfigs();
  if (configs.base_url && configs.base_url.trim() !== '') {
    return configs.base_url.trim().replace(/\/+$/, '');
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
  if (process.env.VERCEL || (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.startsWith('127.'))) {
    const proto = forwardedProto || 'https';
    return `${proto}://${forwardedHost}`;
  }
  const ips = getNetworkIPs();
  if (ips.length > 0) {
    return `http://${ips[0].address}:${PORT}`;
  }
  const host = req.headers.host || `localhost:${PORT}`;
  return `http://${host}`;
}

function slugifyToken(text) {
  const base = String(text || 'reunion')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22);
  const rand = crypto.randomBytes(2).toString('hex');
  return `${base || 'evento'}-${rand}`;
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return resolve(req.body);
      }
      if (typeof req.body === 'string') {
        try {
          return resolve(req.body ? JSON.parse(req.body) : {});
        } catch {
          return reject(new Error('Formato JSON inválido.'));
        }
      }
      if (Buffer.isBuffer(req.body)) {
        try {
          const s = req.body.toString('utf8');
          return resolve(s ? JSON.parse(s) : {});
        } catch {
          return reject(new Error('Formato JSON inválido.'));
        }
      }
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('El tamaño de los datos enviados excede el límite permitido (10MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Formato JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStaticFile(res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Archivo no encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function buildEventResponse(evento, baseUrl) {
  const status = computeEventStatus(evento);
  const countRow = db
    .prepare('SELECT COUNT(*) as total FROM asistencias WHERE evento_id = ? AND COALESCE(eliminado, 0) = 0')
    .get(evento.id);
  const link = `${baseUrl}/asistencia/${encodeURIComponent(evento.token)}`;
  const logoDirUrl = resolveLogoForDireccion(evento.direccion_organiza);
  return {
    ...status,
    total_asistencias: countRow ? countRow.total : 0,
    vinculo: link,
    qr_svg_url: `/api/qr/${encodeURIComponent(evento.token)}?url=${encodeURIComponent(link)}`,
    acta_url: `/acta/${encodeURIComponent(evento.token)}`,
    logo_direccion_url: logoDirUrl || '/image/uamh.png',
  };
}

async function requestHandler(req, res) {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    if (parsedUrl.searchParams.has('__vercel_route')) {
      pathname = decodeURIComponent(parsedUrl.searchParams.get('__vercel_route'));
    } else if (req.headers['x-matched-path']) {
      pathname = decodeURIComponent(req.headers['x-matched-path']);
    } else if (req.headers['x-original-url']) {
      pathname = decodeURIComponent(req.headers['x-original-url'].split('?')[0]);
    }
    const method = req.method.toUpperCase();

    // ── 1. Server-Sent Events (SSE) ───────────────────────────────────────────
    if (pathname === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: process.env.VERCEL ? 'close' : 'keep-alive',
      });
      res.write(`retry: 15000\nevent: connected\ndata: ${JSON.stringify({ time: getNowISO(), serverless: Boolean(process.env.VERCEL) })}\n\n`);
      if (process.env.VERCEL) {
        res.end();
        return;
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ── 1.1. Sincronización Bidireccional Cliente <-> Servidor (Persistencia Total) ──
    if (pathname === '/api/sync' && method === 'POST') {
      const body = await readJsonBody(req);
      syncClientDataToDb(body);

      const baseUrl = getEffectiveBaseUrl(req);
      const allEvRows = db.prepare('SELECT * FROM eventos ORDER BY fecha DESC, hora DESC').all();
      const allEventosRaw = allEvRows.map((ev) => buildEventResponse(ev, baseUrl));
      const eventosActivos = allEventosRaw.filter((ev) => !ev.eliminado);
      const eventosPapelera = allEventosRaw.filter((ev) => Boolean(ev.eliminado));

      const allAsisRows = db
        .prepare(`
          SELECT
            a.*,
            e.tema as evento_tema,
            e.fecha as evento_fecha,
            e.hora as evento_hora,
            e.token as evento_token,
            e.lugar as evento_lugar,
            e.tipo as evento_tipo,
            e.direccion_organiza as evento_direccion_organiza,
            e.proceso_iso as evento_proceso_iso,
            e.planificacion as evento_planificacion
          FROM asistencias a
          LEFT JOIN eventos e ON e.id = a.evento_id
          ORDER BY a.id DESC
        `)
        .all();

      const asistenciasPapelera = allAsisRows.filter((a) => Boolean(a.eliminado));

      return sendJSON(res, 200, {
        ok: true,
        baseUrl,
        eventos: eventosActivos,
        allEventosRaw,
        allAsistenciasRaw: allAsisRows,
        papelera: {
          eventos: eventosPapelera,
          asistencias: asistenciasPapelera,
          totalEventos: eventosPapelera.length,
          totalAsistencias: asistenciasPapelera.length,
          total: eventosPapelera.length + asistenciasPapelera.length,
        },
      });
    }

    // ── 2. Información del Sistema y Recursos ────────────────────────────────
    if (pathname === '/api/system-info' && method === 'GET') {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      let dbSizeBytes = 0;
      try {
        dbSizeBytes = fs.statSync(DB_PATH).size;
      } catch {
        dbSizeBytes = 0;
      }
      const ips = getNetworkIPs();
      const baseUrl = getEffectiveBaseUrl(req);
      const totalEventos = db.prepare('SELECT COUNT(*) as c FROM eventos WHERE COALESCE(eliminado, 0) = 0').get().c;
      const totalAsistencias = db.prepare('SELECT COUNT(*) as c FROM asistencias WHERE COALESCE(eliminado, 0) = 0').get().c;
      const totalPapeleraEventos = db.prepare('SELECT COUNT(*) as c FROM eventos WHERE COALESCE(eliminado, 0) = 1').get().c;
      const totalPapeleraAsistencias = db.prepare('SELECT COUNT(*) as c FROM asistencias WHERE COALESCE(eliminado, 0) = 1').get().c;
      const totalUnidades = db
        .prepare("SELECT COUNT(*) as c FROM catalogos WHERE categoria = 'UNIDAD' AND activo = 1")
        .get().c;

      return sendJSON(res, 200, {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        nodeVersion: process.version,
        cpuModel: cpus[0] ? cpus[0].model.trim() : 'CPU Multinúcleo',
        cpuCores: cpus.length,
        memoryTotalMB: Math.round(totalMem / (1024 * 1024)),
        memoryUsedMB: Math.round((totalMem - freeMem) / (1024 * 1024)),
        memoryPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        dbSizeKB: Math.round((dbSizeBytes / 1024) * 10) / 10,
        uptimeSeconds: Math.round(process.uptime()),
        port: PORT,
        networkIPs: ips,
        effectiveBaseUrl: baseUrl,
        stats: {
          totalEventos,
          totalAsistencias,
          totalUnidades,
          totalPapelera: totalPapeleraEventos + totalPapeleraAsistencias,
          totalPapeleraEventos,
          totalPapeleraAsistencias,
        },
      });
    }

    // ── 3. Configuración Global y Logos de las Listas de Asistencia ──────────
    if (pathname === '/api/logo-direccion' && method === 'GET') {
      const dir = parsedUrl.searchParams.get('direccion') || '';
      const resolved = resolveLogoForDireccion(dir);
      return sendJSON(res, 200, {
        direccion: dir,
        logo_url: resolved || '/image/uamh.png',
        has_custom_logo: Boolean(resolved),
      });
    }

    if (pathname === '/api/config' && method === 'GET') {
      const configs = getAllConfigs();
      const cleanDerecho =
        String(configs.logo_derecho || '').replace(/.*uverde.*/i, '') || '/image/Jaguar34.png';
      return sendJSON(res, 200, {
        ...configs,
        logo_derecho: cleanDerecho,
        effectiveBaseUrl: getEffectiveBaseUrl(req),
        networkIPs: getNetworkIPs(),
        port: PORT,
      });
    }

    if (pathname === '/api/config' && method === 'PUT') {
      const body = await readJsonBody(req);
      const allowedKeys = [
        'titulo_header',
        'subtitulo_header',
        'logo_izquierdo',
        'logo_derecho',
        'mensaje_gracias_titulo',
        'mensaje_gracias_cuerpo',
        'minutos_expiracion',
        'base_url',
      ];
      const updates = {};
      for (const k of allowedKeys) {
        if (body[k] !== undefined) {
          updates[k] = body[k];
        }
      }
      const updated = updateConfigs(updates);
      broadcastSSE('config_actualizada', updated);
      return sendJSON(res, 200, {
        ...updated,
        effectiveBaseUrl: getEffectiveBaseUrl(req),
      });
    }

    // Subida de Logo Izquierdo o Derecho (guarda tanto DataURL en config como archivo para compatibilidad local + Vercel)
    if (pathname === '/api/upload-logo' && method === 'POST') {
      const body = await readJsonBody(req);
      const { side, dataUrl } = body;
      if (!['left', 'right'].includes(side) || !dataUrl) {
        return sendJSON(res, 400, { error: 'Parámetros de logo inválidos.' });
      }

      // Guardamos el DataURL directamente en config para que persista incluso en entornos serverless
      const configKey = side === 'left' ? 'logo_izquierdo' : 'logo_derecho';
      const updated = updateConfigs({ [configKey]: dataUrl });
      broadcastSSE('config_actualizada', updated);
      return sendJSON(res, 200, { url: dataUrl, config: updated });
    }

    // ── 4. Catálogos Desplegables (Campos y Opciones) ─────────────────────────
    if (pathname === '/api/catalogos' && method === 'GET') {
      const soloActivos = parsedUrl.searchParams.get('activos') === '1';
      const categoria = parsedUrl.searchParams.get('categoria') || '';
      const data = getCatalogos({ soloActivos, categoria });
      return sendJSON(res, 200, {
        ...data,
      });
    }

    // Crear un Nuevo Campo / Lista Desplegable Personalizada
    if (pathname === '/api/catalogos/campos' && method === 'POST') {
      const body = await readJsonBody(req);
      const nombre = String(body.nombre || '').trim();
      const icono = String(body.icono || '📋').trim();
      const descripcion = String(body.descripcion || '').trim();
      try {
        const campo = addCampoCatalogo({ nombre, icono, descripcion });
        broadcastSSE('catalogo_actualizado', { campo });
        return sendJSON(res, 201, { campo });
      } catch (err) {
        return sendJSON(res, 400, { error: err.message || 'No se pudo crear el campo.' });
      }
    }

    // Eliminar un Campo / Lista Desplegable Personalizada
    const campoDeleteMatch = pathname.match(/^\/api\/catalogos\/campos\/([A-Za-z0-9_]+)$/);
    if (campoDeleteMatch && method === 'DELETE') {
      const codigo = campoDeleteMatch[1];
      try {
        deleteCampoCatalogo(codigo);
        broadcastSSE('catalogo_actualizado', { deletedCampo: codigo });
        return sendJSON(res, 200, { ok: true });
      } catch (err) {
        return sendJSON(res, 400, { error: err.message || 'No se pudo eliminar el campo.' });
      }
    }

    // Eliminación masiva de campos del catálogo
    if (pathname === '/api/catalogos/campos/batch-delete' && method === 'POST') {
      const body = await readJsonBody(req);
      const codigos = Array.isArray(body.codigos) ? body.codigos.map(String) : [];
      if (codigos.length === 0) {
        return sendJSON(res, 400, { error: 'No se enviaron campos para eliminar.' });
      }
      let deleted = 0;
      for (const cod of codigos) {
        try {
          deleteCampoCatalogo(cod);
          deleted++;
        } catch (e) {
          console.warn(`No se pudo eliminar campo ${cod}:`, e.message);
        }
      }
      broadcastSSE('catalogo_actualizado', { batchDeletedCampos: codigos });
      return sendJSON(res, 200, { ok: true, deletedCount: deleted });
    }

    // Eliminación masiva de opciones de catálogo
    if (pathname === '/api/catalogos/items/batch-delete' && method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => !isNaN(n) && n > 0) : [];
      if (ids.length === 0) {
        return sendJSON(res, 400, { error: 'No se seleccionaron opciones para eliminar.' });
      }
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM catalogos WHERE id IN (${placeholders})`).run(...ids);
      broadcastSSE('catalogo_actualizado', { batchDeletedItems: ids });
      return sendJSON(res, 200, { ok: true, deletedCount: ids.length });
    }

    // Agregar una opción a cualquier campo/lista desplegable
    if (pathname === '/api/catalogos' && method === 'POST') {
      const body = await readJsonBody(req);
      const categoria = String(body.categoria || 'UNIDAD').trim().toUpperCase();
      const nombre = String(body.nombre || '').trim();
      const codigo = String(body.codigo || '').trim().toUpperCase();

      const camposDisponibles = getCamposCatalogo();
      const validCodes = camposDisponibles.map((c) => c.codigo);

      if (!validCodes.includes(categoria)) {
        return sendJSON(res, 400, { error: `La categoría o campo "${categoria}" no es válida.` });
      }
      if (!nombre) {
        return sendJSON(res, 400, { error: 'El nombre del elemento es obligatorio.' });
      }

      try {
        const maxRow = db
          .prepare('SELECT MAX(orden) as m FROM catalogos WHERE categoria = ?')
          .get(categoria);
        const nextOrden = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
        const result = db
          .prepare(`
            INSERT INTO catalogos (categoria, nombre, codigo, activo, orden, creado_en)
            VALUES (?, ?, ?, 1, ?, ?)
          `)
          .run(categoria, nombre, codigo, nextOrden, getNowISO());
        const item = db.prepare('SELECT * FROM catalogos WHERE id = ?').get(result.lastInsertRowid);
        broadcastSSE('catalogo_actualizado', { categoria, item });
        return sendJSON(res, 201, { item });
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return sendJSON(res, 400, { error: `La opción "${nombre}" ya existe en este campo.` });
        }
        return sendJSON(res, 400, { error: err.message || 'Error al guardar elemento.' });
      }
    }

    const catMatch = pathname.match(/^\/api\/catalogos\/(\d+)$/);
    if (catMatch) {
      const id = Number(catMatch[1]);
      const existing = db.prepare('SELECT * FROM catalogos WHERE id = ?').get(id);
      if (!existing) return sendJSON(res, 404, { error: 'Elemento no encontrado.' });

      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const nombre = body.nombre !== undefined ? String(body.nombre).trim() : existing.nombre;
        const codigo = body.codigo !== undefined ? String(body.codigo).trim().toUpperCase() : existing.codigo;
        const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : existing.activo;

        db.prepare('UPDATE catalogos SET nombre = ?, codigo = ?, activo = ? WHERE id = ?').run(
          nombre,
          codigo,
          activo,
          id
        );
        const updated = db.prepare('SELECT * FROM catalogos WHERE id = ?').get(id);
        broadcastSSE('catalogo_actualizado', { categoria: updated.categoria, item: updated });
        return sendJSON(res, 200, { item: updated });
      }

      if (method === 'DELETE') {
        db.prepare('DELETE FROM catalogos WHERE id = ?').run(id);
        broadcastSSE('catalogo_actualizado', { categoria: existing.categoria });
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ── 5. Gestión de Reuniones / Eventos Calendarizados ─────────────────────
    if (pathname === '/api/eventos' && method === 'GET') {
      const baseUrl = getEffectiveBaseUrl(req);
      const rows = db
        .prepare('SELECT * FROM eventos WHERE COALESCE(eliminado, 0) = 0 ORDER BY fecha DESC, hora DESC')
        .all();
      const eventos = rows.map((ev) => buildEventResponse(ev, baseUrl));
      return sendJSON(res, 200, { eventos, baseUrl });
    }

    if (pathname === '/api/eventos' && method === 'POST') {
      const body = await readJsonBody(req);
      const tema = String(body.tema || '').trim();
      const fecha = String(body.fecha || '').trim();
      const hora = String(body.hora || '').trim();
      const direccionOrganiza = String(body.direccion_organiza || '').trim();
      const unidadesInvitadasArr = parseUnidadesInvitadas(body.unidades_invitadas);
      const lugar = String(body.lugar || '').trim();
      const tipo = String(body.tipo || 'Presencial').trim();
      const procesoIso = String(body.proceso_iso || '').trim();
      const planificacion = String(body.planificacion || '').trim();
      const duracionVentana =
        body.duracion_ventana_min !== undefined && body.duracion_ventana_min !== null
          ? Number(body.duracion_ventana_min)
          : 30;
      const estadoManual =
        body.estado_manual !== undefined
          ? String(body.estado_manual)
          : duracionVentana <= 0
          ? 'FORZAR_ABIERTA'
          : 'AUTO';

      if (!tema || !fecha || !hora) {
        return sendJSON(res, 400, {
          error: 'Los campos Fecha, Hora y Tema son obligatorios para programar la reunión.',
        });
      }
      if (!direccionOrganiza) {
        return sendJSON(res, 400, {
          error: 'Por favor seleccione la Dirección que Organiza.',
        });
      }
      if (unidadesInvitadasArr.length === 0) {
        return sendJSON(res, 400, {
          error: 'Por favor seleccione al menos 1 Unidad Invitada.',
        });
      }

      const id = crypto.randomUUID();
      let token = slugifyToken(tema);
      while (db.prepare('SELECT 1 FROM eventos WHERE token = ?').get(token)) {
        token = slugifyToken(tema);
      }

      const nowIso = getNowISO();
      db.prepare(`
        INSERT INTO eventos (
          id, token, tema, fecha, hora, direccion_organiza, unidades_invitadas,
          lugar, tipo, proceso_iso, planificacion, organizador, descripcion,
          duracion_ventana_min, estado_manual, creado_en, actualizado_en
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        token,
        tema,
        fecha,
        hora,
        direccionOrganiza,
        JSON.stringify(unidadesInvitadasArr),
        lugar,
        tipo,
        procesoIso,
        planificacion,
        direccionOrganiza,
        '',
        duracionVentana,
        estadoManual,
        nowIso,
        nowIso
      );

      const creado = db.prepare('SELECT * FROM eventos WHERE id = ?').get(id);
      const baseUrl = getEffectiveBaseUrl(req);
      const enriched = buildEventResponse(creado, baseUrl);
      broadcastSSE('evento_actualizado', enriched);
      return sendJSON(res, 201, { evento: enriched });
    }

    const eventoIdMatch = pathname.match(/^\/api\/eventos\/([^/]+)$/i);
    if (eventoIdMatch) {
      const idOrToken = eventoIdMatch[1];
      const existing = db
        .prepare('SELECT * FROM eventos WHERE id = ? OR token = ?')
        .get(idOrToken, idOrToken);
      if (!existing) {
        return sendJSON(res, 404, { error: 'Evento no encontrado.' });
      }
      const eventoId = existing.id;

      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const tema = body.tema !== undefined ? String(body.tema).trim() : existing.tema;
        const fecha = body.fecha !== undefined ? String(body.fecha).trim() : existing.fecha;
        const hora = body.hora !== undefined ? String(body.hora).trim() : existing.hora;
        const direccionOrganiza =
          body.direccion_organiza !== undefined
            ? String(body.direccion_organiza).trim()
            : existing.direccion_organiza;
        const unidadesInvitadas =
          body.unidades_invitadas !== undefined
            ? JSON.stringify(parseUnidadesInvitadas(body.unidades_invitadas))
            : existing.unidades_invitadas;
        const lugar = body.lugar !== undefined ? String(body.lugar).trim() : existing.lugar;
        const tipo = body.tipo !== undefined ? String(body.tipo).trim() : existing.tipo;
        const procesoIso =
          body.proceso_iso !== undefined ? String(body.proceso_iso).trim() : existing.proceso_iso;
        const planificacion =
          body.planificacion !== undefined ? String(body.planificacion).trim() : existing.planificacion;

        let duracionVentana =
          body.duracion_ventana_min !== undefined
            ? Number(body.duracion_ventana_min)
            : existing.duracion_ventana_min;
        let estadoManual =
          body.estado_manual !== undefined ? String(body.estado_manual) : existing.estado_manual;

        if (body.accion === 'ACTIVAR_PERMANENTE') {
          estadoManual = 'FORZAR_ABIERTA';
        } else if (body.accion === 'REACTIVAR_TIEMPO' || body.accion === 'REACTIVAR_30M') {
          const extraMin = Math.max(1, Number(body.minutos || 30));
          const startDate = parseEventStartDate(fecha, hora);
          const createdMs = existing.creado_en ? new Date(existing.creado_en).getTime() : 0;
          const effectiveStartMs =
            !isNaN(createdMs) && createdMs > startDate.getTime() ? createdMs : startDate.getTime();
          const targetExpirationMs = Date.now() + extraMin * 60 * 1000;
          duracionVentana = Math.max(
            extraMin,
            Math.ceil((targetExpirationMs - effectiveStartMs) / 60000)
          );
          estadoManual = 'AUTO';
        } else if (body.accion === 'DESACTIVAR') {
          estadoManual = 'FORZAR_CERRADA';
        }

        const nowIso = getNowISO();

        db.prepare(`
          UPDATE eventos
          SET tema = ?, fecha = ?, hora = ?, direccion_organiza = ?, unidades_invitadas = ?,
              lugar = ?, tipo = ?, proceso_iso = ?, planificacion = ?,
              duracion_ventana_min = ?, estado_manual = ?, actualizado_en = ?
          WHERE id = ?
        `).run(
          tema,
          fecha,
          hora,
          direccionOrganiza,
          unidadesInvitadas,
          lugar,
          tipo,
          procesoIso,
          planificacion,
          duracionVentana,
          estadoManual,
          nowIso,
          eventoId
        );

        db.prepare('UPDATE asistencias SET tema = ?, fecha = ?, hora = ?, actualizado_en = ? WHERE evento_id = ?').run(
          tema,
          fecha,
          hora,
          nowIso,
          eventoId
        );

        const actualizado = db.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId);
        const enriched = buildEventResponse(actualizado, getEffectiveBaseUrl(req));
        broadcastSSE('evento_actualizado', enriched);
        return sendJSON(res, 200, { evento: enriched });
      }

      if (method === 'DELETE') {
        const now = getNowISO();
        db.prepare('UPDATE eventos SET eliminado = 1, eliminado_en = ?, actualizado_en = ? WHERE id = ?').run(now, now, eventoId);
        db.prepare('UPDATE asistencias SET eliminado = 1, eliminado_en = ?, actualizado_en = ? WHERE evento_id = ?').run(now, now, eventoId);
        broadcastSSE('evento_eliminado', { id: eventoId, papelera: true });
        broadcastSSE('papelera_actualizada', {});
        return sendJSON(res, 200, { ok: true, softDeleted: true });
      }
    }

    // ── 6. Generador de Código QR por cada Lista ─────────────────────────────
    const qrMatch = pathname.match(/^\/api\/qr\/([^/]+)$/);
    if (qrMatch && method === 'GET') {
      const token = qrMatch[1];
      const evento = db.prepare('SELECT * FROM eventos WHERE token = ? OR id = ?').get(token, token);
      if (!evento) {
        return sendJSON(res, 404, { error: 'Lista no encontrada para generar QR.' });
      }
      const baseUrl = getEffectiveBaseUrl(req);
      const customUrl = parsedUrl.searchParams.get('url');
      const targetUrl = customUrl || `${baseUrl}/asistencia/${encodeURIComponent(evento.token)}`;
      const format = parsedUrl.searchParams.get('format') || 'svg';

      if (format === 'json') {
        const matrix = generateQRMatrix(targetUrl);
        return sendJSON(res, 200, { url: targetUrl, token: evento.token, matrix });
      }

      const svg = generateQRSVG(targetUrl, {
        sizePx: Number(parsedUrl.searchParams.get('size') || 320),
        darkColor: '#0099a8',
        lightColor: '#ffffff',
        margin: 3,
      });
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(svg);
      return;
    }

    // ── 7. API Pública para el Formulario Individual de Asistencia ───────────
    const pubEventoMatch = pathname.match(/^\/api\/public\/evento\/([^/]+)$/);
    if (pubEventoMatch && method === 'GET') {
      const token = pubEventoMatch[1];
      const evento = db.prepare('SELECT * FROM eventos WHERE token = ? OR id = ?').get(token, token);
      if (!evento || evento.eliminado === 1) {
        return sendJSON(res, 404, { error: 'El vínculo de esta lista de asistencia no existe o fue enviado a la papelera.' });
      }

      const status = buildEventResponse(evento, getEffectiveBaseUrl(req));
      const configs = getAllConfigs();
      const { grouped } = getCatalogos({ soloActivos: true });
      const allUnidadesCatalog = grouped.UNIDAD || [];
      const invitedNames = Array.isArray(status.unidades_invitadas_lista)
        ? status.unidades_invitadas_lista
        : [];
      const invitedUnidadesCatalog =
        invitedNames.length > 0
          ? invitedNames.map((uName) => {
              const found = allUnidadesCatalog.find((u) => u.nombre === uName);
              return found || { nombre: uName, codigo: '' };
            })
          : allUnidadesCatalog;

      const dirLogo = resolveLogoForDireccion(evento.direccion_organiza);
      const cleanRightLogo =
        String(evento.logo_derecho_custom || configs.logo_derecho || '').replace(/.*uverde.*/i, '') ||
        '/image/Jaguar34.png';

      return sendJSON(res, 200, {
        evento: status,
        unidades: invitedUnidadesCatalog,
        catalogos: {
          ...grouped,
          UNIDAD: invitedUnidadesCatalog,
        },
        config: {
          titulo_header: configs.titulo_header || 'ASISTENCIA DE PARTICIPACIÓN',
          subtitulo_header: configs.subtitulo_header || 'Registro Oficial de Participación y Firmas',
          logo_izquierdo: dirLogo || evento.logo_izquierdo_custom || configs.logo_izquierdo || '/image/uamh.png',
          logo_derecho: cleanRightLogo,
          mensaje_gracias_titulo: configs.mensaje_gracias_titulo || '¡Gracias por llenar esta asistencia!',
          mensaje_gracias_cuerpo:
            configs.mensaje_gracias_cuerpo ||
            'Su participación y firma han sido registradas correctamente.',
        },
        serverTime: getNowISO(),
      });
    }

    const pubSubmitMatch = pathname.match(/^\/api\/public\/asistencia\/([^/]+)$/);
    if (pubSubmitMatch && method === 'POST') {
      const token = pubSubmitMatch[1];
      const evento = db.prepare('SELECT * FROM eventos WHERE token = ? OR id = ?').get(token, token);
      if (!evento || evento.eliminado === 1) {
        return sendJSON(res, 404, { error: 'Lista de asistencia no encontrada o fue enviada a la papelera.' });
      }

      const status = computeEventStatus(evento);
      if (!status.activa) {
        return sendJSON(res, 403, {
          error:
            'Lista desactivada: Han transcurrido más de 30 minutos desde la fecha y hora programada para esta reunión.',
          evento: status,
        });
      }

      const body = await readJsonBody(req);
      const unidad = String(body.unidad || '').trim();
      const cargo = String(body.cargo || '').trim();
      const sexo = normalizeSexo(body.sexo || '');
      const nombre = String(body.nombre || '').trim();
      const firmaBase64 = String(body.firma_base64 || '').trim();

      if (!unidad) {
        return sendJSON(res, 400, { error: 'Por favor seleccione su Unidad de la lista desplegable.' });
      }
      if (
        Array.isArray(status.unidades_invitadas_lista) &&
        status.unidades_invitadas_lista.length > 0 &&
        !status.unidades_invitadas_lista.includes(unidad)
      ) {
        return sendJSON(res, 400, {
          error: 'La unidad seleccionada no se encuentra dentro de las unidades invitadas a esta reunión.',
        });
      }
      if (!nombre || nombre.length < 2) {
        return sendJSON(res, 400, { error: 'Por favor ingrese su Nombre completo.' });
      }
      if (!firmaBase64 || !firmaBase64.startsWith('data:image/')) {
        return sendJSON(res, 400, {
          error: 'Por favor realice su firma en el recuadro antes de guardar.',
        });
      }

      const ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        '';
      const userAgent = String(req.headers['user-agent'] || '').slice(0, 250);
      const registradoEn = getNowISO();

      const result = db
        .prepare(`
          INSERT INTO asistencias (
            evento_id, unidad, cargo, sexo, tema, nombre, fecha, hora, firma_base64, ip_dispositivo, user_agent, registrado_en, actualizado_en
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          evento.id,
          unidad,
          cargo,
          sexo,
          evento.tema,
          nombre,
          evento.fecha,
          evento.hora,
          firmaBase64,
          ip,
          userAgent,
          registradoEn,
          registradoEn
        );

      const nuevoRegistro = db
        .prepare('SELECT * FROM asistencias WHERE id = ?')
        .get(result.lastInsertRowid);

      broadcastSSE('nueva_asistencia', {
        asistencia: nuevoRegistro,
        evento_id: evento.id,
        token: evento.token,
      });

      const configs = getAllConfigs();
      return sendJSON(res, 201, {
        ok: true,
        mensaje_titulo: configs.mensaje_gracias_titulo || '¡Gracias por llenar esta asistencia!',
        mensaje_cuerpo:
          configs.mensaje_gracias_cuerpo ||
          'Su asistencia ha sido guardada exitosamente en la base de datos.',
        registro: nuevoRegistro,
      });
    }

    // ── 8. Base de Datos General Centralizada ────────────────────────────────
    if (pathname === '/api/asistencias' && method === 'GET') {
      const eventoId = parsedUrl.searchParams.get('evento_id') || '';
      const token = parsedUrl.searchParams.get('token') || '';
      const unidad = parsedUrl.searchParams.get('unidad') || '';
      const cargo = parsedUrl.searchParams.get('cargo') || '';
      const sexo = parsedUrl.searchParams.get('sexo') || '';
      const procesoIso = parsedUrl.searchParams.get('proceso_iso') || '';
      const fecha = parsedUrl.searchParams.get('fecha') || '';
      const q = (parsedUrl.searchParams.get('q') || '').trim();

      let whereClauses = [
        'COALESCE(a.eliminado, 0) = 0',
        '(e.id IS NULL OR COALESCE(e.eliminado, 0) = 0)',
      ];
      let params = [];

      if (eventoId) {
        whereClauses.push('a.evento_id = ?');
        params.push(eventoId);
      }
      if (token) {
        whereClauses.push('(e.token = ? OR e.id = ?)');
        params.push(token, token);
      }
      if (unidad) {
        whereClauses.push('a.unidad = ?');
        params.push(unidad);
      }
      if (cargo) {
        whereClauses.push('a.cargo = ?');
        params.push(cargo);
      }
      if (sexo) {
        whereClauses.push('a.sexo = ?');
        params.push(sexo);
      }
      if (procesoIso) {
        whereClauses.push('e.proceso_iso = ?');
        params.push(procesoIso);
      }
      if (fecha) {
        whereClauses.push('a.fecha = ?');
        params.push(fecha);
      }
      if (q) {
        whereClauses.push('(a.nombre LIKE ? OR a.tema LIKE ? OR a.unidad LIKE ? OR a.cargo LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }

      const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`
          SELECT
            a.*,
            e.token as evento_token,
            e.lugar as evento_lugar,
            e.tipo as evento_tipo,
            e.direccion_organiza as evento_direccion_organiza,
            e.proceso_iso as evento_proceso_iso,
            e.planificacion as evento_planificacion
          FROM asistencias a
          LEFT JOIN eventos e ON e.id = a.evento_id
          ${whereSQL}
          ORDER BY a.id DESC
        `)
        .all(...params);

      const normalizedRows = rows.map((r) => ({
        ...r,
        sexo: normalizeSexo(r.sexo),
      }));

      return sendJSON(res, 200, {
        total: normalizedRows.length,
        asistencias: normalizedRows,
      });
    }

    const deleteAsistenciaMatch = pathname.match(/^\/api\/asistencias\/(\d+)$/);
    if (deleteAsistenciaMatch && method === 'DELETE') {
      const id = Number(deleteAsistenciaMatch[1]);
      const now = getNowISO();
      db.prepare('UPDATE asistencias SET eliminado = 1, eliminado_en = ?, actualizado_en = ? WHERE id = ?').run(now, now, id);
      broadcastSSE('asistencia_eliminada', { id, papelera: true });
      broadcastSSE('papelera_actualizada', {});
      return sendJSON(res, 200, { ok: true, softDeleted: true });
    }

    // ── 8.1. Papelera de Reciclaje (Reuniones y Asistencias) ────────────────
    if (pathname === '/api/papelera' && method === 'GET') {
      const baseUrl = getEffectiveBaseUrl(req);
      const eventosEliminados = db
        .prepare('SELECT * FROM eventos WHERE COALESCE(eliminado, 0) = 1 ORDER BY eliminado_en DESC, fecha DESC')
        .all()
        .map((ev) => buildEventResponse(ev, baseUrl));

      const asistenciasEliminadas = db
        .prepare(`
          SELECT
            a.*,
            e.tema as evento_tema,
            e.fecha as evento_fecha,
            e.hora as evento_hora,
            e.token as evento_token,
            e.direccion_organiza as evento_direccion_organiza
          FROM asistencias a
          LEFT JOIN eventos e ON e.id = a.evento_id
          WHERE COALESCE(a.eliminado, 0) = 1
          ORDER BY a.eliminado_en DESC, a.id DESC
        `)
        .all();

      return sendJSON(res, 200, {
        eventos: eventosEliminados,
        asistencias: asistenciasEliminadas,
        totalEventos: eventosEliminados.length,
        totalAsistencias: asistenciasEliminadas.length,
        total: eventosEliminados.length + asistenciasEliminadas.length,
      });
    }

    // Restaurar elemento de la papelera
    if (pathname === '/api/papelera/restaurar' && method === 'POST') {
      const body = await readJsonBody(req);
      const tipo = String(body.tipo || '').toLowerCase();
      const id = body.id;
      const now = getNowISO();

      if (!id || !['evento', 'asistencia'].includes(tipo)) {
        return sendJSON(res, 400, { error: 'Parámetros inválidos para restaurar.' });
      }

      if (tipo === 'evento') {
        const ev = db.prepare('SELECT * FROM eventos WHERE id = ?').get(id);
        const status = ev ? computeEventStatus(ev) : null;
        const nuevoEstadoManual = status && !status.activa ? 'FORZAR_ABIERTA' : (ev ? ev.estado_manual : 'AUTO');
        db.prepare('UPDATE eventos SET eliminado = 0, eliminado_en = NULL, estado_manual = ?, actualizado_en = ? WHERE id = ?').run(nuevoEstadoManual, now, id);
        db.prepare('UPDATE asistencias SET eliminado = 0, eliminado_en = NULL, actualizado_en = ? WHERE evento_id = ?').run(now, id);
        broadcastSSE('evento_restaurado', { id });
      } else if (tipo === 'asistencia') {
        db.prepare('UPDATE asistencias SET eliminado = 0, eliminado_en = NULL, actualizado_en = ? WHERE id = ?').run(now, Number(id));
        broadcastSSE('asistencia_restaurada', { id });
      }

      broadcastSSE('papelera_actualizada', {});
      return sendJSON(res, 200, { ok: true, tipo, id });
    }

    // Purgar elemento individual o vaciar papelera definitivamente
    if (pathname === '/api/papelera/purgar' && method === 'POST') {
      const body = await readJsonBody(req);
      const tipo = String(body.tipo || '').toLowerCase();
      const id = body.id;

      if (tipo === 'todo') {
        db.prepare('DELETE FROM asistencias WHERE COALESCE(eliminado, 0) = 1').run();
        db.prepare('DELETE FROM asistencias WHERE evento_id IN (SELECT id FROM eventos WHERE COALESCE(eliminado, 0) = 1)').run();
        db.prepare('DELETE FROM eventos WHERE COALESCE(eliminado, 0) = 1').run();
        broadcastSSE('papelera_vaciada', {});
        return sendJSON(res, 200, { ok: true, purgados: 'todo' });
      }

      if (tipo === 'evento' && id) {
        db.prepare('DELETE FROM asistencias WHERE evento_id = ?').run(id);
        db.prepare('DELETE FROM eventos WHERE id = ?').run(id);
        broadcastSSE('evento_purgado', { id });
        return sendJSON(res, 200, { ok: true, tipo, id });
      }

      if (tipo === 'asistencia' && id) {
        db.prepare('DELETE FROM asistencias WHERE id = ?').run(Number(id));
        broadcastSSE('asistencia_purgada', { id });
        return sendJSON(res, 200, { ok: true, tipo, id });
      }

      return sendJSON(res, 400, { error: 'Parámetros inválidos para purgar de papelera.' });
    }

    // ── 9. Exportación CSV / Excel de Base de Datos General ──────────────────
    if (pathname === '/api/export/csv' && method === 'GET') {
      const eventoId = parsedUrl.searchParams.get('evento_id') || '';
      const unidad = parsedUrl.searchParams.get('unidad') || '';
      let where = ['COALESCE(a.eliminado, 0) = 0', '(e.id IS NULL OR COALESCE(e.eliminado, 0) = 0)'];
      let params = [];
      if (eventoId) {
        where.push('a.evento_id = ?');
        params.push(eventoId);
      }
      if (unidad) {
        where.push('a.unidad = ?');
        params.push(unidad);
      }
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rowsRaw = db
        .prepare(`
          SELECT
            a.id, a.fecha, a.hora, a.tema,
            e.direccion_organiza, e.lugar, e.tipo, e.proceso_iso, e.planificacion,
            a.unidad, a.cargo, a.sexo, a.nombre, a.registrado_en, a.ip_dispositivo
          FROM asistencias a
          LEFT JOIN eventos e ON e.id = a.evento_id
          ${whereSQL}
          ORDER BY a.id ASC
        `)
        .all(...params);

      // Ordenar por cantidad de registros de cada Dirección/Facultad (descendente) y por último la Dirección Organizadora
      const normU = (s) => String(s || '').trim().toLowerCase();
      const unitCounts = {};
      for (const r of rowsRaw) {
        const k = normU(r.unidad);
        unitCounts[k] = (unitCounts[k] || 0) + 1;
      }
      const rows = rowsRaw.slice().sort((a, b) => {
        const aIsOrg = a.direccion_organiza && normU(a.unidad) === normU(a.direccion_organiza);
        const bIsOrg = b.direccion_organiza && normU(b.unidad) === normU(b.direccion_organiza);
        if (aIsOrg !== bIsOrg) return aIsOrg ? 1 : -1;
        const countDiff = (unitCounts[normU(b.unidad)] || 0) - (unitCounts[normU(a.unidad)] || 0);
        if (countDiff !== 0) return countDiff;
        const unitCmp = String(a.unidad || '').localeCompare(String(b.unidad || ''), 'es');
        if (unitCmp !== 0) return unitCmp;
        return Number(a.id || 0) - Number(b.id || 0);
      });

      const escapeCSV = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

      const headers = [
        'Folio',
        'Fecha Reunión',
        'Hora Reunión',
        'Tema de Reunión',
        'Dirección que Organiza',
        'Lugar',
        'Modalidad / Tipo',
        'Proceso ISO',
        'Planificación',
        'Unidad del Participante',
        'Cargo',
        'Sexo',
        'Nombre del Participante',
        'Fecha/Hora Exacta Firma',
        'IP Dispositivo',
      ];

      let varonCount = 0;
      let mujerCount = 0;
      const csvLines = [headers.map(escapeCSV).join(',')];
      for (const r of rows) {
        const sxNorm = normalizeSexo(r.sexo);
        if (sxNorm === 'Varón') varonCount++;
        else if (sxNorm === 'Mujer') mujerCount++;

        csvLines.push(
          [
            r.id,
            r.fecha,
            formatHoraAmPm(r.hora),
            r.tema,
            r.direccion_organiza || '',
            r.lugar || '',
            r.tipo || '',
            r.proceso_iso || '',
            r.planificacion || '',
            r.unidad,
            r.cargo || '',
            sxNorm || '',
            r.nombre,
            r.registrado_en,
            r.ip_dispositivo || '',
          ]
            .map(escapeCSV)
            .join(',')
        );
      }

      const totalCount = rows.length;
      const varonPct = totalCount > 0 ? ((varonCount / totalCount) * 100).toFixed(1) + '%' : '0.0%';
      const mujerPct = totalCount > 0 ? ((mujerCount / totalCount) * 100).toFixed(1) + '%' : '0.0%';
      const totalPct = totalCount > 0 ? '100.0%' : '0.0%';

      csvLines.push('');
      csvLines.push(['RESUMEN POR SEXO', 'CANTIDAD', 'PORCENTAJE'].map(escapeCSV).join(','));
      csvLines.push(['Varón', varonCount, varonPct].map(escapeCSV).join(','));
      csvLines.push(['Mujer', mujerCount, mujerPct].map(escapeCSV).join(','));
      csvLines.push(['TOTAL', totalCount, totalPct].map(escapeCSV).join(','));

      const csvContent = '\uFEFF' + csvLines.join('\r\n');
      const filename = eventoId
        ? `asistencia-evento-${eventoId.slice(0, 8)}.csv`
        : 'base-datos-asistencias-general.csv';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      res.end(csvContent);
      return;
    }

    // ── 10. Rutas de Vistas Web ──────────────────────────────────────────────
    if ((pathname.startsWith('/asistencia/') || pathname.startsWith('/a/')) && method === 'GET') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'asistencia.html'));
    }

    if (pathname.startsWith('/acta/') && method === 'GET') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'acta.html'));
    }

    if ((pathname === '/reporte-pdf' || pathname.startsWith('/reporte-pdf/') || pathname === '/reporte' || pathname.startsWith('/reporte/')) && method === 'GET') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'reporte-pdf.html'));
    }

    if (pathname === '/' || pathname === '/admin') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    if (pathname.startsWith('/image/') && method === 'GET') {
      const relSubpath = pathname.replace(/^\/image\/+/, '').replace(/^(\.\.[/\\])+/, '');
      const segments = relSubpath.split('/').filter(Boolean);
      const roots = [path.join(PUBLIC_DIR, 'image'), path.join(__dirname, 'image')];

      for (const rootDir of roots) {
        const directPath = path.join(rootDir, ...segments);
        if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
          return serveStaticFile(res, directPath);
        }
        // Resolución insensible a mayúsculas/minúsculas para subcarpetas (ej. /image/Logos/DPGC.png)
        try {
          let currentPath = rootDir;
          let matchedAll = true;
          for (const seg of segments) {
            if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
              matchedAll = false;
              break;
            }
            const entries = fs.readdirSync(currentPath);
            const match = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
            if (!match) {
              matchedAll = false;
              break;
            }
            currentPath = path.join(currentPath, match);
          }
          if (matchedAll && fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()) {
            return serveStaticFile(res, currentPath);
          }
        } catch (_) {}
      }
    }

    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR)) {
      return serveStaticFile(res, filePath);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta no encontrada');
  } catch (err) {
    console.error('Error en el servidor:', err);
    sendJSON(res, 500, { error: err.message || 'Error interno del servidor' });
  }
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = getNetworkIPs();
    console.log('==================================================================');
    console.log('  SISTEMA DE LISTAS DE ASISTENCIA Y PARTICIPACIÓN (ACTIVO)');
    console.log('==================================================================');
    console.log(`  Panel Local:       http://localhost:${PORT}`);
    for (const ip of ips) {
      console.log(`  Red Local (${ip.name}): http://${ip.address}:${PORT}`);
    }
    console.log('==================================================================');
  });
}

module.exports = requestHandler;
