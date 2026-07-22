FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node-build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build \
    --filter=@cashu-fault-lab/adapter-cashu-ts \
    --filter=@cashu-fault-lab/nostr-fault-relay \
    --filter=@cashu-fault-lab/reference-receiver \
    --filter=@cashu-fault-lab/http-fault-gateway

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node-wallets

WORKDIR /app
ENV NODE_ENV=production
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/adapters/cashu-ts ./adapters/cashu-ts
COPY --from=node-build /app/apps ./apps
COPY --from=node-build /app/packages ./packages
COPY --from=node-build /app/infra ./infra
COPY --from=node-build /app/spec ./spec
USER node

FROM rust:1.97-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa AS cdk-build

WORKDIR /app
COPY adapters/cdk ./adapters/cdk
RUN cargo build --locked --release --manifest-path adapters/cdk/Cargo.toml

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS cdk-adapter

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=cdk-build /app/adapters/cdk/target/release/cashu-fault-lab-cdk-adapter /usr/local/bin/cashu-fault-lab-cdk-adapter
USER 65532:65532
ENTRYPOINT ["cashu-fault-lab-cdk-adapter"]

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS lab-netns

RUN apk add --no-cache socat
CMD ["socat", "TCP-LISTEN:3338,bind=0.0.0.0,fork,reuseaddr", "TCP:nutshell:3338"]
