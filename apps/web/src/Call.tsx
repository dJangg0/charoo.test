import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { api } from "./api";
export function VideoCall({
  callId,
  onEnd,
  onError,
}: {
  callId: string;
  onEnd: () => void;
  onError: (s: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    room = useRef<Room | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const r = new Room();
    room.current = r;
    const attach = (track: any) => {
      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
        const element = track.attach();
        if (track.kind === Track.Kind.Video) element.playsInline = true;
        container.current?.appendChild(element);
      }
    };
    r.on(RoomEvent.TrackSubscribed, attach);
    r.on(RoomEvent.LocalTrackPublished, (p) => {
      if (p.track?.kind === Track.Kind.Video) attach(p.track);
    });
    r.on(RoomEvent.TrackUnsubscribed, (t) =>
      t.detach().forEach((e) => e.remove()),
    );
    r.on(RoomEvent.Disconnected, () => {
      if (!cancelled) onEnd();
    });
    (async () => {
      try {
        const value = await api(`/calls/${callId}/token`, "POST", {});
        if (cancelled) return;
        await r.connect(value.url, value.token);
        if (cancelled) {
          await r.disconnect();
          return;
        }
        await r.localParticipant.setCameraEnabled(true);
        await r.localParticipant.setMicrophoneEnabled(true);
        setReady(true);
      } catch (e) {
        onError((e as Error).message);
        await r.disconnect();
      }
    })();
    return () => {
      cancelled = true;
      r.disconnect();
    };
  }, [callId]);
  return (
    <div className="video-panel">
      <div ref={container} className="video-grid" />
      {!ready && <p>Connecting camera and microphone…</p>}
      <button
        className="danger"
        onClick={async () => {
          try {
            await api(`/calls/${callId}/end`, "POST", {});
            await room.current?.disconnect();
            onEnd();
          } catch (e) {
            onError((e as Error).message);
          }
        }}
      >
        End call
      </button>
    </div>
  );
}
