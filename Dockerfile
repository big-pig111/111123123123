FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || true
COPY . .
RUN npm install --omit=dev --no-audit --no-fund
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.webhook.js"]


