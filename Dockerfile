FROM node:20-slim

# Устанавливаем python3, ffmpeg и ca-certificates для стабильной работы yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем файлы зависимостей и устанавливаем пакеты
COPY package*.json ./
RUN npm ci

# Копируем остальной код проекта и собираем приложение
COPY . .
RUN npm run build

# Открываем порт (7860 подходит для Hugging Face Spaces, 3000 — для Render и остальных)
EXPOSE 7860
ENV PORT=7860
ENV HOSTNAME="0.0.0.0"

CMD ["npm", "start"]