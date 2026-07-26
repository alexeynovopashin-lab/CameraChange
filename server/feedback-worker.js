/**
 * Camerateka — воркер: статистика голосов «подходит?» и лента новостей.
 *
 * Бесплатный Cloudflare Worker + KV.
 *  • Голоса: принимает из виджета подбора, хранит только счётчики по камерам
 *    (никаких персональных данных).
 *  • Новости: агрегирует RSS профильных изданий. Браузер не может читать чужие
 *    фиды из-за CORS — воркер выступает прокси и кэширует результат в KV.
 *
 * Деплой — см. server/README.md. После деплоя вставьте URL воркера
 * в константу FEEDBACK_ENDPOINT в index.html и admin.html и в NEWS_ENDPOINT
 * в novosti.html.
 *
 * API:
 *   POST /vote  body: { cameraId: "fujifilm-x100v", vote: 1 | -1, level?: "beginner" }
 *   GET  /stats -> { total, cameras: { <id>: { up, down, levels: { <level>: n } } } }
 *   GET  /news  -> { updated, items: [{ title, link, source, date, summary }] }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Источники ленты. Отдаём только заголовок, краткую выжимку и ссылку на оригинал —
// статьи не копируем: задача проекта соединять знания, а не присваивать их (Vision).
const FEEDS = [
  { source: 'Photar',            lang: 'ru', url: 'https://photar.ru/feed/' },
  { source: 'Canon Rumors',      lang: 'en', url: 'https://www.canonrumors.com/feed/' },
  { source: 'Nikon Rumors',      lang: 'en', url: 'https://nikonrumors.com/feed/' },
  { source: 'Sony Alpha Rumors', lang: 'en', url: 'https://www.sonyalpharumors.com/feed/' },
  { source: 'Fuji Rumors',       lang: 'en', url: 'https://www.fujirumors.com/feed/' },
];

const NEWS_TTL = 1800;          // 30 минут — не долбим источники на каждый заход
const NEWS_KEY = 'news:cache';
const PER_FEED = 8;             // сколько свежих материалов брать с каждого источника

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

function parseFeed(xml, feed) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, PER_FEED)) {
    const title = tag(b, 'title');
    const link = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    if (!title || !link) continue;
    const raw = tag(b, 'description') || tag(b, 'content:encoded');
    const summary = decodeEntities(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
    const date = tag(b, 'pubDate') || tag(b, 'dc:date');
    items.push({
      title: title.slice(0, 300),
      link: link.trim(),
      source: feed.source,
      lang: feed.lang,
      date: date ? new Date(date).toISOString() : null,
      summary,
    });
  }
  return items;
}

async function buildNews() {
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const res = await fetch(f.url, {
      headers: { 'User-Agent': 'Camerateka/1.0 (+https://github.com/alexeynovopashin-lab/CameraChange)' },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!res.ok) throw new Error(f.source + ': HTTP ' + res.status);
    return parseFeed(await res.text(), f);
  }));

  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed.push(FEEDS[i].source);
  });
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { updated: new Date().toISOString(), failed, items: items.slice(0, 60) };
}

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
      const current = JSON.parse((await env.KV.get(key)) || '{"up":0,"down":0,"levels":{}}');
      if (vote === 1) current.up++; else current.down++;
      current.levels[level] = (current.levels[level] || 0) + 1;
      await env.KV.put(key, JSON.stringify(current));
      return json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      const cameras = {};
      let cursor;
      do {
        const page = await env.KV.list({ prefix: 'votes:', cursor });
        for (const k of page.keys) {
          const v = await env.KV.get(k.name);
          if (v) cameras[k.name.slice(6)] = JSON.parse(v);
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      const total = Object.values(cameras).reduce((s, c) => s + c.up + c.down, 0);
      return json({ total, cameras });
    }

    if (request.method === 'GET' && url.pathname === '/news') {
      // Кэш в KV: источники опрашиваем не чаще раза в NEWS_TTL секунд.
      const cached = await env.KV.get(NEWS_KEY, { type: 'json' });
      if (cached && Date.now() - new Date(cached.updated).getTime() < NEWS_TTL * 1000
          && url.searchParams.get('refresh') !== '1') {
        return json({ ...cached, cached: true });
      }
      try {
        const fresh = await buildNews();
        if (fresh.items.length) {
          await env.KV.put(NEWS_KEY, JSON.stringify(fresh));
          return json({ ...fresh, cached: false });
        }
        // все источники молчат — лучше отдать прошлый кэш, чем пустоту
        if (cached) return json({ ...cached, cached: true, stale: true });
        return json({ updated: new Date().toISOString(), items: [], failed: fresh.failed }, 502);
      } catch (e) {
        if (cached) return json({ ...cached, cached: true, stale: true });
        return json({ error: 'news unavailable' }, 502);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
