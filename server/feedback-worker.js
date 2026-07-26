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

// Некоторые фиды отдают сотни килобайт (Nikon Rumors ~400 КБ). Свежие материалы
// всегда в начале, а разбор всего объёма регулярками упирается в лимит CPU
// бесплатного тарифа Workers — поэтому режем хвост.
const MAX_XML = 200000;

// Картинку в RSS кладут по-разному, а часть изданий её не кладёт вовсе
// (из наших пятерых — только Canon Rumors и Nikon Rumors). Пробуем по очереди.
function extractImage(block) {
  const enclosure = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (enclosure && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(enclosure[1])) return enclosure[1];

  const media = block.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
  if (media) return media[1];

  // первый <img> внутри content:encoded / description
  const img = block.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) return img[1];

  return null;
}

// Иконки сайта и трекинг-пиксели в фидах встречаются вперемешку с реальными
// иллюстрациями — отсекаем по характерным размерам в имени файла.
function isUsableImage(u) {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  if (/-(\d{1,2}|1\d\d)x(\d{1,2}|1\d\d)\.(jpe?g|png|webp)/i.test(u)) return false; // мелкие кропы вроде -32x32
  if (/(favicon|logo-only|cropped-.*-32x32|pixel|spacer|feedburner|gravatar)/i.test(u)) return false;
  return true;
}

function parseFeed(xml, feed) {
  const items = [];
  const blocks = xml.slice(0, MAX_XML).match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, PER_FEED)) {
    const title = tag(b, 'title');
    const link = tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    if (!title || !link) continue;
    const raw = tag(b, 'description') || tag(b, 'content:encoded');
    const summary = decodeEntities(raw)
      .replace(/<[^>]+>/g, ' ')
      // WordPress дописывает в конец «The post … first appeared on …» — это не текст статьи
      .replace(/The post[\s\S]*?(?:first )?appeared first on[\s\S]*$/i, '')
      .replace(/The post[\s\S]*?first appeared on[\s\S]*$/i, '')
      .replace(/\[…\]|\[\.\.\.\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    const date = tag(b, 'pubDate') || tag(b, 'dc:date');
    const rawImg = extractImage(b);
    items.push({
      title: title.slice(0, 300),
      link: link.trim(),
      source: feed.source,
      lang: feed.lang,
      date: date ? new Date(date).toISOString() : null,
      summary,
      image: isUsableImage(rawImg) ? rawImg : null,
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

// Имя KV-биндинга задаётся при настройке воркера и у всех разное (KV, FEEDBACK, …).
// Вместо жёсткой привязки находим первый биндинг с методами KV — тогда код
// не падает из-за того, что переменную назвали иначе.
function getKV(env) {
  if (!env) return null;
  for (const key of Object.keys(env)) {
    const v = env[key];
    if (v && typeof v.get === 'function' && typeof v.put === 'function' && typeof v.list === 'function') {
      return v;
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    // Любая необработанная ошибка внутри воркера превращается в «error code: 1101»
    // без подробностей. Ловим всё и отвечаем понятным JSON — иначе отладка вслепую.
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ error: 'worker exception', detail: String(e && e.message || e) }, 500);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const KV = getKV(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Диагностика: показывает, видит ли воркер KV и как называется биндинг.
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      ok: true,
      kv: !!KV,
      bindings: Object.keys(env || {}),
      endpoints: ['/vote', '/stats', '/news', '/health'],
    });
  }

  if (request.method === 'POST' && url.pathname === '/vote') {
    if (!KV) return json({ error: 'KV binding not found' }, 500);
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
    const current = JSON.parse((await KV.get(key)) || '{"up":0,"down":0,"levels":{}}');
    if (vote === 1) current.up++; else current.down++;
    current.levels[level] = (current.levels[level] || 0) + 1;
    await KV.put(key, JSON.stringify(current));
    return json({ ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/stats') {
    if (!KV) return json({ error: 'KV binding not found' }, 500);
    const cameras = {};
    let cursor;
    do {
      const page = await KV.list({ prefix: 'votes:', cursor });
      for (const k of page.keys) {
        const v = await KV.get(k.name);
        if (v) cameras[k.name.slice(6)] = JSON.parse(v);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const total = Object.values(cameras).reduce((s, c) => s + c.up + c.down, 0);
    return json({ total, cameras });
  }

  if (request.method === 'GET' && url.pathname === '/news') {
    // Кэш в KV: источники опрашиваем не чаще раза в NEWS_TTL секунд.
    // Без KV лента всё равно работает — просто без кэша.
    let cached = null;
    if (KV) {
      try { cached = await KV.get(NEWS_KEY, { type: 'json' }); } catch (e) { cached = null; }
    }
    if (cached && cached.updated && Date.now() - new Date(cached.updated).getTime() < NEWS_TTL * 1000
        && url.searchParams.get('refresh') !== '1') {
      return json({ ...cached, cached: true });
    }
    try {
      const fresh = await buildNews();
      if (fresh.items.length) {
        if (KV) { try { await KV.put(NEWS_KEY, JSON.stringify(fresh)); } catch (e) {} }
        return json({ ...fresh, cached: false });
      }
      // все источники молчат — лучше отдать прошлый кэш, чем пустоту
      if (cached) return json({ ...cached, cached: true, stale: true });
      return json({ error: 'all feeds failed', failed: fresh.failed, items: [] }, 502);
    } catch (e) {
      if (cached) return json({ ...cached, cached: true, stale: true });
      return json({ error: 'news unavailable', detail: String(e && e.message || e), items: [] }, 502);
    }
  }

  return json({ error: 'not found' }, 404);
}
