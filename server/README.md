# Сервер статистики голосов (вариант Б)

Общая статистика «подходит?» для всех пользователей — без своего сервера,
на бесплатном тарифе Cloudflare Workers (100 000 запросов в день).

Воркер хранит **только счётчики** по камерам (за/против + уровень опроса).
Сырые голоса, IP и любые персональные данные не сохраняются.

## Деплой (один раз, ~10 минут)

1. Зарегистрируйтесь на [dash.cloudflare.com](https://dash.cloudflare.com) (бесплатно).
2. **Workers & Pages → Create → Worker**, имя например `camerateka-feedback`.
3. Вставьте содержимое [feedback-worker.js](feedback-worker.js) вместо шаблонного кода, нажмите **Deploy**.
4. **Storage & Databases → KV → Create namespace**, имя любое (напр. `kamerateka-feedback`).
5. В настройках воркера: **Settings → Bindings → Add → KV namespace**,
   Variable name — `KV`, namespace — созданный на шаге 4. Сохраните и передеплойте.
6. Скопируйте URL воркера (`https://camerateka-feedback.<ваш-аккаунт>.workers.dev`).

## Подключение сайта

Вставьте URL в константу `FEEDBACK_ENDPOINT`:

- `index.html` — виджет начнёт отправлять голоса на сервер (localStorage остаётся как резерв);
- `admin.html` — на вкладке «Фидбэк» появится кнопка «Статистика с сервера».

Пока константа пустая — всё работает по-старому, только локально.

## Проверка

```
curl -X POST https://<воркер>/vote -d '{"cameraId":"fujifilm-x100v","vote":1,"level":"beginner"}'
curl https://<воркер>/stats
```
