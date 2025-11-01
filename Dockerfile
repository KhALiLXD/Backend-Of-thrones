# يبني صورة Node للخدمتين (API/SSE)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci 

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# اختياري: تقليل استهلاك الذاكرة
ENV NODE_OPTIONS="--max-old-space-size=1024"
# الأمر الفعلي نحدده من docker-compose لكل خدمة
CMD ["node","src/approach-2/index.api.js"]
