FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:25-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/infancia-feliz.sqlite
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js infancia-feliz-v27.html app.js manifest.json sw.js icon-192.png icon-512.png package.json ./
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "server.js"]
