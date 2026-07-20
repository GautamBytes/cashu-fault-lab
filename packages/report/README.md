# @cashu-fault-lab/report

Redacts sensitive data and renders scenario run results as JSON, JUnit XML, or self-contained HTML reports.

## Purpose

Takes a `ScenarioRunResult` and produces a redacted report suitable for CI (JUnit), debugging (JSON), or browser review (HTML). All bearer material (secrets, proofs, tokens) is stripped before output.

## Key exports

- `renderJson` — pretty-printed JSON report
- `renderJunit` — JUnit XML for CI test reporting
- `renderHtml` — self-contained HTML page with timeline and evidence

## Tests

```bash
pnpm --filter @cashu-fault-lab/report test
```
