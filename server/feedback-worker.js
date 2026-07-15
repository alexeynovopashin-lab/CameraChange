/**
 * Camerateka — воркер общей статистики голосов «подходит?» (вариант Б).
 *
 * Бесплатный Cloudflare Worker + KV: принимает голоса из виджета подбора
 * и отдаёт агрегированную статистику для админки. Сырые голоса не хранит —
 * только счётчики по камерам (никаких персональных данных).
 *
 * Деплой — см. server/README.md. После деплоя вставьте URL воркера
 * в константу FEEDBACK_ENDPOINT в index.html и admin.html.
 *
 * API:
 *   POST /vote  body: { cameraId: "fujifilm-x100v", vote: 1 | -1, level?: "beginner" }
 *   GET  /stats -> { total, cameras: { <id>: { up, down, levels: { <level>: n } } } }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === 'POST' && url.pathname === '/vote') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

      const cameraId = String(body.cameraId || '').slice(0, 80);
      const vote = body.vote === 1 ? 1 : body.vote === -1 ? -1 : 0;
      const level = String(body.level || 'unknown').slice(0, 40);
      // id камер — только slug-символы; всё остальное отбрасываем
      if (!cameraId || !/^[a-z0-9-]+$/.test(cameraId) || vote === 0) {
        return json({ error: 'bad vote' }, 400);
      }

      const key = 'votes:' + cameraId;
      const current = JSON.parse((await env.FEEDBACK.get(key)) || '{"up":0,"down":0,"levels":{}}');
      if (vote === 1) current.up++; else current.down++;
      current.levels[level] = (current.levels[level] || 0) + 1;
      await env.FEEDBACK.put(key, JSON.stringify(current));
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      const cameras = {};
      let cursor;
      do {
        const page = await env.FEEDBACK.list({ prefix: 'votes:', cursor });
        for (const k of page.keys) {
          const v = await env.FEEDBACK.get(k.name);
          if (v) cameras[k.name.slice(6)] = JSON.parse(v);
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      const total = Object.values(cameras).reduce((s, c) => s + c.up + c.down, 0);
      return json({ total, cameras });
    }

    return json({ error: 'not found' }, 404);
  },
};
