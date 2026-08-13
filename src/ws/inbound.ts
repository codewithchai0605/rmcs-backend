import { z } from "zod";

const nameField = z.string().trim().min(1).max(20).optional();
const avatarField = z.string().max(32).optional();
const roomIdField = z.string().trim().min(4).max(8);
const passwordField = z.string().min(4).max(32).optional();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_name"),
    payload: z.object({ name: z.string().min(1).max(20), avatarId: avatarField }),
  }),
  z.object({
    type: z.literal("queue_join"),
    payload: z.object({ name: nameField, avatarId: avatarField }).optional(),
  }),
  z.object({
    type: z.literal("queue_leave"),
    payload: z.object({}).optional(),
  }),
  z.object({
    type: z.literal("private_room_create"),
    payload: z.object({
      name: nameField,
      avatarId: avatarField,
      password: passwordField,
      maxRounds: z.number().int().min(1).max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal("private_room_join"),
    payload: z.object({
      roomId: roomIdField,
      password: z.string().max(32).optional(),
      name: nameField,
      avatarId: avatarField,
    }),
  }),
  z.object({
    type: z.literal("room_leave"),
    payload: z.object({}).optional(),
  }),
  z.object({
    type: z.literal("room_start"),
    payload: z.object({}).optional(),
  }),
  z.object({
    type: z.literal("room_kick"),
    payload: z.object({ targetPlayerId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("room_update_settings"),
    payload: z.object({
      maxRounds: z.number().int().min(1).max(100).optional(),
      password: z.string().min(4).max(32).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("chat_send"),
    payload: z.object({ text: z.string().min(1).max(500) }),
  }),
  z.object({
    type: z.literal("make_guess"),
    payload: z.object({ guessedPlayerId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("replay_request"),
    payload: z.object({}).optional(),
  }),
  z.object({
    type: z.literal("replay_response"),
    payload: z.object({ accepted: z.boolean(), requestId: z.string().optional() }),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

/** Narrow a generic ClientMessage down to a specific type's payload. */
export type PayloadOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>["payload"];

export interface ParseResult {
  ok: boolean;
  message?: ClientMessage;
  error?: string;
}

export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Message must be valid JSON" };
  }

  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: "Message failed validation" };
  }

  return { ok: true, message: result.data };
}
