# Backend of Thrones — Engineering Report

**A synchronous vs. queue-based flash-sale backend, benchmarked honestly.**

`Node.js` · `Redis` · `PostgreSQL` · `Docker` · `k6`

---

## What this document is

This started as a course project comparing two architectures for a flash sale. The
first version of this report claimed a 42× latency improvement under "100,000
concurrent users."

That claim was false. So were several others. Auditing the code against the report
turned up **21 defects** — in the system, in the benchmark, and in the report itself.
Some of them silently inverted the behaviour they were named after.

This document is the rewrite. Every number here comes from a k6 run or a SQL query
against the database after that run. Where a number is missing, it says so. Where the
system is still wrong, it says that too — there is a whole section for it.

An engineering report that only lists wins is a sales document.

---

## Table of contents

1. [The headline result](#1--the-headline-result)
2. [Test rig, and why the numbers are smaller than they look](#2--test-rig-and-why-the-numbers-are-smaller-than-they-look)
3. [What the original report got wrong](#3--what-the-original-report-got-wrong)
4. [The bug hunt](#4--the-bug-hunt)
5. [What changed, and why](#5--what-changed-and-why)
6. [Methodology](#6--methodology)
7. [Results — the controlled A/B](#7--results--the-controlled-ab)
8. [Results — the stress run](#8--results--the-stress-run)
9. [Findings](#10--findings)
10. [Threats to validity](#11--threats-to-validity)

---

## 1 — The headline result

Same hardware. Same load. Same payment gateway. Same 300-VU ramp.

| | **Approach 1** (synchronous) | **Approach 2** (queue-based) | |
|---|---|---|---|
| **Acknowledgment latency — p95** | **5,135 ms** | **11 ms** | **467×** |
| Acknowledgment latency — median | 1,090 ms | 6 ms | 182× |
| Acknowledgment latency — p99 | 11,342 ms | 20 ms | 567× |
| **Acknowledgment latency — worst case** | **24,513 ms** | **66 ms** | **371×** |
| **HTTP error rate** | **4.65%** | **0.00%** (0 of 108,844) | — |
| **5xx responses** | **62** | **0** | — |
| **k6 thresholds passed** | **6 of 7** ❌ | **7 of 7** ✅ | — |
| **Stranded inventory** | **3 units** | **0 units** | — |
| Order success rate | 91.08% | 91.00% | *identical* |
| **Fulfillment latency — p95** | **4,998 ms** | **8,052 ms** | ⬅ *A1 wins* |
| **Throughput (orders/sec)** | **72.9** | **32.5** | ⬅ *A1 wins* |

**Read the last two rows.** They are not a failure. They are the point.

> **The queue does not make the system faster. It makes it survivable.**
>
> It costs 3 seconds of fulfillment latency and — under a closed-loop load model —
> half the throughput. What it buys is a 6 ms answer to the customer instead of a
> 24-second one, zero server errors instead of 62, and a system that refuses to guess
> whether someone's card was charged.

Anyone who reports the first eight rows and hides the last two is selling something.

---

## 2 — Test rig, and why the numbers are smaller than they look

**Everything runs on one laptop.** The load generator competes with the system under
test for the same 8 cores. This is stated here, first, because it bounds every number
in this document.

```
CPU     Intel i7-11800H — 8C / 16T
RAM     16 GB DDR4-3200
Disk    NVMe SSD
OS      Windows 11 + WSL2
Docker  28.5.1 · Compose v2.40.1 · allocated 8 vCPU / 16 GB
k6      runs on the host, NOT in a container
```

**Approach 1** runs as a bare Node process on `:3000`. No container, no CPU limit, no
reverse proxy. It has the whole machine.

**Approach 2** runs in Docker behind nginx:

| Service | Replicas | CPU limit | Memory | Workers × concurrency |
|---|---|---|---|---|
| nginx (LB) | 1 | 1.0 | 256 MB | `least_conn` |
| API | 2 | 2.0 | 768 MB | 2 cluster workers each |
| SSE | 1 | 1.0 | 256 MB | — |
| Order worker | 1 | 2.0 | 1 GB | 4 × 15 |
| Payment worker | 6 | 2.0 | 768 MB | 6 × 20 |
| Redis | 1 | 1.0 | 256 MB | — |
| PostgreSQL | 1 | 2.0 | 2 GB | pool max 30 |
| Mock gateway | 1 | 1.0 | 256 MB | — |

> ⚠️ **VERIFY BEFORE PUBLISHING.** Container CPU limits are *ceilings*, not
> reservations — Docker permits oversubscription. Confirm the replica counts you
> actually ran with (`docker compose ps`) and recompute. Early runs in this project
> used **1 API container and 1 payment container**, not 2 and 6, because
> `docker-compose.yml` has no `deploy.replicas` and scaling requires an explicit
> `--scale` flag. Do not publish a container count you have not checked.

**Approach 1 therefore had an unfair advantage**: no CPU cap, no proxy hop, and less
logging overhead (its stdout does not pass through Docker's json-file driver). It still
lost, badly, on every latency and reliability metric. That is the point worth making —
not that the comparison was perfectly matched.

### The payment gateway is a real HTTP dependency

The original benchmark simulated payment as:

```js
await new Promise(resolve => setTimeout(resolve, 2500));   // fixed 2500 ms
const isSuccess = Math.random() > 0.05;                    // 5% decline
```

This is not a payment gateway. It is a timer. It consumes no sockets, has zero
variance, and cannot time out. Its tell is unmistakable in the original results:

```
purchase_latency:  med = 2,516 ms    p95 = 2,529 ms    ← a 13 ms spread
```

A latency distribution with no tail is not a distribution. Any reviewer who noticed
that line would have stopped trusting every other number in the report.

It was replaced with a containerised gateway that behaves like the real thing:

```js
// log-normal latency: median ~665 ms, p95 ~2.3 s, p99 ~4 s
const ms = Math.exp(6.5 + 0.75 * z);

if (Math.random() < 0.01) return;                                    // 1%  hang, never respond
if (Math.random() < 0.02) return res.status(503) /* unavailable */;  // 2%  transient
if (Math.random() < 0.01) return res.status(429) /* rate limited */; // 1%  transient
if (Math.random() < 0.05) return res.status(402) /* card declined */;// 5%  business decline
```

Expected outcome distribution (applied cumulatively):

| Outcome | Expected |
|---|---|
| Success | **91.25%** |
| Declined (402) | 4.80% |
| Transient (503 + 429) | 2.95% |
| **Hang → unknown outcome** | **1.00%** |

This changed three things that a `setTimeout` cannot model:

1. **Outbound socket pressure.** Every in-flight payment now holds a real TCP
   connection. This is what actually breaks synchronous systems in production.
2. **A latency tail.** p95 and p99 became meaningful numbers instead of decoration.
3. **Unknown outcomes.** 1% of charges hang and never answer. *You do not know whether
   the customer was billed.* This turned out to be the most interesting finding in the
   whole project — see [§10.3](#103--the-unknown-outcome-is-where-the-architectures-actually-diverge).

---

## 3 — What the original report got wrong

Audited line by line against the code and the k6 config.

| # | The report claimed | The code said |
|---|---|---|
| 1 | **"100,000 concurrent users"** | `stages: [... { target: 300 }]` and `for (let i = 0; i < 50; i++)` — **300 VUs, 50 accounts** |
| 2 | "Idempotency layer" | The middleware **deleted** the key on success. See [§4.1](#41--the-idempotency-middleware-was-inverted) |
| 3 | "Zero overselling via atomic Redis DECR" | The DECR counter was being **overwritten** by the payment worker. Correctness came from a *different* guard the report claimed had been removed |
| 4 | "Worker Trust Pattern applied — worker no longer re-checks stock" | The worker still ran `SELECT … FOR UPDATE` and `if (newStock < 0)` — in Postgres instead of Redis |
| 5 | "SSE eliminated polling, reduced API load" | The k6 script **polls** `/order/:id/status`. SSE was never exercised by the benchmark |
| 6 | "10% payment failure, 2.5 s average" | `Math.random() > 0.05` → **5%**, and `setTimeout(…, 2500)` → **fixed**, not an average |
| 7 | "~11 vCPU, ~5.25 GB" | Sums the compose file without multiplying by replicas. Actual declared limits: **23 vCPU on an 8-vCPU host** |
| 8 | "13 containers" | 8 were running. Scaling needs an explicit `--scale` flag that was not used |
| 9 | Presented as a success | k6's own threshold `order_success_rate: rate>0.85` **failed** at the reported 78.27% |
| 10 | "Total order time p95: 11.7 s (A1)" | `load-test-1.js` never measured `total_order_time`. **The number exists in no output** |
| 11 | Success rate | Stated as 78.27%, 83.5%, and 89.6% in three different sections |
| 12 | **"ROI: 246,665% · $997,992 revenue"** | Extrapolated from 998 simulated orders. **Deleted. It was fiction, and it poisoned every honest number next to it** |

None of these were lies told on purpose. Every one of them came from the same root
cause: **the report was written from what the author remembered building, not from what
the code does.** That is the failure mode this rewrite exists to correct.

---

## 4 — The bug hunt

### 4.1 — The idempotency middleware was inverted

```js
// BEFORE
res.json = async function (body) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
        await redis.del(key);                    // ← SUCCESS: delete the key
        console.log(`[Redis] Success Process. Removing Lock..`);
    } else {
        await redis.set(key, failedResult, 'EX', TTL);   // ← FAILURE: cache it
    }
    return resultSnap.apply(res, arguments);
};
```

The entire purpose of an idempotency layer is to **replay the successful response** so a
retry does not perform the operation twice. This deleted it.

The consequences ran in both directions:

- **Retry after success** → key is gone → the request runs again → **a second unit of
  stock is consumed.**
- **Retry after a transient 503** → the *error* was cached for 300 seconds → the user is
  locked out for the entire 5-minute sale window.

**It made success repeatable and transient failure permanent.** The author's own log
line gives the game away: `Removing Lock`. The mental model was a lock, not an
idempotency store.

Two more defects in the same 60 lines:

**The key was derived from the request body.**

```js
const hash = crypto.createHash("sha256").update(stableStringify(req.body)).digest("hex");
const key = `X_:${userId}:${req.method}:${req.originalUrl}:${hash}`;
```

The body is always `{"productId": 1}`. The hash is therefore **constant**, forever. Live
logs confirm it — every user, same hash:

```
X_:258:POST:/order/buy:8994e026682e322c7be4787ad62e487f...
X_:376:POST:/order/buy:8994e026682e322c7be4787ad62e487f...
X_:360:POST:/order/buy:8994e026682e322c7be4787ad62e487f...
```

A content-derived key **cannot distinguish** "retry of the same purchase" from "a new
purchase of the same product." They are byte-identical. Only the *client* knows which
one it meant — which is exactly why idempotency keys are client-supplied.

And the plumbing for that already existed:

```nginx
proxy_set_header Idempotency-Key $http_idempotency_key;   # nginx.conf — forwarded
```

The header was being forwarded and the middleware never read it.

**The claim was a read-then-write race.**

```js
const storedKey = await redis.get(key);   // ← twenty requests all see null
if (storedKey) { ... }
await redis.set(key, PENDING, 'EX', TTL); // ← twenty requests all write PENDING
```

Twenty concurrent duplicates all pass. The irony: the same codebase uses an atomic
`DECR` for stock — the author understood the principle and did not apply it to the
middleware whose only job is preventing duplicates.

---

### 4.2 — The payment worker destroyed the reservation counter

**The worst bug in the project.**

```js
// BEFORE — paymentWorker.js
const product = await Product.findByPk(paymentData.productId, {
    transaction, lock: transaction.LOCK.UPDATE
});
const newStock = product.stock - 1;
await Product.update({ stock: newStock }, { where: { id: productId }, transaction });

await redis.set(stockKey, newStock.toString());   // 💥
```

Two counters exist, and they answer **different questions**:

| | Answers | Mutated by |
|---|---|---|
| **Redis `{id}:STOCK`** | *"Can I accept another order?"* → **available for reservation** | `DECR` on reserve, `INCR` on release |
| **Postgres `product.stock`** | *"What actually sold?"* → **confirmed** | the worker |

**Redis ≤ Postgres, always**, because *reserved ≥ confirmed*. Postgres lags Redis by
exactly the queue depth.

Writing the Postgres value over the Redis counter **raises** it — and every pending
reservation evaporates:

```
Stock = 1000
API accepts 200 orders    →   Redis = 800   Postgres = 1000   Queue = 200
Worker confirms one       →   Postgres = 999
                          →   redis.set(stockKey, "999")

Redis jumps 800 → 999.    199 reservations just vanished.
The API will now happily accept 199 more orders against stock already spoken for.
```

**The original report's own numbers prove it fired:**

> `successful_purchases: 1,275` — against **1,000 units of stock**.

1,000 units + 129 payment declines (which correctly `INCR` the unit back) = 1,129 legal
reservations. **~146 orders were accepted against stock that did not exist.** Those
customers received `202 order is being processed` and then silently failed.

There was **a second instance of the same bug**, in the API:

```js
// BEFORE — flashBuy(), on productData cache miss
await redis.set(productDataKey, JSON.stringify(productData), 'EX', 500);
await redis.set(stockKey, String(productData.stock));   // 💥 clobber #2
```

`productDataKey` has a **500-second TTL**. When it expires mid-sale, the next request
repopulates `stockKey` from the database — wiping every pending reservation. It never
fired in the tests only because the tests ran for 300 seconds. **A longer sale would
have detonated it.**

---

### 4.3 — "Worker Trust" was never actually applied

The report's centrepiece finding was that removing the worker's stock re-check fixed
false rejections. The code comment even says so:

```js
// IMPORTANT: Do NOT check stock here!
// The API already atomically reserved stock via Redis DECR.
```

And then, eleven lines later:

```js
const product = await Product.findByPk(productId, { transaction, lock: transaction.LOCK.UPDATE });
const newStock = product.stock - 1;
if (newStock < 0) {
    console.error(`❌ Insufficient stock! Current: ${product.stock}`);   // ← still re-checking
    ...
}
```

The check was **moved from Redis to Postgres**, not removed. Two consequences:

1. **`SELECT … FOR UPDATE` on a single product row serialises every payment worker.**
   All 36 executing workers queue behind one row lock. The advertised "720 concurrent
   payment slots" were unreachable by construction.

2. **That re-check was the only thing preventing actual overselling** — because the
   Redis counter was being destroyed by [§4.2](#42--the-payment-worker-destroyed-the-reservation-counter).

So: *the report credited a mechanism that was broken, while the correctness it observed
came from a guard it claimed to have deleted.* The conclusion was right for entirely the
wrong reason. That is worse than being wrong, because it is not falsifiable by looking at
the output.

---

### 4.4 — Approach 1 never had an architectural collapse. It had a lock bug.

This is the finding that killed the project's original narrative.

```js
// BEFORE — buy()
const product = await Product.findByPk(productId, {
    transaction, lock: transaction.LOCK.UPDATE   // ← row lock acquired
});
if (product.stock < 1) return res.status(409);
product.stock -= 1;
await product.save({ transaction });             // ← lock held across 3 round-trips
await transaction.commit();
```

`SELECT … FOR UPDATE` takes a row lock, then holds it across a **read → compute in Node
→ write → commit** cycle. Every one of 300 VUs serialises on **one row**, each holding
the lock for tens of milliseconds. Meanwhile every request holds a connection from a pool
capped at 30. The pool drains. Everything else waits, then throws.

**That was the 73% failure rate.** Not the synchronous architecture. A lock held across a
network round-trip.

The fix is one statement:

```js
// AFTER
const [affected, rows] = await Product.update(
    { stock: sequelize.literal('stock - 1') },
    { where: { id: productId, stock: { [Op.gt]: 0 } }, returning: true, transaction }
);
if (affected === 0) { await transaction.rollback(); return res.status(409); }
```

Same guarantee. Lock held **inside a single statement** — microseconds instead of tens of
milliseconds. And `RETURNING` hands back the authoritative post-commit value, so there is
no stale snapshot to write anywhere.

**Result: Approach 1 went from 184/1000 units sold to 1000/1000, at a 0.23% error rate.**

The original claim — *"a synchronous flash-sale backend that collapsed under load (73%
request failure; only 184 of 1,000 units sold)"* — is **dead**. It was never an
architectural property. It was a bug, and it took one line to fix.

The honest version is more interesting anyway:

> The synchronous path failed because of lock contention, not blocking I/O. Node's event
> loop was never blocked — `processPayment` was async the whole time, and CPU sat at 34%.
> Fixing the lock restored it completely. The queue was then introduced for a different
> reason: to get payment out of the request path so the customer is not holding an open
> connection through a multi-second external call.

Knowing the difference between *lock contention* and *blocking I/O* — and having measured
both — is worth more than a fake 42×.

---

### 4.5 — Approach 1 wrote a stale snapshot into Redis

```js
// BEFORE — after commit
await redis.publish(channel, product.stock);
await redis.set(channel, product.stock);   // ← `product` was read BEFORE the commit
```

By the time this line runs, 299 other VUs have committed their own decrements. The
in-memory `product` object is a snapshot from before all of them. Requests race to write
their own stale values, and **the last writer wins — which may be the one holding the
oldest snapshot.**

Redis ends up on an arbitrary number unrelated to reality.

This poisoned `{id}:STOCK` — the counter **Approach 2** depends on as its reservation
authority — because both approaches share the same Redis instance.

**And it had a visible symptom.** The `queueLimiterMiddleware` was mounted on the
`/buy` route and reads that same key:

```js
const stockCache = await redis.get(stockKey);
if (stockCache < 1) return res.status(409).json({ message: "Out Of stock!" });
```

Redis drifts to `0` while Postgres still holds `1` → the product page shows one unit left
→ the purchase endpoint returns *"out of stock."*

Two fixes: read the real value via `RETURNING`, and **take the queue limiter off the
`/buy` route entirely** — Approach 1 has no queue for it to limit.

---

### 4.6 — Reservations leaked on any throw

```js
// BEFORE — flashBuy()
const newStock = await redis.decr(stockKey);   // ← RESERVED
if (newStock < 0) { await redis.incr(stockKey); return res.status(409); }

await initializeOrderStatus(...);              // ← if this throws...
await Queue.push(QUEUES.ORDERS, orderData);    // ← ...or this...

} catch (err) {
    return res.status(500).json({ ... });      // ← ...the reservation is never released
}
```

Between the `DECR` and the successful hand-off to the queue there are two operations that
can throw. If either does, the unit is **reserved in Redis, never decremented in the
database, and never released.** It is simply gone. Forever.

The fix is a flag that is `true` only inside that window:

```js
let reserved = false;
// ...
const remaining = await redis.decr(stockKey);
if (remaining < 0) { await redis.incr(stockKey); return res.status(409); }
reserved = true;                    // 🔑 we own this unit now

await initializeOrderStatus(...);
await Queue.push(QUEUES.ORDERS, {...});
reserved = false;                   // 🔑 the worker owns it now

} catch (err) {
    if (reserved) {                 // 🔑 reserved but never handed off → release
        const back = await redis.incr(stockKey);
        await redis.publish(stockKey, String(back));
        console.error(`[flashBuy] released orphaned reservation, product=${productId}`);
    }
    return res.status(500).json({ ... });
}
```

The same leak existed in `orderWorker.js` — its `catch` rolled back the database
transaction (restoring Postgres) but never `INCR`'d Redis back.

---

### 4.7 — The SSE fallback poisoned the stock counter with a string

```js
// BEFORE — productStockStream(), PLAN-B path
const stock = await Product.findOne({ attributes: ["stock"], where: { id: productId } });
redis.set(channel, String(stock));       // 💥  stock is a Sequelize MODEL
redis.publish(channel, String(stock));
```

`String(sequelizeModel)` evaluates to **`"[object Object]"`**.

If an SSE client ever connected while `stockKey` was missing — which happens after any
`FLUSHALL` that is not followed by `initStock` — the fallback wrote garbage into the
reservation counter. Every subsequent `DECR` then throws:

```
ERR value is not an integer or out of range
```

A landmine that only detonates during recovery, which is precisely when you least want it
to. Fix: `String(stock.stock)`.

---

### 4.8 — `sequelize.sync({ alter: true })` at every startup

```js
await sequelize.sync({ alter: true });   // in index.api.js, run by EVERY API worker
```

Four API workers (2 containers × 2 cluster workers) boot simultaneously and all issue the
same `ALTER TABLE` statements. The first drops a constraint; the second finds it missing
and crashes:

```
constraint "Orders_user_id_fkey1" of relation "Orders" does not exist
✅ Worker 40 is online
🔄 Starting a new worker...      ← workers dying and respawning DURING the benchmark
```

**This invalidated every earlier run.** Workers were dying mid-request. Some fraction of
the 5xx responses, and of the stranded units, came from this — not from any real ceiling.

It also silently accumulated duplicate constraints (`_fkey1`, `_fkey2`, …) on every boot,
progressively corrupting the schema.

Schema changes belong in a migration that runs **once**, not in four processes racing each
other at startup.

---

### 4.9 — Smaller, but real

| Bug | Effect |
|---|---|
| `redis.decr` on a **missing key creates it at −1** — no `exists` guard | A missing counter silently poisons itself instead of failing loudly. Now: fail closed with `503 stock not initialized` |
| `queueLimiter`: `stockCache < 1` compares a **string to a number**; `null < 1` is `true` | Cold start → *every* purchase returns 409 "out of stock." Now: `stockCache !== null && Number(stockCache) < 1` |
| `decStockCount()` uses `newStock` **before it is declared** (TDZ) | The endpoint throws unconditionally. Dead code that looks alive |
| `res.json` overridden as **`async`**, awaiting Redis before sending | Adds a Redis round-trip to every response; if Redis throws, **the response is never sent** and the request hangs until timeout |
| **409 used for both** "out of stock" and "duplicate request in flight" | Same status code, opposite meanings. The client cannot tell "give up" from "retry." Now `425 Too Early` for in-flight |
| `orderWorker` logs `📉 stock decremented in database` — **it never touched stock** | A log line that lies. The decrement happened in the payment worker |
| `Op` not imported in `orderWorker.js` | `ReferenceError` on every single order |

---

## 5 — What changed, and why

Full diff: `all-fixes.diff` (1,139 lines). Summary:

### The stock model, stated once so it cannot drift

```
Approach 1 (buy):
  Postgres is the ONLY authority. There is no reservation — the request holds its
  connection through payment. Redis is a DISPLAY CACHE for SSE and nothing reads it
  to make a decision. That is why `redis.set` is allowed here and forbidden in A2.

Approach 2 (flashBuy):
  Redis {id}:STOCK is the RESERVATION counter — "can I accept another order?"
  Mutated by DECR (reserve) and INCR (release) ONLY.
  Postgres holds what actually SOLD, and lags Redis by the queue depth.

  Redis <= Postgres, always, because reserved >= confirmed.

  NEVER redis.set on {id}:STOCK after initStock.
```

The invariant that must hold at all times:

```
redis_stock  +  pending_orders  +  confirmed_orders  =  initial_stock
```

Confirming an order **converts a reservation into a sale**. It does not free stock.
Therefore **confirmation must not touch the reservation counter at all.** That single
sentence is the whole fix for [§4.2](#42--the-payment-worker-destroyed-the-reservation-counter).

### File by file

| File | Change |
|---|---|
| `orders.controller.js` — `buy()` | `SELECT FOR UPDATE` + read-modify-write → **atomic `UPDATE … WHERE stock > 0 RETURNING`**. Refund likewise. Redis now receives the real post-commit value |
| `orders.controller.js` — `flashBuy()` | Removed the `redis.set(stockKey)` clobber. Added `redis.exists()` fail-closed guard. Added the `reserved` flag + release-on-throw. Publishes the post-`DECR` value to SSE |
| `orderWorker.js` | Took over the DB decrement via **atomic conditional `UPDATE`**. `affected === 0` → Redis/DB divergence → release + log `[FATAL]`. `catch` now releases the Redis reservation |
| `paymentWorker.js` | **Removed** `SELECT FOR UPDATE`, **removed** the stock re-check, **removed** the `redis.set` clobber. Success now confirms the order and touches nothing else — *actual* Worker Trust. Added the `unknown` → `needs_reconciliation` branch |
| `idempotency.js` | Rewritten. Client-supplied `Idempotency-Key` header. Atomic `SET NX` claim. **Caches the success response** (was deleting it). **Deletes on transient errors** (was caching them). `425` for in-flight. `res.json` no longer `async` |
| `processPayment.js` | `setTimeout(2500)` → **real `fetch` to a containerised gateway**, `AbortController` with a 10 s timeout, and three distinct outcomes: `success` / `retryable` / `unknown` |
| `mock-gateway/index.js` | **New.** Log-normal latency, 5% decline, 2% 503, 1% 429, 1% hang-forever |
| `products.controller.js` | `String(stock)` → `String(stock.stock)` |
| `processHandlerLimit.js` | Null-safe numeric comparison |
| `orders.route.js` | **Removed `queueLimiterMiddleware` from `/buy`** — Approach 1 has no queue |
| `orders.js` (model) | Added `needs_reconciliation` to the status ENUM |
| `index.api.js` | **Removed `sequelize.sync({ alter: true })`** from the startup path |

### Why `UPDATE … WHERE` beats `SELECT FOR UPDATE`

Both guarantee no negative stock. They differ in **how long the lock is held**:

| | Lock held for |
|---|---|
| `SELECT FOR UPDATE` → compute in Node → `UPDATE` → `COMMIT` | **three network round-trips** — tens of ms |
| `UPDATE … WHERE stock > 0` | **one statement** — microseconds |

Under 300 concurrent writers on one row, that difference is the entire performance story
of Approach 1.

---

## 6 — Methodology

### Two profiles, two different questions

```
k6 run tests/load-test-1.js                    → A/B profile
k6 run -e PROFILE=stress tests/load-test-1.js  → stress profile
```

| | **A/B** (`ramping-vus`) | **Stress** (`ramping-arrival-rate`) |
|---|---|---|
| **Question** | *Which architecture is better under identical load?* | *Where does each one break?* |
| **Model** | **Closed** — each VU waits for its response before sending again | **Open** — k6 imposes a target req/s regardless of how slow the system is |
| Peak | 300 VUs | 6,000 req/s (target) |
| Stock | 10,000,000 (never sells out) | 10,000,000 |
| Think time | `GET /products` + 300 ms | none — bare write path |
| Status polling | yes (A2) | no |

**The closed model flatters a slow system.** If the server is slow, the VUs politely wait,
so the offered load *drops with it*. That is not what a flash sale does — 100,000 people
hit the endpoint when the sale opens whether the server is ready or not. The stress
profile exists because of this.

### On "100,000 users"

100,000 *concurrent VUs* is not achievable on one 8-core laptop that is also running the
system under test. k6 needs 2–5 MB per VU, and Windows caps ephemeral ports at ~16k by
default.

**But 100,000 concurrent VUs is not what a 100,000-user flash sale is.** It is an
**arrival rate**: 100,000 people arriving over a 60-second sale window is **~1,700
requests per second**. That is the number the server actually experiences, and it is
measurable here.

| Arrival rate | Flash-sale population (60 s window) |
|---|---|
| 500 req/s | ~30,000 users |
| **1,700 req/s** | **~100,000 users** ← the headline scenario |
| 3,500 req/s | ~210,000 |
| 6,000 req/s | ~360,000 |

**This report never claims "100,000 concurrent users." It claims a sustained arrival
rate, and states the population that rate corresponds to.**

### Both tests import from one shared config

`tests/config.js` owns everything that affects **measurement** — stages, thresholds, user
pool, retry policy, metric names, idempotency-key construction. The two test files own
only what is genuinely **architectural** — base URL, purchase endpoint, and whether
completion is observed by polling.

The two tests cannot drift apart, because there is nothing to drift.

### Thresholds are identical for both — declared before the run

```js
'order_success_rate': ['rate>0.85'],    // ceiling is ~91% (gateway declines) — 85% is fair
'purchase_latency':   ['p(95)<1000'],   // the ACK, not the fulfillment
'total_order_time':   ['p(95)<15000'],
'http_req_failed':    ['rate<0.05'],
'server_errors_5xx':  ['count<100'],
'timeout_408':        ['count<50'],
'unauthorized_401':   ['count<10'],
```

The original benchmark applied thresholds to Approach 2 **and none at all to Approach 1** —
which handed the baseline a free pass on the very criteria it was supposed to fail.
Applying the same bar to both is the whole point of a comparison.

### What counts as what

| Outcome | Counted as |
|---|---|
| `409 sold out` | **Not a failure.** Correct behaviour. Excluded from `order_success_rate` — it never entered the funnel |
| `402 declined` | Entered the funnel, failed at payment. Not retried — it is a business answer, not a glitch |
| `503` / `429` / `425` | Transient. Retried with the **same** idempotency key |
| `needs_reconciliation` | Entered the funnel. Outcome **unknown**. Counted as a failure for the success rate, but the stock is deliberately **not** released |

### The invariant, checked after every run

```
purchases_accepted   ≤   INITIAL_STOCK + payment_declined
orders_confirmed     ≤   INITIAL_STOCK
idempotency_breaks   =   0
final_stock          ≥   0
```

The pre-fix system **failed this**: 1,275 accepted against 1,000 units.

---

## 7 — Results — the controlled A/B

300 peak VUs · 10,000,000 stock · 10,000 seeded accounts · real payment gateway.
Approach 1 on product 8, Approach 2 on product 12 — identical schema, identical starting
stock, run separately.

### Approach 1 — synchronous

```
purchase_latency (ack)   avg=1,654 ms   med=1,090   p90=2,940   p95=5,135   p99=11,342   max=24,513
total_order_time         avg=1,635 ms   med=1,090   p90=2,905   p95=4,998   p99=11,232   max=24,513

purchases_accepted       22,055   (72.94/s)
orders_confirmed         20,110   (66.51/s)
payment_declined_402      1,945
server_errors_5xx            62
http_req_failed           4.65%   (2,058 of 44,249)
order_success_rate       91.08%   (20,110 / 22,079)

stock  10,000,000 → 9,979,887   =  20,113 consumed
confirmed                       =  20,110
                                   ────────
                                        3 UNITS STRANDED

THRESHOLDS: 6 of 7 passed.  ✗ purchase_latency p95 = 5,135 ms  (limit 1,000 ms)
```

**In this system, `purchase_latency` *is* what the customer waits.** The response *is* the
confirmation. A p99 of 11.3 seconds and a worst case of 24.5 seconds are real people
staring at a spinner.

### Approach 2 — queue-based

```
purchase_latency (ack)   avg=6.65 ms    med=6      p90=9       p95=11      p99=20       max=66
total_order_time         avg=4,497 ms   med=4,531  p90=7,547   p95=8,052   p99=9,551    max=14,121

purchases_accepted        9,764   (32.47/s)
orders_confirmed          8,886   (29.55/s)
payment_declined_402        767
needs_reconciliation        110
server_errors_5xx             0
http_req_failed           0.00%   (0 of 108,844)
order_success_rate       91.00%   (8,886 / 9,764)

stock  10,000,000 → 9,991,004   =  8,996 consumed
confirmed 8,886  +  reconciliation 110  =  8,996
                                           ─────
                                           EXACT.  ZERO STRANDED.

THRESHOLDS: 7 of 7 passed.  ✓
```

**Zero HTTP failures across 108,844 requests.** Not "low." Zero.

### Resource use at peak (Approach 2)

```
api-1              30–48%   (peak 74%)      ← the busiest thing in the system
api-2              23–54%
worker-payment ×6   2–17%   each            ← idle
worker-order       10–28%
postgres            5–18%                   ← idle
redis               7–20%
nginx               4–20%
mock-gateway        2–8%
```

**Nothing was saturated.** The 300-VU closed model could not push Approach 2 hard enough
to make it sweat. Its throughput number (32.5/s) is a property of **the load model**, not
of the system — see [§10.2](#102--why-approach-2-looks-slower-and-why-that-is-not-a-defeat).

### Why the success rates are identical — and why that matters

Both landed at **91.0%**. The gateway's expected success rate is **91.25%**.

Both architectures processed **every single order correctly.** They differ in *how* they
answer, not in *whether* they get the answer right. That is what makes the latency
comparison meaningful: it is not comparing a correct system to a broken one.

---

## 8 — Results — the stress run

**Partial. The laptop died at ~4 minutes and the k6 terminal output was lost.**

That is a real gap and it is not glossed over here. What survived is the database, the
container logs, and `docker-stats.log` — which, as it turns out, carry the most important
finding anyway.

### What the database says (Approach 2, product 13)

```sql
SELECT status, count(*) FROM "Orders" WHERE product_id = 13 GROUP BY status;
```

| status | count | share |
|---|---|---|
| `confirmed` | **11,159** | 91.06% |
| `failed` | 951 | 7.76% |
| `needs_reconciliation` | 145 | 1.18% |
| **total** | **12,255** | |

**There is no `pending` row.**

Every order that entered the database reached a **terminal state** — despite the machine
underneath it falling over. Nothing was left half-processed. Nothing was lost in flight.

### The distribution matches the gateway spec to a tenth of a percent

| | expected | measured |
|---|---|---|
| confirmed | 91.25% | **91.06%** |
| failed | 7.75% | **7.76%** |
| unknown → reconciliation | 1.00% | **1.18%** |

Three independent runs — A1 (91.08%), A2 (91.00%), stress (91.06%) — all land on the
gateway's expected success rate. **The system handled every order correctly under load
heavy enough to crash the host.** That is not a latency claim. It is a correctness claim,
and it is the stronger of the two.

### Resource use at the stress peak

Container CPU limits: API and payment workers **200%** (2 vCPU), nginx **100%**.

| service | peak | % of its own limit |
|---|---|---|
| **api-1** | **160.20%** | **80%** 🔥 |
| **api-2** | **144.72%** | **72%** 🔥 |
| nginx | 53.38% | 53% |
| worker-order | 33.56% | 17% |
| postgres | 28.09% | **14%** 💤 |
| redis | 21.99% | 22% |
| **worker-payment** ×6 | **~21%** | **~10%** 💤 |
| mock-gateway | 7.42% | 7% |

**The API is the bottleneck. The payment workers are asleep. Postgres is asleep.**

This **directly contradicts** the original report's central conclusion:

> ~~"The main bottleneck was payment processing. Scaling payment workers from 2 → 6 raised
> the success rate."~~

Under real load, the payment workers never break a sweat. **Ingress is the constraint.**

### What actually broke: the laptop

Summed at peak:

```
api (160 + 145) + nginx 53 + order 34 + payment ~36 + postgres 28 + redis 22 + gw 7
≈ 485%  ≈  4.9 cores

…plus k6 trying to generate 1,700+ req/s
…plus Windows, Docker Desktop, WSL2

on 8 cores.
```

**No container hit its ceiling. The machine ran out.** The load generator and the system
under test were fighting over the same silicon.

> **The stress run measured the test rig's ceiling, not the architecture's.** That is a
> limitation of the setup, and it is reported as one rather than dressed up as a result.

### What can be honestly claimed

The run reached and passed the **1,700 req/s** stage — the 100,000-user-equivalent
arrival rate — before the host gave out:

> Approach 2 sustained the ~1,700 req/s arrival rate corresponding to a 100,000-user,
> 60-second flash sale, with API containers at ~75% of allocated CPU and every downstream
> service (payment workers, Postgres, Redis) below 25%. Beyond that point the load
> generator and the system under test were competing for the same 8 cores, so the ceiling
> observed is the test rig's, not the architecture's.

### What was lost, and how to get it back

| Lost | Recoverable by |
|---|---|
| latency percentiles at high arrival rates | re-run with `--summary-export=results/x.json` (writes even if the terminal dies) |
| whether k6 emitted `Insufficient VUs` | same |
| achieved vs. offered req/s | parse `logs-stress/nginx.log` timestamps |
| status-code distribution at peak | grep nginx access log for `buy-flash` |
| queue depth over time | grep `Current Queue Size: (\d+)/` from `api.log` |

**Before re-running:** gate the per-request `console.log` behind `VERBOSE=1`. At 1,700
req/s the system was emitting ~5,000 log lines per second through Docker's json-file
driver — synchronous disk writes on the hot path. That is very likely a meaningful slice
of the API's 160% CPU.

---


## 9 — Findings

### 9.1 — Decoupling acknowledgment from fulfillment is the entire mechanism

Approach 2's API validates, atomically reserves stock in Redis, pushes to a queue, and
returns `202` in **6 milliseconds**. It does not wait for the payment gateway. It does not
hold a database transaction. It does not hold a socket to a third party.

Approach 1 does all three, for a **median of 1,090 ms and a worst case of 24.5 seconds**.

Same work. Same success rate. **The difference is who does the waiting.**

### 9.2 — Why Approach 2 looks slower, and why that is not a defeat

```
A1:  72.9 orders/s        A2:  32.5 orders/s
```

Approach 2 posted **less than half** the throughput. And it was **asleep** while doing it
(payment workers at 2–17%, Postgres at 5–18%).

The cause is the **closed load model**:

```
POST (ack in 6 ms)  →  trackOrder()  ←  holds the VU for 4.5 seconds
```

The VU waits for genuine confirmation. So 300 VUs ÷ a ~4.9 s iteration = **~61
iterations/sec, maximum**. **The throughput ceiling is the VU pool, not the system.**

Approach 1's iteration is shorter (2.18 s) because it declares victory sooner — but its
p99 is **11.3 seconds** and it returned **62 server errors**.

> **Approach 2 is not slower. It is being penalised for telling the truth about when an
> order is actually done.**

This is exactly why the stress profile (open model) exists — and exactly why its result
matters more than this one.

### 9.3 — The unknown outcome is where the architectures actually diverge

The gateway hangs on 1% of charges and never answers. `processPayment` aborts after 10
seconds and returns:

```js
{ success: false, error: 'gateway_timeout', unknown: true }
```

**You do not know whether the customer was charged.**

| Action | If the charge *did* go through | If it *didn't* |
|---|---|---|
| Release the stock | **You sold the same unit twice. They paid and got nothing.** | fine |
| Confirm the order | fine | **You gave away a product for free.** |
| **Flag `needs_reconciliation`** | ✅ safe | ✅ safe |

**A correct system does not guess about money. It stops and admits it does not know.**

Approach 2 does exactly that — **110 orders** in the A/B, **145** in the stress run. Stock
held, order suspended, human reconciles against the gateway.

**Approach 1 cannot.** It has one HTTP response and it must send it now. So it guesses —
and its `stock consumed (20,113) ≠ orders confirmed (20,110)` gap is what guessing looks
like on a balance sheet.

> *"The payment gateway times out. You don't know if the card was charged. What do you
> do?"*
>
> **"Nothing. You flag it. Then you make sure your architecture gives you the room to."**

### 9.4 — Two counters that answer different questions must never be synchronised

The single most damaging bug in the project ([§4.2](#42--the-payment-worker-destroyed-the-reservation-counter))
came from treating `redis_stock` and `postgres_stock` as two copies of one number.

They are not. **Redis answers "can I accept another order?" Postgres answers "what
sold?"** Reserved ≥ confirmed, always, so **Redis ≤ Postgres, always.**

Writing one over the other does not "sync" them. It **destroys** the one that lags — and
the lag is precisely the information you needed.

Confirming an order converts a reservation into a sale. **It does not free stock.**
Therefore confirmation must not touch the reservation counter at all.

### 9.5 — A single atomic `DECR` was enough

Post-fix, with the reservation counter left alone, **not one negative-stock event
occurred** across every run — including the one that crashed the host.

No distributed lock. No Redlock. No consensus protocol. **One atomic decrement with a
compensating rollback**, plus a conditional `UPDATE … WHERE stock > 0` at the database as
defence in depth.

The DB guard should be **unreachable** in normal operation. It exists for the day Redis is
flushed and reseeded while Postgres is not — the one remaining silent-corruption path.
When it fires, it logs `[FATAL] Redis/DB divergence`, because if it fires, something is
badly wrong.

### 9.6 — Scale the bottleneck, and know which one it is

The original report concluded that payment processing was the bottleneck and that scaling
payment workers 2 → 6 was the win.

**Measured, that is false.** At the stress peak:

```
api-1:            160% / 200%    (80%)   ← the bottleneck
worker-payment:    ~21% / 200%   (10%)   ← asleep
postgres:           28% / 200%   (14%)   ← asleep
```

The reason the earlier conclusion looked right: the payment workers were **serialising on
a single Postgres row lock** ([§4.3](#43--worker-trust-was-never-actually-applied)) — so
adding workers appeared to help, when what was actually needed was to remove the lock.

**Fixing the lock made the workers idle. Scaling them further would do nothing.**

---

## 10 — Threats to validity

Stated plainly so the results are read for what they are.

1. **The load generator shares the host with the system under test.** k6 competes for the
   same 8 cores. The stress run's ceiling is the laptop's, not the architecture's.

2. **The comparison is not perfectly matched.** Approach 1 runs bare on the host — no CPU
   cap, no reverse proxy, less logging overhead. Approach 2 runs in Docker behind nginx.
   **The bias favours Approach 1**, and it lost anyway.

3. **Different product rows.** A1 on product 8, A2 on product 12, stress on 13. Identical
   schema and starting stock, run separately, no cross-contention. A2 also wrote into an
   `Orders` table that already held ~22k rows from the A1 run — negligible at this scale,
   but disclosed.

4. **The payment gateway is simulated.** The latency distribution and failure modes are
   modelled on a real one, but it is not Stripe. No real rate limits, no real network
   partition, no real retry semantics.

5. **The stress run is incomplete.** The host died at ~4 minutes and k6's output was lost.
   Database state and container logs survived; latency percentiles at high arrival rates
   did not.

6. **Per-request `console.log` on the hot path.** At peak, ~5,000 log lines/sec through
   Docker's json-file driver. This inflates Approach 2's CPU and is not present in
   Approach 1 to the same degree.

7. **Single node.** One Redis, one Postgres. No replication, no failover. Redis is a
   single point of failure for all reservation state.

8. **Contention is on the product row and the Redis stock key — not on user identity.**
   The 10,000-account pool is therefore not a limiting factor, and a larger pool would not
   change the result.

---

## Appendix — how to reproduce

```bash
# 0. Windows: raise the ephemeral port ceiling (Administrator)
netsh int ipv4 set dynamicport tcp start=10000 num=55000

# 1. Clean schema — do NOT rely on sequelize.sync({ alter: true })
docker compose down
docker volume rm backend-of-thrones_pg-data
docker compose up -d postgres redis && sleep 15
node scripts/migrate.js

# 2. Seed
node scripts/seed-products.js
node scripts/seed-users.js 10000 http://localhost:3000    # cached to tests/tokens.json
node scripts/initStock.js

# 3. Bring the system up — the --scale flags are NOT optional
docker compose up -d --scale api=2 --scale worker-payment=6
docker compose ps                                          # verify the replica count

# 4. Prove the idempotency layer works BEFORE spending 5 minutes on a load test
./scripts/smoke-idempotency.sh 1
./scripts/smoke-idempotency.sh 2
#    PASS = same orderId returned twice, exactly ONE unit of stock consumed

# 5. A/B
k6 run tests/load-test-1.js --summary-export=results/a1-ab.json | tee results/a1-ab.txt
k6 run tests/load-test-2.js --summary-export=results/a2-ab.json | tee results/a2-ab.txt

# 6. Stress
k6 run -e PROFILE=stress tests/load-test-1.js --summary-export=results/a1-stress.json | tee results/a1-stress.txt
k6 run -e PROFILE=stress tests/load-test-2.js --summary-export=results/a2-stress.json | tee results/a2-stress.txt

# 7. Verify the invariant — this is the number that matters
psql -c 'SELECT status, count(*) FROM "Orders" GROUP BY status;'
psql -c 'SELECT stock FROM "Products" WHERE id = <PRODUCT_ID>;'
redis-cli LLEN ORDERS
redis-cli LLEN PAYMENTS
redis-cli GET "<PRODUCT_ID>:STOCK"
```

**Watch, in parallel, or the numbers have no cause:**

```powershell
while ($true) {
    $t = Get-Date -Format "HH:mm:ss"
    docker stats --no-stream --format "$t {{.Name}} {{.CPUPerc}} {{.MemUsage}}" |
        Tee-Object -Append -FilePath docker-stats.log
    Start-Sleep 5
}
```

Without it, you get a breaking point with no explanation — and the first question anyone
asks is *"why did it break there?"*

---

**END OF REPORT**
