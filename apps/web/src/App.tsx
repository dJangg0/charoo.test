import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Sparkles,
  Compass,
  Shuffle,
  Users,
  Link,
  MessageCircle,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Search,
  Shield,
  Settings,
  LogOut,
  Menu,
  X,
  Send,
  Paperclip,
  Video,
  Flag,
  Heart,
  Clock,
  ChevronLeft,
  Check,
  Download,
  Globe,
  Radio,
} from "lucide-react";
import {
  categories,
  type User,
  type Room,
  type Message,
  type Settings as AppSettings,
} from "@charoo/contracts";
import { api, setCsrf } from "./api";
const VideoCall = lazy(() =>
  import("./Call").then((m) => ({ default: m.VideoCall })),
);
type Page =
  "tonight" | "strangers" | "groups" | "contacts" | "profile" | "admin";
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
const field = (form: HTMLFormElement, name: string) =>
  String(new FormData(form).get(name) || "");
export function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState<Page>(
      location.pathname.startsWith("/admin") ? "admin" : "tonight",
    ),
    [settings, setSettings] = useState<AppSettings | null>(null),
    [rooms, setRooms] = useState<Room[]>([]),
    [conversations, setConversations] = useState<Room[]>([]),
    [active, setActive] = useState<any>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [draft, setDraft] = useState(""),
    [status, setStatus] = useState("Online"),
    [queue, setQueue] = useState(false),
    [modal, setModal] = useState<string | null>(null),
    [toast, setToast] = useState(""),
    [error, setError] = useState(false),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [requests, setRequests] = useState<any[]>([]),
    [contacts, setContacts] = useState<any[]>([]),
    [history, setHistory] = useState<any[]>([]),
    [blocks, setBlocks] = useState<any[]>([]),
    [shareUrl, setShareUrl] = useState(""),
    [connected, setConnected] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [pending, setPending] = useState<any[]>([]),
    [reply, setReply] = useState<Message | null>(null),
    [typing, setTyping] = useState(false),
    [admin, setAdmin] = useState<any>(null),
    [adminReports, setAdminReports] = useState<any[]>([]),
    [adminRooms, setAdminRooms] = useState<any[]>([]),
    [audit, setAudit] = useState<any[]>([]),
    [calls, setCalls] = useState<any[]>([]),
    [callId, setCallId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [feedNext, setFeedNext] = useState<string | null>(null),
    [messageNext, setMessageNext] = useState<string | null>(null),
    [install, setInstall] = useState<any>(null);
  const ws = useRef<WebSocket | null>(null),
    activeRef = useRef<any>(null),
    userRef = useRef<User | null>(null),
    statusRef = useRef(status),
    actionRef = useRef<(e: any) => void>(() => {}),
    acks = useRef(
      new Map<string, { resolve: () => void; reject: () => void }>(),
    ),
    chatEnd = useRef<HTMLDivElement>(null),
    typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    explicitAvailable = useRef(false);
  activeRef.current = active;
  userRef.current = user;
  statusRef.current = status;
  const notify = (text: string, isError = false) => {
    setToast(text);
    setError(isError);
  };
  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      notify((e as Error).message, true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  async function me() {
    const result = await api("/me");
    setUser(result.user);
    userRef.current = result.user;
    setCsrf(result.csrf);
    setSettings(result.settings);
    return result;
  }
  async function loadRooms(more = false) {
    if (!userRef.current?.verified) return;
    const result = await api(
      `/rooms?q=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}${more && feedNext ? `&before=${encodeURIComponent(feedNext)}` : ""}`,
    );
    setRooms((prev) =>
      more
        ? [
            ...prev,
            ...result.rooms.filter(
              (r: Room) => !prev.some((p) => p.id === r.id),
            ),
          ]
        : result.rooms,
    );
    setFeedNext(result.next);
  }
  async function loadSocial() {
    const [cs, rs, cts, hs, bs, vs] = await Promise.all([
      api("/conversations"),
      api("/requests"),
      api("/contacts"),
      api("/reconnect"),
      api("/blocks"),
      api("/calls"),
    ]);
    setConversations(cs);
    setRequests(rs);
    setContacts(cts);
    setHistory(hs);
    setBlocks(bs);
    setCalls(vs);
  }
  async function openRoom(id: string) {
    const room = await api(`/rooms/${id}`),
      result = await api(`/rooms/${id}/messages`);
    setActive(room);
    activeRef.current = room;
    setMessages(result.messages);
    setMessageNext(result.next);
    setQueue(false);
    setDraft("");
    setReply(null);
    setTyping(false);
    if (ws.current?.readyState === 1)
      ws.current.send(JSON.stringify({ type: "subscribe", roomId: id }));
    await api(`/rooms/${id}/read`, "POST", {});
  }
  async function refreshChat() {
    const room = activeRef.current;
    if (!room) return;
    try {
      const [data, meta] = await Promise.all([
        api(`/rooms/${room.id}/messages`),
        api(`/rooms/${room.id}`),
      ]);
      setMessages(data.messages);
      setMessageNext(data.next);
      setActive(meta);
      await api(`/rooms/${room.id}/read`, "POST", {});
    } catch (e) {
      setActive(null);
      activeRef.current = null;
      notify((e as Error).message, true);
    }
  }
  async function heartbeat() {
    if (!userRef.current) return;
    const value = await api("/presence", "POST", {
      status: statusRef.current,
      roomId: activeRef.current?.id,
      heartbeat: !explicitAvailable.current,
    });
    explicitAvailable.current = false;
    setStatus(value.status);
  }
  async function loadAdmin() {
    const [d, r, rs] = await Promise.all([
      api("/admin/dashboard"),
      api("/admin/reports"),
      api("/admin/rooms"),
    ]);
    setAdmin(d);
    setAdminReports(r);
    setAdminRooms(rs);
    if (userRef.current?.role === "ADMIN") setAudit(await api("/admin/audit"));
  }
  async function joinShared() {
    const t = new URLSearchParams(location.hash.slice(1)).get("room");
    if (t) {
      const room = await api("/shared/join", "POST", { token: t });
      location.hash = "";
      await openRoom(room.id);
    }
  }
  useEffect(() => {
    (async () => {
      try {
        const verification = new URLSearchParams(location.hash.slice(1)).get(
          "verify",
        );
        if (verification) {
          location.hash = "";
          const result = await api("/auth/verify", "POST", {
            token: verification,
          });
          setCsrf(result.csrf);
          notify("Email verified. Welcome to Charoo.");
        }
        await me();
      } catch (e) {
        if (!String((e as Error).message).includes("Sign in"))
          notify((e as Error).message, true);
      } finally {
        setLoading(false);
      }
    })();
    const listener = (e: Event) => {
      e.preventDefault();
      setInstall(e);
    };
    window.addEventListener("beforeinstallprompt", listener);
    return () => window.removeEventListener("beforeinstallprompt", listener);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 6500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    if (!user) return;
    act(async () => {
      await heartbeat();
      await loadSocial();
      await joinShared();
    });
    const t = setInterval(
      () => heartbeat().catch(() => setConnected(false)),
      25000,
    );
    return () => clearInterval(t);
  }, [user?.id]);
  useEffect(() => {
    if (!user?.verified || page !== "tonight") return;
    const t = setTimeout(() => act(() => loadRooms()), 250);
    return () => clearTimeout(t);
  }, [search, category, page, user?.verified]);
  useEffect(() => {
    if (page === "admin" && user && user.role !== "USER") act(loadAdmin);
  }, [page, user?.id]);
  useEffect(() => {
    if (ws.current?.readyState === 1 && user?.verified)
      ws.current.send(
        JSON.stringify({
          type: "discovery",
          payload: page === "tonight" && !active,
        }),
      );
  }, [page, active?.id, connected, user?.verified]);
  useEffect(() => {
    if (!active || connected) return;
    const t = setInterval(() => refreshChat().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [active?.id, connected]);
  useEffect(() => {
    if (!queue) return;
    const t = setInterval(
      () =>
        act(async () => {
          const result = await api("/match", "POST", {});
          if (result.roomId) await openRoom(result.roomId);
        }),
      5000,
    );
    return () => clearInterval(t);
  }, [queue]);
  actionRef.current = (event: any) => {
    if (event.type === "ack") {
      const ack = acks.current.get(event.payload.clientMessageId);
      if (ack) ack.resolve();
    }
    if (event.type === "read" && event.roomId === activeRef.current?.id)
      api(`/rooms/${event.roomId}/messages`)
        .then((r) => setMessages(r.messages))
        .catch(() => {});
    if (event.type === "matched")
      act(async () => {
        await openRoom(event.payload.roomId);
        await loadSocial();
      });
    if (
      ["message", "room.changed"].includes(event.type) &&
      event.roomId === activeRef.current?.id
    )
      act(refreshChat);
    if (
      event.type === "room.closed" &&
      event.roomId === activeRef.current?.id
    ) {
      setActive(null);
      activeRef.current = null;
      notify("This room has closed.");
      act(loadSocial);
    }
    if (
      event.type === "discovery.changed" &&
      userRef.current?.verified &&
      page === "tonight" &&
      !activeRef.current
    ) {
      act(() => loadRooms());
    }
    if (
      ["request", "call.request"].includes(event.type) &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      document.hidden
    )
      new Notification("A new hello on Charoo", {
        body:
          event.type === "request"
            ? "You have a new connection request."
            : "You have a video invitation.",
        icon: "/icon-192.png",
      });
    if (
      [
        "request",
        "request.responded",
        "call.request",
        "call.changed",
        "blocked",
      ].includes(event.type)
    ) {
      act(async () => {
        await loadSocial();
        if (activeRef.current) await refreshChat();
      });
    }
    if (
      event.type === "typing" &&
      event.payload.userId !== userRef.current?.id
    ) {
      setTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setTyping(false), 2500);
    }
    if (event.type === "session.revoked") {
      setUser(null);
      setActive(null);
      notify("Your session is no longer available.", true);
    }
  };
  useEffect(() => {
    if (!user) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    function connect() {
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`,
      );
      ws.current = socket;
      socket.onopen = () => {
        setConnected(true);
        if (userRef.current?.verified)
          socket.send(
            JSON.stringify({ type: "discovery", payload: page === "tonight" }),
          );
        if (activeRef.current)
          socket.send(
            JSON.stringify({ type: "subscribe", roomId: activeRef.current.id }),
          );
        act(async () => {
          await loadSocial();
          if (activeRef.current) await refreshChat();
        });
      };
      socket.onmessage = (e) => {
        try {
          actionRef.current(JSON.parse(e.data));
        } catch {}
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) timer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, [user?.id]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);
  async function startGuest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await act(async () => {
      const value = await api("/auth/guest", "POST", { adultConsent: true });
      setCsrf(value.csrf);
      setUser(value.user);
      setModal(null);
    });
  }
  async function email(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await act(async () => {
      const r = await api("/auth/email", "POST", {
        email: field(form, "email"),
        adultConsent: true,
      });
      notify(r.message);
      setModal(null);
    });
  }
  async function createRoom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await act(async () => {
      const r = await api("/rooms", "POST", {
        type: modal === "public" ? "AVAILABLE_TONIGHT" : "SHARED_GROUP",
        title: field(form, "title"),
        description: field(form, "description"),
        category: field(form, "category") || "Conversation",
        region: field(form, "region"),
        tags: field(form, "tags")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        verifiedOnly: new FormData(form).has("verified"),
        durationHours: Number(field(form, "duration") || 12),
      });
      setShareUrl(r.shareUrl || "");
      setModal(r.shareUrl ? "share" : null);
      await openRoom(r.id);
      await loadSocial();
    });
  }
  async function submitMessage(payload: any) {
    const roomId = activeRef.current?.id;
    if (!roomId) return;
    let acknowledged = false;
    if (ws.current?.readyState === 1) {
      acknowledged = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          acks.current.delete(payload.clientMessageId);
          resolve(false);
        }, 2000);
        acks.current.set(payload.clientMessageId, {
          resolve: () => {
            clearTimeout(timer);
            acks.current.delete(payload.clientMessageId);
            resolve(true);
          },
          reject: () => {
            clearTimeout(timer);
            acks.current.delete(payload.clientMessageId);
            resolve(false);
          },
        });
        ws.current!.send(JSON.stringify({ type: "message", roomId, payload }));
      });
    }
    if (!acknowledged) await api(`/rooms/${roomId}/messages`, "POST", payload);
    setPending((prev) =>
      prev.filter((p) => p.clientMessageId !== payload.clientMessageId),
    );
    await refreshChat();
  }
  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || !active) return;
    const payload = {
      clientMessageId: crypto.randomUUID(),
      text: draft.trim(),
      replyTo: reply?.id,
    };
    setDraft("");
    setReply(null);
    setPending((p) => [...p, { ...payload, roomId: active.id }]);
    try {
      await submitMessage(payload);
    } catch (e) {
      notify(`${(e as Error).message} — your message is ready to retry.`, true);
    }
  }
  async function attach(file: File) {
    await act(async () => {
      const room = activeRef.current;
      if (!room) return;
      const init = await api("/media/init", "POST", {
        roomId: room.id,
        name: file.name,
        mime: file.type,
        size: file.size,
      });
      const response = await fetch(init.url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error("Upload failed");
      await api(`/media/${init.id}/complete`, "POST", {});
      await submitMessage({
        clientMessageId: crypto.randomUUID(),
        text: `Attachment: ${file.name}`,
        attachmentId: init.id,
      });
    });
  }
  const nav: [Page, string, ReactNode][] = [
    ["tonight", "Available Tonight", <Compass size={20} />],
    ["strangers", "Meet a stranger", <Shuffle size={20} />],
    ["groups", "Shared rooms", <Link size={20} />],
    ["contacts", "Your connections", <Users size={20} />],
    ["profile", "Your profile", <Settings size={20} />],
  ];
  if (user && user.role !== "USER")
    nav.push(["admin", "Moderation", <Shield size={20} />]);
  const choosePage = (p: Page) => {
    setPage(p);
    if (activeRef.current && ws.current?.readyState === 1)
      ws.current.send(
        JSON.stringify({ type: "unsubscribe", roomId: activeRef.current.id }),
      );
    setActive(null);
    activeRef.current = null;
    setMobileNav(false);
  };
  const request = (targetId: string, kind: string) =>
    act(async () => {
      await api("/requests", "POST", {
        targetId,
        kind,
        roomId: activeRef.current?.id,
      });
      notify("Request sent. They decide whether to accept.");
    });
  const moderation = (action: string, targetId?: string) =>
    act(async () => {
      await api(`/rooms/${active.id}/moderate`, "POST", { action, targetId });
      if (action === "CLOSE") {
        setActive(null);
        activeRef.current = null;
      } else await refreshChat();
    });
  const isOwner =
    active?.creator_id === user?.id &&
    ["AVAILABLE_TONIGHT", "SHARED_GROUP"].includes(active?.type);
  const peers =
    active?.participants?.filter((p: any) => p.id !== user?.id) || [];
  if (loading)
    return (
      <div className="loading">
        <Sparkles />
        <p>Finding a little connection…</p>
      </div>
    );
  return (
    <div className="app">
      <aside className={`sidebar ${mobileNav ? "visible" : ""}`}>
        <a className="brand" href="/" aria-label="Charoo home">
          <span>
            <Sparkles size={23} />
          </span>
          charoo<span className="brand-dot">.</span>
        </a>
        <div className="sidebar-caption">A LITTLE CONNECTION</div>
        <nav>
          {nav.map(([p, label, icon]) => (
            <button
              key={p}
              className={page === p && !active ? "selected" : ""}
              onClick={() => choosePage(p)}
            >
              {icon}
              <span>{label}</span>
              {p === "contacts" && requests.length > 0 && (
                <b className="count">{requests.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-rooms">
          <div className="eyebrow">YOUR CONVERSATIONS</div>
          {conversations.slice(0, 7).map((r) => (
            <button
              key={r.id}
              className={active?.id === r.id ? "selected" : ""}
              onClick={() => act(() => openRoom(r.id))}
            >
              <MessageCircle size={16} />
              <span>{r.title}</span>
            </button>
          ))}
          {!conversations.length && (
            <p>Good conversations start with a hello.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="safety">
            <Shield size={17} />
            <span>
              18+ community
              <br />
              <small>Consent comes first.</small>
            </span>
          </div>
          {install && (
            <button onClick={() => install.prompt()}>
              <Download size={16} />
              Install Charoo
            </button>
          )}
          {user ? (
            <>
              <button
                className="user-mini"
                onClick={() => choosePage("profile")}
              >
                <span className="avatar">{user.displayName[0]}</span>
                <span>
                  {user.displayName}
                  <small>
                    {user.verified
                      ? "Verified member"
                      : "Guest · temporary identity"}
                  </small>
                </span>
              </button>
              <button
                className="quiet"
                onClick={() =>
                  act(async () => {
                    await api("/auth/logout", "POST", {});
                    setUser(null);
                    setCsrf("");
                    setActive(null);
                    setConversations([]);
                    setPending([]);
                  })
                }
              >
                <LogOut size={15} />
                Sign out
              </button>
            </>
          ) : (
            <button onClick={() => setModal("guest")}>
              Join the conversation <ArrowRight size={16} />
            </button>
          )}
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button
            className="mobile-only icon-button"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label="Toggle menu"
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            YOUR WORLD, A LITTLE CLOSER <span>✦</span>
          </div>
          <div className="header-actions">
            {user && (
              <>
                <span className={`connection ${connected ? "on" : ""}`}>
                  {connected ? "Live" : "Reconnecting"}
                </span>
                <select
                  aria-label="Availability status"
                  value={status}
                  onChange={(e) => {
                    const next = e.target.value;
                    statusRef.current = next;
                    setStatus(next);
                    explicitAvailable.current = next === "Available Tonight";
                    act(heartbeat);
                  }}
                >
                  <option>Online</option>
                  <option>Offline</option>
                  {user.verified && <option>Available Tonight</option>}
                </select>
              </>
            )}
            {!user && (
              <button
                className="button small"
                onClick={() => setModal("email")}
              >
                Sign in <ArrowUpRight size={15} />
              </button>
            )}
          </div>
        </header>
        {!active && page === "tonight" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <span className="pill">
                  <span className="live-dot" /> THE NIGHT IS STILL YOUNG
                </span>
                <h1>
                  Same night.
                  <br />
                  <em>New people.</em>
                </h1>
                <p>
                  Find a conversation worth staying up for.
                  <br />
                  Pick a room, say hello, see where it goes.
                </p>
                <div className="hero-actions">
                  <button
                    className="button"
                    onClick={() =>
                      user?.verified ? setModal("public") : setModal("email")
                    }
                  >
                    <Plus size={18} />
                    Start a room
                  </button>
                  <span>Open to conversation. Always your choice.</span>
                </div>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="bubble bubble-one">
                  hey, anyone up? <span>✦</span>
                </div>
                <div className="bubble bubble-two">
                  always down for a good chat ☕
                </div>
                <div className="bubble bubble-three">
                  <Heart size={20} /> a little less strangers.
                </div>
                <div className="art-star">✳</div>
              </div>
            </section>
            <section className="discovery">
              <div className="section-title">
                <div>
                  <span className="eyebrow">FIND YOUR KIND OF NIGHT</span>
                  <h2>
                    Available Tonight <span className="live-dot" />
                  </h2>
                </div>
                <button
                  className="text-button"
                  onClick={() =>
                    user?.verified ? setModal("public") : setModal("email")
                  }
                >
                  Create a room <Plus size={16} />
                </button>
              </div>
              {!user?.verified ? (
                <div className="gate">
                  <span className="gate-icon">
                    <Globe size={28} />
                  </span>
                  <h3>A whole night of possibilities.</h3>
                  <p>
                    Verify your email to discover public topic rooms and meet
                    other verified members. Stranger chats and shared rooms
                    welcome guests.
                  </p>
                  <button className="button" onClick={() => setModal("email")}>
                    Explore with a verified account <ArrowRight size={16} />
                  </button>
                  <button
                    className="text-button"
                    onClick={() => choosePage("strangers")}
                  >
                    Or meet a stranger
                  </button>
                </div>
              ) : (
                <>
                  <div className="filters">
                    <label className="search">
                      <Search size={18} />
                      <input
                        placeholder="Find a topic, tag or conversation…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                    <select
                      aria-label="Category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      <option value="">All categories</option>
                      {categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div className="chips">
                    {[
                      "",
                      "Conversation",
                      "Hangout",
                      "Gaming",
                      "Food & Drinks",
                      "Study",
                    ].map((c) => (
                      <button
                        key={c}
                        className={category === c ? "active" : ""}
                        onClick={() => setCategory(c)}
                      >
                        {c || "All nights"}
                      </button>
                    ))}
                  </div>
                  <div className="room-grid">
                    {rooms.map((r, i) => (
                      <article className={`room-card tone-${i % 4}`} key={r.id}>
                        <div className="room-card-top">
                          <span className="room-symbol">
                            {r.category === "Gaming"
                              ? "↗"
                              : r.category === "Food & Drinks"
                                ? "☕"
                                : r.category === "Study"
                                  ? "✎"
                                  : "✳"}
                          </span>
                          <span className="category">{r.category}</span>
                        </div>
                        <h3>{r.title}</h3>
                        <p>
                          {r.description ||
                            "A new room, a new conversation. Come say hello."}
                        </p>
                        <div className="tags">
                          {r.tags.slice(0, 3).map((t) => (
                            <span key={t}>#{t}</span>
                          ))}
                        </div>
                        <div className="room-meta">
                          <span>
                            <Radio size={14} />
                            {r.online} active
                          </span>
                          <span>
                            <Clock size={13} />
                            {r.region || "Anywhere"}
                          </span>
                        </div>
                        <button
                          className="join-button"
                          onClick={() =>
                            act(async () => {
                              await api(`/rooms/${r.id}/join`, "POST", {});
                              await openRoom(r.id);
                              await loadSocial();
                            })
                          }
                        >
                          Join the conversation <ArrowUpRight size={18} />
                        </button>
                      </article>
                    ))}
                  </div>
                  {!rooms.length && (
                    <div className="empty">
                      <Sparkles size={32} />
                      <h3>Be the first hello tonight.</h3>
                      <p>
                        No rooms match right now. Start a topic and invite a
                        little serendipity.
                      </p>
                    </div>
                  )}
                  {feedNext && (
                    <button
                      className="button secondary"
                      onClick={() => act(() => loadRooms(true))}
                    >
                      More rooms
                    </button>
                  )}
                </>
              )}
            </section>
            <footer className="page-footer">
              <span>Small hellos. Unexpected connections.</span>
              <span>Public rooms are temporary · 18+ only</span>
            </footer>
          </>
        )}
        {!active && page === "strangers" && (
          <section className="focus-page">
            <span className="pill">A FRESH START, EVERY TIME</span>
            <h1>
              Someone new.
              <br />
              <em>Something unexpected.</em>
            </h1>
            <p>
              Your identity stays hidden. A little ASL can be revealed after a
              real exchange, if you’ve chosen to share it. Conversations expire
              after they end.
            </p>
            <div className={`match-orb ${queue ? "searching" : ""}`}>
              <Shuffle size={50} />
            </div>
            <h2>
              {queue ? "Finding your next hello…" : "Ready to meet a stranger?"}
            </h2>
            <p>No pressure. Leave, block or report whenever you need to.</p>
            {queue ? (
              <button
                className="button secondary"
                onClick={() =>
                  act(async () => {
                    await api("/match", "DELETE");
                    setQueue(false);
                  })
                }
              >
                Cancel search
              </button>
            ) : (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  user
                    ? act(async () => {
                        await heartbeat();
                        const r = await api("/match", "POST", {});
                        if (r.roomId) await openRoom(r.roomId);
                        else setQueue(true);
                      })
                    : setModal("guest")
                }
              >
                Meet someone <ArrowRight size={18} />
              </button>
            )}
          </section>
        )}
        {!active && page === "groups" && (
          <section className="content-page">
            <span className="eyebrow">JUST YOUR PEOPLE</span>
            <h1>
              A room of
              <br />
              <em>your own.</em>
            </h1>
            <p>
              Unlisted, temporary group chats. Create a room and share its
              secure link. Your group won’t appear in Available Tonight.
            </p>
            <button
              className="button"
              onClick={() => (user ? setModal("shared") : setModal("guest"))}
            >
              <Plus size={18} />
              Create a shared room
            </button>
            <div className="list">
              {conversations
                .filter((r) => r.type === "SHARED_GROUP")
                .map((r) => (
                  <button key={r.id} onClick={() => act(() => openRoom(r.id))}>
                    <Link />
                    <span>
                      {r.title}
                      <small>
                        Expires {new Date(r.expires_at!).toLocaleString()}
                      </small>
                    </span>
                    <ArrowUpRight />
                  </button>
                ))}
            </div>
          </section>
        )}
        {!active && page === "contacts" && (
          <section className="content-page">
            <span className="eyebrow">MAKE THE HELLO LAST</span>
            <h1>
              Your connections<span className="accent">.</span>
            </h1>
            {!user?.verified ? (
              <div className="empty">
                <p>
                  Verify your email to save contacts and accept private chat
                  requests.
                </p>
                <button className="button" onClick={() => setModal("email")}>
                  Verify email
                </button>
              </div>
            ) : (
              <>
                <h2>
                  Requests <span className="count">{requests.length}</span>
                </h2>
                <div className="list">
                  {requests.map((r) => (
                    <div key={r.id}>
                      <span className="avatar">{r.display_name[0]}</span>
                      <span>
                        {r.display_name}
                        <small>{r.kind.toLowerCase()} request</small>
                      </span>
                      <button
                        className="button small"
                        onClick={() =>
                          act(async () => {
                            const result = await api(
                              `/requests/${r.id}/respond`,
                              "POST",
                              { accept: true },
                            );
                            await loadSocial();
                            if (result.roomId) await openRoom(result.roomId);
                          })
                        }
                      >
                        Accept
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            await api(`/requests/${r.id}/respond`, "POST", {
                              accept: false,
                            });
                            await loadSocial();
                          })
                        }
                      >
                        Decline
                      </button>
                    </div>
                  ))}
                </div>
                <h2>Saved contacts</h2>
                <div className="list">
                  {contacts.map((c) => (
                    <div key={c.id}>
                      <span className="avatar">{c.display_name[0]}</span>
                      <span>
                        {c.display_name}
                        <small>Mutually connected</small>
                      </span>
                      <button
                        className="text-button"
                        onClick={() => act(() => openRoom(c.room_id))}
                      >
                        Chat <MessageCircle size={16} />
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            await api(`/contacts/${c.id}`, "DELETE");
                            await loadSocial();
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                {!contacts.length && (
                  <p className="muted">
                    Save someone after you’ve shared a conversation. They’ll
                    need to accept.
                  </p>
                )}
                <h2>
                  Meet again <span className="label">FREE FOR MVP</span>
                </h2>
                <div className="list">
                  {history.map((h) => (
                    <div key={h.id}>
                      <span>
                        {h.display_name}
                        <small>
                          Previously matched ·{" "}
                          {new Date(h.matched_at).toLocaleDateString()}
                        </small>
                      </span>
                      <button
                        className="text-button"
                        onClick={() => request(h.id, "RECONNECT")}
                      >
                        Request reconnect <ArrowUpRight size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
        {!active && page === "profile" && (
          <section className="content-page">
            <span className="eyebrow">YOU CHOOSE WHAT TO SHARE</span>
            <h1>
              Your little corner<span className="accent">.</span>
            </h1>
            {user ? (
              <>
                <div className="profile-status">
                  <span className="avatar large">{user.displayName[0]}</span>
                  <div>
                    <h2>{user.displayName}</h2>
                    <p>
                      {user.verified
                        ? "✓ Email verified"
                        : "Guest identity · temporary"}{" "}
                      {!user.verified && (
                        <button
                          className="text-button"
                          onClick={() => setModal("email")}
                        >
                          Verify & keep this identity
                        </button>
                      )}
                    </p>
                  </div>
                </div>
                <form
                  className="profile-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = e.currentTarget;
                    act(async () => {
                      const r = await api("/me/profile", "PATCH", {
                        displayName: field(f, "displayName"),
                        age: field(f, "age") ? Number(field(f, "age")) : null,
                        gender: field(f, "gender"),
                        region: field(f, "region"),
                        bio: field(f, "bio"),
                        interests: field(f, "interests")
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        aslVisibility: field(f, "visibility"),
                      });
                      setUser(r);
                      notify("Profile saved.");
                    });
                  }}
                >
                  <label>
                    Display name
                    <input
                      name="displayName"
                      required
                      minLength={2}
                      maxLength={40}
                      defaultValue={user.profile.displayName}
                    />
                  </label>
                  <div className="form-grid">
                    <label>
                      Age (18+)
                      <input
                        name="age"
                        type="number"
                        min={18}
                        max={120}
                        defaultValue={user.profile.age || ""}
                      />
                    </label>
                    <label>
                      Gender
                      <input
                        name="gender"
                        maxLength={40}
                        defaultValue={user.profile.gender}
                      />
                    </label>
                  </div>
                  <label>
                    Approximate region
                    <input
                      name="region"
                      placeholder="City or region only"
                      maxLength={80}
                      defaultValue={user.profile.region}
                    />
                  </label>
                  <label>
                    Interests, separated by commas
                    <input
                      name="interests"
                      defaultValue={user.profile.interests.join(", ")}
                    />
                  </label>
                  <label>
                    A little about you
                    <textarea
                      name="bio"
                      maxLength={300}
                      defaultValue={user.profile.bio}
                    />
                  </label>
                  <label>
                    ASL visibility
                    <select
                      name="visibility"
                      defaultValue={user.profile.aslVisibility}
                    >
                      <option value="private">Private</option>
                      <option value="contacts_only">Contacts only</option>
                      <option value="public">
                        Share after stranger reveal / in rooms
                      </option>
                    </select>
                  </label>
                  <p className="form-note">
                    Your email is never shown to other members. Share only an
                    approximate region.
                  </p>
                  <button className="button" disabled={busy}>
                    Save profile <Check size={16} />
                  </button>
                </form>
                <button
                  className="text-button"
                  onClick={() =>
                    act(async () => {
                      if (!("Notification" in window))
                        throw new Error(
                          "Notifications are not supported in this browser",
                        );
                      const result = await Notification.requestPermission();
                      notify(
                        result === "granted"
                          ? "Notifications enabled while Charoo is open."
                          : "Notifications were not enabled.",
                      );
                    })
                  }
                >
                  Enable browser notifications
                </button>
                <h2>Blocked members</h2>
                <div className="list">
                  {blocks.map((b) => (
                    <div key={b.target_id}>
                      <span>{b.display_name}</span>
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            await api(`/blocks/${b.target_id}`, "DELETE");
                            await loadSocial();
                          })
                        }
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <button className="button" onClick={() => setModal("guest")}>
                Start as a guest
              </button>
            )}
          </section>
        )}
        {active && (
          <section className="chat">
            <div className="chat-head">
              <button
                className="icon-button"
                aria-label="Back"
                onClick={() => {
                  if (ws.current?.readyState === 1)
                    ws.current.send(
                      JSON.stringify({
                        type: "unsubscribe",
                        roomId: active.id,
                      }),
                    );
                  setActive(null);
                  activeRef.current = null;
                }}
              >
                <ChevronLeft />
              </button>
              <div>
                <h2>
                  {active.type === "STRANGER"
                    ? "Your next hello"
                    : active.title}
                </h2>
                <p>
                  {active.type === "STRANGER"
                    ? active.asl_revealed
                      ? "ASL unlocked · visibility preferences apply"
                      : "Identity hidden · get to know each other first"
                    : `${active.online} active · ${active.type === "SHARED_GROUP" ? "Unlisted room" : "Verified community"}`}
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Report room"
                onClick={() => setModal("report")}
              >
                <Flag size={18} />
              </button>
              <button
                className="text-button"
                onClick={() =>
                  act(async () => {
                    await api(`/rooms/${active.id}/leave`, "POST", {});
                    setActive(null);
                    activeRef.current = null;
                    await loadSocial();
                  })
                }
              >
                Leave
              </button>
            </div>
            <div className="chat-layout">
              <div className="chat-main">
                <div className="messages" aria-live="polite">
                  {messageNext && (
                    <button
                      className="text-button"
                      onClick={() =>
                        act(async () => {
                          const r = await api(
                            `/rooms/${active.id}/messages?before=${encodeURIComponent(messageNext)}`,
                          );
                          setMessages((prev) => [...r.messages, ...prev]);
                          setMessageNext(r.next);
                        })
                      }
                    >
                      Earlier messages
                    </button>
                  )}
                  <div className="chat-welcome">
                    <span className="room-symbol">✳</span>
                    <h3>A little hello goes a long way.</h3>
                    <p>Be kind. Respect boundaries. Leave whenever you want.</p>
                  </div>
                  {messages.map((m) => (
                    <div
                      className={`message ${m.senderId === user?.id ? "own" : ""}`}
                      key={m.id}
                    >
                      <span className="message-name">
                        {m.senderId === user?.id ? "You" : m.name}{" "}
                        <small>
                          {new Date(m.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </small>
                      </span>
                      {m.replyTo && (
                        <small className="reply-preview">
                          Replying to an earlier message
                        </small>
                      )}
                      <div className="message-bubble">
                        {m.text}
                        {m.attachmentId && (
                          <button
                            className="text-button"
                            onClick={() =>
                              act(async () => {
                                const r = await api(
                                  `/media/${m.attachmentId}/download`,
                                );
                                window.open(
                                  r.url,
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              })
                            }
                          >
                            <Download size={15} />
                            Download scanned attachment
                          </button>
                        )}
                      </div>
                      <div className="message-tools">
                        {m.senderId === user?.id && (
                          <small>{m.readBy?.length ? "Seen" : "Sent"}</small>
                        )}
                        <button onClick={() => setReply(m)}>Reply</button>
                        <button
                          onClick={() =>
                            act(async () => {
                              await api(
                                `/rooms/${active.id}/reactions`,
                                "POST",
                                {
                                  messageId: m.id,
                                  emoji: "❤️",
                                  remove:
                                    m.reactions["❤️"]?.includes(user!.id) ||
                                    false,
                                },
                              );
                              await refreshChat();
                            })
                          }
                        >
                          ♡ {m.reactions["❤️"]?.length || ""}
                        </button>
                        <button
                          onClick={() => {
                            setReply(m);
                            setModal("report");
                          }}
                        >
                          Report
                        </button>
                      </div>
                    </div>
                  ))}
                  {pending
                    .filter((p) => p.roomId === active.id)
                    .map((p) => (
                      <div
                        className="message own pending"
                        key={p.clientMessageId}
                      >
                        <div className="message-bubble">{p.text}</div>
                        <button
                          className="text-button"
                          onClick={() => act(() => submitMessage(p))}
                        >
                          Not confirmed · retry
                        </button>
                      </div>
                    ))}
                  {typing && <p className="typing">Someone is typing…</p>}
                  <div ref={chatEnd} />
                </div>
                <form className="composer" onSubmit={sendMessage}>
                  {reply && (
                    <div className="reply-bar">
                      Replying to: {reply.text.slice(0, 80)}
                      <button
                        type="button"
                        onClick={() => setReply(null)}
                        aria-label="Cancel reply"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <div className="composer-row">
                    <label
                      className="icon-button attachment"
                      title="Upload scanned media"
                    >
                      <Paperclip size={20} />
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,audio/webm,audio/mpeg,application/pdf"
                        capture="environment"
                        onChange={(e) => {
                          if (e.target.files?.[0]) attach(e.target.files[0]);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <input
                      aria-label="Message"
                      placeholder="A hello is a good place to start…"
                      maxLength={4000}
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        if (ws.current?.readyState === 1)
                          ws.current.send(
                            JSON.stringify({
                              type: "typing",
                              roomId: active.id,
                            }),
                          );
                      }}
                    />
                    <button
                      className="send"
                      aria-label="Send message"
                      disabled={!draft.trim()}
                    >
                      <Send size={19} />
                    </button>
                  </div>
                  <div className="composer-note">
                    <span>Ephemeral by design. Encrypted at rest.</span>
                    <button
                      type="button"
                      onClick={() =>
                        act(async () => {
                          const r = await api("/assistant", "POST", {
                            roomId: active.id,
                            style: "icebreaker",
                          });
                          setDraft(r.suggestion);
                        })
                      }
                    >
                      <Sparkles size={13} />
                      Need an icebreaker?
                    </button>
                  </div>
                </form>
              </div>
              <aside className="participants">
                <span className="eyebrow">IN THIS CONVERSATION</span>
                {active.participants.map((p: any) => (
                  <div className="participant" key={p.id}>
                    <div>
                      <span className="avatar">{p.name[0]}</span>
                      <strong>
                        {p.id === user?.id ? "You" : p.name}
                        {p.verified && <Check size={13} />}
                      </strong>
                    </div>
                    {p.asl && (
                      <p>
                        {[p.asl.age, p.asl.gender, p.asl.region]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                    {p.id !== user?.id && (
                      <div className="participant-actions">
                        {user?.verified && p.verified && (
                          <>
                            <button onClick={() => request(p.id, "PRIVATE")}>
                              Private chat request
                            </button>
                            <button onClick={() => request(p.id, "CONTACT")}>
                              Save contact request
                            </button>
                          </>
                        )}
                        <button
                          onClick={() =>
                            act(async () => {
                              await api("/blocks", "POST", { targetId: p.id });
                              await refreshChat();
                              await loadSocial();
                            })
                          }
                        >
                          Block
                        </button>
                        {isOwner && (
                          <>
                            <button onClick={() => moderation("MUTE", p.id)}>
                              Mute for 30 min
                            </button>
                            <button onClick={() => moderation("REMOVE", p.id)}>
                              Remove
                            </button>
                          </>
                        )}
                        {["PRIVATE", "CONTACT", "STRANGER"].includes(
                          active.type,
                        ) && (
                          <button
                            onClick={() =>
                              act(async () => {
                                await api("/calls", "POST", {
                                  roomId: active.id,
                                  targetId: p.id,
                                });
                                notify("Call invitation sent.");
                                await loadSocial();
                              })
                            }
                          >
                            <Video size={13} />
                            Invite to video
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {active.participants.length >= 100 && (
                  <p className="muted">Showing the first 100 members.</p>
                )}
                {isOwner && (
                  <div className="owner-controls">
                    <h3>Your room</h3>
                    <button
                      className="text-button"
                      onClick={() => setModal("editRoom")}
                    >
                      Edit topic / slow mode
                    </button>
                    <button
                      className="danger"
                      onClick={() => moderation("CLOSE")}
                    >
                      Close room
                    </button>
                  </div>
                )}
                <div className="privacy-note">
                  <Shield size={18} />
                  <p>
                    Joining a room means joining a conversation. Private chats,
                    contacts and calls always need consent.
                  </p>
                </div>
              </aside>
            </div>
          </section>
        )}
        {!active &&
          page === "admin" &&
          user &&
          user.role !== "USER" &&
          admin && (
            <section className="content-page admin-page">
              <span className="eyebrow">CHAROO OPERATIONS</span>
              <h1>
                Community care<span className="accent">.</span>
              </h1>
              <div className="stats">
                {[
                  ["Accounts", admin.users],
                  ["Public rooms", admin.public_rooms],
                  ["Shared rooms", admin.shared_rooms],
                  ["Open reports", admin.reports],
                  ["Match queue", admin.queue],
                ].map(([k, v]) => (
                  <div key={k}>
                    <span>{k}</span>
                    <strong>{v}</strong>
                  </div>
                ))}
              </div>
              <h2>Reports</h2>
              <div className="list">
                {adminReports.map((r) => (
                  <div key={r.id}>
                    <span>
                      {r.reason}
                      <small>
                        {r.state} · {new Date(r.created_at).toLocaleString()}
                        <br />
                        User: {r.target_id || "—"} · Room: {r.room_id || "—"}
                      </small>
                    </span>
                    {user.role !== "SUPPORT" && r.message_id && (
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            const evidence = await api(
                              `/admin/reports/${r.id}/evidence`,
                            );
                            notify(
                              evidence.text || "Reported content has expired.",
                            );
                          })
                        }
                      >
                        View reported message
                      </button>
                    )}
                    {user.role !== "SUPPORT" && r.state === "OPEN" && (
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            await api("/admin/actions", "POST", {
                              action: "RESOLVE_REPORT",
                              targetId: r.id,
                            });
                            await loadAdmin();
                          })
                        }
                      >
                        Resolve
                      </button>
                    )}
                    {user.role !== "SUPPORT" && r.target_id && (
                      <>
                        <button
                          className="text-button"
                          onClick={() =>
                            act(async () => {
                              await api("/admin/actions", "POST", {
                                action: "SUSPEND",
                                targetId: r.target_id,
                              });
                              await loadAdmin();
                            })
                          }
                        >
                          Suspend 24h
                        </button>
                        <button
                          className="danger small"
                          onClick={() =>
                            act(async () => {
                              await api("/admin/actions", "POST", {
                                action: "BAN",
                                targetId: r.target_id,
                              });
                              await loadAdmin();
                            })
                          }
                        >
                          Ban
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <h2>Rooms</h2>
              <div className="list">
                {adminRooms.map((r) => (
                  <div key={r.id}>
                    <span>
                      {r.title}
                      <small>
                        {r.type} · {r.state}
                      </small>
                    </span>
                    {user.role !== "SUPPORT" && r.message_id && (
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            const evidence = await api(
                              `/admin/reports/${r.id}/evidence`,
                            );
                            notify(
                              evidence.text || "Reported content has expired.",
                            );
                          })
                        }
                      >
                        View reported message
                      </button>
                    )}
                    {user.role !== "SUPPORT" && r.state === "OPEN" && (
                      <button
                        className="text-button"
                        onClick={() =>
                          act(async () => {
                            await api("/admin/actions", "POST", {
                              action: "CLOSE_ROOM",
                              targetId: r.id,
                            });
                            await loadAdmin();
                          })
                        }
                      >
                        Close
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {user.role === "ADMIN" && (
                <>
                  <h2>System settings</h2>
                  <form
                    className="settings-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      act(async () => {
                        const data = new FormData(e.currentTarget);
                        const cfg = Object.fromEntries(
                          Object.entries(admin.settings).map(([k, v]) => [
                            k,
                            typeof v === "boolean"
                              ? data.has(k)
                              : Number(data.get(k)),
                          ]),
                        );
                        await api("/admin/settings", "PATCH", cfg);
                        notify("Settings updated.");
                        await loadAdmin();
                      });
                    }}
                  >
                    {Object.entries(admin.settings).map(([k, v]) => (
                      <label key={k}>
                        {k.replaceAll("_", " ")}
                        {typeof v === "boolean" ? (
                          <input type="checkbox" name={k} defaultChecked={v} />
                        ) : (
                          <input
                            type="number"
                            name={k}
                            defaultValue={Number(v)}
                            readOnly={k === "reconnect_price"}
                          />
                        )}
                      </label>
                    ))}
                    <button className="button">Save settings</button>
                  </form>
                  <h2>Audit trail</h2>
                  <div className="list">
                    {audit.map((a) => (
                      <div key={a.id}>
                        <span>
                          {a.action}
                          <small>
                            {a.target_id} ·{" "}
                            {new Date(a.created_at).toLocaleString()}
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
      </main>
      {calls.length > 0 && !callId && (
        <div className="call-invite">
          <Video />
          <div>
            {calls[0].state === "RINGING"
              ? `${calls[0].display_name} · video invitation`
              : "Your video call is ready"}
          </div>
          {calls[0].state === "ACCEPTED" ? (
            <button
              className="button small"
              onClick={() => setCallId(calls[0].id)}
            >
              Join call
            </button>
          ) : calls[0].target_id === user?.id ? (
            <>
              <button
                className="button small"
                onClick={() =>
                  act(async () => {
                    await api(`/calls/${calls[0].id}/respond`, "POST", {
                      accept: true,
                    });
                    await loadSocial();
                    setCallId(calls[0].id);
                  })
                }
              >
                Accept
              </button>
              <button
                className="text-button"
                onClick={() =>
                  act(async () => {
                    await api(`/calls/${calls[0].id}/respond`, "POST", {
                      accept: false,
                    });
                    await loadSocial();
                  })
                }
              >
                Decline
              </button>
            </>
          ) : (
            <button
              className="text-button"
              onClick={() =>
                act(async () => {
                  await api(`/calls/${calls[0].id}/end`, "POST", {});
                  await loadSocial();
                })
              }
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {callId && (
        <Modal
          title="Private video call"
          onClose={() => notify("End the call to close this window.")}
        >
          <Suspense fallback={<p>Loading video…</p>}>
            <VideoCall
              callId={callId}
              onEnd={() => {
                setCallId(null);
                act(loadSocial);
              }}
              onError={(s) => notify(s, true)}
            />
          </Suspense>
        </Modal>
      )}
      {toast && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ? <Flag size={17} /> : <Check size={17} />}
          <span>{toast}</span>
          <button onClick={() => setToast("")} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal === "guest"
              ? "Start with a hello"
              : modal === "email"
                ? "Make your hello last"
                : modal === "share"
                  ? "Your room is ready"
                  : modal === "report"
                    ? "Help keep Charoo safe"
                    : modal === "editRoom"
                      ? "Your room, your topic"
                      : modal === "public"
                        ? "Start something tonight"
                        : "Create your shared room"
          }
          onClose={() => {
            setModal(null);
            if (modal === "report") setReply(null);
          }}
        >
          {modal === "guest" ? (
            <form onSubmit={startGuest}>
              <p>
                Get a temporary identity and meet a stranger. You can verify
                your email later without losing this identity.
              </p>
              <label className="checkbox">
                <input type="checkbox" required />I am 18 or older and agree to
                respectful, consent-based conversations.
              </label>
              <button className="button" disabled={busy}>
                Continue as guest <ArrowRight size={16} />
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setModal("email")}
              >
                Sign in with email instead
              </button>
            </form>
          ) : modal === "email" ? (
            <form onSubmit={email}>
              <p>
                We’ll send a secure sign-in link. Verification confirms access
                to your email, not a person’s real-world identity.
              </p>
              <label>
                Email
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="you@example.com"
                />
              </label>
              <label className="checkbox">
                <input type="checkbox" required />I am 18 or older and agree to
                respectful, consent-based conversations.
              </label>
              <button className="button" disabled={busy}>
                Send my sign-in link <ArrowRight size={16} />
              </button>
            </form>
          ) : modal === "share" ? (
            <>
              <p>
                This room is unlisted. Anyone with the link can join, subject to
                its verification setting.
              </p>
              <input readOnly value={shareUrl} aria-label="Secure room link" />
              <button
                className="button"
                onClick={() =>
                  act(async () => {
                    await navigator.clipboard.writeText(shareUrl);
                    notify("Link copied.");
                  })
                }
              >
                Copy invite link <Link size={16} />
              </button>
              <p className="form-note">
                Save this link now. It won’t be returned by room listings.
              </p>
            </>
          ) : modal === "report" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = e.currentTarget;
                act(async () => {
                  const r = await api("/reports", "POST", {
                    roomId: active?.id,
                    messageId: reply?.id,
                    targetId: reply?.senderId || peers[0]?.id,
                    reason: field(f, "reason"),
                  });
                  notify(r.message);
                  setModal(null);
                  setReply(null);
                });
              }}
            >
              <label>
                What happened?
                <textarea
                  name="reason"
                  required
                  minLength={5}
                  maxLength={1000}
                />
              </label>
              <button className="button">
                Send report <Flag size={16} />
              </button>
            </form>
          ) : modal === "editRoom" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = e.currentTarget;
                act(async () => {
                  await api(`/rooms/${active.id}`, "PATCH", {
                    title: field(f, "title"),
                    description: field(f, "description"),
                    slowMode: Number(field(f, "slow")),
                  });
                  await refreshChat();
                  setModal(null);
                });
              }}
            >
              <label>
                Topic
                <input
                  name="title"
                  defaultValue={active.title}
                  required
                  minLength={3}
                  maxLength={100}
                />
              </label>
              <label>
                Description
                <textarea
                  name="description"
                  defaultValue={active.description}
                  maxLength={500}
                />
              </label>
              <label>
                Seconds between messages
                <input
                  type="number"
                  name="slow"
                  min={0}
                  max={60}
                  defaultValue={active.slow_mode}
                />
              </label>
              <button className="button">Save changes</button>
            </form>
          ) : (
            <form onSubmit={createRoom}>
              <p>
                {modal === "public"
                  ? "A temporary public room for verified people. Give your night a topic."
                  : "A temporary, unlisted space. Only people with your secure link can join."}
              </p>
              <label>
                Room title
                <input
                  name="title"
                  placeholder="Coffee and random conversations"
                  required
                  minLength={3}
                  maxLength={100}
                />
              </label>
              <label>
                A little more context
                <textarea
                  name="description"
                  placeholder="What’s the plan?"
                  maxLength={500}
                />
              </label>
              <div className="form-grid">
                <label>
                  Category
                  <select name="category">
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Ends in
                  <select name="duration">
                    <option value={3}>3 hours</option>
                    <option value={6}>6 hours</option>
                    <option value={12}>12 hours</option>
                    <option value={24}>24 hours</option>
                  </select>
                </label>
              </div>
              <label>
                Approximate area (optional)
                <input
                  name="region"
                  maxLength={80}
                  placeholder="Iloilo, or anywhere"
                />
              </label>
              <label>
                Tags (comma separated)
                <input name="tags" placeholder="coffee, chill, conversation" />
              </label>
              {modal === "shared" && (
                <label className="checkbox">
                  <input type="checkbox" name="verified" />
                  Verified members only
                </label>
              )}
              <button className="button" disabled={busy}>
                {modal === "public" ? "Publish room" : "Create & get a link"}{" "}
                <ArrowUpRight size={17} />
              </button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
