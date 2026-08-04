"""Generated Cashu Fault Lab wallet-doctor artifact contract."""

from dataclasses import dataclass
from typing import Optional

__spec_digest__ = "sha256:d9cd1c5bfc03e2a3b590b98ff2691d59257fcb842243cf66cd0a9c6b0431dd3a"
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
