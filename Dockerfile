FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts --omit=optional && npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/gateway/package.json ./packages/gateway/package.json
RUN npm ci --ignore-scripts --omit=dev --workspace=@dsh-mobile/gateway --workspace=@dsh-mobile/protocol && npm cache clean --force
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/gateway/dist ./packages/gateway/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/gateway/dist/main.js"]
