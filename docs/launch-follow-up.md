# Launch follow-up

This first PR implements the core product and provides provider seams; it does not complete every future enhancement listed in the original architecture prompt.

## Required before a public launch

- Integration-test actual PostgreSQL/Redis across multiple replicas, Redis disconnect/recovery, concurrent cancellation/matching, pub/sub fan-out, cleanup concurrency and provider failures. The embedded test adapters cannot establish production distributed behavior.
- Set production HTTPS/cookies/origin, trusted reverse-proxy handling, real SMTP, private authenticated data services, encrypted storage/backups, key management, monitoring and staffed moderation.
- Establish an enforceable adult policy, privacy/community terms, moderation response and escalation procedures. Current 18+ acknowledgement is self-attestation.
- Add versioned encryption keys and planned KMS/envelope rotation. Add verified-account deletion/export, legal evidence policy and backup expiry/recovery validation.
- Implement and test the scanner contract before enabling uploads; test storage CORS and presigned size/host behavior. Add orphan-object reconciliation and explicit lifecycle rules.
- Verify LiveKit consent withdrawal, **immediate** media revocation on block/ban/room closure, TURN, network reconnection and mobile devices. The current cleanup process terminates ended calls; a live provider integration has not been certified.
- Add AI output moderation/safety evaluation before enabling public suggestions. A fixed system prompt is not a moderation guarantee.
- Add automated public title/description/link screening, duplicate-room detection and abuse-risk signals. Existing rate limits/reporting are basic controls, not complete content safety.
- Load-test large rooms and discovery under realistic fan-out. Coalesce discovery/count invalidations and add full participant pagination. The app intentionally imposes no global member cap, but no high-concurrency capacity claim is established.

## Product and implementation follow-ups

- Profile images, camera recording controls, audio recording, arbitrary safe-file support, multiple reactions, mute/unmute UI, call device-selection UI, nuanced delivery/read displays and contact-chat restoration.
- Full participant pagination (the current panel shows the first 100), room-owner unmute, share-link rotation/revocation and invitation-password/approval features.
- Discover “active now”, interest/region ranking and full-text indexing once justified. This version sorts by creation time and searches bounded fields with PostgreSQL.
- Structured settings/history pagination across every admin list, user search, report assignment, appeal/unban controls, granular permission tables, richer system-health metrics and audit filters.
- Separate admin deployment if required. The current dedicated `/admin` route shares the PWA bundle and relies on server-enforced roles.
- Durable email/scan notification jobs and a job dashboard; the current worker is a scheduled API-process cleanup routine.
- Offline message queue persistence and background Web Push. This version stores no private API response in service-worker caches, only static app assets. Notifications work while the application is running.
- Bot-proof or semantically “meaningful” ASL evaluation, safer pseudonymous IDs and a full privacy review. Current deterministic message heuristics reduce easy spam but cannot establish human participation.
- Paid reconnect entitlements, subscription/payment workflows, contextual AI replies, group voice/video, E2EE and recommendation systems are later-phase work.

## Verification performed in this workspace

See the PR for final command results. Automated coverage includes real REST/WebSocket identity and membership checks, encrypted persistence, shared/public separation, one-use verification, guest upgrade, block rules, idempotency, ASL participation, consent, RBAC/audit, expiry and cleanup, cursor stability and desktop/mobile browser smoke flows.

Container builds and external provider integrations require their actual runtime/services and credentials. They must be validated independently before deploying this branch to a public production environment.
