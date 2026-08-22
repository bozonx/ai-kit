ARG NODE_MAJOR=22
FROM node:${NODE_MAJOR}-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=8080
ENV TZ=UTC
ENV LOG_LEVEL=warn

# Install tini for better signal handling
RUN apk add --no-cache tini

# Install pnpm
RUN corepack enable

# Copy runtime files
COPY package.json pnpm-lock.yaml ./
COPY config.yaml models.yaml ./
RUN pnpm install --prod --frozen-lockfile --prefer-offline || pnpm install --prod --prefer-offline

COPY public ./public
# Copy pre-built application
COPY dist ./dist

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/src/main.js"]
