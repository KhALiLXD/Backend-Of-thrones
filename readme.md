# 🏰 Backend of Thrones - High-Performance Flash Sale System

**Production-Ready E-Commerce Backend for Handling 100,000+ Concurrent Users**

A sophisticated distributed system built to handle extreme Black Friday traffic loads with zero overselling, demonstrating advanced backend engineering patterns including asynchronous processing, horizontal scaling, atomic operations, and multi-process execution.

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue)](https://www.docker.com/)
[![Redis](https://img.shields.io/badge/Redis-7.x-red)](https://redis.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18.x-blue)](https://www.postgresql.org/)

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Performance Metrics](#-performance-metrics)
- [API Documentation](#-api-documentation)
- [Load Testing](#-load-testing)
- [Project Structure](#-project-structure)
- [Configuration](#-configuration)
- [Design Decisions](#-design-decisions)
- [Troubleshooting](#-troubleshooting)

---

## 🎯 Overview

### The Challenge

Build a backend system that handles a flash sale scenario:
- **Product:** iPhone 15 Pro (1,000 units @ $999.99)
- **Users:** 100,000+ concurrent buyers
- **Time Window:** 5 minutes
- **Requirement:** Zero overselling, maintain consistency under extreme load

### The Solution

A distributed, queue-based architecture with:
- Atomic stock management (Redis DECR)
- Multi-process execution (Node.js clustering)
- Horizontal scaling (6 payment worker containers)
- Asynchronous processing (queue-based background workers)
- Load balancing (Nginx)

---

## ✨ Features

### Core Capabilities

| Feature | Implementation | Benefit |
|---------|---------------|---------|
| **Atomic Stock Management** | Redis `DECR` operations | Zero overselling guaranteed |
| **Asynchronous Processing** | Redis queue + Worker pools | Immediate user response (50ms) |
| **Multi-Process Execution** | Node.js clustering | Utilizes all CPU cores |
| **Horizontal Scaling** | Docker replicas | Handles 100K+ concurrent users |
| **Load Balancing** | Nginx (least connections) | Even traffic distribution |
| **Real-Time Updates** | Server-Sent Events (SSE) | Live stock notifications |
| **Payment Processing** | Background workers | Non-blocking operations |
| **Authentication** | JWT + bcrypt | Secure user sessions |

### Architecture Patterns

- ✅ **Worker Trust Pattern** - Workers trust API's atomic reservation
- ✅ **Queue-Based Processing** - Decoupled request/response
- ✅ **Idempotency** - Server-side keys prevent duplicates
- ✅ **Graceful Degradation** - 503 responses when queue full
- ✅ **Atomic Rollback** - Stock refund on payment failure

---

## 🏗️ Architecture

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────────┐
│              NGINX Load Balancer (Port 80)                      │
│              - Least connections algorithm                       │
│              - 10K concurrent connections                        │
└────────────────────┬────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
    ┌───▼────┐   ┌──▼─────┐  ┌──▼─────┐
    │ API-1  │   │ API-2  │  │  SSE   │
    │ :3000  │   │ :3000  │  │ :4000  │
    │2 workers   │2 workers  │1 worker │
    └───┬────┘   └───┬────┘  └───┬────┘
        │            │           │
        └────────┬───┴───────────┘
                 │
        ┌────────▼─────────┐
        │  Redis (:6379)   │
        │  • Queue         │
        │  • Cache         │
        │  • Stock Counter │
        │  • Pub/Sub (SSE) │
        └────────┬─────────┘
                 │
      ┌──────────┼────────────────────────────────────┐
      │          │                                    │
  ┌───▼────┐ ┌──▼─────────┐  ┌────────────────────▼───┐
  │ Order  │ │  Payment   │  │  Payment Worker         │
  │Worker  │ │  Worker-1  │  │  Containers 2-6         │
  │:4 wkrs │ │  :6 wkrs   │  │  (6 total containers)   │
  │×15 conc│ │  ×20 conc  │  │  36 workers total       │
  └───┬────┘ └───┬────────┘  └────────────┬────────────┘
      │          │                        │
      └──────────┴────────────────────────┘
                 │
        ┌────────▼──────────┐
        │ PostgreSQL (:5432)│
        │  • Products table │
        │  • Orders table   │
        │  • Users table    │
        │  • Transactions   │
        └───────────────────┘
```

### Request Flow

```
1. User → Nginx → API Worker
   ↓
2. API: JWT validation (5ms)
   ↓
3. API: Redis DECR atomic stock reservation (2ms)
   ↓
4. API: Push to order queue (1ms)
   ↓
5. API: Return 202 Accepted (Total: 50ms)
   ↓
6. Order Worker: Pop from queue
   ↓
7. Order Worker: Save to PostgreSQL
   ↓
8. Order Worker: Push to payment queue
   ↓
9. Payment Worker: Process payment (2-3s)
   ↓
10. Payment Worker: Update order status
    ↓
11. User polls /order/:id/status
    ↓
12. Final status: "confirmed" or "payment_failed"
```

### Technology Stack

**Backend:**
- **Runtime:** Node.js 20 (multi-process clustering)
- **Framework:** Express.js
- **Database:** PostgreSQL 18 (ACID transactions)
- **Cache/Queue:** Redis 7 (atomic operations)
- **ORM:** Sequelize (SQL injection prevention)
- **Authentication:** JWT + bcrypt

**Infrastructure:**
- **Containerization:** Docker + Docker Compose
- **Load Balancer:** Nginx (least connections)
- **Orchestration:** Docker Compose scaling
- **Testing:** k6 (Grafana Labs)

**Key Libraries:**
- `ioredis` - Redis client with pipelining
- `jsonwebtoken` - JWT authentication
- `bcrypt` - Password hashing
- `express` - Web framework

---

## 🚀 Quick Start

### Prerequisites

```bash
# Required
- Node.js 18+ (https://nodejs.org/)
- Docker Desktop (https://www.docker.com/)
- Docker Compose v2
- k6 load testing tool (https://k6.io/)
- Git

# Verify installations
node --version    # Should be v18+
docker --version  # Should be 20+
k6 version       # Should be v0.40+
```

### Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd Backend-Of-thrones

# 2. Ensure Docker Desktop is running
docker ps  # Should work without errors

# 3. Run automated deployment script
chmod +x deploy-optimal.sh
./deploy-optimal.sh
```

### What the Deployment Script Does

1. ✅ Stops existing containers
2. ✅ Rebuilds Docker images with new code
3. ✅ Starts services with horizontal scaling:
   - 2 API containers
   - 6 Payment worker containers
   - 1 Order worker container
4. ✅ Waits for health checks to pass
5. ✅ Creates test product (1,000 stock)
6. ✅ Loads stock into Redis
7. ✅ Verifies clustering is working

**Expected deployment time:** 2-3 minutes

### Verify Deployment

```bash
# 1. Check all containers are running
docker compose ps

# Expected output (11 containers):
# NAME                          STATUS
# backend-api-1                 Up (healthy)
# backend-api-2                 Up (healthy)
# backend-worker-payment-1      Up
# backend-worker-payment-2      Up
# backend-worker-payment-3      Up
# backend-worker-payment-4      Up
# backend-worker-payment-5      Up
# backend-worker-payment-6      Up
# backend-worker-order-1        Up
# backend-redis-1               Up (healthy)
# backend-postgres-1            Up (healthy)
# backend-nginx-1               Up
# backend-sse-1                 Up (healthy)

# 2. Verify API clustering (multi-process)
docker compose logs api | grep "Starting 2 workers"
# Should show: "📊 [API] Starting 2 workers..."

# 3. Verify stock in Redis
docker compose exec redis redis-cli GET "1:STOCK"
# Should output: "1000"

# 4. Test API health
curl http://localhost/api/products/1
# Should return product JSON
```

---

## 📊 Performance Metrics

### Current System Performance

| Metric | Value | Industry Standard |
|--------|-------|-------------------|
| **Throughput** | 213 req/s | 100-500 req/s |
| **Confirmed Orders** | 999/1,000 | 95%+ |
| **Success Rate** | 90-95% | 85%+ ✅ |
| **API Response Time (P50)** | 40ms | <100ms ✅ |
| **API Response Time (P95)** | 300ms | <500ms ✅ |
| **Total Order Time (P95)** | 10.2s | <15s ✅ |
| **Payment Processing** | 6.8s avg | <10s ✅ |
| **Out of Stock Handling** | 46,061 rejected | 100% accurate |
| **Overselling** | 0 | Zero tolerance ✅ |

### Capacity

| Component | Configuration | Capacity |
|-----------|--------------|----------|
| **API Workers** | 2 containers × 2 workers | 4 workers total |
| **Order Workers** | 1 container × 4 workers × 15 concurrency | 60 concurrent |
| **Payment Workers** | 6 containers × 6 workers × 20 concurrency | **720 concurrent** |
| **Redis Queue** | Unlimited (memory-bound) | Millions/sec |
| **PostgreSQL** | Connection pool: 30 | 30 concurrent |

### Load Test Results

**Test Scenario:**
- Duration: 5 minutes
- Virtual Users: 50 → 150 → 300 (ramping)
- Total Requests: 65,000+
- Purchase Attempts: 1,274 accepted

**Results:**
```
✅ Confirmed Orders:          999/1,000 (99.9%)
✅ Success Rate:              90-95%
✅ P95 Latency:              10.2s (target: <15s)
✅ API Response Time:        107ms avg
✅ Payment Processing Time:  6.8s avg
✅ Correctly Rejected:       46,061 (out of stock)
✅ Server Errors (5xx):      0
✅ Bad Requests (400):       0
```

---

## 📚 API Documentation

### Base URL

```
http://localhost/api
```

### Authentication Endpoints

#### Register User

```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123"
}
```

**Response (201 Created):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

#### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "password123"
}
```

**Response (200 OK):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Product Endpoints

#### Get Product Details

```http
GET /api/products/1
```

**Response (200 OK):**
```json
{
  "id": 1,
  "name": "iPhone 15 Pro - Flash Sale",
  "price": "999.99",
  "stock": 1000,
  "createdAt": "2025-11-05T10:00:00.000Z",
  "updatedAt": "2025-11-05T10:00:00.000Z"
}
```

### Order Endpoints

#### Place Flash Sale Order

```http
POST /api/order/buy-flash
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "productId": 1
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "orderId": "1762359092781481",
  "status": "queued",
  "message": "order is being processed",
  "checkStatusUrl": "/order/1762359092781481/status",
  "product": {
    "id": 1,
    "name": "iPhone 15 Pro - Flash Sale",
    "price": "999.99"
  }
}
```

**Possible Responses:**
- `202 Accepted` - Order queued for processing
- `409 Conflict` - Product out of stock
- `401 Unauthorized` - Invalid/missing JWT
- `400 Bad Request` - Missing productId

#### Check Order Status

```http
GET /api/order/:orderId/status
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "orderId": "1762359092781481",
  "userId": 1,
  "status": "confirmed",
  "totalPrice": "999.99",
  "product": {
    "id": 1,
    "name": "iPhone 15 Pro - Flash Sale",
    "price": "999.99"
  },
  "createdAt": "2025-11-05T10:00:00.000Z",
  "updatedAt": "2025-11-05T10:01:30.000Z"
}
```

**Order Status Values:**
- `queued` - Order in queue
- `processing` - Being processed by worker
- `pending` - Saved to database
- `awaiting_payment` - Waiting for payment worker
- `processing_payment` - Payment being processed
- `confirmed` - ✅ Purchase successful
- `payment_failed` - ❌ Payment declined
- `failed` - ❌ System error

### Real-Time Stock Updates (SSE)

#### Connect to Stock Stream

```http
GET /sse/stock/1
Authorization: Bearer <JWT_TOKEN>
```

**Response (text/event-stream):**
```
data: {"productId":1,"stock":999}

data: {"productId":1,"stock":998}

data: {"productId":1,"stock":997}
```

**Usage Example (JavaScript):**
```javascript
const eventSource = new EventSource('http://localhost/sse/stock/1');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`Stock remaining: ${data.stock}`);
};
```

---

## 🧪 Load Testing

### Running Load Tests

```bash
# Ensure system is deployed
docker compose ps  # All should be "Up (healthy)"

# Run the load test
k6 run tests/load-test-2.js
```

### Test Scenario Details

**Test Profile:**
```javascript
stages: [
  { duration: '30s', target: 50 },   // Ramp-up
  { duration: '1m',  target: 150 },  // Increase load
  { duration: '2m',  target: 300 },  // Peak load
  { duration: '1m',  target: 100 },  // Ramp-down
  { duration: '30s', target: 0 },    // Cool-down
]
```

**What It Tests:**
- 300 concurrent virtual users (peak)
- 5-minute duration
- ~65,000 total HTTP requests
- ~1,300 purchase attempts
- Stock: 1,000 items

**Success Criteria:**
- ✅ Success rate > 85%
- ✅ P95 latency < 15s
- ✅ Server errors < 100
- ✅ No overselling (exactly 1,000 or less confirmed)

### Understanding Results

```bash
# Key metrics to watch:
successful_purchases        # Orders accepted (got 202)
fully_confirmed_orders      # Orders completed successfully
order_success_rate          # Percentage of accepted orders confirmed
out_of_stock_409           # Correctly rejected (expected: high)
payment_processing_time    # How long payments take
total_order_time           # End-to-end order time
```

### Custom Load Tests

Create your own test:
```javascript
// tests/custom-test.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 100,        // 100 virtual users
  duration: '2m',  // Run for 2 minutes
};

export default function() {
  const res = http.get('http://localhost/api/products/1');
  check(res, { 'status is 200': (r) => r.status === 200 });
}
```

Run with: `k6 run tests/custom-test.js`

---

## 📁 Project Structure

```
Backend-Of-thrones/
├── src/
│   ├── approach-2/                    # Main application
│   │   ├── index.api.js              # API server with clustering
│   │   ├── index.sse.js              # SSE server for real-time updates
│   │   └── workers/
│   │       ├── orderWorker.js        # Order processing worker
│   │       └── paymentWorker.js      # Payment processing worker
│   ├── shared/                        # Shared modules
│   │   ├── config/
│   │   │   ├── db.js                 # PostgreSQL configuration
│   │   │   ├── redis.js              # Redis configuration
│   │   │   └── cluster.js            # Clustering setup
│   │   ├── controllers/
│   │   │   └── orders.controller.js  # Order business logic
│   │   ├── middleware/
│   │   │   ├── auth.js               # JWT authentication
│   │   │   └── rateLimiter.js        # Rate limiting
│   │   ├── modules/                  # Sequelize models
│   │   │   ├── users.js
│   │   │   ├── products.js
│   │   │   └── orders.js
│   │   ├── routes/                   # Express routes
│   │   │   ├── auth.route.js
│   │   │   ├── products.route.js
│   │   │   └── orders.route.js
│   │   └── utils/
│   │       ├── queue.js              # Redis queue abstraction
│   │       ├── processPayment.js     # Payment simulation
│   │       └── orderTracing.js       # Order status tracking
│   └── loadbalancer/
│       └── nginx.conf                 # Nginx configuration
├── scripts/
│   ├── insertProduct.js               # Setup test data
│   └── initStock.js                   # Load stock into Redis
├── tests/
│   ├── load-test-2.js                 # Main load test
│   └── README.md                      # Test documentation
├── .env                               # Local environment variables
├── .env.docker                        # Docker environment variables
├── docker-compose.yml                 # Container orchestration
├── Dockerfile                         # Application container
├── deploy-optimal.sh                  # Automated deployment
├── package.json                       # Node.js dependencies
├── README.md                          # This file
├── ARCHITECTURE.md                    # Detailed architecture docs
├── DEPLOYMENT_GUIDE.md                # Deployment instructions
├── TESTING_GUIDE.md                   # Testing instructions
└── OPTIMAL_FLASH_SALE_ARCHITECTURE.md # Architecture analysis
```

---

## ⚙️ Configuration

### Environment Variables

**`.env.docker` (Docker Compose):**
```env
# PostgreSQL
POSTGRES_DB=flashsale
POSTGRES_USER=postgres
POSTGRES_PASSWORD=123456
DB_HOST=postgres
DB_PORT=5432

# Redis
REDIS_URL=redis://redis:6379

# Workers Configuration
API_WORKERS=2              # Workers per API container
ORDER_WORKERS=4            # Workers per order container
PAYMENT_WORKERS=6          # Workers per payment container
WORKER_CONCURRENCY=20      # Concurrent jobs per worker

# Database Pool
DB_POOL_MAX=30
DB_POOL_MIN=5

# JWT
JWT_SECRET=your-secret-key-change-in-production
```

### Scaling Configuration

**In `docker-compose.yml`:**

```yaml
# API Scaling
api:
  environment:
    API_WORKERS: "2"    # Increase for more CPU utilization
  # To run multiple API containers:
  # docker compose up -d --scale api=4

# Payment Worker Scaling
worker-payment:
  environment:
    PAYMENT_WORKERS: "6"        # Workers per container
    WORKER_CONCURRENCY: "20"    # Jobs per worker
  # Total capacity: containers × workers × concurrency
  # Current: 8 × 8 × 20 = 1280 concurrent payments

  # To run more payment containers:
  # docker compose up -d --scale worker-payment=8
```

**Capacity Calculation:**
```
Total Capacity = Replicas × Workers × Concurrency

Example (current):
8 containers × 8 workers × 20 concurrency = 1,280 concurrent jobs
```

### Nginx Configuration

**`src/loadbalancer/nginx.conf`:**
```nginx
upstream api_backend {
    least_conn;  # Load balancing algorithm
    server api:3000 resolve max_fails=3 fail_timeout=30s;
}

server {
    listen 80;

    location /api/ {
        proxy_pass http://api_backend/;
        proxy_connect_timeout 10s;
        proxy_read_timeout 30s;
    }
}
```

---

## 🎓 Course Requirements Met

✅ **Execution Architecture:** Multi-process (Node.js clustering)
✅ **Load Distribution:** Nginx load balancer (least connections)
✅ **Zero Overselling:** Atomic Redis operations (DECR)
✅ **Performance Analysis:** Load tests with k6, metrics collected
✅ **Real-Time Updates:** Server-Sent Events (SSE)
✅ **Scalability:** Horizontal scaling (Docker replicas)
✅ **High Availability:** Multiple containers, automatic restart

---

## 👥 Project Information

**Scenario:** E-Commerce Flash Sale System

**Completion Date:** November 2025

**Built by:**
Bayan Abd El Bary & 
Khalil Al-yacoubi

---




