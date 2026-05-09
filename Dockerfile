FROM node:18-slim
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://get.docker.com | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
