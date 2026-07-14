/**
 * Seed test users and cache their JWTs to tests/tokens.json
 *
 *   node scripts/seed-users.js 10000 http://localhost:3000
 *
 * Why offline: registering 10k users inside k6's setup() would take many
 * minutes and count against setupTimeout. Seed once, reuse across every run.
 * Users are idempotent — re-running logs in existing accounts instead of
 * failing on 409.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COUNT    = Number(process.argv[2] || 10000);
const BASE_URL = process.argv[3] || 'http://localhost:3000';
const OUT      = join(__dirname, '..', 'tests', 'tokens.json');
const BATCH    = 50;   // parallel registrations per batch

async function getToken(i) {
    const user = {
        name: `TestUser${i}`,
        email: `testuser${i}@test.com`,
        password: 'test123456',
    };
    const headers = { 'Content-Type': 'application/json' };

    let res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST', headers, body: JSON.stringify(user),
    });

    if (res.status === 409) {
        res = await fetch(`${BASE_URL}/auth/login`, {
            method: 'POST', headers,
            body: JSON.stringify({ email: user.email, password: user.password }),
        });
    }

    if (!res.ok) throw new Error(`user ${i}: HTTP ${res.status}`);

    const body = await res.json();
    if (!body.token) throw new Error(`user ${i}: no token in response`);
    return body.token;
}

(async () => {
    console.log(`Seeding ${COUNT} users against ${BASE_URL}...`);
    const tokens = [];
    const started = Date.now();

    for (let i = 0; i < COUNT; i += BATCH) {
        const batch = [];
        for (let j = i; j < Math.min(i + BATCH, COUNT); j++) batch.push(getToken(j));

        const results = await Promise.allSettled(batch);
        for (const r of results) {
            if (r.status === 'fulfilled') tokens.push(r.value);
            else console.error(`  ${r.reason.message}`);
        }

        if ((i / BATCH) % 20 === 0) {
            const pct = ((tokens.length / COUNT) * 100).toFixed(1);
            console.log(`  ${tokens.length}/${COUNT}  (${pct}%)`);
        }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (tokens.length < COUNT * 0.99) {
        console.error(`\nFAILED: only ${tokens.length}/${COUNT} tokens. Fix the API first.`);
        process.exit(1);
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(tokens));

    console.log(`\n${tokens.length} tokens -> ${OUT}  (${elapsed}s)`);
})();