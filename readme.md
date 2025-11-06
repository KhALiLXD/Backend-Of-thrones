# 🏰 Backend of Thrones – High‑Performance Flash Sale System

&#x20; &#x20;

> This README focuses on the required items: scenario, tech stack, setup (via `docker-compose up`), how to run load tests, and a brief architecture overview. Extra visuals (badges/ToC) are added for public readability.

---

## 📑 Table of Contents

- [1. Scenario Chosen and Why](#1-scenario-chosen-and-why)
- [2. Tech Stack Used](#2-tech-stack-used)
- [3. Setup Instructions](#3-setup-instructions)
  - [3.1 Local ](#31-local-env-for-manual-runs)[`.env`](#31-local-env-for-manual-runs)[ (for manual runs)](#31-local-env-for-manual-runs)
  - [3.2 Docker ](#32-docker-envdocker-for-compose)[`.env.docker`](#32-docker-envdocker-for-compose)[ (for Compose)](#32-docker-envdocker-for-compose)
  - [3.3 Start the Stack](#33-start-the-stack)
- [4. How to Run Load Tests](#4-how-to-run-load-tests)
- [5. Brief Architecture Overview](#5-brief-architecture-overview)
- [6. Project Structure (compact)](#6-project-structure-compact)

---

## 1. Scenario Chosen and Why

This project implements a **Flash Sale System** to simulate extreme e‑commerce pressure (Black Friday style):

- **100,000+ concurrent users** hitting a single product.
- **1,000 units** only (strict stock integrity; zero overselling).
- **5‑minute window** causing bursty traffic and queue backpressure.

Chosen because it surfaces real‑world backend challenges: concurrency control, queueing, worker scaling, end‑to‑end latency, and observability under load.

---

## 2. Tech Stack Used

**Backend:** Node.js, Express.js\
**Database:** PostgreSQL (ACID)\
**Cache & Queue:** Redis (`DECR`, `LPUSH/BRPOP`, Pub/Sub)\
**Real‑Time:** Server‑Sent Events (SSE)\
**Load Balancer:** Nginx\
**Containers:** Docker + Docker Compose\
**Load Testing:** k6

---

## 3. Setup Instructions

> The system is expected to run with ``.

### 3.1 Local `.env` (for Approatch1)

Create a file named `.env` in the project root:

```bash
DB_HOST=localhost
DB_PORT=5432
POSTGRES_DB=flashsale_dev
POSTGRES_USER=postgres
POSTGRES_PASSWORD=1
REDIS_URL=redis://127.0.0.1:6379

# shared env for both implementations (keep it here)
RATE_LIMIT_WINDOW=1
RATE_LIMIT_MAX=20

JWT_SECRET=88a68078ad21d0b40b582ff50f086e52b71a36c3f802ae45d3ff84c98bdd77363523bdd7a0f40f58f0879888ce62978ce23387e1873b1a2018559f8b3d23313b
```

### 3.2 Docker `.env.docker` (for Approatch2)

Create a file named `.env.docker` in the project root:

```env
DB_HOST=postgres
DB_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD="1"
POSTGRES_DB=flashsale_dev
REDIS_URL=redis://redis:6379
```

### 3.3 Start the Stack
#### `Aprroatch 1`

```bash
# 1) Clone
git clone <repo-url>
cd Backend-Of-thrones
# 2) instal dependency
npm i
# 3) Run
npm run start1
```
#### `Approatch 2`
```bash
# 1) Clone
git clone <repo-url>
cd Backend-Of-thrones
# 2) instal dependency
npm i
# 3) Prepare project on docker
npm run build
# 4) start
npm run start2
```
After startup you will have:

- API (Express)
- SSE server
- Redis (cache + queues)
- PostgreSQL
- Order worker
- Payment worker
- Nginx (gateway/LB)

---

## 4. How to Run Load Tests

1. Install k6 → [https://k6.io](https://k6.io)
2. With the stack running, execute:

```bash
npm run test1 # for Approattch 1
```

```bash
npm run test2 # for Approattch 2
```
The test validates:

- API behavior under pressure
- Queue dynamics (accepted vs. out‑of‑stock)
- Stock correctness (≤ 1,000)
- End‑to‑end latency across workers

---

## 5. Brief Architecture Overview

- **Nginx** balances traffic to API containers.
- **API** checks stock and enqueues orders (`LPUSH`).
- **Redis** provides `DECR` for stock, list queues (`BRPOP`) for workers, and Pub/Sub for SSE.
- **Order Worker** persists orders to **PostgreSQL** and forwards payment jobs.
- **Payment Worker** simulates payment and finalizes order status.
- **SSE** streams stock updates to clients in real‑time.

For a deeper design document (diagrams, OSI mapping, sequences), read ``.

---

## 6. Project Structure (compact)

```bash
Backend-Of-thrones/
├── README.md                     # Overview & setup (this file)
├── ARCHITECTURE.md               # System design & diagrams
├── docker-compose.yml            # Multi-service orchestration
├── tests/                        # k6 load-testing scripts
│   ├── load-test-1.js
│   └── load-test-2.js
├── src/
│   ├── approach-1/               # First implementation
│   │   ├── index.js
│   │   └── ...
│   ├── approach-2/               # Final implementation
│   │   ├── index.api.js
│   │   ├── index.sse.js
│   │   ├── workers/
│   │   │   ├── orderWorker.js
│   │   │   └── paymentWorker.js
│   │   └── ...
│   ├── shared/                   # Shared modules
│   │   ├── config/               # DB / Redis / cluster configs
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── modules/              # Sequelize models
│   │   ├── routes/
│   │   └── utils/                # Queue, payment, tracing
│   └── loadbalancer/             # Nginx config
├── scripts/                      # Data setup utilities
│   ├── insertProduct.js
│   └── initStock.js
├── .env                          # Local environment
└── .env.docker                   # Docker env
```


# Made with ❤️ by [Khalil Alyacoubi](https://github.com/KhALiLXD) & [Bayan Abd El Bary](https://github.com/bayan2002)

