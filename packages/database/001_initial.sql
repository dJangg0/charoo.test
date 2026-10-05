CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE users (
 id uuid PRIMARY KEY, email text UNIQUE, verified boolean NOT NULL DEFAULT false,
 display_name text NOT NULL, profile jsonb NOT NULL,
 role text NOT NULL DEFAULT 'USER' CHECK(role IN ('USER','SUPPORT','MODERATOR','ADMIN')),
 banned boolean NOT NULL DEFAULT false, suspended_until timestamptz(3),
 created_at timestamptz(3) NOT NULL DEFAULT now(), guest_expires_at timestamptz(3)
);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, csrf text NOT NULL, expires_at timestamptz(3) NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE email_tokens (token_hash text PRIMARY KEY, email text NOT NULL, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires_at timestamptz(3) NOT NULL);
CREATE TABLE settings (id boolean PRIMARY KEY DEFAULT true CHECK(id), value jsonb NOT NULL);
CREATE TABLE rooms (
 id uuid PRIMARY KEY, type text NOT NULL CHECK(type IN ('STRANGER','PRIVATE','CONTACT','AVAILABLE_TONIGHT','SHARED_GROUP')),
 creator_id uuid NOT NULL REFERENCES users, title text NOT NULL, description text NOT NULL DEFAULT '',
 category text NOT NULL DEFAULT 'Conversation', region text NOT NULL DEFAULT '', tags jsonb NOT NULL DEFAULT '[]',
 verified_only boolean NOT NULL DEFAULT false, share_hash text UNIQUE,
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED')),
 slow_mode integer NOT NULL DEFAULT 0, asl_revealed boolean NOT NULL DEFAULT false,
 created_at timestamptz(3) NOT NULL DEFAULT now(), last_activity timestamptz(3) NOT NULL DEFAULT now(),
 expires_at timestamptz(3), closed_at timestamptz(3), purge_at timestamptz(3),
 UNIQUE(id,type)
);
CREATE INDEX rooms_discovery ON rooms(created_at DESC,id) WHERE type='AVAILABLE_TONIGHT' AND state='OPEN';
CREATE INDEX rooms_expiration ON rooms(expires_at) WHERE state='OPEN';
CREATE INDEX rooms_purge ON rooms(purge_at);
CREATE TABLE participants (
 room_id uuid NOT NULL REFERENCES rooms ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users,
 state text NOT NULL DEFAULT 'JOINED' CHECK(state IN ('JOINED','LEFT','REMOVED')), muted_until timestamptz(3),
 meaningful_count integer NOT NULL DEFAULT 0, last_fingerprint text, last_qualifying_at timestamptz(3),
 last_message_at timestamptz(3), read_at timestamptz(3), joined_at timestamptz(3) NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,user_id)
);
CREATE INDEX participants_user ON participants(user_id,state);
CREATE TABLE messages (
 id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES rooms ON DELETE CASCADE,
 sender_id uuid NOT NULL REFERENCES users, client_message_id uuid NOT NULL, ciphertext text NOT NULL,
 reply_to uuid REFERENCES messages ON DELETE SET NULL, attachment_id uuid,
 created_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(room_id,sender_id,client_message_id)
);
CREATE INDEX messages_history ON messages(room_id,created_at DESC,id DESC);
CREATE TABLE reactions (message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users,emoji text NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
CREATE TABLE blocks (user_id uuid NOT NULL REFERENCES users,target_id uuid NOT NULL REFERENCES users,PRIMARY KEY(user_id,target_id),CHECK(user_id<>target_id));
CREATE TABLE social_requests (
 id uuid PRIMARY KEY, requester_id uuid NOT NULL REFERENCES users,target_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL CHECK(kind IN ('PRIVATE','CONTACT','RECONNECT')), source_room_id uuid REFERENCES rooms ON DELETE SET NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ACCEPTED','REJECTED')), result_room_id uuid REFERENCES rooms ON DELETE SET NULL,
 created_at timestamptz(3) NOT NULL DEFAULT now(),expires_at timestamptz(3) NOT NULL DEFAULT now()+interval '24 hours',CHECK(requester_id<>target_id)
);
CREATE UNIQUE INDEX social_pending ON social_requests(requester_id,target_id,kind) WHERE state='PENDING';
CREATE TABLE contacts (user_a uuid NOT NULL REFERENCES users,user_b uuid NOT NULL REFERENCES users,room_id uuid NOT NULL REFERENCES rooms,PRIMARY KEY(user_a,user_b),CHECK(user_a<user_b));
CREATE TABLE match_history (user_a uuid NOT NULL REFERENCES users,user_b uuid NOT NULL REFERENCES users,room_id uuid REFERENCES rooms ON DELETE SET NULL,matched_at timestamptz(3) NOT NULL DEFAULT now(),PRIMARY KEY(user_a,user_b),CHECK(user_a<user_b));
CREATE TABLE reports (id uuid PRIMARY KEY,reporter_id uuid REFERENCES users,target_id uuid REFERENCES users,room_id uuid REFERENCES rooms ON DELETE SET NULL,message_id uuid REFERENCES messages ON DELETE SET NULL,reason text NOT NULL,state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED')),created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE audit_logs (id uuid PRIMARY KEY,actor_id uuid REFERENCES users,action text NOT NULL,target_id text,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE attachments (id uuid PRIMARY KEY,room_id uuid NOT NULL REFERENCES rooms ON DELETE CASCADE,uploader_id uuid NOT NULL REFERENCES users,object_key text NOT NULL UNIQUE,name text NOT NULL,mime text NOT NULL,size integer NOT NULL,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPROVED','REJECTED')),created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE object_deletions (object_key text PRIMARY KEY,created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE calls (id uuid PRIMARY KEY,room_id uuid NOT NULL REFERENCES rooms ON DELETE CASCADE,caller_id uuid NOT NULL REFERENCES users,target_id uuid NOT NULL REFERENCES users,media_terminated boolean NOT NULL DEFAULT false,state text NOT NULL DEFAULT 'RINGING' CHECK(state IN ('RINGING','ACCEPTED','ENDED')),created_at timestamptz(3) NOT NULL DEFAULT now(),expires_at timestamptz(3) NOT NULL DEFAULT now()+interval '1 hour');
CREATE UNIQUE INDEX calls_active ON calls(room_id) WHERE state IN ('RINGING','ACCEPTED');

CREATE TABLE message_fingerprints (room_id uuid NOT NULL REFERENCES rooms ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users,fingerprint text NOT NULL,PRIMARY KEY(room_id,user_id,fingerprint));
