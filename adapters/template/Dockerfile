# syntax=docker/dockerfile:1
# Local build only — shares the monorepo build context. For standalone builds,
# use the infra/docker/wallet-adapters.Dockerfile multi-stage pattern.

FROM node:24-alpine AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY adapters/template/package.json adapters/template/package.json
COPY packages/delivery-core/package.json packages/delivery-core/package.json
COPY packages/delivery-core/src packages/delivery-core/src
COPY packages/delivery-core/tsconfig.build.json packages/delivery-core/tsconfig.build.json
COPY packages/delivery-core/tsconfig.json packages/delivery-core/tsconfig.json
COPY packages/adapter-contract/package.json packages/adapter-contract/package.json
COPY packages/adapter-contract/src packages/adapter-contract/src
COPY packages/adapter-contract/tsconfig.build.json packages/adapter-contract/tsconfig.build.json
COPY packages/adapter-contract/tsconfig.json packages/adapter-contract/tsconfig.json
COPY adapters/template/src adapters/template/src
COPY adapters/template/tsconfig.build.json adapters/template/tsconfig.build.json
COPY adapters/template/tsconfig.json adapters/template/tsconfig.json
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm run --filter @cashu-fault-lab/delivery-core build
RUN corepack pnpm run --filter @cashu-fault-lab/adapter-contract build
RUN corepack pnpm run --filter @cashu-fault-lab/adapter-template build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/adapters/template/dist /app/dist
COPY --from=build /app/packages/delivery-core/dist /app/packages/delivery-core/dist
COPY --from=build /app/packages/adapter-contract/dist /app/packages/adapter-contract/dist
USER node
ENTRYPOINT ["node", "/app/dist/bin.js"]
