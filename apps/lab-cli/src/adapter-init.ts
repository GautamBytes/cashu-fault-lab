import { currentAdapterContract } from '@cashu-fault-lab/adapter-contract';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const supportedAdapterLanguages = ['typescript', 'rust', 'python'] as const;
export type AdapterTemplateLanguage = (typeof supportedAdapterLanguages)[number];
export type AdapterTemplateRole = 'sender' | 'receiver' | 'both';

export interface ScaffoldAdapterProjectOptions {
  readonly language: AdapterTemplateLanguage;
  readonly name: string;
  readonly role?: AdapterTemplateRole;
  readonly output?: string;
}

export interface ScaffoldAdapterProjectResult {
  readonly output: string;
  readonly language: AdapterTemplateLanguage;
  readonly name: string;
  readonly role: AdapterTemplateRole;
  readonly files: readonly string[];
}

interface TemplateContext {
  readonly name: string;
  readonly language: AdapterTemplateLanguage;
  readonly role: AdapterTemplateRole;
  readonly moduleName: string;
  readonly tokenEnv: string;
  readonly capabilitiesJson: string;
  readonly capabilitiesPretty: string;
  readonly manifestPretty: string;
}

type FileMap = Readonly<Record<string, string>>;

const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;

function assertLanguage(value: string): asserts value is AdapterTemplateLanguage {
  if (!(supportedAdapterLanguages as readonly string[]).includes(value)) {
    throw new Error(`Unsupported adapter language: ${value}`);
  }
}

function validateProjectName(name: string): void {
  if (!PROJECT_NAME.test(name) || name.includes('--') || name.endsWith('-')) {
    throw new Error(
      'Adapter project name must start with a lowercase letter and contain only lowercase letters, digits, and single hyphens.',
    );
  }
}

function moduleName(name: string): string {
  return name.replace(/-/gu, '_');
}

function tokenEnv(name: string): string {
  return `${name.toUpperCase().replace(/-/gu, '_')}_TOKEN`;
}

function roleCapabilities(role: AdapterTemplateRole): Readonly<Record<string, unknown>> {
  const capability = {
    transports: ['http'],
    profiles: ['delivery-v1'],
    durability: 'process',
    evidence: { tier: 'T0', sources: ['adapter'] },
  };
  return {
    ...(role === 'sender' || role === 'both' ? { sender: capability } : {}),
    ...(role === 'receiver' || role === 'both' ? { receiver: capability } : {}),
  };
}

function templateContext(
  language: AdapterTemplateLanguage,
  name: string,
  role: AdapterTemplateRole,
): TemplateContext {
  const capabilities = {
    schemaVersion: 2,
    contract: currentAdapterContract(),
    implementation: {
      id: name,
      version: '0.1.0',
      language,
      runtime:
        language === 'rust' ? 'rust-1.97' : language === 'python' ? 'python-3.12' : 'node-24',
      sourceDigest: `sha256:${'00'.repeat(32)}`,
      buildDigest: `sha256:${'00'.repeat(32)}`,
    },
    roles: roleCapabilities(role),
    nuts: [18],
    encodings: ['creqA'],
    mints: [],
  };
  const manifest = {
    schemaVersion: 1,
    adapters: [{ id: name, url: 'http://127.0.0.1:4100', tokenEnv: tokenEnv(name) }],
  };
  return {
    name,
    language,
    role,
    moduleName: moduleName(name),
    tokenEnv: tokenEnv(name),
    capabilitiesJson: JSON.stringify(capabilities),
    capabilitiesPretty: `${JSON.stringify(capabilities, null, 2)}\n`,
    manifestPretty: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function commonFiles(context: TemplateContext): FileMap {
  return {
    'adapter-manifest.json': context.manifestPretty,
    '.dockerignore': `node_modules
dist
target
.venv
__pycache__
.pytest_cache
.git
`,
    '.env.example': `${context.tokenEnv}=replace-with-a-local-control-token\nPORT=4100\n`,
  };
}

function typescriptTemplate(context: TemplateContext): FileMap {
  const packageJson = {
    name: context.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=24 <25' },
    scripts: {
      build: 'tsc --project tsconfig.json',
      start: 'node dist/bin.js',
      test: 'vitest run',
    },
    dependencies: {
      fastify: '^5.0.0',
    },
    devDependencies: {
      '@types/node': '^26.0.0',
      typescript: '^7.0.0',
      vitest: '^4.0.0',
    },
  };
  return {
    ...commonFiles(context),
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'src/contract.ts': `export const contract = ${context.capabilitiesJson} as const;

export const routeCount = 7 as const;

export interface UnsupportedResponse {
  readonly status: 'not_applicable';
  readonly reason: string;
}
`,
    'src/server.ts': `import Fastify from 'fastify';
import { contract, type UnsupportedResponse } from './contract.js';

export interface ServerOptions {
  readonly token?: string;
}

function unsupported(reason: string): UnsupportedResponse {
  return { status: 'not_applicable', reason };
}

export function buildServer(options: ServerOptions = {}) {
  const token = options.token ?? process.env.${context.tokenEnv};
  if (token === undefined || token.length === 0) {
    throw new Error('${context.tokenEnv} is required');
  }
  const server = Fastify({ logger: true });

  server.get('/healthz', async () => ({ ok: true }));
  server.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return;
    if (request.headers.authorization !== \`Bearer \${token}\`) {
      await reply.code(401).send({ code: 'unauthorized' });
    }
  });

  server.get('/v1/capabilities', async () => contract);
  server.post('/v1/reset', async (_request, reply) =>
    reply.code(501).send(unsupported('reset route is not implemented')),
  );
  server.post('/v1/requests', async (_request, reply) =>
    reply.code(501).send(unsupported('request creation is not implemented')),
  );
  server.post('/v1/send', async (_request, reply) =>
    reply.code(501).send(unsupported('send route is not implemented')),
  );
  server.get('/v1/deliveries/:deliveryId', async (_request, reply) =>
    reply.code(501).send(unsupported('delivery lookup is not implemented')),
  );
  server.get('/v1/ledger', async (_request, reply) =>
    reply.code(501).send(unsupported('ledger evidence is not implemented')),
  );
  server.get('/v1/proofs', async (_request, reply) =>
    reply.code(501).send(unsupported('proof evidence is not implemented')),
  );

  return server;
}
`,
    'src/bin.ts': `import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 4100);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const server = buildServer();
await server.listen({ host: '0.0.0.0', port });
`,
    'test/contract.test.ts': `import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const token = 'test-token';
const auth = { authorization: \`Bearer \${token}\` };

describe('${context.name} adapter contract surface', () => {
  it('exposes health and seven authenticated contract routes', async () => {
    const server = buildServer({ token });
    try {
      expect((await server.inject('/healthz')).statusCode).toBe(200);
      expect((await server.inject('/v1/capabilities')).statusCode).toBe(401);
      const capabilities = await server.inject({ method: 'GET', url: '/v1/capabilities', headers: auth });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toMatchObject({ implementation: { id: '${context.name}' } });
      for (const request of [
        { method: 'POST', url: '/v1/reset', payload: { seed: 'test' } },
        { method: 'POST', url: '/v1/requests', payload: { amount: 1, unit: 'sat', transports: ['http'], singleUse: true, expiresIn: 60 } },
        { method: 'POST', url: '/v1/send', payload: { request: 'creqAexample' } },
        { method: 'GET', url: '/v1/deliveries/AAECAwQFBgcICQoLDA0ODw' },
        { method: 'GET', url: '/v1/ledger' },
        { method: 'GET', url: '/v1/proofs' },
      ] as const) {
        const response = await server.inject({ ...request, headers: auth });
        expect(response.statusCode).toBe(501);
        expect(response.json()).toMatchObject({ status: 'not_applicable' });
      }
    } finally {
      await server.close();
    }
  });
});
`,
    Dockerfile: `FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN corepack enable && pnpm install

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4100
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
HEALTHCHECK --interval=5s --timeout=2s --retries=12 CMD node -e "fetch('http://127.0.0.1:4100/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/bin.js"]
`,
    'README.md': `# ${context.name}

Standalone TypeScript Cashu Fault Lab adapter scaffold.

## Run

\`\`\`bash
pnpm install
cp .env.example .env
${context.tokenEnv}=local-token pnpm test
${context.tokenEnv}=local-token pnpm build
${context.tokenEnv}=local-token pnpm start
\`\`\`

The scaffold exposes \`/healthz\`, \`/v1/capabilities\`, and six explicit \`501/not_applicable\` route stubs for the delivery contract.
`,
    '.github/workflows/ci.yml': `name: Adapter CI

on:
  pull_request:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: corepack enable
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
      - run: docker build .
`,
  };
}

function rustTemplate(context: TemplateContext): FileMap {
  return {
    ...commonFiles(context),
    'Cargo.toml': `[package]
name = "${context.name}"
version = "0.1.0"
edition = "2024"
rust-version = "1.97"

[dependencies]
axum = "0.8"
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "signal"] }
tower-http = { version = "0.6", features = ["trace"] }

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
`,
    'src/contract.rs': `pub const CAPABILITIES: &str = r#"${context.capabilitiesJson}"#;
`,
    'src/main.rs': `mod contract;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    env,
    net::{SocketAddr, TcpStream},
    process,
    sync::Arc,
    time::Duration,
};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
}

async fn authorize(State(state): State<AppState>, headers: HeaderMap, request: axum::extract::Request, next: Next) -> Response {
    let expected = format!("Bearer {}", state.token);
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|actual| actual == expected);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "code": "unauthorized" }))).into_response();
    }
    next.run(request).await
}

async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn capabilities() -> Json<Value> {
    Json(serde_json::from_str(contract::CAPABILITIES).expect("valid capabilities"))
}

async fn not_applicable() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "status": "not_applicable", "reason": "route is not implemented" })),
    )
}

fn app_with_token(token: String) -> Router {
    let state = AppState { token: Arc::new(token) };
    let contract_routes = Router::new()
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/reset", post(not_applicable))
        .route("/v1/requests", post(not_applicable))
        .route("/v1/send", post(not_applicable))
        .route("/v1/deliveries/{delivery_id}", get(not_applicable))
        .route("/v1/ledger", get(not_applicable))
        .route("/v1/proofs", get(not_applicable))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    Router::new()
        .route("/healthz", get(healthz))
        .merge(contract_routes)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let port = env::var("PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(4100);
    if env::args().any(|arg| arg == "--healthcheck") {
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        if TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_err() {
            process::exit(1);
        }
        return;
    }
    let token = env::var("${context.tokenEnv}").expect("${context.tokenEnv} is required");
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .expect("bind adapter listener");
    axum::serve(listener, app_with_token(token)).await.expect("serve adapter");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Method, Request},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn exposes_health_and_contract_routes() {
        let app = app_with_token("test-token".to_string());
        let health = app
            .clone()
            .oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let auth = "Bearer test-token";
        let routes = [
            (Method::GET, "/v1/capabilities", StatusCode::OK),
            (Method::POST, "/v1/reset", StatusCode::NOT_IMPLEMENTED),
            (Method::POST, "/v1/requests", StatusCode::NOT_IMPLEMENTED),
            (Method::POST, "/v1/send", StatusCode::NOT_IMPLEMENTED),
            (Method::GET, "/v1/deliveries/AAECAwQFBgcICQoLDA0ODw", StatusCode::NOT_IMPLEMENTED),
            (Method::GET, "/v1/ledger", StatusCode::NOT_IMPLEMENTED),
            (Method::GET, "/v1/proofs", StatusCode::NOT_IMPLEMENTED),
        ];
        for (method, uri, status) in routes {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("authorization", auth)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
    }
}
`,
    Dockerfile: `FROM rust:1.97 AS build
WORKDIR /app
COPY . .
RUN cargo test
RUN cargo build --release

FROM debian:trixie-slim
WORKDIR /app
ENV PORT=4100
COPY --from=build /app/target/release/${context.name} /usr/local/bin/${context.name}
HEALTHCHECK --interval=5s --timeout=2s --retries=12 CMD ["/usr/local/bin/${context.name}", "--healthcheck"]
CMD ["/usr/local/bin/${context.name}"]
`,
    'README.md': `# ${context.name}

Standalone Rust Cashu Fault Lab adapter scaffold.

## Run

\`\`\`bash
cargo test
${context.tokenEnv}=local-token cargo run
\`\`\`

The scaffold uses Rust 1.97, edition 2024, Axum, and Tokio. It exposes \`/healthz\`, \`/v1/capabilities\`, and six explicit \`501/not_applicable\` route stubs.
`,
    '.github/workflows/ci.yml': `name: Adapter CI

on:
  pull_request:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: 1.97
      - run: cargo test
      - run: docker build .
`,
  };
}

function pythonTemplate(context: TemplateContext): FileMap {
  return {
    ...commonFiles(context),
    'pyproject.toml': `[project]
name = "${context.name}"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.125",
  "pydantic>=2",
  "uvicorn[standard]>=0.38",
]

[project.optional-dependencies]
test = ["pytest>=9", "httpx>=0.28"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
`,
    [`src/${context.moduleName}/__init__.py`]: '',
    [`src/${context.moduleName}/contract.py`]: `CAPABILITIES = ${context.capabilitiesPretty}`,
    [`src/${context.moduleName}/main.py`]: `import os
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .contract import CAPABILITIES

security = HTTPBearer(auto_error=False)
app = FastAPI(title="${context.name} Cashu Fault Lab Adapter")


def require_auth(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> None:
    token = os.getenv("${context.tokenEnv}")
    if not token:
        raise RuntimeError("${context.tokenEnv} is required")
    if credentials is None or credentials.scheme.lower() != "bearer" or credentials.credentials != token:
        raise HTTPException(status_code=401, detail={"code": "unauthorized"})


def unsupported(reason: str) -> dict[str, str]:
    return {"status": "not_applicable", "reason": reason}


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get("/v1/capabilities", dependencies=[Depends(require_auth)])
def capabilities() -> dict:
    return CAPABILITIES


@app.post("/v1/reset", status_code=501, dependencies=[Depends(require_auth)])
def reset() -> dict[str, str]:
    return unsupported("reset route is not implemented")


@app.post("/v1/requests", status_code=501, dependencies=[Depends(require_auth)])
def create_request() -> dict[str, str]:
    return unsupported("request creation is not implemented")


@app.post("/v1/send", status_code=501, dependencies=[Depends(require_auth)])
def send() -> dict[str, str]:
    return unsupported("send route is not implemented")


@app.get("/v1/deliveries/{delivery_id}", status_code=501, dependencies=[Depends(require_auth)])
def delivery(delivery_id: str) -> dict[str, str]:
    return unsupported(f"delivery {delivery_id} lookup is not implemented")


@app.get("/v1/ledger", status_code=501, dependencies=[Depends(require_auth)])
def ledger() -> dict[str, str]:
    return unsupported("ledger evidence is not implemented")


@app.get("/v1/proofs", status_code=501, dependencies=[Depends(require_auth)])
def proofs() -> dict[str, str]:
    return unsupported("proof evidence is not implemented")
`,
    'tests/test_contract.py': `from fastapi.testclient import TestClient

from ${context.moduleName}.main import app


def test_health_and_contract_routes(monkeypatch):
    monkeypatch.setenv("${context.tokenEnv}", "test-token")
    client = TestClient(app)
    auth = {"Authorization": "Bearer test-token"}

    assert client.get("/healthz").status_code == 200
    assert client.get("/v1/capabilities").status_code == 401
    capabilities = client.get("/v1/capabilities", headers=auth)
    assert capabilities.status_code == 200
    assert capabilities.json()["implementation"]["id"] == "${context.name}"

    routes = [
        ("post", "/v1/reset"),
        ("post", "/v1/requests"),
        ("post", "/v1/send"),
        ("get", "/v1/deliveries/AAECAwQFBgcICQoLDA0ODw"),
        ("get", "/v1/ledger"),
        ("get", "/v1/proofs"),
    ]
    for method, path in routes:
        response = getattr(client, method)(path, headers=auth)
        assert response.status_code == 501
        assert response.json()["status"] == "not_applicable"
`,
    Dockerfile: `FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir ".[test]" && pytest
ENV PORT=4100
HEALTHCHECK --interval=5s --timeout=2s --retries=12 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4100/healthz', timeout=2)"
CMD ["sh", "-c", "uvicorn ${context.moduleName}.main:app --host 0.0.0.0 --port \${PORT:-4100}"]
`,
    'README.md': `# ${context.name}

Standalone Python Cashu Fault Lab adapter scaffold.

## Run

\`\`\`bash
python -m pip install -e ".[test]"
${context.tokenEnv}=local-token pytest
${context.tokenEnv}=local-token uvicorn ${context.moduleName}.main:app --host 0.0.0.0 --port 4100
\`\`\`

The scaffold uses Python 3.12+, FastAPI, and Pydantic-ready type hints. It exposes \`/healthz\`, \`/v1/capabilities\`, and six explicit \`501/not_applicable\` route stubs.
`,
    '.github/workflows/ci.yml': `name: Adapter CI

on:
  pull_request:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-python@v6
        with:
          python-version: "3.12"
      - run: python -m pip install -e ".[test]"
      - run: pytest
      - run: docker build .
`,
  };
}

function filesFor(context: TemplateContext): FileMap {
  if (context.language === 'typescript') return typescriptTemplate(context);
  if (context.language === 'rust') return rustTemplate(context);
  return pythonTemplate(context);
}

async function destinationState(
  output: string,
): Promise<'missing' | 'empty-directory' | 'blocked'> {
  try {
    const info = await stat(output);
    if (!info.isDirectory()) return 'blocked';
    return (await readdir(output)).length === 0 ? 'empty-directory' : 'blocked';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function writeFiles(root: string, files: FileMap): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFile(path, contents, { encoding: 'utf8', mode: 0o644 });
  }
}

export async function scaffoldAdapterProject(
  options: ScaffoldAdapterProjectOptions,
): Promise<ScaffoldAdapterProjectResult> {
  assertLanguage(options.language);
  const role = options.role ?? 'both';
  if (role !== 'sender' && role !== 'receiver' && role !== 'both') {
    throw new Error('Adapter role must be sender, receiver, or both.');
  }
  validateProjectName(options.name);
  const output = resolve(options.output ?? options.name);
  if (basename(output) === '' || output === dirname(output)) {
    throw new Error('Adapter output path is invalid.');
  }

  const state = await destinationState(output);
  if (state === 'blocked') {
    throw new Error('Adapter output directory already exists and is non-empty.');
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const temp = join(parent, `.${basename(output)}.tmp-${process.pid}-${randomUUID()}`);
  const context = templateContext(options.language, options.name, role);
  const files = filesFor(context);
  try {
    await mkdir(temp, { mode: 0o755 });
    await writeFiles(temp, files);
    if (state === 'empty-directory') await rmdir(output);
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return {
    output,
    language: options.language,
    name: options.name,
    role,
    files: Object.keys(files).sort(),
  };
}
