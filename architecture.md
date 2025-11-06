# ARCHITECTURE.md

## 1. System Architecture Overview
This document explains the architectural decisions, data flows, diagrams, OSI model mapping, and the design trade-offs behind the **Flash Sale System** implemented in *Backend Of Thrones*. It avoids source code and focuses on architecture-level artifacts only.

---

## 2. High-Level Architecture Diagram
Two architecture approaches were experimented with during development. Both diagrams are included below.

### Approach 1 
![Approach 1](https://cdn.lous.in/storage/4dda852b-bc17-4a99-ab56-9c6729e9502e_Untitled_Diagram_3.jpg)

### Approach 2 
![Approach 2](https://cdn.lous.in/storage/3d3d11fa-55eb-40a2-99b2-7a215f9027a7_Untitled_Diagram_2.jpg)


---

## 3. OSI Model Breakdown
This section maps each protocol/component of the system to its respective OSI layer.

### **Layer 7 – Application**
- HTTP/JSON (API requests)
- SSE (real-time stock updates)
- Postgres SQL protocol
- Redis command protocol

### **Layer 4 – Transport**
- TCP (transport for HTTP, Redis, Postgres, and SSE streams)

### **Layer 3 – Network**
- Docker internal network routing between containers

### **Layer 2 – Data Link**
- Docker virtual bridge (switching between container interfaces)

### **Layer 1 – Physical**
- Host machine running Docker (Laptop / VPS / VM)

---

## 4. Key Sequence Diagrams
Below are the core flows required to understand how the system behaves during a flash‑sale scenario.

### 4.1 Order Placement Flow
```
User → API: POST /order/buy 
API → Redis: DECR stock + LPUSH order
Redis → API: Return success or out‑of‑stock
API → User: 202 Accepted (Queued)

Order Worker → Redis: BRPOP queue
Order Worker → Postgres: INSERT order record
Order Worker → Payment Worker: Push payment job

Payment Worker → Redis: BRPOP queue:payments
Payment Worker → Postgres: UPDATE order (paid = true)
Payment Worker → SSE Server: Publish "order_confirmed"
SSE Server → User: event: confirmed
```

### 4.2 Stock Streaming Flow (SSE)
```
Client → SSE Server: GET /stock/:id/stream
SSE Server → Redis: SUBSCRIBE stock:<id>
Redis → SSE Server: PUBLISH stock changes
SSE Server → Client: text/event-stream updates
```

---

## 5. Design Decisions & Trade-Offs

### Redis as cache Stock Handling
- **Why:** Sub‑millisecond operations; simple `DECR` for stock and `LPUSH/BRPOP` for queueing that match the current code.
- **Trade-off:** Without a Lua script, `DECR` and `LPUSH` are two operations; we accept the small non-atomic window and mitigate at the DB layer (unique constraints, transactional checks). Persistence (AOF/RDB) remains recommended.

### Queue-Based Worker System
- **Why:** Prevents API from being overloaded under heavy traffic.
- **Trade-off:** Slight delay in order confirmation.

### PostgreSQL as the Source of Truth
- **Why:** Strong ACID guarantees and data consistency.
- **Trade-off:** Heavier than an in-memory DB, but essential for financial integrity.

### SSE Instead of WebSockets
- **Why:** Simpler, more lightweight, perfect for one‑way stock updates.
- **Trade-off:** One-direction communication only.

### Idempotency Layer
- **Why:** Prevent users from purchasing the same item multiple times due to retries or double-clicks.
- **Trade-off:** Requires cache storage and safe key expiration.

---

## 6. Reasons Behind Chosen Patterns
- **LPUSH/BRPOP Queues + Explicit Stock Control:** Mirrors the current implementation: API performs `DECR` then enqueues with `LPUSH`, workers consume with `BRPOP`.
- **Distributed Worker Model:** Allows horizontal scaling and separation of concerns.
- **CQRS-Lite:** API handles writes; SSE handles real-time reads of stock state.
- **Rate Limiting at the API Layer:** Protects backend services during peak bursts.

---

## 7. Summary
This architecture demonstrates a production-grade approach for handling extreme flash‑sale conditions with:
- Safe stock decrement
- Queue-driven order processing
- Real-time user feedback via SSE
- Clear separation between API, workers, storage, and streaming layers

The approaches evolved through experimentation, with Approach 2 being the optimal version used in the final system.

