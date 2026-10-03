FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY data ./data
ENV STATE_DIR=/data/state
VOLUME /data/state
EXPOSE 8787
CMD ["node", "src/cli.js", "run"]
