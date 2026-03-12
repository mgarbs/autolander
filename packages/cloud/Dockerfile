FROM node:20-alpine AS builder

WORKDIR /app

COPY packages/cloud/package.json packages/cloud/package-lock.json* ./packages/cloud/
COPY packages/shared/ ./packages/shared/

WORKDIR /app/packages/cloud
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY packages/cloud/prisma/ ./prisma/
RUN npx prisma generate

FROM node:20-alpine

RUN apk add --no-cache tini
WORKDIR /app/packages/cloud

COPY --from=builder /app/packages/cloud/node_modules ./node_modules
COPY --from=builder /app/packages/cloud/node_modules/.prisma ./node_modules/.prisma

COPY packages/cloud/ ./
COPY packages/shared/ node_modules/@autolander/shared/

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy --schema=prisma/schema.prisma && node src/index.js"]
