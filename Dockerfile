FROM node:20-slim

# Instala Ghostscript — responsável pela compressão real dos PDFs
RUN apt-get update && apt-get install -y ghostscript && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

ENV PORT=8080
CMD ["node", "index.js"]