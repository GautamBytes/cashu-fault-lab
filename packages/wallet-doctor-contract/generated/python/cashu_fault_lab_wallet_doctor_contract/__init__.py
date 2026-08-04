"""Generated Cashu Fault Lab wallet-doctor artifact contract."""

from dataclasses import dataclass
from typing import Optional

__spec_digest__ = "sha256:2e972596094411d00ec09a3f2a0233f99cbfd69ab027a93e83e0409bab5a5e46"
__capture_schema_version__ = 2

@dataclass(frozen=True)
class CaptureMetadata:
    captured_at: str
    digest: str
    subject: str

@dataclass(frozen=True)
class RelayEvidence:
    url: str
    status: str
    error: Optional[str]
    event_ids: tuple[str, ...]

@dataclass(frozen=True)
class ArtifactReference:
    schema_version: int
    kind: str
    generated_from: str
