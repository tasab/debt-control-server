# План імплементації — Сервер

Backend (`server/`) для P2P-платформи. Похідний від `PLATFORM_PLAN.md`.
Парний файл: `CLIENT_PLAN.md`.

Стек лишається: **Fastify 5 + Drizzle + Postgres** (docker-compose вже є).

> **Сервер володіє контрактом API (§2).** Будь-яка зміна контракту — спершу правка
> цього файлу, потім код. Клієнт пишеться проти §2, а не проти реального сервера,
> тому розсинхрон контракту = зламана паралельна робота.

---

## 1. Структура проєкту

```
server/
  src/
    index.js              // bootstrap Fastify, плагіни, реєстрація роутів
    config.js             // env: PORT, DATABASE_URL, JWT_SECRET, FEE_*, RATE_SOURCE
    plugins/
      auth.js             // decorate: request.user, guard(capabilities[])
      errors.js           // єдиний формат помилок (§2.3)
    money/
      amount.js           // bigint-хелпери, парс/серіалізація, округлення
      ledger.js           // postTransaction() — ЄДИНА точка запису в реєстр
      balances.js         // читання балансів, доступне/заморожене
      fees.js             // розрахунок комісій за fee_policies
    fx/
      providers/
        hardcoded.js      // Ф2
        external.js       // Ф7, той самий інтерфейс
      service.js          // quote / execute
      job.js              // періодичне оновлення курсів
    domain/
      auth.js  transfers.js  businesses.js
      requests.js  loans.js  repayments.js
      scoring.js  stats.js
    routes/               // тонкі: валідація → domain → серіалізація
    validation/           // Zod-схеми, спільні за формою з клієнтськими
    jobs/
      accrual.js          // щоденне нарахування %
      snapshots.js        // balance_snapshots
      reconcile.js        // звірка реєстру
  db/
    schema/               // Drizzle
    migrations/
    seeds/
  test/
```

Правило шарів: **`routes/` не знає про Drizzle, `domain/` не знає про HTTP.**
Гроші рухаються тільки через `money/ledger.js` — це те, що можна перевірити
одним grep-ом.

---

## 2. Контракт API

Спільна основа для клієнта й сервера. Клієнт мокає саме це.

### 2.1 Загальні правила

- База: `/api`. Автентифікація: httpOnly-кука `sid` (JWT з refresh-ротацією).
- **Суми на дроті — рядки в мінорних одиницях.** Ніколи не `number` (JS втратить
  точність на великих сумах, а `bigint` не серіалізується в JSON).
  ```json
  { "amount": "100000", "currency": "UAH" }   // 1000.00 UAH
  ```
  Клієнт форматує сам, знаючи `exponent` з `GET /api/currencies`.
- Дати — ISO-8601 UTC (`2026-07-25T14:32:00Z`).
- Ставки — `rateAnnualBps` (ціле, базисні пункти). `1800` = 18% річних.
- Усі write-запити приймають заголовок `Idempotency-Key: <uuid>`.
- Списки — курсорна пагінація: `?limit=50&cursor=<opaque>` →
  `{ "items": [...], "nextCursor": "..." | null }`.

### 2.2 Ендпоінти

| Метод | Шлях | Доступ | Фаза |
|---|---|---|---|
| `POST` | `/auth/register` | публічний | S0 |
| `POST` | `/auth/login` | публічний | S0 |
| `POST` | `/auth/logout` | auth | S0 |
| `GET` | `/auth/me` | auth | S0 |
| `GET` | `/currencies` | публічний | S0 |
| `GET` | `/wallets` | auth | S0 |
| `GET` | `/transactions` | auth | S0 |
| `GET` | `/transactions/:id` | auth | S0 |
| `POST` | `/admin/topups` | admin | S0 |
| `GET` | `/users/search?q=` | auth | S1 |
| `POST` | `/transfers` | auth | S1 |
| `GET` | `/fees/preview` | auth | S1 |
| `GET` | `/fx/rates` | auth | S2 |
| `POST` | `/fx/quote` | auth | S2 |
| `POST` | `/fx/execute` | auth | S2 |
| `POST` | `/businesses` | `borrow` | S3 |
| `GET` | `/businesses/:id` | auth | S3 |
| `GET` | `/businesses/me` | `borrow` | S3 |
| `GET` | `/businesses/me/dashboard` | `borrow` | S3 |
| `GET/POST/PATCH/DELETE` | `/businesses/me/registers[/:id]` | `borrow` | S3 |
| `GET` | `/funding-requests` | auth | S4 |
| `POST` | `/funding-requests` | `borrow` | S4 |
| `GET` | `/funding-requests/:id` | auth | S4 |
| `POST` | `/funding-requests/:id/cancel` | `borrow` | S4 |
| `POST` | `/funding-requests/:id/fundings` | `invest` | S4 |
| `DELETE` | `/fundings/:id` | `invest` | S4 |
| `GET` | `/loans` | auth | S4 |
| `GET` | `/loans/:id` | auth | S4 |
| `POST` | `/loans/:id/repay` | `borrow` | S4 |
| `GET` | `/portfolio` | `invest` | S5 |
| `GET` | `/stats/balance-history` | auth | S5 |
| `GET` | `/stats/summary` | auth | S5 |

### 2.3 Ключові схеми

```jsonc
// POST /auth/register
{ "email": "a@b.com", "password": "...", "displayName": "Олекса",
  "capability": "invest" | "borrow" }

// GET /auth/me
{ "id": "usr_...", "email": "...", "displayName": "...",
  "capabilities": ["invest"], "rating": { "grade": "B", "score": 68 },
  "businessId": "biz_..." | null }

// GET /currencies
[{ "code": "UAH", "name": "Гривня", "exponent": 2, "isActive": true }]

// GET /wallets
[{ "currency": "USD", "available": "243900", "held": "50000", "total": "293900" }]

// GET /transactions
{ "items": [{
    "id": "txn_...", "type": "transfer_out" | "transfer_in" | "fx" | "fee"
          | "topup" | "funding_hold" | "funding_release" | "disbursement"
          | "repayment_in" | "repayment_out" | "interest_accrued",
    "currency": "UAH", "amount": "-100500",       // знак з погляду цього юзера
    "comment": "за оренду", "counterparty": { "id": "usr_...", "name": "Марія" },
    "relatedLoanId": null, "createdAt": "..." }],
  "nextCursor": null }

// POST /transfers   →  201 { "transactionId": "txn_..." }
{ "toUserId": "usr_...", "currency": "UAH",
  "amount": "100000", "comment": "за оренду" }

// GET /fees/preview?kind=transfer&currency=UAH&amount=100000
{ "amount": "100000", "fee": "500", "total": "100500", "payer": "sender" }

// GET /fx/rates
[{ "code": "USD", "bid": "40.000000", "sell": "41.000000",
   "observedAt": "...", "isStale": false }]

// POST /fx/quote  →  { "quoteId": "...", "amountFrom": "100000",
//                      "amountTo": "2439", "rate": "41.000000",
//                      "expiresAt": "..." }
{ "from": "UAH", "to": "USD", "amountFrom": "100000" }

// POST /funding-requests
{ "currency": "UAH", "amountTarget": "50000000", "rateAnnualBps": 1800,
  "termDays": 180, "repaymentType": "bullet" | "interest_only_flex",
  "minTicket": "10000", "minFillBps": 5000, "purpose": "...", "expiresAt": "..." }

// GET /funding-requests?currency=&minRate=&maxTermDays=&minGrade=&status=open
{ "items": [{
    "id": "req_...", "business": { "id": "biz_...", "name": "Кав'ярня",
      "rating": { "grade": "A", "score": 82 } },
    "currency": "UAH", "amountTarget": "50000000", "amountFunded": "31000000",
    "fundedBps": 6200, "rateAnnualBps": 1800, "termDays": 180,
    "repaymentType": "bullet", "status": "open", "expiresAt": "...",
    "investorCount": 4 }] }

// POST /funding-requests/:id/fundings  → 201 { "fundingId": "...", "held": "..." }
{ "amount": "10000000" }

// GET /loans/:id
{ "id": "loan_...", "status": "repaying", "currency": "UAH",
  "principal": "50000000", "outstandingPrincipal": "50000000",
  "accruedInterest": "1230000", "rateAnnualBps": 1800,
  "disbursedAt": "...", "maturesAt": "...",
  "myShareBps": 2000,                       // якщо запитує інвестор
  "schedule": [{ "id": "rep_...", "dueAt": "...", "principalDue": "0",
                 "interestDue": "750000", "status": "due" | "paid" | "overdue",
                 "paidAt": null }] }

// POST /loans/:id/repay
{ "amount": "750000" }    // interest-first, розкладається сервером
```

### 2.4 Формат помилок

```jsonc
// 400/401/403/404/409/422
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Недостатньо коштів",
             "fields": { "amount": "максимум 243.90 USD" } } }
```

Коди, які клієнт обробляє окремо: `INSUFFICIENT_FUNDS`, `QUOTE_EXPIRED`,
`REQUEST_NOT_OPEN`, `BELOW_MIN_TICKET`, `OVERFUNDED`, `IDEMPOTENCY_CONFLICT`,
`RATE_STALE`, `FORBIDDEN_CAPABILITY`.

---

## 3. Фази

Нумерація S* відповідає Ф* із `PLATFORM_PLAN.md` §10.

### S0 — Фундамент реєстру + auth ⛔ критичний шлях

Схема: `users`, `sessions`, `currencies`, `accounts`, `transactions`,
`ledger_entries`, `audit_log`.

- `money/amount.js` — `bigint` усюди, парс/формат, `floor`/`ceil` з явним
  напрямком округлення.
- **`money/ledger.js: postTransaction(entries[], meta)`** — серце системи:
  - одна SQL-транзакція, `SELECT ... FOR UPDATE` на задіяних рахунках;
  - перевірка Σ`amount` = 0 **окремо по кожній валюті**;
  - перевірка невід'ємності для рахунків типу `user_wallet`;
  - запис `idempotency_key` з унікальним індексом → повтор повертає той самий
    `transactionId`, а не помилку;
  - оновлення `account_balances` у тій самій транзакції.
- Констрейнт у БД як другий рубіж: `DEFERRABLE` тригер на баланс транзакції.
- Auth: argon2, httpOnly-кука, `capabilities` як `text[]`, guard-плагін.
- `POST /admin/topups` — проводка `external → user_wallet` (єдиний легальний
  спосіб з'яви грошей у системі).
- Сід: 3 юзери (інвестор, бізнес, адмін), валюти, курси.

**Тести (обов'язкові, це не «потім»):**
незбалансована транзакція відхиляється · баланс не йде в мінус ·
100 паралельних списань з одного гаманця не пробивають нуль ·
повтор з тим самим `Idempotency-Key` не дублює · Σ реєстру = 0 після сіду.

**Готово коли:** можна створити юзерів, нарахувати кошти адміном, і `GET /wallets`
рахує баланс із проводок.

### S1 — Перекази й комісії

`fee_policies` (датовані). `POST /transfers`: guard → перевірка балансу →
розрахунок комісії → **одна** `postTransaction` з 3 проводками.
`GET /fees/preview` — щоб клієнт показав суму до підтвердження.
`GET /transactions` з фільтрами (валюта, тип, період, пошук по коментарю) і
курсором. `GET /users/search` — тільки публічні поля.

**Готово коли:** переказ проходить, комісія на `platform_fee`, подвійний сабміт
не дублює, історія фільтрується.

### S2 — Валюти й конвертація

`rate_sources`, `exchange_rates`, `fx_quotes`. `HardcodedRateProvider`.
`fx/service.js`: `quote()` (TTL 60с, вибір сторони BID/SELL, `floor` на користь
платформи) і `execute()` (перевірка протухання + `consumed_by_tx`, 4 проводки).
Job оновлення курсів + валідація `sell > bid > 0` і стрибка > N%.

**Готово коли:** конвертація створює 4 збалансовані проводки за курсом із quote,
протухлий quote відхиляється з `QUOTE_EXPIRED`.

### S3 — Бізнес і каси

`businesses`, `registers`. Створення бізнес-профілю (тільки `borrow`).
Каси як `accounts.kind='business_register'`. Стартовий капітал — датована настройка.
`GET /businesses/me/dashboard` — перенесений `engine.js`: активи, зобов'язання,
чиста вартість, P&L, вартість капіталу (`PLATFORM_PLAN.md` §5 + Додаток А).

**Готово коли:** дашборд рахує P&L проти стартового капіталу з даних реєстру.

### S4 — Позики ⛔ найбільша фаза

`funding_requests`, `fundings`, `loans`, `loan_shares`, `repayments`,
`repayment_splits`.

- Машина станів заявки з явними переходами (одна функція, не `if` по роутах).
- Фінансування → холд `user_wallet → user_hold`.
- Збір 100% або дедлайн з `min_fill` → видача: холди всіх інвесторів →
  `business_wallet`, фіксація `share_bps` (Σ = 10000 рівно).
- `jobs/accrual.js` — щоденне нарахування %.
- Погашення: interest-first, **одна** транзакція з N+1 проводками,
  залишок від округлення — найбільшій частці детерміновано.
- `OVERDUE` виставляється, наслідків немає (D2).

**Тести:** Σ`share_bps` = 10000 при будь-якій кількості інвесторів ·
виплати N інвесторам + комісія = сплаченому бізнесом до копійки ·
скасована заявка повертає всі холди · перефінансування відхиляється.

**Готово коли:** повний цикл заявка → 2+ інвестори → видача → погашення → закриття.

### S5 — Рейтинг і статистика

`scoring.js` (ваги з §7), `balance_snapshots` + нічний job,
`GET /stats/balance-history`, `GET /portfolio` (XIRR, розподіл, дефолти).

### S6 — Зрілість

Прострочки з наслідками (знімає D2), 2FA, rate-limit, `jobs/reconcile.js`
з алертом, admin-панель, розширений аудит.

### S7 — Реальні курси

`external.js` за інтерфейсом із `PLATFORM_PLAN.md` §3.3. Вмикається змінною
`RATE_SOURCE` — **якщо довелося правити щось поза `fx/providers/`, абстракція
спроєктована неправильно.**

---

## 4. Порядок і залежності

```
S0 ─┬─► S1 ─┬─► S4 ─► S5 ─► S6
    ├─► S2 ─┘
    └─► S3 ─┘
S7 — будь-коли після S2
```

S0 блокує все. S1/S2/S3 після нього незалежні між собою.
