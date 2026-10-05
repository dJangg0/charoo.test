# Provider contracts

## SMTP

The API uses Nodemailer with `SMTP_URL` and `EMAIL_FROM`. It sends an email verification link with a 15-minute, one-use token in the URL fragment. Tokens are hashed in PostgreSQL. The fragment is consumed by the web app and exchanged through an origin-checked POST. It does not become an HTTP access-log query string.

Mail failures currently surface a generic retryable error. The browser does not mark an email verified until the token is exchanged successfully. A production email job queue and delivery monitoring are follow-up work.

## S3-compatible storage and scanning

The bucket must be private, encrypted at rest and accessible only to narrowly scoped application/scanner identities. A development MinIO instance is included; bucket creation, encryption, credentials and CORS configuration are operator tasks.

Configure bucket CORS for **only your frontend origin**, `PUT` and the signed content headers. Do not confuse this storage-specific rule with API CORS; the API independently requires an exact trusted origin and CSRF tokens for session-authenticated mutations.

`S3_ENDPOINT` is the server's storage endpoint. `S3_PUBLIC_ENDPOINT`, if present, is used to sign browser/scanner URLs. In production it should be a publicly reachable HTTPS storage hostname with the same bucket/key mapping. Never expose the MinIO console to the public internet.

Upload flow:

1. Authorized room member requests upload initialization with a validated filename, MIME and size. The API checks server-configured limits and public-room media policy.
2. The client receives a five-minute presigned `PUT` to a quarantine key.
3. After upload, the API checks stored length and content type.
4. The authenticated scanner receives a read URL and a different write URL for a sanitized approved object. The original uploader never receives the approved-object write URL.
5. The scanner validates magic bytes and media structure, scans for malware and unsafe content, strips metadata and **writes the sanitized file** to the supplied write URL with the same allowed MIME.
6. The scanner returns all required booleans. Any missing, false, invalid or unavailable result fails closed. The API checks the approved object's size and MIME and only then marks it approved.
7. Downloads require current room membership and block checks. The API returns a 60-second URL with attachment disposition and an octet-stream response.
8. Quarantine objects and expired approved objects enter a persistent deletion queue. The cleanup worker retries failed deletions.

Scanner POST request:

```json
{
  "url": "https://storage.example/quarantine/...?...",
  "writeUrl": "https://storage.example/approved/...?...",
  "mime": "image/jpeg",
  "size": 12345,
  "stripMetadata": true
}
```

Header: `Authorization: Bearer <MEDIA_SCANNER_TOKEN>`.

Scanner response **after writing the sanitized object**:

```json
{
  "clean": true,
  "magicBytesValid": true,
  "metadataStripped": true,
  "contentSafe": true
}
```

Keep both URLs out of scanner/application logs. The scanner must reject decompression bombs, malformed files and unsupported content, bound CPU/memory/processing time, and enforce the declared file type against actual bytes. It must not follow arbitrary embedded links. The API does not claim that a MIME/extension check replaces scanning.

A production object lifecycle rule should additionally bound leftover objects from interrupted scanning; account for the maximum room lifetime plus post-closure retention before expiring approved objects. Monitor the deletion queue. A scanner can produce an approved object and then fail before the database commit; use a lifecycle rule and reconcile orphan objects to bound that case.

## LiveKit

Configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `video_enabled`. The caller invites a member of an authorized 1-to-1 conversation. The recipient must explicitly accept before either party can obtain a room-scoped token. Tokens have a five-minute issuance TTL; the call record expires after one hour. This is not a guarantee that an already-connected media participant is disconnected merely because a token expires.

Ending a call marks it ended and deletes its LiveKit room. Blocking, banning/suspending, and closing a conversation also request immediate media termination, with persistent retries after provider failures. The cleanup worker retries ended-room termination and expires call records. Test cached-token replay/reconnect after termination against your LiveKit deployment; the application refusing new tokens does not itself revoke already-issued provider credentials. Configure TURN/STUN in LiveKit and test camera/microphone support on actual Android/iOS PWAs. Media authorization/revocation during a ban/block/room closure is part of the launch integration checklist; do not launch calls until that behavior is verified with the provider.

## AI suggestions

`AI_BASE_URL` must be an operator-controlled HTTPS OpenAI-compatible API base path; do not accept it from users. Configure `AI_API_KEY`, `AI_MODEL` and `AI_assistant_enabled`.

The current endpoint accepts a bounded style enum (`icebreaker`, `playful`, `reply`, `revive`), sends a fixed adult-safe system prompt and asks for a short suggestion. It sends no chat history, exact location, profile data or peer content. “Reply” is consequently a generic suggestion rather than a contextual reply. The suggestion appears in the composer for review; sending requires the user's action.

A system prompt alone does not certify output safety. Add provider output moderation, content policy evaluation and abuse monitoring before enabling this feature publicly. Keep provider keys in a secret manager and do not log prompts or completions. Fine-tuning and payments are intentionally absent.
