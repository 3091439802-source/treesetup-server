FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV MONGOMS_DISABLE_POSTINSTALL=1
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src

EXPOSE 3000
CMD ["node", "src/app.js"]
