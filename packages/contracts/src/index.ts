import { z } from "zod";
export const roomTypes = [
  "AVAILABLE_TONIGHT",
  "SHARED_GROUP",
  "STRANGER",
  "PRIVATE",
  "CONTACT",
] as const;
export type RoomType = (typeof roomTypes)[number];
export const categories = [
  "Conversation",
  "Hangout",
  "Food & Drinks",
  "Gaming",
  "Events",
  "Music",
  "Study",
  "Sports",
  "Random",
  "Other",
] as const;
export const visibility = z.enum(["public", "contacts_only", "private"]);
export const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(40),
  age: z.number().int().min(18).max(120).nullable(),
  gender: z.string().trim().max(40),
  region: z.string().trim().max(80),
  bio: z.string().trim().max(300),
  interests: z.array(z.string().trim().min(1).max(30)).max(10),
  aslVisibility: visibility,
});
export const guestSchema = z.object({ adultConsent: z.literal(true) });
export const emailSchema = z.object({
  email: z.string().email().max(254),
  adultConsent: z.literal(true),
});
export const roomSchema = z.object({
  type: z.enum(["AVAILABLE_TONIGHT", "SHARED_GROUP"]),
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().max(500).default(""),
  category: z.enum(categories).default("Conversation"),
  region: z.string().trim().max(80).default(""),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  verifiedOnly: z.boolean().default(false),
  durationHours: z.number().int().min(1).max(24).optional(),
});
export const messageSchema = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().trim().min(1).max(4000),
  replyTo: z.string().uuid().nullable().optional(),
  attachmentId: z.string().uuid().nullable().optional(),
});
export const requestSchema = z.object({
  targetId: z.string().uuid(),
  kind: z.enum(["PRIVATE", "CONTACT", "RECONNECT"]),
  roomId: z.string().uuid().optional(),
});
export const reportSchema = z
  .object({
    targetId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    reason: z.string().trim().min(5).max(1000),
  })
  .refine(
    (v) => !!(v.targetId || v.roomId || v.messageId),
    "A report needs a target",
  );
export type Profile = z.infer<typeof profileSchema>;
export interface User {
  id: string;
  displayName: string;
  verified: boolean;
  role: "USER" | "SUPPORT" | "MODERATOR" | "ADMIN";
  profile: Profile;
  status: string;
}
export interface Room {
  id: string;
  type: RoomType;
  title: string;
  description: string;
  category: string;
  region: string;
  tags: string[];
  creator_id: string;
  expires_at: string | null;
  state: string;
  online: number;
  verified_only: boolean;
  slow_mode: number;
}
export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  name: string;
  text: string;
  createdAt: string;
  clientMessageId: string;
  replyTo: string | null;
  attachmentId: string | null;
  reactions: Record<string, string[]>;
  readBy?: string[];
}
export interface Event {
  type: string;
  roomId?: string;
  userIds?: string[];
  payload?: unknown;
}
export const defaultSettings = {
  guest_access_enabled: true,
  available_tonight_enabled: true,
  available_tonight_duration_hours: 6,
  available_room_retention_hours: 12,
  shared_room_retention_hours: 24,
  conversation_retention_hours: 24,
  available_room_creation_limit: 3,
  asl_reveal_threshold: 20,
  minimum_messages_per_user: 10,
  asl_minimum_duration_seconds: 120,
  available_room_slow_mode: 2,
  upload_size_limit_mb: 10,
  available_room_media_enabled: false,
  video_enabled: false,
  AI_assistant_enabled: false,
  reconnect_price: 0,
};
export const settingsSchema = z.object({
  guest_access_enabled: z.boolean(),
  available_tonight_enabled: z.boolean(),
  available_tonight_duration_hours: z.number().int().min(1).max(24),
  available_room_retention_hours: z.number().int().min(1).max(24),
  shared_room_retention_hours: z.number().int().min(1).max(168),
  conversation_retention_hours: z.number().int().min(1).max(168),
  available_room_creation_limit: z.number().int().min(1).max(20),
  asl_reveal_threshold: z.number().int().min(2).max(200),
  minimum_messages_per_user: z.number().int().min(1).max(100),
  asl_minimum_duration_seconds: z.number().int().min(30).max(3600),
  available_room_slow_mode: z.number().int().min(0).max(60),
  upload_size_limit_mb: z.number().int().min(1).max(25),
  available_room_media_enabled: z.boolean(),
  video_enabled: z.boolean(),
  AI_assistant_enabled: z.boolean(),
  reconnect_price: z.literal(0),
});
export type Settings = typeof defaultSettings;
export { z };
